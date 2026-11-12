# Testing the board, in detail

Moved out of `CLAUDE.md` on 22 Sep 2026. `CLAUDE.md` keeps the rules that
matter every time (run through the script; lock the tab). This file has the
per-suite detail — what each one covers and why it's shaped the way it is — for
when you're touching the area it protects.

## Run them through `scripts/test-board.sh`

```
scripts/test-board.sh test_board.mjs timeline test_bucket_brief.py
scripts/test-board.sh --all          # every kanban/test_*.mjs
scripts/test-board.sh --no-build ... # skip npm run build when nothing in kanban/ui/ changed
```

Added 25 Sep 2026, after six agents in one night each hand-rolled a second
server and one's scratch `data/.current` leaked into another's lookup. The
script:

1. Builds `kanban/ui/` (`npm run build`) unless told `--no-build`.
2. Makes a temp folder holding `data/_test/todo.md` (a copy of
   `kanban/demo.md`) and `data/.current` naming it.
3. Starts `kanban/server.py` on a free port with `TODOS_DATA_ROOT` (the temp
   `data/`), `TODOS_PORT` and `TODOS_NO_BROWSER=1`, and waits until
   `/datasets.json` answers `_test` and nothing else.
4. Runs each suite with `BOARD_PORT` at that server, `CDP_PORT` (headless
   Chrome's debugging port) free, and `CHROME_PROFILE` inside the temp folder.
   The dataset is reseeded before every suite.
5. Prints one line per suite, and the `FAIL` lines (or the log's tail) of the
   ones that failed.
6. Kills the server and any Chrome it started and deletes the temp folder on
   exit, Ctrl-C and failure included.

It refuses to start if the data root resolves inside the repo's own `data/`.
With the three `TODOS_*` variables unset, `server.py` behaves exactly as it
always has. `agents/plan-agent/paths.py` and `core/tick_queue.py` read
`TODOS_DATA_ROOT` too, since the server calls into them, and Run the Plan agent
now refuses on a scratch root rather than start a real run.

A suite run on its own, without `BOARD_PORT`, still goes to 8765 and prints a
one-line hint saying so. Python suites named on the command line run exactly as
they would by hand: `kanban/test_bucket_brief.py` starts its own in-process
server over a temp folder and needs none of this, so `--all` leaves it out.

`test_chats.mjs` fails when run from a worktree under `.claude/worktrees/`, with
or without the script: `server.py` finds `ai_chat_engine` at
`ROOT/../PACKAGES/`, which does not exist from there. Run it from the main
checkout.

## The suites

A test that talks to the running `kanban/server.py` can save for real — the
board's autosave fires within seconds of anything that marks the document dirty
(dragging a card, ticking a box), with no confirmation. Two real overwrites of
the live work list have already happened this way, both recovered only
because a session backup happened to exist.

**`kanban/test_chats.mjs`** is the worked example of the default (lock the tab).
It drives the board in headless Chrome, locks the tab before loading `demo.md`,
and then tears every non-GET out of `fetch` so nothing can reach disk even if
something unlocks the tab later — that second guard isn't belt and braces for
its own sake: a past run recorded an attempted `PUT /data/todo.md` that it
stopped. Run it with `scripts/test-board.sh test_chats.mjs`.

**`kanban/test_one_board.mjs` and `kanban/test_subtasks.mjs`** are the ones that
unlock the tab, because handing a task over, approving and draining the agents'
queue all edit the document. Each installs a `fetch` that tears every non-GET out
before it does, records what was attempted, and ends by asserting nothing
reached `todo.md`; the queue tests stub `/tick-queue.json` rather than read a
file. `kanban/test_schedule.mjs` (the Spend and Schedules panels of the Agents tab) does the same.

**`kanban/test_focus_prompt.mjs`** unlocks the tab too, because a locked tab
shows no focus prompt. It holds cards, sub-tasks and drawer sections and talks
to the PA through the prompt, with no Claude behind it: a POST to `/claude`
answers with a stream the test writes into a line at a time, so Working and
Done can each be looked at while they last. `saveFile` is stubbed and every
other write is torn out of `fetch`. It tells the board a chat engine is there,
so unlike `test_chats.mjs` it passes from a worktree.

**`kanban/test_projects.mjs`** covers both halves of the Projects view — the tab
listing every folder under `data/projects/`, and the drawer that shows what's
inside one, describes it, and says when it was last touched. It stubs
`/projects.json` and `/project.json` rather than reading disk, so it needs no
project folder to exist, and its blocked list is asserted empty: a project is a
folder, the panel only ever reads it. It also covers the Project card in the
task drawer's second column, and holds the assertion that keeps that column
tidy — every section in it is a `details.field.sugg` drawn by `sideSection()`,
so a new one can't arrive with its own invented heading. It's defending the fact
that neither the description nor the date is a field anyone maintains: the
first is the H1 and lead paragraph of the folder's own `CLAUDE.md`, the second
is the newest mtime in the folder.

**`kanban/test_notes.mjs`** covers the drawer's Description field, which renders
Markdown at rest and swaps to a raw textarea when clicked. It's the one board
test that has to unlock the tab and type for real, since that's the thing under
test — the `fetch` guard does the whole job on its own there, and the blocked
list is asserted to hold nothing but the board's own `todo.md` save. It clicks
at real coordinates rather than calling the handler with made-up ones, because
the caret arithmetic starts from a hit test the browser does — which means it
has to wait out the drawer's slide-in transition first, or every hit test
misses.

**Orphaned headless Chrome:** a board test that throws before its
`chrome.kill()` leaves a headless Chrome holding the debugging port and the
page it had loaded. The next run finds the port taken, connects to that orphan,
and asserts against a stale copy of `index.html` — three real failures in code
that's actually fine. `scripts/test-board.sh` kills every Chrome it started
after each suite and hands each a free port, so this only bites a suite run by
hand. If one fails on text you can see is correct on disk, that's what
happened:

```
pkill -f "remote-debugging-port=94"
```

**`core/test_todo.mjs`** needs none of the above — it's the one to reach for
when what changed is the format rather than the view. It runs `core/todo.js` in
a `vm` context with no browser, no server and no `todo.md` in reach, so it's
fast and can't touch anything. Run it alongside `python3 core/test_todo.py`,
which reads the same fixtures.

## Every suite, in one place

```
python3 core/test_todo.py          # the fixtures, and the working calendars
node core/test_todo.mjs            # the same fixtures, the other language
python3 core/test_reports.py       # aggregate.py, render.py, archive.py — no JS counterpart
node kanban/ui/test_primitives.mjs # the React primitives against colHTML/cardShellHTML
python3 agents/plan-agent/test_planning_agent.py    # the schedule, the picker, the runner
python3 companion/test_companion.py   # notify.py and digest.py; the Electron app is retired
python3 core/test_notify_due.py    # desktop banners: the rules, the state file, the queue and its lock
python3 kanban/test_bucket_brief.py # the brief routes — no board, no browser
python3 kanban/test_board_access.py # signed-in mode and board access — starts its own servers
python3 kanban/test_chat_spend.py   # the shared board's daily chat ledger and its limits
python3 kanban/test_pa_check.py     # the second check on a PA reply's changes, with a fake model
python3 kanban/test_server_chat.py  # chats on the signed-in board, end to end, with a stand-in claude
python3 kanban/test_server_chat_live.py # the real CLI with the shared board's settings; skips without a key
# the ones below need the board: scripts/test-board.sh --all runs every one
node kanban/test_schedule.mjs
node kanban/test_board_link.mjs   # a banner's link naming its board
node kanban/test_one_board.mjs     # handing a task over, the two reviews, whose move it is
node kanban/test_signed_in.mjs     # signed in: the name, the Mac-only parts gone, sharing a list
node kanban/test_subtasks.mjs      # sub-tasks in the drawer, and the agents' tick queue
node kanban/test_board.mjs         # drag, drop, sort, add, Done as a heading, string card vs React one
node kanban/test_chats.mjs
node kanban/test_projects.mjs
node kanban/test_notes.mjs
node kanban/test_backups.mjs       # and the read-only preview it opens
node kanban/test_matrix.mjs        # and the dot's pinned preview
node kanban/test_phone.mjs         # the 640px breakpoint, from both sides
node kanban/test_overview.mjs      # capMsgCards() against real, painted layout
node kanban/test_timeline.mjs      # every Timeline drag, end to end: reorder, bar, handle, track, tray
node kanban/test_reports.mjs       # both halves, and the window picker over them
node kanban/test_recurring_roll.mjs # where a recurring card lands when its date turns over
node kanban/test_archiving.mjs     # the only thing that rewrites todo.md on a timer
node kanban/test_save_guard.mjs    # the preconditions on PUT /data/todo.md
node kanban/test_bucket_brief.mjs  # the Brief button, and the sheet behind it
```

**`test_phone.mjs`** runs twice — a 400px window and a 1400px one, both through
the same checks, so what's under test is the breakpoint rather than one side of
it. It covers three things a desk-width-only check misses: drag and drop
doesn't fire on touch (the drawer's Column field is the only way to move a card
there), a touch screen never hovers (so anything hover-revealed is invisible),
and six columns snapped one to a screen say nothing about which one you're
looking at.

**`test_save_guard.mjs`** is the odd one out: it needs the server but no
browser, because it checks the server's own contract. Every `PUT` it sends is
meant to be refused and carries the file's own current bytes as its body, so a
regression that lets one through rewrites `todo.md` with what it already said
rather than with a fixture. Never give one of those requests a body of its own.

**`test_merge_board.mjs`** saves for real, and so refuses to run anywhere but
the script's `_test` list. It plays the second person by saving `{text, base}`
over HTTP itself, then checks the tab: a merged save shows both changes, the
watcher brings one in without closing the open task, and the conflict box names
the task and field and saves whichever answer is clicked.
**`test_merge_save.py`** is the server's half, with no browser: it starts its own
server over a temp folder, as the Mac board and signed in, and holds do_PUT to
merging two saves, refusing the same field changed apart, and taking two saves
sent at once one at a time. The merge itself is pinned by
`core/fixtures/merge.json`, which both `core/test_todo.*` suites read.

**`test_authorship.py`** starts its own server the same way and holds the
server to who wrote and changed each task: the sign-in header decides the name,
`created-by:` or `edited-by:` sent by a tab is put back, every change reaches
`activity.jsonl`, and the Mac board writes no tag at all. It also queues
agent ticks with `core/tick_queue.py` and writes `todo.md` behind the server's
back, to hold the agent and `pa` attribution. **`test_save_inprocess.py`** runs
the server in its own thread for the two cases no route reaches from outside:
a first save to a list with no file, and the drain holding the save lock.
**`test_authorship.mjs`** is the on-screen half, locked: the names on cards and
in the task and sub-task panels, the status line, and the Mine chip.

**`test_server_chat.py`** starts its own servers signed in, with a fake `ANTHROPIC_API_KEY` and a stand-in `claude` first on `PATH` that logs how it was started and answers from files the test writes. It needs `ai_chat_engine` with `ask_allows`: set `BENCH_PACKAGES` to a PACKAGES folder that has it. **`test_server_chat_live.py`** runs the real CLI with the same settings and costs a few cents, so it skips without a key; run it on the server after `scripts/setup-server-chat.sh`.

**`test_board_people.py`** holds `/board-people.json` to a board's own people
(owner, shared-with, signed-in team members), refuses an outsider and the Mac
board, and checks a request in a person's name is never credited as an agent's.
**`test_assign_people.mjs`** is the on-screen half, locked: Delegate to on a
shared board and on the Mac, the round faces with initials, an email never read
as an agent, Mine on the stored email, and a Mac list round-tripping unchanged.

The watcher polls with `HEAD` every three seconds, so a suite that tears every
non-`GET` out of `fetch` sees one within a few seconds. It is a read: answer it
from the stub and leave it out of what counts as a write.

Never write into a real list under `data/` from a test, not even a
small, temporary one — that's real content, private and irreplaceable in a way
`data/_test/` deliberately isn't.
