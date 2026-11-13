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

## The planning agent

`agents/plan-agent/` runs overnight, sets one sub-agent per task with an open
Plan sub-task assigned to it, and writes a plan for each into
`data/<dataset>/plans/`. It proposes and never executes. A task reaches it by
being handed over on the board (see below); `[to:: Plan agent]` on a task
nobody handed over is not planned until the board hands it over, which the
agent asks for after each run (`pick.unhanded()`). Read
[agents/plan-agent/README.md](agents/plan-agent/README.md) before changing any
of it, particularly the schedule, which is the whole of what keeps it out
of the working day.

- **It never writes `todo.md`.** `plan.py` hashes the file before the batch and
  checks it after every task; that guard should be fixed, not removed, if it
  gets noisy. It asks for its Plan sub-task to be ticked through
  `core/tick_queue.py`, and the board applies the tick only from the agent the
  sub-task is assigned to.
- **The scheduled hours are the only thing keeping it out of the morning.**
  `schedule.py` holds the hours, with a preferred night range the dashboard
  hatches but does not enforce; run `python3 agents/plan-agent/test_planning_agent.py` after touching either.

Each bucket's planner lives beside its brief, at
`data/<dataset>/buckets/<stream>/<dataset>-<stream>-agent.md`, gitignored with
the rest of `data/`. Claude Code only reads agent definitions from inside
`.claude/agents/`, so each one is symlinked in there. A bucket with no planner
falls back to the list's `general` one, then to none. The tracked
`agents/plan-agent/example-bucket-agent.md` is the one to copy; the plan-agent
README says how.

## The implementing agent

`implement-agent` (`agents/implement-agent/`, [README](agents/implement-agent/README.md))
carries out a plan the owner has already agreed to.

- **There is one of it**, not one per bucket. Per-bucket knowledge lives in
  `data/<dataset>/buckets/<stream>/<stream>.md`, which the planners read too —
  written once. That folder is gitignored (real people, real processes);
  [agents/plan-agent/bucket-brief.template.md](agents/plan-agent/bucket-brief.template.md)
  is the tracked half.
- **It runs alone only on the plan types in `core/plan_types.py`**, through its
  own runner (`agents/implement-agent/hooks.py`), off until hours are set. Figma
  work, a task handed straight to it, and anything else only run from a session
  the owner is in, through the `do` skill, where it can stop and ask.
- **It does not write `todo.md`.** Where the work means the task itself should
  change, it asks for the change in its report, precisely enough to apply, and
  `pa` makes it.

Work reaches it through a sub-task assigned to it, open, with what it waits on
ticked — what the `do` skill finds.

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

The shared packages (`ai_chat_engine`, `agents-engine`, `work-streams`) are
pinned in `packages.lock`, one full commit each. CI tests against those
commits and a deploy checks them out on the server, so moving a package is a
PR that changes its line there.

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
