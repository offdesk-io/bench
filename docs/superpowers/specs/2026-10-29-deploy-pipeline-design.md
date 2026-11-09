# Deploy pipeline: main to the agency server

## Goal

When an approved PR is merged into `main`, the agency server runs that commit
without anyone deploying by hand, and only if every test has passed.

## How a change reaches the server

1. A PR is opened against `main`.
2. Protection on `main` lets it merge only when it is approved and the test job has passed on it.
3. The merge pushes to `main`, which starts `.github/workflows/deploy.yml`.
4. The workflow runs the tests again on the merged commit, then asks the server to deploy that commit.
5. The server checks it out, builds, restarts and checks that the board answers, and if the board does not answer it puts the previous commit back.

## Pieces

### 1. `.github/workflows/deploy.yml`

- **Triggers:** `push` to `main`, and `workflow_dispatch` so it can be run by hand from the Actions tab. The test job also runs on `pull_request` against `main`, so protection has a check to require.
- **Job `test`** (ubuntu, Python 3, Node, Chrome):
  - `npm ci`, then `npm run build`
  - `python3 core/test_todo.py`, `node core/test_todo.mjs`
  - every `kanban/test_*.py`, `agents/plan-agent/test_planning_agent.py`, `agents/implement-agent/test_implement_agent.py`
  - `node kanban/ui/test_primitives.mjs`
  - `scripts/test-board.sh --all`, which drives every board suite in headless Chrome against a throwaway copy of `kanban/demo.md`
  - The exact list is the one in `docs/TESTING.md`. The workflow runs what that file says, and that file is kept up to date.
- **Job `deploy`:** runs only on `push` or `workflow_dispatch`, `needs: test`. It connects with the deploy key and sends the commit id (`${{ github.sha }}`), nothing else.
- **One deploy at a time:** `concurrency: { group: deploy-server, cancel-in-progress: false }`. A later merge waits for the deploy in progress, then deploys its own commit.

### 2. The server's deploy command

- The part of `scripts/deploy-server.sh` that runs on the server (the heredoc) moves into `scripts/deploy-on-server.sh`. It takes `<bench-ref> [--packages ...] [--apply]` as it does today.
- `deploy-server.sh` on the Mac sends that file over ssh as before, so the manual route is unchanged.
- It is installed on the server as a fixed copy, at a root-owned path outside the checkout. A deploy then never runs a script that the commit being deployed has just rewritten. The fixed copy is refreshed only when it is installed by hand.
- **A lock:** `flock` on a lock file, so a manual deploy and a pipeline deploy cannot overlap.
- **The refusals it has today stay:** it refuses when the checkout has uncommitted edits to tracked files, and it refuses a ref that is not a plain name.

### 3. The deploy key

- A new key pair, used only by this pipeline.
- On the server, its `authorized_keys` line forces the one command (`command="<fixed path> \"$SSH_ORIGINAL_COMMAND\""`) with `restrict`: no shell, no port forwarding, no pty. The command accepts a 40-character commit id and nothing else, and deploys it with `--apply`. After fetching, the deploy refuses a commit that is not on `origin/main` (`git merge-base --is-ancestor`), so the key cannot put an unmerged commit on the server.
- GitHub holds two secrets: `DEPLOY_SSH_KEY` (the private key) and `DEPLOY_KNOWN_HOSTS` (the server's host key line), so the workflow refuses a server it does not recognise. The address is a third secret, `DEPLOY_HOST`, so it is not written in the public repo. All three live in a `production` environment that only `main` may use, named by the deploy job, so a workflow on any other branch cannot read them.

### 4. Protecting `main` (Tiago, in the repo settings)

- Require a pull request before merging, with one approval.
- Require the `test` check to pass.
- Block force pushes, and include administrators, so the owner's direct pushes go through a PR too.

## Errors

- **A test fails:** the deploy job does not run, the server is untouched, and GitHub marks the run red and emails whoever merged.
- **The server refuses** (local edits, lock held, bad ref): the deploy job fails with the server's own message, and nothing on the server changes.
- **The board does not answer after the restart:** `deploy-on-server.sh` checks out the previous commit, rebuilds and restarts as it does today, and the job fails.
- `data/` is never touched by any of these.

## Before it is switched on

1. Get the work that exists only on the server (the PA save route: `pa_save.py`, `test_pa_save.py` and the edits to `kanban/server.py`, `core/board_access.py` and two PA docs) onto GitHub through a PR. Until then every deploy refuses, because the checkout is dirty.
2. Make `test_chats.mjs` and `test_projects.mjs` pass on `main`, or every run stops at the tests.
3. Tiago adds the three secrets and turns on protection for `main`.

## Not included

- The shared packages (`agents-engine`, `ai_chat_engine`, `work-streams`). They have their own repos and stay manual, with `deploy-server.sh main --packages ... --apply`.
- Staging, preview servers or deploying from branches other than `main`.

## Testing the pipeline itself

- Run `deploy-on-server.sh` without `--apply` (a dry run) from the Mac script, before and after the move, and confirm the output is the same.
- Check the forced command by connecting with the deploy key and asking for a shell, then for a ref that is not a commit id. Both should be refused.
- The first real run is a `workflow_dispatch` on `main` that is already deployed. It should report "already there" and restart cleanly.
