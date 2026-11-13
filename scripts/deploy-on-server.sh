#!/usr/bin/env bash
# The half of a deploy that runs on the server, as root. Two callers:
#
#   scripts/deploy-server.sh, from the Mac, which sends this file over ssh
#     (bash -s -- <apply> <bench-repo> <pkg-dir> <bench-ref> [<name>=<ref> ...])
#   scripts/deploy-forced-command.sh, the pipeline's deploy key, which runs the
#     copy installed at /usr/local/lib/bench-deploy/ with apply=1
#
# Arguments are positional: apply (1 or 0), the Bench checkout, the packages
# folder, the Bench ref, then any packages as name=ref. data/ is never touched.
#
# Every package that packages.lock names, at the Bench commit being deployed,
# goes to the commit it names there, so the server runs the packages the
# tests ran with. A package named on the command line keeps the ref given.
set -uo pipefail
APPLY="$1"; BENCH_REPO="$2"; PKG_DIR="$3"; BENCH_REF="$4"; shift 4
BHOME="$(getent passwd bench | cut -d: -f6)"
as_bench() { runuser -u bench -- env HOME="$BHOME" "$@"; }
git_in() { local d="$1"; shift; as_bench git -C "$d" "$@"; }

REPOS=("bench|$BENCH_REPO|$BENCH_REF")
for p in "$@"; do REPOS+=("${p%%=*}|$PKG_DIR/${p%%=*}|${p#*=}"); done

say() { printf '%s\n' "$*"; }
die() { say "ABORT: $*" >&2; exit 1; }

# One deploy at a time on this server, whoever started it. Held until this
# script exits; a second deploy waits up to ten minutes, then gives up.
if [ "$APPLY" = 1 ]; then
  exec 9>"${BENCH_DEPLOY_LOCK:-/run/lock/bench-deploy.lock}"
  flock -w 600 9 || die "another deploy has held the lock for ten minutes"
fi

# Resolve a ref to a full commit. Dry run asks the remote without writing
# anything; apply resolves after the fetch.
# Both follow one order: branch, then tag (the commit a tag points at), then,
# on --apply only, anything else git can name (a short commit id).
resolve_remote() {
  local dir="$1" ref="$2" out
  if [[ "$ref" =~ ^[0-9a-f]{40}$ ]]; then echo "$ref"; return; fi
  out="$(git_in "$dir" ls-remote origin "refs/heads/$ref" 2>/dev/null | head -1 | cut -f1)"
  if [ -z "$out" ]; then
    out="$(git_in "$dir" ls-remote origin "refs/tags/$ref^{}" 2>/dev/null | head -1 | cut -f1)"
  fi
  if [ -z "$out" ]; then
    out="$(git_in "$dir" ls-remote origin "refs/tags/$ref" 2>/dev/null | head -1 | cut -f1)"
  fi
  echo "$out"
}
resolve_local() {
  local dir="$1" ref="$2"
  git_in "$dir" rev-parse --verify --quiet "refs/remotes/origin/$ref^{commit}" \
    || git_in "$dir" rev-parse --verify --quiet "refs/tags/$ref^{commit}" \
    || git_in "$dir" rev-parse --verify --quiet "$ref^{commit}"
}
short() { echo "${1:0:9}"; }

declare -A OLD NEW
record_old() {
  local name="$1" dir="$2"
  [ -d "$dir/.git" ] || die "$dir is not a git checkout"
  OLD[$name]="$(git_in "$dir" rev-parse HEAD)" || die "cannot read HEAD of $dir"
  if [ -n "$(git_in "$dir" status --porcelain --untracked-files=no)" ]; then
    die "$dir has uncommitted changes to tracked files; deploying would overwrite them"
  fi
}
for r in "${REPOS[@]}"; do
  IFS='|' read -r name dir ref <<<"$r"
  record_old "$name" "$dir"
done

# packages.lock at the Bench commit being deployed: one package a line, its
# folder in the packages folder, a full commit id, then the URL CI clones.
# Read with git show, so nothing is checked out first. Each package it names
# that the command line did not is added, fetched (on --apply) and checked
# out with the rest, and rolled back with them.
lock_packages() {
  local text line name sha dir r known
  text="$(git_in "$BENCH_REPO" show "${NEW[bench]}:packages.lock" 2>/dev/null)" || return 0
  while read -r name sha _; do
    case "$name" in ''|\#*) continue ;; esac
    [[ "$name" =~ ^[A-Za-z0-9_.-]+$ ]] || die "packages.lock: '$name' is not a package folder name"
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "packages.lock: $name needs a full commit id, not '$sha'"
    known=0
    for r in "${REPOS[@]}"; do [ "${r%%|*}" = "$name" ] && known=1; done
    [ "$known" = 1 ] && continue
    dir="$PKG_DIR/$name"
    record_old "$name" "$dir" </dev/null
    if [ "$APPLY" = 1 ]; then
      git_in "$dir" fetch --tags --prune origin </dev/null 2>&1 | sed "s/^/  $name: /" || die "fetch failed for $name"
      git_in "$dir" cat-file -e "$sha^{commit}" 2>/dev/null \
        || die "$name: $(short "$sha") from packages.lock is not on its origin"
    fi
    NEW[$name]="$sha"
    REPOS+=("$name|$dir|$sha")
  done <<<"$text"
}

