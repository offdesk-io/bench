# Bench

A personal task system made of two halves: a Kanban board that reads and writes a
single markdown file, and a skill that runs a review session over that same file.

## Getting started

You need macOS or Linux, Python 3, and Node 20 or newer.

1. Clone the repo, run `npm install` in it (that fetches the Tenon design system the board is drawn with), then run `scripts/install.sh`. It is safe to run again, and `--dry-run` prints what it would do and changes nothing. The steps below are what it does, if you would rather do them by hand.
2. It works out where the checkout is. The skills expect it at `~/Code/bench`. If you keep it somewhere else, the script prints an `export BENCH_ROOT=/path/to/bench` line to add to your shell profile (it never edits the profile), and every skill and command follows it.
3. It links the skills into `~/.claude/skills/`. Claude Code only sees a skill once it is linked there, and one loop links the whole set, `do` included:
   ```
   mkdir -p ~/.claude/skills
   for s in "${BENCH_ROOT:-$HOME/Code/bench}"/agents/pa_agent/skills/* "${BENCH_ROOT:-$HOME/Code/bench}"/agents/implement-agent/skills/do; do ln -sfn "$s" ~/.claude/skills/; done
   ```
   A real folder already sitting under one of those names is left alone and reported. It also links `pa-agent.md` into `~/.claude/agents/`, and `implement-agent.md` into the checkout's own `.claude/agents/`.
4. It installs `chevron`, the Python library the PA renders its briefs with (see `core/render.py`), unless it is already there: `pip3 install --user chevron`.
5. It creates `data/`, which git ignores, and copies `core/settings.example.json` to `data/settings.json` and `agents/pa_agent/profile.example.md` to `data/profile.md`, only when they are missing. The board reads your first name from the profile (it names who the review steps of a handover are assigned to) and falls back to "Me" without one.
6. It offers the hourly wake that starts the scheduled agents, when `../PACKAGES/agents-engine` is next to the checkout and has the `wake install` command. The default is no. `--yes` accepts and `--no-wake` skips the question. The wake is installed with this checkout as its root, so it wakes the agents inside it and no others. The board's Agents tab is scoped the same way, to `agents/`.
7. Start the board with `./run.command` (it builds the front end, then starts `kanban/server.py` on port 8765). `python3 kanban/server.py` on its own starts the server without building. The first time it opens, a welcome asks for your name and country, then for your first list and its buckets. It cannot be skipped. To see it without touching your own data, run `scripts/try-onboarding.sh`: it starts the board on port 8799 over an empty throwaway folder and opens it in Brave.

A list is a folder under `data/` holding a `todo.md`. To make the first one by hand: `mkdir -p data/work`, `cp kanban/demo.md data/work/todo.md` (or write your own, see CONVENTIONS.md), and `printf work > data/.current` to say which list is live.

The board's Settings screen changes your name, country, models and when each agent starts later, so nothing in `data/settings.json` or `data/profile.md` needs editing by hand.

Models live in one optional file, `data/settings.json`, which git ignores. Copy `core/settings.example.json` to start it. `models` picks `opus`, `sonnet` or `haiku` per job (`plan`, `implement`, `chat`, `brief`) with `default` for the rest. Without the file, or with a null, every job runs on the model it used before. `BENCH_MODEL_<JOB>` in the environment wins over the file, and a list's own `claude.json` still wins for its chat. `agents.plan.start` and `agents.implement.start` are `scheduled` (wait for the agent's hours, the default) or `now` (the board starts a run as soon as a task is handed over, or a plan approved, and saved). The board reads and writes it at `/settings.json`.

The same file can name a memory folder, `memory_root`, for when the facts about you are kept outside Bench so agents elsewhere can share them. The profile and each list's people, company text and Context are facts about you rather than board state, so with it set Bench reads `<memory_root>/me/profile.md` and `<memory_root>/bench/<list>/people.md`, `about.md` and `context.md` first and falls back to `data/` for any that are not there. Boards, queues, locks, history and runs stay in `data/`. Bench also keeps `<memory_root>/boards.md`, one line per list with the current one marked, rewritten when a list is made, when the current list changes and each time the board starts, so an agent outside Bench can see which boards exist without reading `data/`. Bench knows nothing about what a list is for or whether it is frozen, so whatever follows a list's folder on its line, and any mark besides `current`, is carried over from the file as it was. Unset, nothing changes. It is under Settings on the board.

Each list can also name its own projects folder, under `projects_roots`, a map from list name to folder, for keeping that list's project folders outside Bench. For a list in it, a task's `data/projects/<name>` note is looked for in that folder first and at `data/<list>/projects/<name>/` after, the board starts new projects there, and the board's chats may write there. The Projects view of a list shows its own folder and its `data/` one, never another list's, which is why two lists cannot name the same folder. A list with none keeps `data/<list>/projects/`, and with the key unset nothing changes. It is under Settings, for the list that is open.

Three sibling folders are optional. Each is looked up as `../PACKAGES/<name>` next to this repo, and without it the board still starts:

| Folder | Without it |
| --- | --- |
| `../PACKAGES/ai_chat_engine` | no chat window, and the Claude buttons on a task are hidden |
| `../PACKAGES/work-streams` | no work-stream queues (`/streams.json` answers 404) |
| `../PACKAGES/agents-engine` | the Agents tab of the Settings page shows a stub saying it has nothing to show |

The agents (`agents/plan-agent`, `agents/implement-agent`) need the `claude` command line tool and do nothing until a list is switched on in the Agents tab of the Settings page. The tests are in `docs/TESTING.md`: run them with `scripts/test-board.sh --all`.

**Claude Code is optional.** Without it, the board works in full: lists, buckets, columns, editing, backups, reports, the archive and Settings. What needs it: the chat window and the PA, the Plan and Implement agents, and bucket briefs. With no `claude` on the path, the board hides all of those. The Agents tab says what to install, and the run buttons refuse rather than start something that cannot run. Install Claude Code and log in, then reload the board to turn them on.

## Deploying to the agency server

The agency server runs its own copy of Bench in `/opt/agency/bench`, with the three libraries beside it in `/opt/agency/PACKAGES`. All four are git checkouts of the public GitHub repos, so a change reaches the server by being pushed to GitHub first and then deployed by hand from the Mac with one script. It stays manual on purpose until it has proved itself, and it never touches the server's `data/`, which holds that server's own lists.

```
scripts/deploy-server.sh main                                     # dry run
scripts/deploy-server.sh main --packages agents-engine=main --apply
```

Without `--apply` it only reads: it prints each repo's current commit on the server and the commit the ref points to on GitHub. With `--apply` it records the current commits, fetches, checks out the refs, runs `npm ci` (which installs exactly `package-lock.json` and rewrites nothing) and `npm run build` for the board's front end, restarts `bench.service` and waits up to 20 seconds for the board to answer on `127.0.0.1:8765` (200, or 302 and 401 once sign-in is on, since an unsigned request gets 401). If it does not, the recorded commits go back and the service restarts again. A ref is a branch, tag or commit, and a short commit id only resolves once fetched. Refs may only use letters, digits and `. _ / -`, and the script refuses anything else before it connects. Afterwards each checkout on the server sits on a detached HEAD at the commit the script prints, not on a branch, which is expected. It stops if a checkout on the server has uncommitted changes to tracked files. `DEPLOY_HOST` changes the server.

## What it is for

The point of all of it is delegation. The loop is plan, accept, execute, and it
should complete without my attention being the thing it waits on. When that works
I keep my output up while doing less of it myself, because the context an agent
needs to decide well is already written down in here: the bucket briefs, the
people file, the project folders.

It also says how to judge any part of this. The loop only moves as fast as its
slowest gate, and today that gate is reading. A night that writes twenty plans of
five hundred words each costs more to read than the plans save, so most are never
opened and nothing after that step gets a chance. Work that makes a plan easier to
act on comes before work that makes the board nicer to look at.

## Where the list lives

Everything private sits in one folder, `data/`, ignored by git. Inside it, one subfolder per data set — one list, kept completely apart from any other:

```
data/.current              which one below is live right now
data/profile.md            the PA's profile of its owner, see below
data/work/todo.md          the list
data/work/backups/         the board's snapshots, and done-archive.md
data/work/sessions.json    which Claude chats belong to which task
data/work/claude.json      that data set's own Claude config
data/work/jira.json        that data set's own Jira boards
data/work/meeting-declines.md    meeting actions pa-retrieve-tasks showed and the owner
                                  turned down, kept so one can be found again
data/work/projects/        that data set's own project folders, see below
data/personal/todo.md      a second, unrelated list, shaped the same way
```

`data/profile.md` sits at the root of that folder and holds the owner's setup for the PA: their name and how to address them, where this repo is, their writing habits, their meeting recorder and how they work. The PA asks for it on first run and writes it from the tracked template at `agents/pa_agent/profile.example.md`. Facts about who the owner is live in their own facts file, which the profile links to.

