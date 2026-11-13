#!/usr/bin/env bash
# Update the agency server's Bench (and optionally its shared packages) to given
# commits. Run from the Mac. Dry run unless --apply is given.
#
#   scripts/deploy-server.sh <bench-ref> [--packages <name>=<ref> ...] [--apply]
#
#   scripts/deploy-server.sh main
#   scripts/deploy-server.sh v1.2 --packages agents-engine=main --apply
#
# <name> is agents-engine, ai_chat_engine or work-streams. A ref is a branch,
# tag or commit on the repo's GitHub origin, so push it there first. Packages
# not named go to the commit packages.lock names at <bench-ref>.
#
# --apply records the current commits, fetches, checks out the refs, installs
# and builds the board's front end, restarts bench.service and waits up to 20 s
# for the board to answer (200, or 302 and 401 under sign-in). If it does not, the recorded commits go back and
# the service restarts again. data/ is never touched.
#
# DEPLOY_HOST changes the server (default root@167.235.25.240).

set -u

HOST="${DEPLOY_HOST:-root@167.235.25.240}"
BENCH_REPO="/opt/agency/bench"
PKG_DIR="/opt/agency/PACKAGES"

usage() {
  sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

[ $# -ge 1 ] || usage
BENCH_REF=""
APPLY=0
PKGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --packages)
      shift
      while [ $# -gt 0 ] && [[ "$1" != --* ]] && [[ "$1" == *=* ]]; do
        PKGS+=("$1"); shift
      done
      continue ;;
    -h|--help) usage ;;
    --*) echo "Unknown option $1" >&2; usage ;;
    *) if [ -z "$BENCH_REF" ]; then BENCH_REF="$1"; else echo "Unexpected argument $1" >&2; usage; fi ;;
  esac
  shift
done
[ -n "$BENCH_REF" ] || usage

# Refs are checked here, before any ssh call, and quoted again when sent.
valid_ref() { [[ "$1" =~ ^[A-Za-z0-9._/-]+$ && "$1" != -* ]]; }
valid_ref "$BENCH_REF" || { echo "Refused ref '$BENCH_REF': use letters, digits, . _ / - only, and not a leading -." >&2; exit 2; }
for p in ${PKGS[@]+"${PKGS[@]}"}; do
  case "${p%%=*}" in
    agents-engine|ai_chat_engine|work-streams) ;;
    *) echo "Unknown package '${p%%=*}'. Use agents-engine, ai_chat_engine or work-streams." >&2; exit 2 ;;
  esac
  valid_ref "${p#*=}" || { echo "Refused ref '${p#*=}' for ${p%%=*}: use letters, digits, . _ / - only, and not a leading -." >&2; exit 2; }
done

# ssh joins its arguments into one string for the server's shell, so each is
# quoted with %q.
ARGS=""
for a in "$APPLY" "$BENCH_REPO" "$PKG_DIR" "$BENCH_REF" ${PKGS[@]+"${PKGS[@]}"}; do
  ARGS+=" $(printf '%q' "$a")"
done

# The server's half lives in deploy-on-server.sh, so the pipeline's forced
# command (deploy-forced-command.sh) runs the same steps. It runs as root, with
# git and npm handed to the bench user (git refuses a checkout owned by someone else).
ssh "$HOST" "bash -s --$ARGS" < "$(dirname "${BASH_SOURCE[0]}")/deploy-on-server.sh"