if [ "$APPLY" = 1 ]; then
  say "== Fetch"
  for r in "${REPOS[@]}"; do
    IFS='|' read -r name dir ref <<<"$r"
    git_in "$dir" fetch --tags --prune origin 2>&1 | sed "s/^/  $name: /" || die "fetch failed for $name"
    NEW[$name]="$(resolve_local "$dir" "$ref")" || true
    [ -n "${NEW[$name]:-}" ] || die "$name: '$ref' not found on origin"
  done
  # Set by deploy-forced-command.sh: the pipeline's key deploys only a commit
  # the branch has reached, never one the server fetched from anywhere else.
  if [ -n "${BENCH_DEPLOY_ONLY_ON:-}" ]; then
    git_in "$BENCH_REPO" merge-base --is-ancestor "${NEW[bench]}" "refs/remotes/origin/$BENCH_DEPLOY_ONLY_ON" \
      || die "bench: $(short "${NEW[bench]}") is not on origin/$BENCH_DEPLOY_ONLY_ON"
  fi
  lock_packages
else
  say "DRY RUN (nothing on the server changes). Add --apply to deploy."
  for r in "${REPOS[@]}"; do
    IFS='|' read -r name dir ref <<<"$r"
    NEW[$name]="$(resolve_remote "$dir" "$ref")"
  done
  # Only when the server already has that Bench commit; otherwise --apply
  # reads packages.lock after its fetch.
  if [ -n "${NEW[bench]:-}" ] && git_in "$BENCH_REPO" cat-file -e "${NEW[bench]}^{commit}" 2>/dev/null; then
    lock_packages
  else
    say "(packages.lock at that commit is read after the fetch, on --apply)"
  fi
fi

say
for r in "${REPOS[@]}"; do
  IFS='|' read -r name dir ref <<<"$r"
  to="${NEW[$name]:-}"
  [ -n "$to" ] || to="(cannot resolve '$ref' without fetching; a short commit id resolves on --apply)"
  [ "${NEW[$name]:-}" = "${OLD[$name]}" ] && same=" (already there)" || same=""
  say "$name ($dir)"
  say "  from $(short "${OLD[$name]}")  ${OLD[$name]}"
  say "  to   ${to}  [$ref]$same"
done

build() {
  # npm ci installs exactly package-lock.json and never rewrites it. The board's front end builds to kanban/dist (gitignored). The packages
  # ship their built files in git, so only bench needs it.
  local bhead="$1"
  say "== npm ci + build (bench)"
  as_bench bash -c "cd '$BENCH_REPO' && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent" 2>&1 | sed 's/^/  /'
}

health() {
  say "== Waiting for http://127.0.0.1:8765/ (20 s)"
  local i code
  for i in $(seq 1 20); do
    code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8765/ || true)"
    case "$code" in 200|302|401) say "  ${code} after ${i} s"; return 0 ;; esac
    sleep 1
  done
  say "  last answer: ${code:-none}"
  return 1
}

checkout_all() {  # args: associative array name to read, then 1 to discard edits to tracked files first
  local -n target="$1"
  for r in "${REPOS[@]}"; do
    IFS='|' read -r name dir ref <<<"$r"
    if [ "${2:-0}" = 1 ]; then git_in "$dir" checkout --quiet -- . || return 1; fi
    git_in "$dir" checkout --quiet --detach "${target[$name]}" || return 1
  done
}

if [ "$APPLY" != 1 ]; then
  say
  say "Steps with --apply:"
  say "  1. record the commits above"
  say "  2. git fetch --tags origin in each repo, as the bench user"
  say "  3. git checkout --detach <commit> in each repo, packages at their packages.lock commit"
  say "  4. npm ci and npm run build in $BENCH_REPO (data/ untouched)"
  say "  5. systemctl restart bench.service"
  say "  6. wait up to 20 s for the board to answer on http://127.0.0.1:8765/ (200, 302 or 401)"
  say "  7. on failure: check out the recorded commits, rebuild, restart"
  exit 0
fi

say
say "== Checkout"
if ! checkout_all NEW; then
  say "Checkout failed, putting the recorded commits back."
  checkout_all OLD 1
  exit 1
fi

if build x && systemctl restart bench.service && health; then
  say "Deployed. Each repo on the server is now on a detached HEAD at:"
  for r in "${REPOS[@]}"; do
    IFS='|' read -r name dir ref <<<"$r"
    say "  $name $(git_in "$dir" rev-parse HEAD)"
  done
  exit 0
fi

say
say "== FAILED, rolling back"
checkout_all OLD 1 || say "  rollback checkout failed; check $BENCH_REPO by hand"
build x || say "  rebuild failed"
systemctl restart bench.service
if health; then say "Rolled back to the recorded commits; the board answers."; else say "Rolled back, but the board is not answering. Check: journalctl -u bench.service -n 50"; fi
exit 1
