# Deploy Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After an approved PR is merged into `main`, GitHub runs every test and then deploys that exact commit to the agency server, with no one deploying by hand.

**Architecture:** A GitHub Actions workflow tests every PR and every push to `main`. On a push, a second job connects to the server with a deploy key that `authorized_keys` limits to a single fixed command. That command accepts a 40-character commit id and nothing else, and runs the same server-side deploy logic `scripts/deploy-server.sh` uses today, moved into its own file and installed at a root-owned path outside the checkout. Protection on `main` is the gate that requires an approved PR.

**Tech Stack:** GitHub Actions (ubuntu-24.04, Python 3.12, Node 22, Google Chrome), bash, OpenSSH forced commands, `flock`, systemd (`bench.service`).

**Design:** `docs/superpowers/specs/2026-10-29-deploy-pipeline-design.md`

---

## Before starting

These are two cards on the offdesk board, and the pipeline cannot run until both are done:

1. **Get the server-only PA save work onto GitHub.** While `/opt/agency/bench` has uncommitted edits, the deploy logic refuses (`... has uncommitted changes to tracked files`), so every pipeline deploy would fail. Waiting on issue #7.
2. **Fix `test_chats.mjs` and `test_projects.mjs` on main.** The test job runs `scripts/test-board.sh --all`, so a red suite stops every deploy.

Tasks 1–5 below can be built and merged before then. Tasks 6–8 (the key, the settings, the first run) wait for both.

## Files

| File | Status | Responsibility |
| --- | --- | --- |
| `scripts/deploy-on-server.sh` | create | The deploy logic that runs on the server: check, fetch, checkout, build, restart, health check, rollback. Moved out of the heredoc in `deploy-server.sh`, plus a lock. |
| `scripts/deploy-server.sh` | modify | Sends `deploy-on-server.sh` over ssh instead of the heredoc. Everything else unchanged. |
| `scripts/deploy-forced-command.sh` | create | What the deploy key may run: checks the request is one commit id, then runs `deploy-on-server.sh --apply` for it. |
| `scripts/test_deploy_forced.py` | create | Tests for the forced command's refusals and for what it runs. |
| `scripts/install-deploy-key.sh` | create | Run from the Mac: installs the two scripts at `/usr/local/lib/bench-deploy/` and puts the key's restricted line in root's `authorized_keys`. |
| `.github/workflows/deploy.yml` | create | The test job and the deploy job. |
| `CLAUDE.md` | modify | A short "Deploying" section. |

---

### Task 1: Move the server half of the deploy into `scripts/deploy-on-server.sh`

**Files:**
- Create: `scripts/deploy-on-server.sh`
- Modify: `scripts/deploy-server.sh:68-212`

- [ ] **Step 1: Record today's dry-run output, for comparison later**

Run (read-only, nothing on the server changes):

```bash
DEPLOY_HOST=agency scripts/deploy-server.sh main > /tmp/deploy-dry-before.txt 2>&1; echo "exit $?"
```

Expected: the plan of steps ending in `7. on failure: ...`, `exit 0`. If it prints `ABORT: /opt/agency/bench has uncommitted changes`, the server-only work is still there. The comparison in Step 6 still works, since both runs abort the same way.

- [ ] **Step 2: Create `scripts/deploy-on-server.sh` from the heredoc body**

```bash
{
  cat <<'HEAD'
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
HEAD
  awk "/<<'REMOTE'/{f=1;next} /^REMOTE\$/{f=0} f" scripts/deploy-server.sh
} > scripts/deploy-on-server.sh
chmod 755 scripts/deploy-on-server.sh
```

- [ ] **Step 3: Add the lock, so a manual deploy and a pipeline deploy never overlap**

In `scripts/deploy-on-server.sh`, directly after the line `die() { say "ABORT: $*" >&2; exit 1; }`, insert:

```bash
# One deploy at a time on this server, whoever started it. Held until this
# script exits; a second deploy waits up to ten minutes, then gives up.
if [ "$APPLY" = 1 ]; then
  exec 9>"${BENCH_DEPLOY_LOCK:-/run/lock/bench-deploy.lock}"
  flock -w 600 9 || die "another deploy has held the lock for ten minutes"
fi
```

- [ ] **Step 4: Make `deploy-server.sh` send the file instead of the heredoc**

Replace lines 68–212 of `scripts/deploy-server.sh`, from the comment `# Everything below runs on the server, as root,` down to and including the closing `REMOTE` line, with:

