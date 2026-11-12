# Bench

Read [README.md](README.md) first. Everything in `data/` is private and
gitignored, including `data/profile.md`, the PA's profile of its owner (read from `<memory_root>/me/profile.md` instead when Bench's `memory_root` setting is set and that file exists).

**Memory root.** The `memory_root` key in `data/settings.json` can point at a folder outside Bench that holds the owner's facts, so agents elsewhere can share them. The profile is `<memory_root>/me/profile.md`, and each list's people, company text and context are `people.md`, `about.md` and `context.md` in `<memory_root>/bench/<list>/`. Bench reads each from there first and falls back to the copy in `data/<list>/` while the memory folder has none, and every save of a list's file goes to the memory folder, so the `data/` copy is never written again once it has been moved. Buckets, task lists and the board's running state (plans, chats, history, queues, backups, settings) stay in `data/`. Bench also writes `boards.md` into that folder, so the board list is visible without reading `data/`. Don't assume any of these files live in `data/`. Find a list's file through `memory_file()` in `core/settings.py` and the profile through `core/owner_profile.py`, or go through the server, all of which resolve the setting. `boards.md` is written by Bench, so don't edit it by hand. A list can have a memory folder of its own: `boards.<list>.memory_root` in `data/settings.json` names it, or is null for none, which keeps everything about that list in `data/<list>/`. Absent, the list takes the global one. Its profile is then its own memory folder's `me/profile.md`, then `data/<list>/profile.md`, and `data/profile.md` only while it inherits, so a list with a folder of its own or none never shows the owner's profile. `boards.md` stays in the global folder.

**Projects folders.** `projects_roots` in `data/settings.json` maps a list's name to its own projects folder, which may sit outside Bench. No two lists share one. For that list a `data/projects/<name>` note means `<name>/` in the list's projects folder when it is there, and `data/<list>/projects/<name>/` when it is not, and new project folders go in the list's projects folder. A list with none keeps `data/<list>/projects/`. Resolve a project through `core/project_folders.py`, never by joining `data/<list>/projects/` yourself.

**Parallel sessions.** If `COORDINATION.md` exists at the repo root, read it at
the start of any task and append an entry when you start, when you change
something another session could depend on, and when you finish. Append only.

**Backlog.** If `IMPROVEMENTS.md` exists, it is the standing list of what is wrong
with the board and what should be built next. Read it before diagnosing anything
here, and update it when something lands or something new turns up.

## The skills

The `pa-*` skills live in `agents/pa_agent/skills/`. See
[agents/pa_agent/CLAUDE.md](agents/pa_agent/CLAUDE.md) for the hierarchy between
them: `pa` writes, everything else feeds it.

## Writing a report

Write to `data/<dataset>/reports/` (the current dataset, named by
`data/.current`) as Markdown with the frontmatter the board expects, following
**Rules for writing a report** in README.md. Read them before drafting. Short
version: never lists individual to-dos, says what moved and what it means, in
the owner's voice, kept short.

## Desktop banners

The board server puts up the banners, through `terminal-notifier`, from a thread that ticks every minute across every board (`core/notify_due.py`, started in `kanban/server.py`). Every task and sub-task with a due date of its own that is not done gets one banner: on the due date at its `[time:: HH:MM]` (or the time in its `repeat:` rule), or at 09:00 when it has none. One more goes out at 09:00 on the next working day if it is still open, then it is silent. A weekend or public holiday stays quiet, and anything due on one goes out once on the next working day. The holidays are each board's own profile's (`owner_profile.board_holiday_regions`), so a board with a memory folder of its own or none goes by its own calendar. A server that starts late sends what was owed earlier that day. What has been sent lives per board in `data/<board>/notify-state.json`, so a restart repeats nothing. A board with `boards.<board>.banners` false in `data/settings.json` gets none of this: no due banners, and its queued lines are dropped unposted.

Agents ask for a banner with `companion/notify.py`, which appends to `data/<board>/notify-queue.json` under a lock the server's drain shares; the server posts the lines between 08:30 and 20:00, three a tick (the `content` board has no window). Every link names its board, `#!board=<name>!task=<key>`, and the board switches to it, so keep it a fragment: a second tab on one list is two autosaves on one file.