`buckets/` sits inside each data set, gitignored with the rest of it. One folder
per bucket of the board, holding the brief that says what work I actually do in
it, and that bucket's own skills:

```
data/work/buckets/people/people.md              the brief
data/work/buckets/people/work-people-agent.md   the bucket's planner
data/work/buckets/people/skills/                the skills that bucket's work runs on
data/work/buckets/README.md                     which buckets that list has
```

Per data set rather than one shared set at the root, because a brief is only true
of one list: `work` and `personal` have different buckets, different processes
and different people.

The planning agent's planners and `implement-agent` both read the brief, and so do I.
A brief exists because a planner knows its bucket only in general terms: which
process a task belongs to, what that process produces, which skill already does
it and who is involved are things only the brief says. It lives at
`data/<dataset>/buckets/<stream>/<stream>.md`, where the stream is the bucket
heading with its number stripped, lowercased and hyphenated (`## 3. DS` is
`ds`), fixed in the list's `buckets/README.md` when the bucket is created so a
rename does not move it. A new brief starts from
`agents/plan-agent/bucket-brief.template.md`, which carries a
`<!-- NOT FILLED IN YET -->` line; while that line is there `bucket_brief()`
treats the file as absent and no agent is pointed at it, so delete it once the
brief is written. The template is the tracked half, so a fresh clone can rebuild
the shape without carrying any of the content.

Nothing else in the repo holds a task, a name or a date. One folder is the only
ignore rule, so a new derived file cannot slip through the way it can with a rule
per file.

To check a list's format and dates, run
`python3 agents/pa_agent/skills/pa/scripts/check_todo.py data/<list>/todo.md`.
The docstring at the top of that script lists what it checks.

A folder counts as a data set purely by having a `todo.md` in it — there is no
registry to fall out of step with what is really on disk. `data/.current` names
which one the board and `server.py` are pointed at; everything the page fetches
— `/data/todo.md`, `/data/backups/…`, `/data/jira.json` — is the same URL
regardless of which data set that is, rewritten on the server to the real file
underneath. The board never learns a data set's name except to draw the
dropdown and to ask for a different one.

### Switching, and starting a new one

The dropdown at the top right of the board, next to the Data buttons, lists
every folder under `data/` that qualifies. Picking one asks the server to make
it current, then reloads the page — a switch changes the list, its backups, its
Claude sessions and its Jira boards all at once, and a reload is the only way to
be sure nothing from the one just left survives into the one opening. Unsaved
changes on the list you are leaving block the switch, same as they block a
backup preview.

**+ New list…**, at the bottom of the dropdown, prompts for a name, slugifies
it into a folder name, and creates it with nothing in it but one empty bucket —
the least a file needs for the board to draw it at all. Everything else — a
Claude config, a Jira board, a first project folder — appears the same way it
would for any other list: the first time something is saved into it.

### Projects