```bash
# The server's half lives in deploy-on-server.sh, so the pipeline's forced
# command (deploy-forced-command.sh) runs the same steps. It runs as root, with
# git and npm handed to the bench user (git refuses a checkout owned by someone else).
ssh "$HOST" "bash -s --$ARGS" < "$(dirname "${BASH_SOURCE[0]}")/deploy-on-server.sh"
```

Do it with an exact edit, not a line-number `sed`: check that the text matches before replacing it.

- [ ] **Step 5: Check both files parse**

Run: `bash -n scripts/deploy-on-server.sh && bash -n scripts/deploy-server.sh && echo ok`
Expected: `ok`

- [ ] **Step 6: Compare the dry run with Step 1**

```bash
DEPLOY_HOST=agency scripts/deploy-server.sh main > /tmp/deploy-dry-after.txt 2>&1; echo "exit $?"
diff /tmp/deploy-dry-before.txt /tmp/deploy-dry-after.txt && echo "same output"
```

Expected: `same output`, and the same exit code as Step 1.

- [ ] **Step 7: Commit**

```bash
git add scripts/deploy-on-server.sh scripts/deploy-server.sh
git commit -m "Move the server half of the deploy into deploy-on-server.sh, with a lock"
```

---

### Task 2: The forced command the deploy key may run

**Files:**
- Create: `scripts/test_deploy_forced.py`
- Create: `scripts/deploy-forced-command.sh`

- [ ] **Step 1: Write the failing test**

`scripts/test_deploy_forced.py`:

```python
#!/usr/bin/env python3
"""Proof that deploy-forced-command.sh, the only thing the pipeline's deploy key
can run, deploys one full commit id and refuses everything else.

It points BENCH_DEPLOY_SCRIPT at a stub that records its arguments, so nothing
is deployed. sshd's `restrict` stops a real client from setting that variable.

    python3 scripts/test_deploy_forced.py
"""

import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
FORCED = os.path.join(HERE, "deploy-forced-command.sh")
SHA = "0123456789abcdef0123456789abcdef01234567"

FAILED = []


def check(name, got, want):
    ok = got == want
    print(("  ok  " if ok else " FAIL ") + " " + name)
    if not ok:
        FAILED.append("%s\n    got  %r\n    want %r" % (name, got, want))


def run(original_command):
    """(exit code, the stub's recorded arguments or None)."""
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "args")
        stub = os.path.join(tmp, "stub.sh")
        with open(stub, "w") as fh:
            fh.write('#!/usr/bin/env bash\nprintf "%%s\\n" "$*" > "%s"\n' % out)
        env = dict(os.environ, BENCH_DEPLOY_SCRIPT=stub)
        if original_command is None:
            env.pop("SSH_ORIGINAL_COMMAND", None)
        else:
            env["SSH_ORIGINAL_COMMAND"] = original_command
        rc = subprocess.run(["bash", FORCED], env=env, capture_output=True).returncode
        got = open(out).read().strip() if os.path.exists(out) else None
        return rc, got


def test_a_full_commit_id_is_deployed_with_apply():
    rc, got = run(SHA)
    check("a commit id exits 0", rc, 0)
    check("it runs the deploy with apply=1 on the real paths",
          got, "1 /opt/agency/bench /opt/agency/PACKAGES " + SHA)


def test_anything_else_is_refused_and_nothing_runs():
    for name, cmd in [
        ("no command (an interactive login)", None),
        ("an empty command", ""),
        ("a shell", "bash"),
        ("a branch name", "main"),
        ("a short commit id", SHA[:9]),
        ("an uppercase commit id", SHA.upper()),
        ("a commit id with more after it", SHA + "; rm -rf /"),
        ("a commit id with a space after it", SHA + " "),
        ("a commit id with a newline after it", SHA + "\nbash"),
    ]:
        rc, got = run(cmd)
        check(name + " is refused", (rc, got), (2, None))


def main():
    test_a_full_commit_id_is_deployed_with_apply()
    test_anything_else_is_refused_and_nothing_runs()
    print()
    if FAILED:
        for f in FAILED:
            print("FAIL " + f)
        print("%d failed" % len(FAILED))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: Run it to see it fail**

Run: `python3 scripts/test_deploy_forced.py`
Expected: FAIL lines, because `deploy-forced-command.sh` does not exist yet (bash exits 127).

- [ ] **Step 3: Write the forced command**

`scripts/deploy-forced-command.sh`:

```bash
#!/usr/bin/env bash
# The only thing the pipeline's deploy key can run. root's authorized_keys
# names it with `restrict,command="..."`, so whatever the client asks for
# arrives here as SSH_ORIGINAL_COMMAND and is never run as a command.
#
# It deploys one full 40-character commit id with --apply, through the
# installed copy of deploy-on-server.sh, and refuses everything else.
# Installed by scripts/install-deploy-key.sh, with deploy-on-server.sh beside it.