Mac only, and only with `terminal-notifier` installed. `BENCH_NOTIFY=0` switches it off, and a throwaway data root (`TODOS_DATA_ROOT`, the test runner's) never starts it. Every banner plays macOS's default sound; `BENCH_NOTIFY_SOUND` names another (e.g. `Glass`) or `0` mutes it. Banners go out only while the board is running. `companion/` (the Electron tray app) is retired and stays on disk for `notify.py` and `digest.py`; do not launch it. Format knowledge and the working calendar live in `core/todo.py` (UK and Portuguese public holidays by default). Run `python3 core/test_todo.py --online` after touching calendar rules, and `python3 core/test_notify_due.py` after touching the banners.

## Where the format lives

Twice, and only twice. `core/todo.js` is the board's copy and the authority;
`core/todo.py` beside it is the port every Python reader imports. Change one and
change the other, never add a third. `core/fixtures/` (three JSON tables,
generated by the board's own functions, read by both suites) is what stops them
drifting. After touching either file:

```
python3 core/test_todo.py     node core/test_todo.mjs
```

The board loads `core/todo.js` as a **classic** script, before the board's own
scripts in `kanban/js/`. Keep it classic (a module would defer it past every
symbol needed at first use) and keep it free of `window`, `document` and
`state` (`test_todo.mjs` runs it in a bare `vm` context with none of them).

## The bucket agents

One agent per bucket of each list, all run by one runner,
`agents/bucket-agent/` ([README](agents/bucket-agent/README.md)). It replaced
the Plan and Implement agents, whose folders stay on disk unwired (no `wake` in
their `agent.json`) until they are deleted. Read the README before changing any
of it.

- **A bucket's agent is defined in its brief**,
  `data/<dataset>/buckets/<stream>/<stream>.md`, read by `core/bucket_agents.py`:
  `mode` (`plan-first` or `free-rein`) and `start` (`on-assign` or `scheduled`)
  in its frontmatter, and six required sections, which go into the agent's
  prompt as written. The tracked half is
  [agents/plan-agent/bucket-brief.template.md](agents/plan-agent/bucket-brief.template.md).
  The one agent definition is the tracked `agents/bucket-agent/bucket-agent.md`;
  nothing is symlinked into `.claude/agents/`.
- **Its name is what a sub-task carries in `[to::]`**: `agent_name()` in
  `core/bucket_agents.py`, "[List] [bucket] agent".
- **It never writes `todo.md`.** The runner hashes the file around every run
  and `plans.todo_moved()` tells the board's own save from anything else's;
  that guard should be fixed, not removed, if it gets noisy. It asks for ticks
  through `core/tick_queue.py`, and the board applies a tick only from the agent
  the sub-task is assigned to. No plan type is approved on arrival, and Review
  the work is always the owner's.
- **When it runs is the bucket's `start`.** A scheduled bucket runs in its
  board's hours on the agents dashboard, through the hourly wake. An on-assign
  one is started within a minute of a handover by `core/bucket_wake.py`, which
  the board server starts beside the banners, never under `TODOS_DATA_ROOT` or
  with `BENCH_AGENTS=0`, and counts against the daily spending caps like a
  scheduled pass. Run `python3 agents/bucket-agent/test_bucket_agent.py`
  after touching any of it.
- **Figma work only runs with the owner in the room**, through the `do` skill
  (`agents/implement-agent/skills/do/`), where it can stop and ask.

## The board

One board. A task keeps its card from the moment it's written until it's
finished, whoever does the work.

- **A column says the state of the card**: Backlog, To do, Doing, Reviewing,
  Done. **Who does the work is `[to::]`, never the column.**
- **An agent's part of a task is sub-tasks on the task's card.** Handing over
  (`handOver()`, drawer's Delegate to) lays out four blocked-in-sequence
  sub-tasks: Plan, Review the plan, Implement, Review the work (or the last two,
  straight to Implement). A sub-task inherits due/impact/urgent/week from its
  task, never the tick or assignee.
- **Approving is ticking a review; sending back unticks what's before it** with
  a `feedback:` note, so the agent takes it up again. Only the Implement
  sub-task moves the card.
- **Agents never write `todo.md`.** They queue a tick in
  `data/<dataset>/tick-queue.json`; the board drains it on load, applying a tick
  only from the agent the sub-task is assigned to.
- **Every column is one object**, `colHTML()` in `kanban/js/09-columns.js`. The
  Figma `Column`/`Column header` components mirror it — change together.

## The React half (`kanban/ui/`)

Component layer, Vite + TypeScript, built to `kanban/dist/board-ui.js`. `Column`
and `Card` are the two primitives every ported view is written against; the
port can be incremental because each view still owns `#lists` until it's ported.

Two rules for every view in `kanban/ui/`:

- **A React view owns a node it created, not `#lists`.** An unported view tears
  out `#lists` wholesale, which would orphan a mounted root.
- **Orchestration stays in `kanban/js/`.** Fetch, error branch, sort preference,
  anything reading `state.doc` — handed to the component as props.

`kanban/ui/test_primitives.mjs` and `test_board.mjs` hold markup parity: change
what a card shows in `cardModel()` (`09-columns.js`), and how it's drawn in both
`cardHTML()` (string) and `TaskCard` (React), together.

## After changing `kanban/server.py`

**Restart the server, and say so.** `index.html` reloads fresh, but
`server.py` is a running process — a new route doesn't exist until it restarts.
The board's own "the board helper needs restarting" error is the symptom.

```
lsof -ti tcp:8765 | xargs kill      # then open Bench.app
```

`run.command`/`Bench.app` rebuild `kanban/ui/` via `npm run build` before
starting the server, so opening the board normally is never stale. Editing a
`.tsx` against a server already running needs a manual build:

```
npm run build        # or npm run watch, to rebuild as you edit
```

then Reload the tab (not Save — a tab open since before the file changed holds
a stale document, and saving from it overwrites disk). The bundle is one global
IIFE, `BoardUI` — keep it one, same reason every file in `kanban/js/` is a
classic script.

## Deploying to the agency server

A merge to `main` deploys itself: `.github/workflows/deploy.yml` runs every
test, then sends the commit id to the server, where the deploy key can only run
`scripts/deploy-forced-command.sh`. That runs the installed copy of
`scripts/deploy-on-server.sh` (check, checkout, build, restart, health check,
rollback), and refuses a commit that is not on `origin/main`. The secrets sit
in the `production` environment, which only `main` can use. `main` is
protected, so only an approved PR with passing tests gets in.

By hand, from the Mac, as before: `scripts/deploy-server.sh main` (dry run),
then `--apply`. Both routes share one lock on the server. After changing
`deploy-on-server.sh` or `deploy-forced-command.sh`, run
`scripts/install-deploy-key.sh` again, since the server runs its installed
copies and never the checkout's.

## Testing the board

Full per-suite detail: [docs/TESTING.md](docs/TESTING.md). Run the browser
suites through the script, never against the live server on 8765:

```
scripts/test-board.sh test_board.mjs timeline   # named suites
scripts/test-board.sh --all                     # every kanban/test_*.mjs
```

It starts a second server over a throwaway `_test` copy of `kanban/demo.md` on
a free port (`TODOS_DATA_ROOT`, `TODOS_PORT`), gives each suite's headless
Chrome a free port of its own, and deletes all of it on exit. Neither the real
`data/` nor `data/.current` is touched, so there is nothing to switch back.
Two rules still apply inside it:

- **Default: lock the tab.** Load the fixture with `load(text, 'name.md', {})`,
  then immediately `state.locked = true` before anything else. A locked tab
  cannot save, full stop. Covers essentially all UI testing.
- **Testing a real save:** do it through the script, where the `_test` list
  it saves to is a temp copy, reseeded before every suite. Never switch the real
  `data/.current`: it is one file shared by every tab and session on the live
  server.

Never write into a real list under `data/` from a test.