Some work carries more context than a task line can hold: a plan, a ticket history, source
documents, a decision and the reason behind it. That goes in `data/projects/<name>/` (in
the list's projects folder when set, see Settings above), one folder per project, with a
`CLAUDE.md` inside holding the background and the sources next to it. The task in
`todo.md` stays short and points at the folder.

`data/` rather than the repo root, for the same reason everything else private sits there:
a project folder holds real names and real dates, and a folder cannot be forgotten by the
ignore rules the way a new file can.

The pointer is an ordinary note on the task, written as `Project:` and then the path in a
code span:

```
- [ ] **ATLAS2027: redefine the initiative and deliver it** [impact:: high] [effort:: L]
  - Project: `data/projects/ATLAS2027`. Background in its `CLAUDE.md`, the raw material for
    the rescope in `redefinition-brief.md`, the roadmap deck and the 1:1 in `sources/`.
```

There is no `project:` tag. The note was already how the file said this before the board
knew projects existed, and a tag carrying the same fact would only give the two a chance to
disagree. The board reads the folder name out of that note and shows it as a chip on the
card; clicking the chip opens the side panel on the project instead of a task, listing every
task pointing at the same folder with the bucket and column each one sits in. That is the
only place a project is visible as a whole, because its tasks are deliberately spread across
the buckets — the presentation is Design System work, the deck review that feeds it is People
work, and the columns are right to keep them apart. Which also means a task without the note
is missing from it.

A project can also live in a folder of your own, anywhere on disk. The note then carries
its absolute path, `- Project: /home/me/Work/client-a`, and the server answers for it only
once that folder sits inside one approved in `data/<dataset>/project-folders.json`. The
drawer's Project section writes that file (after asking), starts a new folder under the
list's projects folder when set, otherwise under `data/projects/`, with a `CLAUDE.md` in
it, and opens a folder in Finder. `core/project_folders.py` holds the one check every
route and the planning agent use: real paths compared with `os.path.commonpath`, so a
symlink or a `..` cannot lead out of an approved folder.

The board reads the pointer and nothing else. It never opens the folder, so what is in there
can be in any shape the work needs.

### On a shared server

The same board can run on a server for more than one person, behind nginx and the Offdesk
sign-in. `BENCH_AUTH=header` in the server's environment turns that on. Unset, nothing in
this section applies and the board on your Mac behaves as it always has.

nginx asks the sign-in service who each visitor is and passes the answer on in three
headers: `X-Offdesk-Email`, `X-Offdesk-Name` (percent-encoded UTF-8) and `X-Offdesk-Teams`
(a comma list of team ids). Bench can trust them because it only ever listens on
127.0.0.1, so nothing but nginx on the same machine reaches it, and it refuses to start
signed-in mode on any other address. A request with no email gets a 401 before any route
runs. Any value of `BENCH_AUTH` other than `header` stops the server at start-up, so a typo
cannot leave a public board open. `/whoami` returns the three, and the header shows the name
with a Sign out button, which posts to nginx's own `/auth/logout`.

What only works on the owner's Mac is refused, and its buttons are hidden: revealing a
folder in Finder or approving one on disk, the Agents tab and its launchd schedules, Spend
and schedules, starting the Plan agent, and the Claude chat, which would run on the server
owner's own Claude login. The settings and the profile belong to the server, so a visitor
can read them and not change them. Every POST must carry `X-Board: 1`, because on a public
address a form on another site could otherwise post with the visitor's cookie. "Me" on the
board, the person review sub-tasks go to, is whoever is signed in.

Each board says who may see it in `data/<board>/access.json`: an owner, and the people (by
email) and teams who share it. A board is personal or shared from the moment it is made.
The New list wizard asks as its last step, and the owner changes it later from Settings,
which on the shared board is the list's sharing and nothing else. A team can only be added
by someone in it. The server writes the file, so nothing else should. A board without one,
or with one that does not parse, is seen by nobody once sign-in is on, because a board
should be opened up on purpose and never by default. For a board that existed before,
`scripts/set-board-access.py <board> --owner <email> --team <id>` sets it once. Team
membership comes only from the header, which keeps the sign-in service's `teams.json` the
one list of who is in which team.

Every route reaches a board through `list_datasets()` and `current_dataset()`, and both
answer for the person asking, so a board outside someone's access drops out of every route
at once. It is missing from the Lists menu, naming it is a 404, and nothing under `data/`
is served except through `/data/` on their own board. Someone who can see no board gets a
404 from every board route rather than a shared empty folder. Which board is on screen is
kept per person in `data/users/`, one file each named from a hash of the address, so one
person switching does not switch anyone else. `data/.current` stays the Mac's pointer, and
on the server it only decides which board the weekly backup and `boards.md` treat as
current. Access is off on the Mac: every board shows, `access.json` or not.

The server builds every file path itself from the address decoded once, and refuses any
part that is empty, starts with a dot or still holds `%`, a backslash or a NUL, so neither
a double-encoded `..` nor `.git` gets through, on the Mac included. The result must stay
inside the board's own folder, or the repo for anything else, once symlinks are followed.
Signed in, only what the page loads is served from outside `/data/`: `kanban/index.html`,
`kanban/board.css`, `kanban/js/`, `kanban/dist/`, the example list, `core/todo.js` and
`core/avatar.js`. Folders are never listed, and the routes answer with names rather than
paths on the server.

## The board

`kanban/index.html` is one page, still. No build step, no dependencies, and
nothing to install. It parses `data/todo.md` into buckets, states and tags,
renders them as columns, and writes the file back when you save. That path never
changes — it always means whichever data set is current, see above.

Two things sit beside it rather than inside it:

- `kanban/board.css` — the stylesheet, 1,700 lines of it. It was inline for no
  reason other than that the page started small, and nothing generates or
  rewrites it, so it lifted out whole. The board still writes a handful of
  custom properties from JavaScript — `--header-h`, `--cols`, `--step-color` and
  two more — which is the only coupling left in either direction.

  Its token block is Tenon, the design system in `PACKAGES/tenon`, installed as a git
  dependency pinned to a tag. The vite build copies its CSS out of
  `node_modules` into `kanban/dist/` beside `board-ui.js`, and the page links it
  from there ahead of `board.css`.

  The card, the column, the count badge and the stat box come from Tenon too.
  The two builders, `colHTML()` and `cardShellHTML()`, emit `.tenon-card` and
  `.tenon-column`, and `kanban/ui/test_primitives.mjs` still renders every
  case both ways and fails on any difference, which is the only thing keeping
  the string half and the React half drawing the same card. What it pins now,
  on top of the markup, is the translation: `cls` is `className`, `stripe` is
  `accent`, `position` is `lead`, `note` is `footer`, `body` is `children`. Every rule here reads a `--tenon-` name, so a
  colour decision is made in one place for this board, `ai_canvas` and the
  personal site at once. The reason for moving it rather than leaving it: the
  hand-written block had `--accent` missing from its dark theme for months and
  nothing could tell, where Tenon's build refuses to write a file whose two
  themes hold different key sets.
- `core/todo.js` — the file format: parsing, serialising, sub-steps, suggested
  messages and the `repeat:` maths. It went to `core/` rather than staying in
  `kanban/` because it is the half that `core/todo.py` is a port *of*, and the
  two belong where they can be read side by side. See `core/README.md`.

Everything else is still the one inline `<script>`, and there is no plan to
split it further beyond what is written in IMPROVEMENTS.md.

`kanban/server.py` is a small local server so the page can read and write the
file — a browser will not let a page opened straight off the disk do that. It
listens on `127.0.0.1` only and refuses to write anything except `data/todo.md`,
translated on the way in to the current data set's own file.

Start it by double-clicking `run.command`.

There is also a Dock launcher, **Bench.app**, which does nothing but hand
off to `run.command` — the board still opens in a Terminal window, because that
window is where Ctrl-C lives. The bundle itself is gitignored: it is three small
files and an icon rebuilt from `kanban/icon.svg`, so keeping the recipe is worth
more than keeping the build.

### Example data

When there is no server to read a list from, the board falls back to
`kanban/demo.md`, an invented list committed to the repo, with the messages and
prompts written out so Quick wins and the other Overview columns have something in them.
The page is a front end for `server.py`: it fetches `data/todo.md` on load, saves
with a `PUT` back to the same path, and asks the server for `/backups.json` and
`/archive`. `data/` is gitignored, so a static copy has no list to read, and the
real file is never put where a static copy can reach it.

The demo loads through the same lock the Backup Preview uses, so example tasks
inherit the guarantee that nothing reaches disk as the live list. The bar across
the top says Example data, and the button under it retries the real file, which
is what you want when you opened the tab a moment before starting `run.command`.

### Stopping it

Ctrl-C in that window, which is what the window tells you. If the window has been
closed without stopping it first, the helper carries on with nothing attached to
it — and because it still holds the port, launching `run.command` again only
opens a tab against that stale copy, which is how a board ends up missing features
that are sitting right there in the file. Stop it by port:

```bash
lsof -ti tcp:8765 | xargs kill
```

By port rather than by name, because the process name depends on which folder it
was started from. The startup output prints this command, so it is in the
scrollback when it is needed.

### Saving, backups and outside edits

Four things keep the file safe without anyone having to remember to press a
button. All of them work off one fact: the file's timestamp the last time the open
tab agreed with what was on disk.

**Auto-save** runs every five minutes, and only when something has actually
changed — an idle tab never touches the file. It holds off while a field is being
typed into, and a failed auto-save reports in the status line rather than throwing
a dialog. There is a toggle in the header; the setting sticks. Manual saving is
unchanged.

**Backups** come in two kinds, listed on the **Backups** tab in the header. A
*session* backup is taken before the first save of each
run, and the last fifty are kept. A *weekly* snapshot is taken the first time the
board notices a new ISO week — on startup, on a save, or on its own half-hourly
check while it sits running — and the last twelve are kept. The two are pruned
separately, so a busy fortnight of saves can never delete the only copy of how the
list looked last month.

**Auto-reload** picks up edits made outside the board: somebody else on a shared
list, Claude working through it, or the file opened in an editor. The board checks
every three seconds while its tab is on screen and every fifteen while it is
hidden. With nothing unsaved in the tab, reloading costs nothing, so it happens
quietly and says so in the status line, and the task open in the panel stays
open. It waits while a field is being typed in, so a reload never takes the field
away mid-word.

**Merging on save** is what happens when the file moved and there is unsaved work
in the tab too. Each save carries the version it was built on, and the server
merges the two task by task (`merge_saves()` in `core/todo.py`, the port of
`mergeSaves()` in `core/todo.js`): a field only one side changed takes that
change, a task one side added lands after the task it followed, and the file's
order is kept. Sub-tasks merge the same way inside their task. The merged list
is written and the tab redraws from it. It is built this way because on a list
two people share, the old question (which whole version wins?) came up every few
minutes about edits that never touched each other, and either answer threw one
person's work away.

**The conflict box** is the one time the board interrupts. It appears only when
both sides changed the same field of the same task, or one deleted a task the
other edited, and it names each task and field. Keep mine or Use theirs settles
all of them, and Download my copy first is there before either. Nothing is
written until that choice is made, and no answer can lose a task nobody chose to
delete.

### Archiving finished work

A task ticked off more than 30 days ago is history rather than a list, so the
header offers to move it out: **Archive N finished**. It goes to
`data/backups/done-archive.md`, which is append-only, never pruned, and written
to by nothing else — so this is a move, not a delete, and the record outlives the
backups that would otherwise be the only copy. Sub-steps and notes travel with the
task. A fresh backup of the whole list is taken first, and the archive file is
written *before* anything leaves `data/todo.md`, so a failure loses nothing.

It is never automatic. The list shrinking on its own while the tab is open is
indistinguishable from the board losing work.

This needs a completion date, which the file did not record: `done:YYYY-MM-DD` is
written when a task is ticked. Tasks that were already ticked before this existed
are stamped with the day they are first seen, because there is no way to recover
when they were actually finished — so nothing is ever archived before it has sat
for a full 30 days under a date the board can vouch for.

### Renaming and reordering the buckets

A bucket is a `## N. Name` line in `data/todo.md` and nothing else. There is no
id, and no record anywhere of which tasks belong to it beyond the fact that they
sit underneath it — so the pencil beside the tabs, which opens all of them in one
sheet, is a small feature rather than a migration. Renaming one rewrites that single heading and
leaves every task under it alone. Moving one up or down rewrites the numbers on
the headings it passed, because the number in the heading is the position. The
colour follows the position too, which is why a bucket that moves changes colour,
along with the ones it moved past. There are six colours; a seventh bucket starts
them again.

Deleting is the part that needed a rule. A bucket with nothing in it simply goes.
A bucket with tasks in it can only go once they have somewhere to land, so the
sheet asks which bucket they move to and says how many are moving; each task keeps
its column, its text and its tags. That is the move the drawer's Bucket field
already makes on one task, done for all of them at once. Deleting the last bucket
is not offered, because the board cannot draw a list with no headings in it and
refuses to read one.

It sits beside the tabs rather than in the Data menu because that strip is where
the buckets already are, and it is an icon rather than a labelled button because
renaming a bucket is a once-a-quarter job. It hides in a backup preview and on the
demo list along with everything else that writes, and nothing reaches the file
until you save.

### Renaming and reordering the columns

A pencil in each column's own head opens one sheet for all of the columns —
Backlog through Doing to Done — a task moves through inside a bucket. The
column set is settled and shared by every bucket, so the control sits in each
column rather than in the filter bar, because that is where the question is asked. The
sheet behind it is still the whole list — is this the right name next to the
others, is this the right order, neither of which a per-column menu could show —
and the pencil only puts the caret in the row you clicked.

A column is a `### Name` heading, and like a bucket it has no id: it is whichever
name a heading uses, read the same everywhere that name turns up.

Five of them are read that way outside the board too. Backlog, To do, Doing,
Reviewing and Done are matched by their exact text by the planning agent, `core/todo.py` and the board's own recurring-task roll, so
renaming one for real would leave a second, empty column of the old name behind.
Typing a new name over one of those five sets a **label** instead: the heading in
`todo.md` stays exactly as it was, the board draws the word you typed, and the
row in the sheet shows the real heading in grey beside it so the two are never
confused. Labels live in `data/<dataset>/column-names.json`, for the same reason
`bucket-colors.json` is its own file — what a column is called on screen is a
preference about looking at the list, not a fact the list carries, and `todo.md`
has exactly one writer. Typing the real heading back clears the label. Nothing
outside the board reads that file, so a renamed column is still "To do" to the
planning agent and in every plan; that is the price of the rename costing nothing.

Not every bucket carries every heading, but the
board draws all of them on every bucket's view regardless, empty wherever that
bucket has no tasks in one. A rename, a reorder, an add or a delete here
reaches every bucket the same way, seeding an empty heading into whichever ones
did not already have it. That looks like more of a file change than it is:
nothing about what is drawn moves, since the empty column was already showing
there before the edit, and the alternative was worse — the column order is
read off the file by scanning bucket by bucket and remembering each name the
first time it appears, so a column confined to one bucket cannot be reordered
relative to the others without every bucket agreeing it exists, or nothing
about its new position inside that one bucket would be visible to the scan at
all.

Deleting works like deleting a bucket: empty, it just goes; holding tasks
anywhere, the sheet asks which column they move to first. The last remaining
column cannot be deleted, for the same reason as the last bucket — the board
cannot draw one with nothing to sort into.

A brand new data set starts with the same five columns as every other one —
Done, Reviewing, Doing, To do, Backlog — precisely so a second list's board
reads the same as the first from the moment it exists, rather than falling
back to a generic default nobody chose. An older list need not have them: the
`personal` list was made before that and carries Doing, To do, For later and
Blocked, which is fine — only the five names above are matched by their text,
and a list is free not to have one. Done is fixed at the far right and is not one
of the rows in the sheet.

### How the board prioritises

Two tiers, at two different moments.

**Impact against effort, at intake.** Every task carries `[impact:: high|med|low]`
and `[effort:: S|M|L]`. Any column can be sorted on impact divided by effort, so a
med/S beats a high/L — high impact for the lighter lift comes first. A task
missing either score shows a *needs scoring* marker and is counted in the header,
because a blank score reads as low and the task sinks without anyone deciding it
should. Sorting never rewrites the file: your own order is still the file order.

The **Matrix** view draws the same two scores as a 3×3 grid, impact down the side
and effort across the top, so the shape of the whole list is visible at once —
how much sits in the expensive corner, whether the cheap high-impact cell is
actually empty. A task is one dot rather than a card, because nine cells on one
screen leaves a thumbnail each; the title is on hover and a click opens the real
task. Anything missing a score sits in a tray under the grid instead of being
dropped, since a dropped task is one that never gets scored.

**The one thing.** A single task carries `headline:<date it was set>` and appears
in a bar above the columns, with a count of how many other tasks it frees. It is
the task that makes the others easier or unnecessary, which is a different
question from which one scores highest. It stays chosen until it is solved. Its
dot on the matrix is ringed, so you can see where your one thing actually sits.

Setting it is a button in the top corner of the task panel, beside Close. It used
to be a field partway down the panel, among impact, effort and the dates, which
put a decision about the whole list in the same run as the task's own scores and
meant scrolling to reach it. The explanation it carried underneath moved to the
button's tooltip: it is worth reading once, not on every task.

### Views

Everything else is worked out from tags at render time, never stored twice:

| View | Built from |
| --- | --- |
| Matrix | `[impact:: ]` against `[effort:: ]`, as a 3×3 grid. One dot per open task, coloured by bucket. |
| This week | `week` |
| Quick wins | `[effort:: S]` grouped by who does it (`[to:: ]`), plus any step with a written message, plus every recurring meeting with an agenda written on it. Anything waiting on an unfinished blocker, or whose `start:` has not arrived, is left out. |
| Big rocks | `[impact:: high]` and `[effort:: L]` |
| Dependency chain | `blocked-by:`, resolved against `#slug` |

These used to be sections written into the file by hand, which meant they drifted
from the tasks they described. Deriving them removed that whole class of bug.

### Reports

Every other column answers what to do next. **Tasks finished** and **Written
reports** answer what got done, which is what a one-to-one or an end-of-quarter
write-up actually asks for and which nothing here could tell you without
counting ticks by hand.

They have a page of their own, the Reports tab right after Overview, with
Tasks finished at twice a reference column's width and Written reports beside
it. Overview holds three columns, Big rocks, This week and Quick wins, so it
reads as the list of what to pick up. Both report columns fold like the ones on
Overview, and an old `#reports` link opens the tab.

The first report is **Counted from the list**, broken down by bucket. It leads
with the total, set large enough to read from across the desk, because that
number is the answer to the question and the buckets underneath only say where it
came from. The line under it names the period as well, so a screenshot of that
block is not ambiguous about what it is counting.

The **Show** picker sets the window: this week, 7, 15, 30, 60 or 90 days, or
**All**, which does not filter at all and counts everything the list and the
archive between them still remember. The narrower windows answer "how am I doing
lately" at different grains; All answers "how much is there", which is a
different question and a slower one, since it always reads the archive.

It counts the `done:` date the board writes when a task is ticked, so it only
sees work finished since that date started being recorded; anything ticked before
then is invisible to it, and the report says so underneath rather than quietly
under-reporting. Each bucket gets its count, its share of the total and a bar
scaled to the busiest bucket, so a quiet month still reads as a shape instead of
four slivers. Buckets with nothing in them stay on the list, because an empty
bucket is a finding.

Thirty days is the default for a reason. Finished work older than that can be
archived out of `todo.md` into `done-archive.md`, so at thirty days and under the
file is the whole story by construction. Every longer window, All included, reads
`done-archive.md` as well and merges it in — and says in a note underneath
whether that read succeeded, so a count that might be short about its older end
tells you rather than looking complete. Opening a bucket shows the tasks behind
the number, each one clickable into the drawer like anywhere else, except
archived ones, which have no live card left to open. Reading a backup preview
reports on that backup rather than the live file, and nothing on this tab writes
anything.

The second report, **Recent accomplishments**, is that same list read the other
way round. Grouped by bucket, every list sits behind its own closed toggle, so
reading what actually got done means opening each non-empty bucket in turn —
and the thing a status update or a one-to-one wants is the list itself, in the
order the work happened. So this one is flat and already open: every finished
task in the window, newest first, with the bucket as a chip on the row rather
than as the heading above it. It has one toggle of its own, around the whole
list, because a month of finished work will push the report below it off the
screen — but it starts open, since a list you have to open first is the thing
this report exists not to be. Same tasks, same window, same archive; nothing is
counted twice and nothing extra is fetched.

The third report, **Weekly pace**, answers the question a single count cannot:
whether that number is more or less than usual. Eight trailing complete weeks,
Monday to Sunday, one line per bucket. It leads with its own total the same way,
and with the per-week average beside it, since "23 over 8 weeks" needs arithmetic
before it means anything and "2.9 a week" does not.

Its window is fixed at those eight weeks and deliberately not wired to the Show
picker — the point of a trend is a constant run to compare against, and letting
the picker resize it would make both reports harder to read. That does mean the
two totals on the tab are usually different numbers, which is why each one names
its own period next to it. The key under the chart switches a bucket off, and
every number on that report follows it: the total, the average, the per-week
figures and the pace sentence, with a note saying so. A headline number still
counting a line you have just hidden would contradict the chart directly above
it.

A fourth report means one more `build*()` function in `kanban/js/12-reports.js`
returning the data it draws from, and one more component in
`kanban/ui/ReportsBlocks.tsx` to draw it — listed in `TasksFinishedColumn`'s
body, where the three today are. The column is built to hold more than one.

The column beside it, **Written reports**, holds the other kind. Counting can only
ever say how many. Saying what moved and what it means is a judgement, so those
have to be written, and they are written by asking Claude for one. They live as
Markdown files in the current dataset's own `reports/` folder, listed by the
server at `/reports.json` and opened in place. Files rather than
sections inside `todo.md`, because a report is finished the day it is written and
the list is not, so keeping them together would mean editing history every time a
task changes. In `data/` rather than anywhere else, because a report about this
list names people, dates and internal decisions, which is the same reason
`todo.md` never leaves that folder.

Each file opens with frontmatter carrying `title`, `date`, `covers`, `topic` and a
one-line `summary`. The list reads only that, so the tab can show a contents page
without fetching every report. The body is pulled in when one is opened.

#### Rules for writing a report

These are the rules Claude follows when asked to generate one. They are here
rather than in a skill so that they are read alongside everything else about the
board.

**Never list individual to-dos.** A report is not a filtered copy of the list. If
the reader wants the tasks, the board is right there. A report that enumerates
what was ticked has done no work.

**Outcomes, not activity.** Say what actually changed for the team or the system,
and what is now possible that was not possible before. The tasks are the evidence
behind that, not the subject of it. "Four of six components documented" and "the
Loom script is written, the recording isn't" are still activity, just described at
a higher altitude than a checklist. "Docs now cover four of the six most-used
components, so contributors stop asking in Slack for the fifth" is the same fact
read for what it changed. Where something has not moved, say so plainly and say
what it is waiting on. A report that only carries wins is not a report.

**Prose by default, bullets when being specific earns it.** When a report needs to
name particular things, components, numbers, decisions, open questions, a short
bullet list is clearer than a sentence carrying six commas. Everywhere else, write
in prose.

**The owner's voice, and keep it short.** The owner's writing-voice skill is the
reference: contractions, British English, short sentences and short paragraphs, no
em dashes, concrete numbers rather than vague claims. Simple and short beats
thorough. A report nobody finishes reading is worth nothing.

**Under 400 words unless there is a reason to go longer.** Three or four sections
is usually the shape: what moved, what has not, and what the pattern across the
two is. If a section needs a paragraph to say one thing, it needs one sentence.

### Plans

There is no Plans tab. Each plan sits in the card of the task it is about. Plans are written
overnight by the planning agent in `agents/plan-agent/`, and **nothing in a plan
has been done** — each one researches what the task actually involves and proposes
a course of action — but a plan is a document and nothing more: it holds
content, and where it stands is the state of the sub-tasks on its task.

Handing a task to the Plan agent, by choosing it in the drawer's Delegate to, lays
four sub-tasks out on the card and moves it to Doing: Plan (the agent), Review the
plan (you), Implement (the Implement agent), Review the work (you), each blocked by
the one before. When the plan is written the agent's Plan sub-task is ticked
through the board's queue, and Review the plan carries a `Plan:` note naming the
file, so opening that sub-task offers to read the plan and to talk it through.
Approving ticks the review; sending it back unticks the Plan with what was wrong as
a `feedback:` note under it, which the next night reads as an instruction.

The files are in `data/<dataset>/plans/`, one per task, listed by the server at
`/plans.json`. Replanning a task rewrites its own file in place, with a `History`
section keeping the earlier revisions.

The full account of how the planning agent decides what to plan and when it is
allowed to spend is in [agents/plan-agent/README.md](agents/plan-agent/README.md). The short version
of the part that matters: it runs at the hours its schedule file names and at no
others, with a floor in `schedule.py` that refuses the working day whatever that
file says.

### Schedule

**Spend** and **Schedules** are two tabs of the Settings page (Data, Settings), beside Memory,
Settings and Backups, with **Run the Plan agent now** in the Data menu. Not tabs of the board,
because they are about the machinery around the list rather than about the list. Both only show
when an agent can run on this machine, so not without Claude Code or `agents-engine`.

Three things here run on a clock rather than when you ask them to: the nightly
agent's twelve launchd wakes, the desktop banners thread, and the weekly
backup thread inside `server.py`. Before this they were three places to go and
look, and "did the nightly job actually run" had no answer short of reading a log.

It reads two sources, and they are not alternatives. **Live** — `launchctl print`,
the plist's own wake times, whether the server's banner thread is alive — says
whether a job is armed and when it fires next, which no log can know, since a
log will happily describe a job that was unloaded a week ago. **The ledger** —
`plans/plan-agent.log`, the backup listing — says what it actually did, which
`launchctl` cannot. A job that is not installed says so and gives the command to
install it. The banners job is a thread in this server, so it has no schedule to
read and no ledger: it says whether it is running, and when it is not, why
(`BENCH_NOTIFY=0`, not a Mac, or no `terminal-notifier`). What it has sent is in
each list's `notify-state.json`.

The second card is the usage windows, which had no home outside running
`core/windows.py --history` at a terminal. The last 30 days, one row a window,
with the ones that started in the night picked out.

Everything in the sheet is read-only. Run the Plan agent now is the one press, and
it asks first, because it spends money.

### Handing a prompt over

A card that carries a written prompt gets **Open in Claude** under the Copy
button. It is an ordinary link to `claude.ai/new?q=`, with the prompt
URL-encoded onto the end, so a click opens a new chat with the text already
sitting in the box — unsent. Unsent is the whole point: most of these prompts
still have a `[path]` to fill in, and one that fired on click would send the
placeholder.

Only prompts get the link. A suggested message is written for a person, so Copy
is the only thing it needs.

### Recurring tasks

Some of the list comes round on a cycle rather than being finished once: the
standing 1:1s, the monthly status update. Before this every one of them was
retyped by hand each cycle, which is how the same task ends up on the list three
times in slightly different words.

One tag, `` `repeat:` ``, and one card:

| | |
| --- | --- |
| `repeat:wed` | every Wednesday |
| `repeat:wed-9:15` | every Wednesday at 9:15 |
| `repeat:15` | the 15th of every month |
| `repeat:wd5` | the fifth working day of every month |
| `repeat:tue2` | the 2nd Tuesday of every month |
| `repeat:tue2-15:00` | the 2nd Tuesday of every month, at 15:00 |
| `repeat:wed/2` | every other Wednesday |
| `repeat:15/3` | the 15th, quarterly |
| `repeat:tue2/3` | the 2nd Tuesday, quarterly |
| `repeat:mon1/6` | the first Monday, twice a year |
| `repeat:~fri-15:00` | weekly, usually Friday 3pm, but the day moves |

`[due:: ]` is the occurrence the card is currently pointing at, so the tag says
how often and the date says which one. A month too short for the day it names
lands on its last day rather than skipping, since the 31st in February is still a
date somebody meant to hit.

The working-day form is there because a real obligation needed it and neither of
the other two could hold it: the status update is due by the fifth working
day, which is 7 September, 7 October, 6 November — a different date every month
and not a day of the month at all. Working means Monday to Friday here, and
counts bank holidays as working days even though `todo.py` now knows perfectly
well which ones they are. That is on purpose: "the fifth working day" is how the
obligation is worded by the people who set it, and they mean the fifth weekday.
Quietly shifting it because one of those days is a bank holiday would make the
board disagree with the deadline it is tracking. The checker still flags the
result if it lands on a holiday, which is the right place for a human to decide.

**Longer cycles: the `/n` suffix.** Everything above repeats at its natural
cadence — weekly for a day, monthly for the rest. `/n` multiplies that, and it
works on all four forms rather than being a form of its own, because a quarterly
meeting is not a different kind of cycle from a monthly one, it is the same cycle
counted differently. `/2` on a weekly form is fortnightly, `/3` on any monthly
one is quarterly, and anything from `/2` to `/24` is accepted.

The thing worth understanding is where the phase lives. "Every other Wednesday"
says nothing about *which* Wednesday, and the tag deliberately does not try to:
`[due:: ]` was already carrying that, so the interval is counted forward from the
date on the card. Move that date by hand and the whole series moves with it,
which is exactly what a rebooked fortnightly meeting wants. The flip side is that
the first date matters — a `/n` task tagged with no date gets the next plain
occurrence of its base cycle and starts counting from there, so set it
deliberately.

The checker can only check the shape, never the phase. It will tell you a
fortnightly Wednesday task is dated on a Thursday. It cannot tell you it is on
the wrong Wednesday, because nothing on the card says which Wednesday is right.

The `~` prefix says the cadence is the usual shape rather than a rule. The design
system drop-in is why it exists: it is weekly, but which day it lands on gets
rebooked around everything else, so four consecutive sessions ran Friday,
Thursday, Friday, Thursday. Without `~` the checker would flag every one of those
as a date disagreeing with its tag, which is correct for a fixed slot and pure
noise for this one. The board still rolls to the tagged day, because that is the
best default available — and the date stays the owner's to correct when the session moves.

### What happens when the meeting does not happen

Nothing is ever lost: the roll rewrites dates and ticks, and it never deletes a
task or a topic. But "the date passed" and "the meeting happened" are not the
same fact, and the board only knows the first one. So the tick is what it reads
to tell them apart, and there are three cases.

**It moved, and you knew in advance.** Change the due date to the new day. The
roll only fires on a date in the past, so a card dated forward is left completely
alone — the agenda stays live, the tick stays where it was. One edit, and it is
the case worth reaching for.

**It did not happen, and the date slid past.** The card was never ticked, which
means the prep was never delivered and those topics were never raised. So the
agenda **carries forward** onto the new date rather than being filed as last
cycle's, and the status line says so. Carrying a topic that did get discussed is
the cheaper of the two mistakes: a line the owner can see and delete, rather than one the owner
cannot see and has lost.

**It was cancelled after you had prepared.** The card was ticked, so the roll
files the agenda as `Previous agenda` — the board cannot tell a delivered agenda
from a cancelled one. Which is why that block has its own Copy, dated with the
occurrence the card points at *now* rather than the one it was written for. Odd
written down, right in use: the only reason to copy a past agenda is that its
meeting moved, so what is wanted is those topics under the new date.

**A recurring task's sub-steps roll with it**, on the loads where it rolls at
all. Its steps are the work of one
occurrence — send the nudge, review what came back — so a step still ticked from
last time would read as already done for a cycle it has never seen. They are
unticked, their `done:` dates cleared, and any `[due:: ]` or `start:` on them
moves by exactly the number of days the parent moved. That last part matters
because a step's date is an offset rather than a fixed day: "the nudge goes out
two days before" survives the roll, where clearing it would lose the intent and
leaving it would point at a session that has already happened.

The board owns that date. On load, once the date on the card has passed, it moves
the date to the next occurrence, unticks the card, and files whatever agenda was
on it as a `Previous agenda (that date):` note. It says so in the status line,
because it changed what a card said without being asked, and it does none of it
while a backup is being previewed — rewriting the dates in a record of a past
state would be a lie about what was on disk that day.

**The board rather than the skill, and on load rather than on a timer.** The
board is open every day; a check-in is not, so a week without one would otherwise
leave last week's date sitting on the card. It sits beside the two fixups that
were already there — renaming Parked to Backlog, dating a task that was ticked
without one — for the same reason all three are automatic: they are facts about
the file rather than decisions about the work.

**One card that rolls, not a template that spawns copies.** A card per occurrence
would put a ticked "prepare for the 1:1" into Done every week for as long as the
meeting exists, and the only question ever asked of last week's is what was on
it — which is one note, not a whole card. Hence `Previous agenda`, which is one
cycle of history and no more.

The tick on a recurring task means *prepared for this one*, not *this happened*.
That is why there is no "agenda ready" chip: the card is the prep, so ticking it
is the status, and a chip saying the same thing a second way would be a second
thing to keep in step. Tick it when the agenda is written, it leaves Quick wins,
and it comes back unticked after the meeting.

### Where the card lands when it rolls

Rolling a card changes what it says, so it also has to change where it sits, or
a meeting prepared for last week stays in To do saying it is this week's work.
Three rules do that, and the only thing they have to agree about is where To do
stops.

**Under two days to the next occurrence, To do.** Preparing for a meeting is
work for the day before it at the earliest, so that is the window in which the
card is actually this session's business.

**Two days or more, Backlog.** There is nothing to do about it yet, and a column
full of meetings nobody is preparing for this week is a column the owner stops reading.

**A week or more, and the card was ticked: nothing at all.** The roll does not
fire. The card keeps its date, its tick, its agenda and its place in Done,
because a monthly meeting already prepared for and delivered has nothing waiting
on it for weeks and no useful column to sit in. It is not skipped for good — the
date it is holding is still in the past, so every later load offers the card
again, and the one after that week closes rolls it properly.

The cost of that third rule is real and was taken deliberately: until the roll
fires, the card carries a date that has gone and reads as prepared for an
occurrence that is over. It is there because Done is not a column, it is the
tick read sideways, so there is no way to say "finished with that one, nothing
due yet" without also saying "prepared for the one coming". Making Done a real
column is the change that removes the need for it, and it is written up in
`IMPROVEMENTS.md`.

Parking once is not enough on its own, which is the part that is easy to miss.
The roll fires the day *after* an occurrence passes, and for a weekly meeting
that is six days out — Backlog, by the rule above, and then nothing would ever
bring it back as the day came round. So a second pass runs on every load and
moves any recurring card sitting in Backlog with its occurrence under two days
away into To do. It only goes that way: moving one back would overrule a card the owner
dragged somewhere themselves, and the board cannot tell that drag from a card that
was never touched.

### The agenda for a recurring meeting

A recurring meeting also carries the topics for the next one, as an `Agenda:`
block on the task:

```
- [ ] **Prepare for 1:1 with Priya** [impact:: med] [effort:: S] [due:: 2026-09-02] `repeat:wed-9:15`
  - Agenda:
    - ATLAS2027
      - Confirm the rescoped recommendation is agreed so the tracker can go out.
    - Personal objectives
      - Shared 26 Aug, pending validation before Sage.
```

That note is the one thing in the file that is a block rather than a quoted line.
Every other note — a message, a prompt, a ticket summary — is a sentence, and a
sentence fits on a line. An agenda is a bullet list with a second level under it,
because that is the thing being produced: it gets pasted into somebody else's
document, and the bullets are the format rather than a way of drawing it. So the
note is the heading and the content is whatever sits indented beneath it, ending
at the first line that is not.

There is no date on the note. The task's `[due:: ]` is the meeting date, and
since the board rolls that forward itself and clears the block as it goes, the
block always holds the agenda for the meeting the card is pointing at. An earlier
version dated the note and marked it amber when the date had gone by; rolling the
task removed the state that marker existed to describe.

#### What Copy actually puts on the clipboard

Not the markdown above. This:

```
Wednesday, 2 September 2026

Agenda
- ATLAS2027
  - Confirm the rescoped recommendation is agreed so the tracker can go out.
```

The meeting date in full on its own line, a blank line, the word Agenda on its
own line, then both levels as bullets. The board builds it from the block and the
task's date, so nothing in the file carries the title or the blank line.

Two flavours go on together, `text/plain` and `text/html`. Plain text alone does
not survive the paste: Google Docs turns a leading `- ` into a bullet only
sometimes and loses the second level every time, so an agenda arrives as literal
hyphens. Given the HTML flavour it reads the `<ul>` and produces real nested
bullets. Anything that cannot read HTML — a terminal, a plain notes field — still
gets the text, so nothing has to choose in advance which one the destination
wants. `ClipboardItem` is what carries both; where it is missing, or where the
browser refuses the write, the fallback copies a selection out of a
`contenteditable` rather than a `textarea`, since that is the only way
`execCommand` ever kept formatting.

On screen the block is drawn as an actual `<ul>`, not as styled indentation, for
the same reason: what is on screen and what lands in the document should not be
two designs of one list.

#### Where the topics come from

Not the board's business. That lives in `context.md`, under `### Recurring
meeting prep scripts`: one line per meeting in the owner's own words, saying when it
happens, what it is usually about, and what to check before it. The `pa`
skill reads that script, pulls the live status of whatever it points at, reads
`Previous agenda` to see what was already raised, and writes the block. Keeping
the script in Context rather than in the skill is deliberate, and the same call
`### How I want messages and prompts written` made: the owner can edit it on the board,
the owner cannot edit the skill, so the owner's copy is the one that is current.

### Chats on a task

The link above has one thing wrong with it, and it is the thing most of these
prompts are about. The chat it opens runs in a browser tab that has never seen
this machine, so a prompt saying *read the notes in `data/projects/ATLAS2027`* is
asking the one end that cannot do it. Every one of them ends the same way: find
the files, paste them in, then start.

Claude Code is already installed, already signed in, and runs where the files
are. So a task now carries **Chats** — a list of conversations, each one running
down at `server.py` and answering in a modal on top of the board.

A list rather than one, because the work on a task is not one conversation.
Reading the 360 responses, drafting the message that comes out of it, and
checking how it was worded last quarter are three, and keeping them apart is the
point: each one stays short enough to be worth coming back to. **+ New chat**
starts one. A prompt written on the task gets **Ask Claude**, which starts one
with that prompt already in the box, unsent — most still have a `[path]` to fill
in, and one that fired on click would send the placeholder.

**A prompt is used up by actually being run.** The line disappears once you
send that first message, not when you click Ask Claude — closing the modal
unsent leaves it exactly where it was, since most of these still want editing
first. The text is not lost: the conversation it started records it, so the
card can say what it was started to do rather than only what the first
message happened to say.

Each entry in the list draws as a card — title, which task it belongs to, when
it last did anything, whether it can write to disk. That last one is the most
important thing on it: the difference between a conversation that can only read
and one that can change files is worth seeing without opening it. A dot beside
the title means something has happened in that conversation since you last
opened it; when each card was last opened is furniture rather than content, so
it lives in `data/<dataset>/chat-viewed.json` beside `sessions.json`, and
deleting that file costs a dot and nothing else.

**A card closes with the × in its corner**, and it is worth being exact about
what that does. The row leaves `sessions.json`, so the board stops listing the
conversation. Claude Code's transcript is left exactly where it is, which means
`claude --resume <id>` still opens it and Claude Desktop still imports it. The
conversation is unfiled rather than deleted, and the confirm asks about the
board rather than about the conversation for that reason — "delete this chat"
would be a promise this board cannot keep, since the file belongs to Claude
Code and nothing here should be reaching into it.

**Attach a session…**, next to **+ New chat**, reaches for a conversation
Claude Code already has on disk that was never started from this board — one
begun in a terminal, say — and files it here directly. The same thing from
inside that conversation instead of from the task is the `/pa-attach` skill,
which cannot write to `todo.md` itself and leaves a request for the board to
pick up on its next load instead — see **Where a conversation actually
lives**, below. `!chat=<id>` on any view opens one conversation, the way
`#board!task=<key>` opens one card.

**There is no canvas over these cards.** "What conversations are open at all"
is not asked often enough to carry a whole view, a geometry store and a second
way of filing a conversation, so the cards live on the task and nowhere else.

### Where a conversation actually lives

Three things, and none of them is a copy of another:

| | |
| --- | --- |
| `` `chat:xxxxxx` `` on the task line | which task a conversation belongs to |
| `data/sessions.json` | which sessions sit under that key |
| `~/.claude/projects/…/<id>.jsonl` | what was said, written by Claude Code |

The third is why nothing here stores a transcript. That file is what the CLI
resumes from and what Claude Desktop imports, so a conversation carried on
somewhere else comes back complete instead of as a stale copy. Clear those files
and the board says the transcript has gone rather than drawing an empty chat.

The key sits on the task line rather than in `sessions.json` because a task gets
renamed, moved between buckets and reordered, and a key written on the line
survives all three where a key made out of the title survives none of them. It
is minted the first time you start a chat on a task, which marks the list dirty
like any other change — so a chat started and never saved leaves an entry in
`sessions.json` with nothing pointing at it. The `×` on a row clears one out.
Nothing is lost either way: the transcript is Claude Code's file and is left
alone.

**Minting that key is a write to `todo.md`, and only the board is ever allowed
to make one.** That is what stops `/pa-attach` writing straight to
`sessions.json` from inside the conversation it is filing: it drops what it
knows — the session id, its working directory, the task it belongs to — into
`data/<dataset>/attach-queue.json` instead, and the board reads that file and
does the actual filing itself the next time it loads. So attaching still works
from a terminal with no board open, and the board stays the only writer.

### Carrying on in Claude Desktop

Every chat row, and the modal, offers **Claude Desktop**. It is a link to
`claude://resume?session=<id>`, which imports the session into the app with its
full history and carries it on there.

That deep link took finding. Claude Desktop keeps its own session records —
`local_…` ids that map to a CLI session — and lists only sessions it created,
which is why a run started here never appeared. `claude://code/continue?session=`
refuses a CLI id outright; it only takes `last` or a `local_…`. `claude://resume`
is the one that adopts a CLI session, and the app's own log says so when it
does: *importing CLI session … as Desktop session local_….*

### What the modal is copied from

`ai_chat/claude-chat-interface-findings.md` is a teardown of the claude.ai chat
interface, and the modal follows it, because that is the shape this conversation
already has in the owner's head:

- **Attribution by asymmetry.** Your message is a filled bubble pushed right;
  the reply is unbubbled prose running the full width. No avatars, no `you:`
  prefix. It keeps the reply reading as a document rather than as a chat log.
- **One slot, one primary action.** Send and Stop share a position, so stopping
  is where sending was and the primary action never competes with a second one
  for the same glance. The box grows line by line instead of scrolling, so a
  long question stays visible while it is written.
- **No spinner.** A line that says what it is doing, rewritten in place as that
  changes. A progress indicator whose content is the progress reads as activity
  rather than as a wait.
- **The trace collapses.** What it did becomes one grey summary line that opens
  into a timeline.

One thing the teardown flags as friction, deliberately not copied: there, the
trace only admits to being a control once the cursor is on it, which hides the
most interesting part of an answer behind the least likely gesture. Here the
chevron is always drawn. The response also keeps its Copy button, which the
teardown notes the original is missing.

The artifact panel has no equivalent and none is faked. A run here changes files
on disk rather than producing something to preview.

### What a chat is allowed to do

**Ask reads and cannot write.** Bash, Edit, Write, NotebookEdit and Task are
removed from the run outright — not permissions it has to ask about, tools that
are absent, so there is nothing to be argued into using. Ask it to create a file
and it answers that it has no way to.

**Do it** is the other half, and it only exists if `data/claude.json` says so.
It runs with permissions bypassed, which is what a headless run needs to do the
actual work, and it is not dressed as the safe button.

The board asks the helper `/claude.json` before drawing any of this. No CLI, no
helper, or a host serving these files statically, and the answer is the same: no
chats, and the prompts keep the link they always had. That is also why a
static copy never shows it.

The config is optional and lives with everything else private:

```json
{
  "cwd": "/home/you/Code",
  "work": false,
  "model": "sonnet",
  "timeout": 900
}
```

`cwd` is the folder a chat starts in, and the one setting worth thinking about.
It defaults to this repo. Point it at a wider folder, such as the one holding
all your projects, when your prompts name things that live outside this repo. Everything a
chat can read is under that folder. `model` is unset by default, so chats use
whatever Claude Code is configured to use; a card-sized question is usually a
Sonnet job, and the cost on a finished chat is the honest reason to care.

Two runs at a time, killed after fifteen minutes, and **Stop** ends one now — it
drops the connection, the helper notices, and the whole process group goes with
it rather than being orphaned. A chat left running carries on while you close
the modal and go and look at something else; the row says *running*.

One guard is worth stating plainly. Any page in any tab can POST to
`127.0.0.1`; that is what CSRF is, and until now the worst it could have done
was write `todo.md`. Running Claude is a bigger thing to hand out, so the
endpoint refuses anything without an `X-Board: 1` header. A form cannot set one,
which forces a preflight this server does not answer, so the request never
leaves the page that tried it.

### Raising a Jira ticket

A task that needs a ticket carries a `Jira` note, the same shape as a prompt:

```
- [ ] **Raise the button variant gap on the contributions board** [impact:: med] [effort:: S]
  - Jira (PLAT): "Button: three variants in Figma with no Storybook equivalent"
  - Description: "Three button variants exist in Figma with no Storybook equivalent ..."
```

The board turns that into **Raise in PLAT**, which opens Jira's create form with
the project, the issue type, the summary and the description already filled in. It creates
nothing. Jira has two endpoints here and only one of them is worth linking to:
`CreateIssueDetails!init.jspa` opens the form and waits, and that is the one
behind the button. A link that raised a ticket on a shared board from a click is
not something worth putting on a card.

`Description:` is optional and belongs on the line under the note it serves, so
a step carrying two tickets keeps two separate bodies. The older
`Description to paste:` still parses — it is what the first of these were written
as, when the board carried only the summary and the body really did have to be
pasted — but nothing writes it now.

Leave the brackets off and every configured board is offered, which is the
honest answer when it is not yet settled where the ticket goes. The column card
shows a `PLAT ticket` marker rather than the button, because the card has no room
for it and a pending ticket is still worth seeing from the board.

Which boards exist is `data/jira.json`, gitignored with everything else private —
it names a company Jira and an account id, and this repo is public:

```json
{
  "site": "https://example.atlassian.net",
  "reporter": "000000:0000...",
  "boards": [
    { "key": "PLAT", "name": "Platform Requests",
      "pid": "10001", "issuetype": "10002", "setReporter": true }
  ]
}
```

Jira wants numeric ids rather than project keys, which is why they are in a file
rather than written on the task. `/rest/api/3/project/PLAT` in a logged-in
browser returns the project id and every issue type id for it.

`setReporter` is per board because it has to be. One board here refuses to create
an issue without a reporter, and the other refuses to let it be set at all, so
one setting could not have served both. No file means no buttons, which is why
a copy without a server falls back to `kanban/jira.demo.json` — the same trick as
`demo.md`, so a public page can show the feature without a real site being
committed to a public repo.

## Desktop banners

The board only says anything while a tab is open on it, so a day it is never
opened is a day nothing is said. The board server fixes that without a second
app: while it is running on a Mac with `terminal-notifier` installed, a thread
inside it (`core/notify_due.py`) wakes every minute, reads every list off disk
and puts a banner up for whatever has fallen due. This replaced the Electron
tray app, To-Do Companion, on 26 Oct 2026. That one only watched a single list,
only spoke once a morning, and needed a second process to be running beside the
board. Banners now come from the process that is already there, and stop when
it stops.

**What gets a banner.** Every task and every sub-task with a due date of its own
that is not done. It goes out on the due date at the item's time, or at 09:00
when it has none. A time is written beside the date, `[due:: 2026-11-02]
[time:: 15:00]`, set from the Due time field in the task or sub-task drawer
(clearing the date clears the time, and a time with no date is dropped on the next
save). A recurring task whose rule carries a time, `repeat:wed-9:15`, uses that.
A sub-task does not borrow its task's date or time; only one with a date of its
own is announced, and its banner opens its task. Each item gets its own banner,
grouped with nothing.

**Overdue, once.** If an item due on a working day is still open on the next
working day, one more banner goes out at 09:00 saying "Overdue since Fri 23 Oct".
After that it is silent, since a banner a day for a week is how banners get
ignored.

**Quiet days.** Weekends and public holidays, from the same working calendar the
rest of Bench reads (`core/todo.py`: UK and Portugal by default), stay quiet.
Something due on one goes out once on the next working day at 09:00, already
saying it is overdue, and gets no second banner. Starting the server late in the
day sends whatever was owed earlier that day on its first tick, and nothing from
before today.

**Once only.** What has been sent is kept per list in
`data/<list>/notify-state.json`, keyed by day, item and kind, and pruned after
14 days, so restarting the server repeats nothing. A banner that fails to post is
retried every ten minutes and only its first failure is written to the log.

**Agents' messages.** The queue an agent asks for a banner on belongs to the
notifier, a folder of its own in PACKAGES (`~/Code/PACKAGES/notify` on the
owner's Mac, `$NOTIFY_HOME` elsewhere), because agents outside Bench need it as
much as the ones inside, and they should not have to reach into Bench's folders
or wait for the board to be open to be heard. It keeps the layout Bench used,
`data/<list>/notify-queue.json`, so a caller names a list the way it always
did, and its own poster drains every queue whether or not the board is running.
`companion/notify.py` stays as a shim with the same interface, so every caller
that reaches it by path keeps working: it picks the list on screen when none is
named and hands the line to the notifier's `notify.py`. A checkout with no
notifier beside it, and a throwaway data root such as the test runner's, keep
the queue in `data/<list>/` as before.

The server drains its lists' queues in both places while it runs, so a Mac
where the poster was never started loses nothing. It posts the lines between
08:30 and 20:00, three a minute at most (the `content` list has no window,
because its 11pm run is the reason it exists). With two drainers a line could
go out twice, so each holds the queue's lock, `notify-queue.lock` beside it,
from reading a line to taking it off, posting included: whichever reaches a
line first posts it and the other finds it gone. A line appended mid-drain
waits for the lock and is kept.

**Pressing a banner.** Each one opens the board on the card, through a link that
names its list, `#!board=<list>!task=<key>`. If that list is not the one showing,
the board switches to it the way its list menu does and then opens the card;
a list that does not exist or that the person cannot see is ignored and the card
opens where it is. The board segment comes off the address once used, so a
reload does not switch again. It is a fragment rather than a query string for the
same reason as every other link into the board: a link differing only after the
`#` brings the tab that is already open to the front, where a `?` would open a
second tab on one list, and two tabs autosaving one `todo.md` is the failure the
board is written to avoid.

**Where it runs.** On a Mac, with `terminal-notifier` found in `PATH`,
`/opt/homebrew/bin`, `/usr/local/bin` or the rvm gems folder (the server can
start without the user's `PATH`). The Linux server never starts it, a throwaway
data root such as the test runner's never starts it, and `BENCH_NOTIFY=0`
switches it off anywhere. The schedule page lists it as Desktop banners and says
why when it is off. Due banners go out only while the board is running; the
agents' lines also go out through the notifier's poster, once something starts
it at login (its README says how).

**The retired app.** `companion/` stays on disk, because `notify.py` (now the
shim above) and `digest.py` are still called from there, but the Electron tray app is not part of
the setup any more: `run.command` starts only the board, nothing launches the
tray app, and its packaged `To-Do Companion.app` can be deleted. Its suite,
`python3 companion/test_companion.py`, still covers `notify.py` and `digest.py`.
The board's own tests for this are `core/test_notify_due.py` and
`kanban/test_board_link.mjs`.

## The skills

The `pa-*` skills and how they fit together are described in
[agents/pa_agent/CLAUDE.md](agents/pa_agent/CLAUDE.md).

### Installing them

Symlink, and nothing else:

```sh
ln -s <path to this repo>/agents/pa_agent/skills/<name> ~/.claude/skills/<name>
```

The folder is the installed skill, so an edit takes effect the next time it
fires. Nothing is packed into an archive, because an archive beside a folder is a
second copy that goes stale. `check_todo.py` resolves through the link and imports
`core/todo.py` five folders up, so there is one copy in git and no build step.

### Two dates, not one

`due:` is the deadline. `start:` is the earliest the work can begin. One date used
to carry both meanings, which made "finish by the 7th" and "cannot begin until
the 1st" indistinguishable — so a filter for what is actionable had to guess, and
either guess was wrong half the time.

Quick wins reads `start:` and ignores `due:` completely. A passed deadline never
hides anything: overdue is the most actionable state on the list, not the least.
Where the gate is another task rather than a calendar date, `blocked-by:` is the
better tool — it resolves itself when the blocker is ticked instead of needing a
date re-guessed by hand.

## File format

```
## 1. People                      <- bucket
### Doing                         <- state
- [ ] **A task** [impact:: high] [effort:: M] [due:: 2026-08-21] [to:: Mia]
  - [ ] A sub-step [due:: 2026-08-19] [to:: Implement agent]
    - Suggested message: "..."   <- ready to send
    - Prompt: "..."              <- ready to hand to Claude
    - Jira (PLAT): "..."         <- a ticket still to raise
    - Description: "..."         <- and its body
  - [ ] A gated step `start:2026-09-01` `blocked-by:some-slug`

- [ ] **A recurring task** `repeat:wed-9:15`   <- how often, board keeps the date
  - Agenda:                     <- a block, not a line: the topics to paste
    - A topic
      - what needs saying about it
```

Tags work on sub-steps as readily as on tasks, and usually belong there.

The columns on the board are exactly the `###` headings in the file, so a new
state is a heading rather than a code change. The board reads them in reverse
file order, so Done is the first heading in a bucket and the far right of the
board. Left to right that is Backlog, To do, Doing, Reviewing, Done. A ticked task lives
under Done, and a file with a ticked task under another heading reads as if it
were under Done, so nothing has to be converted by hand.

`[to:: ]` is who does the work: `Plan agent`, `Implement agent`, or a person's name
from `people.md`. It is optional: most of the list is work you are doing yourself,
and a task without it shows nothing. It replaces the old `[ai:: ]` tag; a backup that still carries `ai:` is
read and the tag dropped. It works on a sub-step as readily as on a task, and never
comes down from the task to its steps. When it is set on a person, the name
appears on the card as an arrowed chip in the accent colour, so scanning a column
tells you what is with somebody else without opening anything.

On a shared board, Delegate to also offers the board's own people: its owner,
the people it is shared with, and everyone who has signed in as a member of a
team it is shared with (`/board-people.json`, from `core/board_access.py`). A
person is stored by email, `[to:: ana@example.com]`, because a name is not
unique and an email is what sign-in vouches for, and is shown the way the
owner's notes write a person: first name and last initial, "Jérôme D.", from the
name they first signed in with, with the email's local part in brackets when two
people on the board would otherwise read the same. A name is stored and shown
without bidirectional or control characters, so it cannot reorder the text
around it. Signed in, Mine and "your move" match the stored email and never a
name. Each has a round face with their initials in a colour
seeded from the email, so it never reads as one of the agents' square ones. An
email is always a person: nothing that checks for an agent (`agentOf()`, the
board's refusal of a tick, the server's credit for one) can read one as an
agent. The Mac board offers what it always has, agents and `people.md` names.

A sub-step carries every tag a task does. Two are its own: `id:` (six characters,
so something outside the file can point at it) and a bare `doing`, for an agent
working on it now. What it does not carry it takes from its task: the due date, the
impact, `urgent` and `week`. Handing a task over lays four of them out with a
slug each, made from the task's id and the step.

On a shared board every task and sub-task also says who wrote it and who last
changed it, `` `created-by:` `` and `` `edited-by:` ``, by the email the person
signed in with, written in front of the `id:`. Only the server writes them: on
every save it compares what it is about to write with the file
(`stamp_authors()` in `core/todo.py`), so a new task is created by whoever
saved it, a changed one is last edited by them, and anything a tab sends for
either tag is put back to what the file says. The card shows the name, from
the list's activity log, and the task panel shows both. A list nobody signs in
to never carries them, so the Mac board's file is unchanged by any of this.

Every save also appends what changed to `data/<list>/activity.jsonl`, one JSON
line per task added, edited or deleted, with who, their name, when, and which
fields. It is append-only and nothing reads it back into the list. Two kinds
of change have nobody's tab behind them. A card an agent's queued request
changed (a tick, a handover, a move) is credited to the agent, as
`implement-agent` in the tags and "Implement agent" in the log, even though the
save that wrote it came from whoever's tab drained the queue. An edit written
straight to `todo.md`, the way the pa skill writes, is found the next time the
server reads the list, by comparing it with the last version the server wrote
(`data/<list>/.known-todo.md`), and is logged under `pa` and, signed in,
stamped on the cards it changed. That waits while `pa-working.json` says pa is
mid-edit, so the edit is counted once, whole. The status
line uses it to say whose the latest change by somebody else was ("Jerome edited
2 min ago"), and a **Mine** chip beside the other filters narrows the board to
tasks whose `[to:: ]`, or a sub-task's, names whoever is signed in.

**Reviewing** holds work that is finished as far as you are concerned and is now
sitting with somebody else for sign-off, or with you, on a review sub-task. Nothing
is owed on it until it comes back, which is a different thing from Doing (live) and
from Backlog (real work, unscheduled). A task waiting
on another task uses `blocked-by:` instead.

### Two tag syntaxes

`impact`, `effort`, `due` and `to` are written as inline fields, in brackets with
a double colon. Everything else is a backtick code span, because a line carrying
eight bracketed fields is unreadable. The older `` `due:2026-08-21` `` form is still read correctly by the board and
by the checker, permanently — the backups and the done archive are full of it —
but nothing writes it any more, and the checker flags one on a task line.