set -uo pipefail
DEPLOY_SCRIPT="${BENCH_DEPLOY_SCRIPT:-/usr/local/lib/bench-deploy/deploy-on-server.sh}"
ref="${SSH_ORIGINAL_COMMAND-}"

if ! [[ "$ref" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Refused: this key only deploys one full commit id." >&2
  exit 2
fi

exec bash "$DEPLOY_SCRIPT" 1 /opt/agency/bench /opt/agency/PACKAGES "$ref"
```

Then: `chmod 755 scripts/deploy-forced-command.sh`

- [ ] **Step 4: Run the test to see it pass**

Run: `python3 scripts/test_deploy_forced.py`
Expected: every line `ok`, then `all checks passed`. The newline case is refused because bash's `=~` anchors `^` and `$` to the whole string, not to each line.

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy-forced-command.sh scripts/test_deploy_forced.py
git commit -m "Forced command for the deploy key: one commit id, nothing else"
```

---

### Task 3: The installer for the server side

**Files:**
- Create: `scripts/install-deploy-key.sh`

- [ ] **Step 1: Write the installer**

`scripts/install-deploy-key.sh`:

```bash
#!/usr/bin/env bash
# Install the pipeline's deploy command on the server and let one key run it.
# Run from the Mac. Run it again after changing deploy-on-server.sh or
# deploy-forced-command.sh, since the server runs its installed copies, never
# the checkout's.
#
#   DEPLOY_HOST=<ssh host> scripts/install-deploy-key.sh <public-key-file>
#
# Copies both scripts to /usr/local/lib/bench-deploy/ (root-owned, 755), and
# replaces any earlier deploy-key line in root's authorized_keys with:
#   restrict,command="/usr/local/lib/bench-deploy/deploy-forced-command.sh" <key>

set -euo pipefail
HOST="${DEPLOY_HOST:?set DEPLOY_HOST to the server's ssh host}"
PUB="${1:?usage: DEPLOY_HOST=<host> scripts/install-deploy-key.sh <public-key-file>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR=/usr/local/lib/bench-deploy

KEY="$(tr -d '\n' < "$PUB")"
[[ "$KEY" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ [A-Za-z0-9@._-]+)?$ ]] \
  || { echo "Expected one ssh-ed25519 public key in $PUB" >&2; exit 2; }

for f in deploy-on-server.sh deploy-forced-command.sh; do
  ssh "$HOST" "install -d -o root -g root -m 755 $DIR && cat > $DIR/.$f.new && install -o root -g root -m 755 $DIR/.$f.new $DIR/$f && rm $DIR/.$f.new" < "$HERE/$f"
  echo "installed $DIR/$f"
done

printf 'restrict,command="%s/deploy-forced-command.sh" %s\n' "$DIR" "$KEY" | ssh "$HOST" '
  set -euo pipefail
  f=/root/.ssh/authorized_keys
  install -d -m 700 /root/.ssh; touch "$f"; chmod 600 "$f"
  { grep -v "bench-deploy/deploy-forced-command.sh" "$f" || true; cat; } > "$f.new"
  chmod 600 "$f.new"; mv "$f.new" "$f"
  grep -c "bench-deploy/deploy-forced-command.sh" "$f" | sed "s/^/deploy-key lines: /"'
```

Then: `chmod 755 scripts/install-deploy-key.sh`

- [ ] **Step 2: Check it parses and refuses a bad key file**

```bash
bash -n scripts/install-deploy-key.sh && echo parses
echo "not a key" > /tmp/bad.pub
DEPLOY_HOST=nowhere scripts/install-deploy-key.sh /tmp/bad.pub; echo "exit $?"
```

Expected: `parses`, then `Expected one ssh-ed25519 public key in /tmp/bad.pub` and `exit 2`, with no ssh attempted.

- [ ] **Step 3: Commit**

```bash
git add scripts/install-deploy-key.sh
git commit -m "Installer for the deploy key's command on the server"
```

---

### Task 4: The workflow

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: Check which Python suites run on their own**

The workflow runs every `core/test_*.py` and `kanban/test_*.py` directly. Confirm each passes that way on a clean `main` checkout before writing them in:

```bash
for t in core/test_*.py kanban/test_*.py agents/plan-agent/test_planning_agent.py agents/implement-agent/test_implement_agent.py agents/pa_agent/skills/pa/scripts/test_check_todo.py scripts/test_deploy_forced.py; do
  python3 "$t" > /tmp/t.log 2>&1 && echo "pass $t" || echo "FAIL $t"
done
```

Expected: every line `pass`. Any suite that needs the board server goes through `scripts/test-board.sh <suite>` in the workflow instead of the loop. Any that fails on `main` gets added to the board card "Fix test_chats.mjs and test_projects.mjs on main" rather than skipped here.

- [ ] **Step 2: Write the workflow**

`.github/workflows/deploy.yml`:

```yaml
# Tests every PR to main. On a merge to main (or a manual run), tests the
# merged commit again and deploys exactly that commit to the agency server.
# The server side is scripts/deploy-forced-command.sh; the design is
# docs/superpowers/specs/2026-10-29-deploy-pipeline-design.md.
name: Test and deploy

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-24.04
    timeout-minutes: 40
    steps:
      - uses: actions/checkout@v4
        with:
          path: bench

      # server.py looks for the shared packages at ../PACKAGES, as on the server.
      - name: Shared packages next to the repo
        run: |
          mkdir -p PACKAGES
          git clone --depth 1 https://github.com/tiagopedras/agents-engine.git PACKAGES/agents-engine
          git clone --depth 1 https://github.com/tiagopedras/ai-chat-engine.git PACKAGES/ai_chat_engine
          git clone --depth 1 https://github.com/tiagopedras/work-streams.git PACKAGES/work-streams

      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
          cache-dependency-path: bench/package-lock.json

      - name: Install
        working-directory: bench
        run: |
          pip install chevron
          npm ci --no-audit --no-fund

      - name: Python and Node suites
        working-directory: bench
        run: |
          set -e
          for t in core/test_*.py kanban/test_*.py \
                   agents/plan-agent/test_planning_agent.py \
                   agents/implement-agent/test_implement_agent.py \
                   agents/pa_agent/skills/pa/scripts/test_check_todo.py \
                   scripts/test_deploy_forced.py; do
            echo "== $t"; python3 "$t"
          done
          node core/test_todo.mjs
          node kanban/ui/test_primitives.mjs

      - name: Board suites in Chrome
        working-directory: bench
        env:
          CHROME_BIN: /usr/bin/google-chrome
        run: scripts/test-board.sh --all

  deploy:
    needs: test
    if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    concurrency:
      group: deploy-server
      cancel-in-progress: false
    steps:
      - name: Deploy this commit
        env:
          DEPLOY_SSH_KEY: ${{ secrets.DEPLOY_SSH_KEY }}
          DEPLOY_KNOWN_HOSTS: ${{ secrets.DEPLOY_KNOWN_HOSTS }}
          DEPLOY_HOST: ${{ secrets.DEPLOY_HOST }}
        run: |
          set -euo pipefail
          install -d -m 700 ~/.ssh
          printf '%s\n' "$DEPLOY_SSH_KEY" > ~/.ssh/deploy
          chmod 600 ~/.ssh/deploy
          printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > ~/.ssh/known_hosts
          ssh -i ~/.ssh/deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
            "root@$DEPLOY_HOST" "$GITHUB_SHA"
```

- [ ] **Step 3: Check the YAML parses**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/deploy.yml')); print('ok')"`
Expected: `ok`. If PyYAML is missing: `ruby -ryaml -e "YAML.load_file('.github/workflows/deploy.yml'); puts 'ok'"`

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "Workflow: test every PR, and deploy main to the server after it passes"
```

---

### Task 5: Say how deploying works now

**Files:**
- Modify: `CLAUDE.md` (a new section after "## After changing `kanban/server.py`")

- [ ] **Step 1: Add the section**

```markdown
## Deploying to the agency server

A merge to `main` deploys itself: `.github/workflows/deploy.yml` runs every
test, then sends the commit id to the server, where the deploy key can only run
`scripts/deploy-forced-command.sh`. That runs the installed copy of
`scripts/deploy-on-server.sh` (check, checkout, build, restart, health check,
rollback). `main` is protected, so only an approved PR with passing tests
gets in.

By hand, from the Mac, as before: `scripts/deploy-server.sh main` (dry run),
then `--apply`. Both routes share one lock on the server. After changing
`deploy-on-server.sh` or `deploy-forced-command.sh`, run
`scripts/install-deploy-key.sh` again, since the server runs its installed
copies and never the checkout's.
```

- [ ] **Step 2: Commit, push, open the PR**

```bash
git add CLAUDE.md
git commit -m "CLAUDE.md: how a merge reaches the server"
git push -u origin feature/deploy-pipeline
cat > /tmp/pr-body.md <<'EOF'
## Why

A merge to main should reach the server without anyone deploying by hand, and only after every test passes. Design: docs/superpowers/specs/2026-10-29-deploy-pipeline-design.md.

## What changed

- `scripts/deploy-on-server.sh`: the server half of `deploy-server.sh`, moved out of its heredoc, plus a lock so two deploys never overlap. `deploy-server.sh` now sends this file; its dry-run output is unchanged.
- `scripts/deploy-forced-command.sh`: the only thing the deploy key can run. One full commit id, deployed with --apply. Anything else is refused.
- `scripts/install-deploy-key.sh`: installs both on the server and adds the key's restricted line.
- `.github/workflows/deploy.yml`: tests every PR to main. On a merge, tests again, then deploys that commit.

## Still to do after merging

1. Tiago makes the deploy key and adds the secrets DEPLOY_SSH_KEY, DEPLOY_KNOWN_HOSTS and DEPLOY_HOST.
2. Protect main: approved PR, passing `test`, no force pushes, no bypass.
3. First run by hand from the Actions tab.

Until the server's uncommitted work is on GitHub (#7), every deploy refuses, so the deploy job will fail.

## Testing

- `python3 scripts/test_deploy_forced.py`: all checks pass.
- `scripts/deploy-server.sh main` dry run: output identical before and after the move.
- The test job runs on this PR.
EOF
gh pr create --base main --title "Deploy main to the server after an approved PR" --body-file /tmp/pr-body.md
```

The PR body and commits must not mention Claude.

On this PR the test job runs (it is a `pull_request`), and the deploy job is skipped. That is the first real check that the test job works on GitHub. Fix whatever it shows before merging.

---

### Task 6: The deploy key (after both prerequisites are done)

Tiago holds the repo's secrets, so Tiago makes the key, which keeps the private key from ever being sent to anyone.

- [ ] **Step 1: Tiago makes the key pair on Tiago's machine**

```bash
ssh-keygen -t ed25519 -N "" -C bench-deploy-pipeline -f ./bench-deploy
```

- [ ] **Step 2: Install it on the server** (anyone with root ssh, from the Bench checkout)

```bash
DEPLOY_HOST=agency scripts/install-deploy-key.sh ./bench-deploy.pub
```

Expected: `installed .../deploy-on-server.sh`, `installed .../deploy-forced-command.sh`, `deploy-key lines: 1`.

- [ ] **Step 3: Check the key can do nothing but deploy**

```bash
ssh -i ./bench-deploy -o IdentitiesOnly=yes root@<server> ; echo "exit $?"
ssh -i ./bench-deploy -o IdentitiesOnly=yes root@<server> 'id' ; echo "exit $?"
ssh -i ./bench-deploy -o IdentitiesOnly=yes -N -L 9999:127.0.0.1:8765 root@<server> ; echo "exit $?"
```

Expected: the first two print `Refused: this key only deploys one full commit id.` with `exit 2`, and no shell opens. The third is refused by `restrict`, with no port forward.

---

### Task 7: Repo settings (Tiago)

- [ ] **Step 1: Add three repository secrets** (Settings → Secrets and variables → Actions)

| Secret | Value |
| --- | --- |
| `DEPLOY_SSH_KEY` | the whole of `./bench-deploy` (the private key) |
| `DEPLOY_KNOWN_HOSTS` | the output of `ssh-keyscan -t ed25519 <server address>` |
| `DEPLOY_HOST` | the server's address |

Then delete `./bench-deploy` from Tiago's machine.

- [ ] **Step 2: Protect `main`** (Settings → Rules → Rulesets → New branch ruleset, target `main`, enforcement Active, no bypass list)

- Require a pull request before merging: 1 approval
- Require status checks to pass: `test`
- Block force pushes
- Restrict deletions

From then on, the author of a PR cannot approve it, so Tiago's PRs need Jerome's approval and Jerome's need Tiago's.

---

### Task 8: The first run

- [ ] **Step 1: Run it by hand on a `main` that is already deployed**

GitHub → Actions → Test and deploy → Run workflow → `main`.

Expected: `test` passes, then `deploy` prints `bench (/opt/agency/bench)`, `to <sha> [<sha>] (already there)`, the build, `200|302|401 after N s`, and `Deployed.`

- [ ] **Step 2: Check the server is on that commit and answering**

```bash
ssh agency 'runuser -u bench -- git -C /opt/agency/bench rev-parse HEAD; systemctl is-active bench.service'
```

Expected: the same sha as the run, then `active`.

- [ ] **Step 3: Tick the board card** "Build the deploy pipeline: main to the server after an approved PR" through the PA.
