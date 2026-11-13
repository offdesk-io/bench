#!/usr/bin/env python3
"""Tiny local server for the to-do board.

This file lives in kanban/ and serves the folder above it, so kanban/index.html
and data/<dataset>/todo.md are both reachable. It accepts PUT /data/todo.md so
the board can write your changes straight back, and keeps backups in
data/<dataset>/backups/. Listens on 127.0.0.1 only, so nothing outside this
machine can reach it.

Everything private lives in data/, and that folder is the whole of what git
ignores. It is not one list any more but a folder of them — data/work/,
data/personal/, whatever the board's dropdown has been used to add — each
shaped exactly like the others: its own todo.md, backups/, views.md, projects/,
claude.json and jira.json. Exactly one of them is "current" at a time, tracked
in data/.current, and every URL the board already used (/data/todo.md,
/data/backups/…) is transparently rewritten below to point at whichever
dataset that is — see translate_path. The board itself never learns a
dataset's name until it asks /datasets.json for the list.

Run it with run.command, or directly:  python3 kanban/server.py
"""

import datetime
import hashlib
import http.server
import json
import mimetypes
import os
import re
import shlex
import subprocess
import shutil
import sys
import tempfile
import threading
import time
import uuid
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
# Everything is served from the project root, one level up from this file, unless
# $BENCH_ROOT says otherwise (core/bench_root.py).
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "core"))
import bench_root  # noqa: E402
ROOT = bench_root.root()
PACKAGES_DIR = bench_root.packages()

# The two shared modules in core/, imported the same conditional way ai_chat is:
# a checkout without them serves the board and answers 404 on the routes that
# need them, rather than refusing to start. `todo` is the working calendar, for
# saying when the companion next speaks; `windows` is the usage-window
# reconstruction behind the Schedule view.
sys.path.insert(0, os.path.join(ROOT, "core"))
try:
    import todo
except ImportError:
    todo = None
try:
    import windows
except ImportError:
    windows = None
# Where a project folder may be, and the one check that says so. Plain stdlib,
# so imported unconditionally: every project route depends on it.
import project_folders
import platform_calls
import settings
import bucket_agents
import bucket_wake
import iso_countries
import board_access
# The list and everything derived from it live in one folder, and that folder is
# the only thing git ignores. Before this, the private half of the repo was four
# separate ignore rules — todo.md, backups/, todo-backup-*.md, views.md — and
# anything new had to remember to add a fifth. One folder cannot be forgotten.
# It is also what Obsidian opens as its vault, so the vault holds the list and
# nothing else: no board, no skill, no README to index.
DATA = "data"
# Where the datasets really sit on disk. The board still asks for /data/..., so
# URLs never change; only the folder they resolve to does. TODOS_DATA_ROOT
# (an absolute path) moves it, and .current with it, which is what lets
# scripts/test-board.sh run a second server over a throwaway copy rather than
# the real lists. Unset, it is ROOT/data exactly as before.
DEFAULT_DATA_ROOT = os.path.join(ROOT, DATA)
DATA_ROOT = os.environ.get("TODOS_DATA_ROOT") or DEFAULT_DATA_ROOT
SCRATCH = os.path.realpath(DATA_ROOT) != os.path.realpath(DEFAULT_DATA_ROOT)
CURRENT_FILE = os.path.join(DATA_ROOT, ".current")
TARGET = DATA + "/todo.md"
PAGE = "kanban/index.html"
PORT = int(os.environ.get("TODOS_PORT") or 8765)
# Loopback only, always. Behind nginx this is also what makes the sign-in
# headers trustworthy: nothing but nginx on the same machine can send them, so
# main() refuses to start signed-in mode on any other address.
HOST = "127.0.0.1"
# Who is asking, when Bench is shared (core/board_access.py). None is the Mac
# board as it always was. An unknown BENCH_AUTH is held as signed-in mode, so
# every request is refused until main() refuses to start at all.
try:
    AUTH = board_access.mode()
    AUTH_ERROR = None
except ValueError as err:
    AUTH, AUTH_ERROR = "header", str(err)
# The person behind the request this thread is answering, set by
# Handler.parse_request before any route runs. ThreadingHTTPServer answers
# each connection on its own thread, so a thread-local is per request.
_request = threading.local()
# A test server must never open a window: it would steal focus mid-run.
OPEN_BROWSER = not os.environ.get("TODOS_NO_BROWSER")
MAX_BYTES = 5 * 1024 * 1024
# A file added to a project folder from the drawer. Not read through _body().
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
# One-backup-per-run applies per dataset, not to the server as a whole — the
# rare session that visits two lists gets one grace save on each.
backup_made = set()
# Everything that writes todo.md takes turns, from reading the file to writing
# it: a tab's save (do_PUT, which merges one save into another), a new list,
# and the server stamping an edit made outside it (notice_outside_edit). The
# board's drain of agent requests takes it too, so the cards it credits to an
# agent are read from the same version the next save is measured against.
# Re-entrant, because a save first checks for an outside edit under it.
_save_lock = threading.RLock()


# Who has signed in, as last written to their data/users/ file, so the file is
# touched once per change rather than once per request.
_people_seen = {}


def seen_person(who):
    """Remembers a signed-in person's first name and current teams for the
    board's list of people (board_access.board_people())."""
    # _signed_in() stands the part of the address before the @ in for a name
    # nginx did not send, which is no name to remember.
    name = "" if who["name"] == who["email"].split("@")[0] else who["name"]
    key = (name, tuple(who["teams"]))
    if _people_seen.get(who["email"]) == key:
        return
    try:
        board_access.remember_person(DATA_ROOT, who["email"], name, who["teams"])
        _people_seen[who["email"]] = key
    except OSError:
        pass


def requester():
    """{email, name, teams} for the signed-in person this request is from, or
    None on the Mac board and outside any request (the weekly backup thread)."""
    return getattr(_request, "who", None)


def pinned_board():
    """The board this request is held to by X-Offdesk-Board, or None.

    The PA's save route (agents/pa_agent/skills/pa/scripts/pa_save.py) names
    its board this way, because a PUT names none and goes to the saver's
    current board. Signed in, nginx sets the header from the sign-in
    service's token check, so the board is the token's and a browser cannot
    send its own. On the Mac pa_save.py sends it itself, so the PA can save a
    board that is not the one on screen without switching it. Either way the
    request may only read and write that board's list (pinned_refusal())."""
    return getattr(_request, "board", None)


# ---- Data sets --------------------------------------------------------------
#
# A dataset is nothing but a folder directly under data/ that has a todo.md in
# it. That is the whole of the contract, so listing them is a directory scan
# rather than a registry that could fall out of step with what is really on
# disk. Which one is "current" is a single word in data/.current; missing,
# blank or naming something deleted, it falls back to the first dataset found,
# which covers a fresh clone (data/.current does not exist) the same way it
# covers a dataset removed by hand outside the board.
#
# Signed in (BENCH_AUTH=header), both answers are the person's own: the list
# is the boards their access.json lets them see, and which one is on screen is
# kept per person in data/users/, never in data/.current. Every route below
# reaches a board through current_dataset(), so filtering here is what keeps a
# board outside someone's access out of every route at once. See
# core/board_access.py.

# A name starting with "_" is kept out of the dropdown, except when
# TODOS_SHOW_HIDDEN is set: scripts/test-board.sh sets it, because its list is
# called _test and the suites must see it along with any other hidden one.
def list_datasets(everyone=False):
    base = DATA_ROOT
    if not os.path.isdir(base):
        return []
    hidden = (".",) if os.environ.get("TODOS_SHOW_HIDDEN") else (".", "_")
    out = [name for name in os.listdir(base)
           if not name.startswith(hidden)
           and os.path.isfile(os.path.join(base, name, "todo.md"))]
    return sorted(n for n in out if everyone or board_visible(n))


def board_visible(name):
    """Whether the person asking may see this board. Always, on the Mac board
    and outside a request; signed in, only through the board's access.json."""
    who = requester()
    if not AUTH or who is None:
        return True
    return board_access.can_see(board_access.read(os.path.join(DATA_ROOT, name)), who)


def _pointer():
    """What data/.current says, whoever is asking."""
    try:
        with open(CURRENT_FILE, encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return ""


def current_dataset():
    pin = pinned_board()
    if pin:
        return pin if pin in list_datasets() else None
    who = requester()
    if AUTH and who:
        name = board_access.read_current(DATA_ROOT, who["email"])
    else:
        name = _pointer()
    names = list_datasets()
    if name in names:
        return name
    return names[0] if names else None


def set_current_dataset(name):
    who = requester()
    if AUTH and who:
        board_access.write_current(DATA_ROOT, who["email"], name)
        return
    os.makedirs(DATA_ROOT, exist_ok=True)
    with open(CURRENT_FILE, "w", encoding="utf-8") as fh:
        fh.write(name)


def slugify(raw):
    """A name typed into the dropdown, turned into a folder name safe to sit
    under data/ and to appear in a URL untouched: lowercase, hyphens, nothing
    that could climb out of the folder or collide with the pointer file."""
    s = re.sub(r"[^a-z0-9]+", "-", (raw or "").strip().lower()).strip("-")
    return s[:40]


def dataset_dir(name):
    # No list yet (a fresh checkout) points at a hidden folder that is never
    # there, so every read finds nothing and the welcome screen makes the first.
    return os.path.join(DATA_ROOT, name or ".no-list")


def memory_path(kind, name=None, write=False):
    # A list's people, about or context file. With a memory folder in
    # settings.json a read takes its copy when there is one and a write always
    # goes there (settings.memory_file); without one, beside the list's todo.md.
    name = name or current_dataset()
    if not name:
        return os.path.join(dataset_dir(None), kind + ".md")
    return settings.memory_file(name, kind, DATA_ROOT, write)


def bucket_agent_name(dataset, bucket):
    """A bucket's agent as the board names it, from core/bucket_agents.py."""
    return bucket_agents.agent_name(dataset, bucket)


def people_path(name=None, write=False):
    return memory_path("people", name, write)


def publish_boards():
    """Rewrite <memory_root>/boards.md, when settings.json names a memory
    folder. A failure is printed and the board carries on: the file is for
    agents outside Bench, and nothing here reads it back."""
    # Every board and the server's own pointer, whoever made the change: the
    # file is for agents on this machine, not for the person signed in.
    names = list_datasets(everyone=True)
    current = _pointer() if _pointer() in names else (names[0] if names else None)
    try:
        settings.write_boards(names, current, DATA_ROOT)
    except OSError as err:
        print("Could not write boards.md in the memory folder: %s" % err)


# The people table's columns beyond Name and Role, by the key the board uses
# and the header words that mean it. A table without one leaves that key out
# of the reply, so a caller that only knows name and role sees what it saw.
PEOPLE_EXTRA = (("team", ("team",)),
                ("reports_to", ("reports to", "reports_to", "reports")),
                ("notes", ("notes", "note")))


def _people_columns(cells):
    """{key: column index} for a people table's header cells: name, role and
    whichever of PEOPLE_EXTRA the header has."""
    heads = [c.strip().lower() for c in cells]
    cols = {"name": 0, "role": 1}
    for key, words in PEOPLE_EXTRA:
        for i, head in enumerate(heads):
            if i > 1 and head in words:
                cols[key] = i
                break
    return cols


def read_people(text):
    """Every person in people.md's tables, in the order the file lists them.

    Only a table headed `Name | Role`, so the GitHub usernames table beside
    them, which lists some of the same people again, is not read twice.
    Asterisks come off the name. What the drawer's Delegate to offers after
    the two agents, so nobody keeps a second list of names by hand. A table
    that also has Team, Reports to or Notes columns brings them along, as
    team, reports_to and notes."""
    people, seen, cols = [], set(), None
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("|"):
            cols = None
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if cells and cells[0].lower() == "name":
            cols = _people_columns(cells) if len(cells) > 1 and cells[1].lower() == "role" else None
            continue
        if cols is None or set(cells[0]) <= set("-: "):
            continue
        name = cells[0].replace("**", "").strip()
        if name and name not in seen:
            seen.add(name)
            row = {"name": name, "role": cells[1] if len(cells) > 1 else ""}
            for key, i in cols.items():
                if key not in row:
                    row[key] = cells[i] if i < len(cells) else ""
            people.append(row)
    return people


def _cell(value):
    """A value as one table cell: no pipe or line break to split the row."""
    return re.sub(r"\s+", " ", str(value or "").replace("|", "/")).strip()


def write_people_table(text, rows):
    """`text` (a people.md, or "") with its people table replaced by `rows`,
    each {name, role, team, reports_to, notes}. Everything else in the file is
    kept as it is: headings, prose, the other tables. The table is the one
    headed `Name | Role`; a file with two of them raises ValueError, because
    read_people() merges their rows and there is no telling which a row
    belongs in. Its columns stay as the file has them,
    and a column the file does not have yet (Team, Reports to, Notes) is added
    on the right. A person already in the file keeps their cells as written
    wherever the saved value is the one read from them. A file with no such
    table gets one at the end."""
    lines = text.split("\n") if text else []
    blocks, i = [], 0       # (first line, line after) of each people table
    while i < len(lines):
        if lines[i].strip().startswith("|"):
            j = i
            while j < len(lines) and lines[j].strip().startswith("|"):
                j += 1
            head = [c.strip().lower() for c in lines[i].strip().strip("|").split("|")]
            if len(head) > 1 and head[0] == "name" and head[1] == "role":
                blocks.append((i, j))
            i = j
        else:
            i += 1
    if len(blocks) > 1:
        raise ValueError("more than one people table")
    heads = ["Name", "Role"]
    old = {}                # name -> its raw cells in the first table
    if blocks:
        a, b = blocks[0]
        heads = [c.strip() for c in lines[a].strip().strip("|").split("|")]
    cols = _people_columns(heads)
    titles = {"team": "Team", "reports_to": "Reports to", "notes": "Notes"}
    for key, _ in PEOPLE_EXTRA:
        if key not in cols:
            cols[key] = len(heads)
            heads.append(titles[key])
    if blocks:
        for a, b in blocks:
            for line in lines[a + 1:b]:
                cells = [c.strip() for c in line.strip().strip("|").split("|")]
                if cells and not set(cells[0]) <= set("-: "):
                    old.setdefault(cells[0].replace("**", "").strip(), cells)
    width = len(heads)
    table = ["| " + " | ".join(heads) + " |", "| " + " | ".join("---" for _ in heads) + " |"]
    for row in rows:
        name = _cell(row.get("name"))
        was = old.get(name)
        cells = (list(was) + [""] * width)[:width] if was else [""] * width
        for key, i in cols.items():
            value = _cell(row.get(key))
            if key == "name":
                if not was:
                    cells[i] = value
                continue
            kept = _cell(was[i]) if was and i < len(was) else ""
            if value != kept:
                cells[i] = value
        table.append("| " + " | ".join(cells) + " |")
    if not blocks:
        body = text.rstrip("\n")
        return (body + "\n\n" if body else "# People\n\n") + "\n".join(table) + "\n"
    a, b = blocks[0]
    return "\n".join(lines[:a] + table + lines[b:])


def write_text_file(path, text):
    """`text` into `path`, through a temp file and a swap, so a crash cannot
    leave half of it for a reader."""
    # A link (a memory_root file) is written through, so it stays a link.
    path = os.path.realpath(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".write-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        try:
            os.chmod(tmp, os.stat(path).st_mode & 0o7777)
        except OSError:
            os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def about_path(name=None, write=False):
    """A board's free-text description of its company and team."""
    return memory_path("about", name, write)


def context_path(name=None, write=False):
    """A board's Context: what changes week to week, in context.md."""
    return memory_path("context", name, write)


def _read_text(path):
    """(text, exists) for a file, ("", False) when it is not there."""
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read(), True
    except OSError:
        return "", False


def bucket_headings(name=None):
    """[(heading, name)] for each numbered bucket in the board's todo.md, in
    file order, as ("1. Tasks", "Tasks"). A `## ` heading with no number is not
    a bucket and is left out. Reads the file and changes nothing."""
    if todo is None:
        return []
    text, _ = _read_text(todo_path(name))
    out = []
    for line in text.splitlines():
        m = todo.BUCKET_RE.match(line)
        if m:
            out.append(("%s. %s" % (m.group(1), m.group(2).strip()), m.group(2).strip()))
    return out


def todo_path(name=None):
    return os.path.join(dataset_dir(name or current_dataset()), "todo.md")


def migrating_path(name=None):
    """The sentinel a migration drops beside todo.md while it works on it.

    Its only job is to make do_PUT refuse. A migration runs with the board shut,
    but a tab left open from before holds a whole pre-migration document and
    autosaves it within four seconds of anything marking it dirty — which
    rollRecurring does on every load, before the owner has touched anything.
    """
    return os.path.join(dataset_dir(name or current_dataset()), ".migrating")

def backup_dir(name=None):
    return os.path.join(dataset_dir(name or current_dataset()), "backups")


def file_hash(path):
    """What todo.md holds right now, as a short content hash.

    Last-Modified is what do_PUT checked first, and it carries one second of
    precision. Two writes inside the same second are indistinguishable to it,
    so the second one lands unrefused on a document built before the first —
    which is the narrow half of the hole the two real losses went through.
    A content hash has no such granularity: it changes when the bytes change
    and not otherwise.

    sha256, the same as the bucket agents' runner (agents/bucket-agent/plans.py),
    which guards the same file for the same reason from the other side. Truncated to
    16 characters because this travels in a header on every read: it is a
    fingerprint for equality, not a signature, and 64 bits is far past enough
    for telling two versions of one file apart.

    None when the file is not there, which is a real state — a dataset that
    has never been written — and one the callers treat as "no opinion".
    """
    try:
        with open(path, "rb") as fh:
            return hashlib.sha256(fh.read()).hexdigest()[:16]
    except OSError:
        return None


def activity_path(name=None):
    """The list's activity log: one JSON line per task added, edited or
    deleted, saying who and when. Append-only, written by do_PUT after each
    save lands and by nothing else, so it is a record and never a source of
    the list. Kept beside todo.md rather than in it because who did what is
    about the list, and the file is the list."""
    return os.path.join(dataset_dir(name or current_dataset()), "activity.jsonl")


def append_activity(ds, changes, who=None, name=None):
    """Adds one save's changes to the log, under the person who made it: the
    signed-in email and name, or on the Mac nobody's email and the owner's
    name from the profile. `who` and `name` say otherwise for the whole save
    (`pa` for an outside edit), and a change carrying its own (an agent's
    card, see take_credits) says otherwise for itself."""
    if not changes:
        return
    import owner_profile
    person = requester()
    at = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    email = who if who is not None else (person["email"] if person else "")
    if name is None:
        name = person["name"] if person else owner_profile.owner_name(DATA_ROOT, board=ds)
    with open(activity_path(ds), "a", encoding="utf-8") as fh:
        for c in changes:
            fh.write(json.dumps(dict({"at": at, "who": email, "name": name}, **c), ensure_ascii=False) + "\n")


# ---- Changes nobody saved from a tab ------------------------------------------
#
# Two kinds of change reach todo.md without a person behind the save. An agent
# never writes the file: it queues a request (core/tick_queue.py), the board
# applies it and saves, so the save is the tab's but the change is the agent's.
# And the pa skill, or anything else, writes the file directly, so the server
# only finds out by seeing the file differ from what it last wrote.

# Cards a drained agent request is about to change, per list, waiting for the
# save that writes them: {task id: {"who", "name", "at"}}. Spent by the save
# that changes the card, and forgotten after AGENT_CREDIT_S, so a request the
# board refused cannot claim an edit somebody makes later. In memory: a
# restart between the drain and the save credits the person who saved.
_agent_credits = {}
AGENT_CREDIT_S = 120


def agent_slug(name):
    """An agent's name as it goes in a tag and the log: `Personal family agent`
    is `personal-family-agent`."""
    return "-".join(str(name).lower().split())


# The one list and the one agent a move request is honoured from, the same as
# MOVE_DATASET and MOVE_AGENT in kanban/js/10-reference-sections.js.
MOVE_DATASET = "content"
MOVE_AGENT = "Content strategist agent"


def credit_agents(ds, entries, text):
    """Notes the cards these queued requests change, only where the board
    applies the request rather than refusing it, since a refused one changes
    nothing and must not claim the next person's edit. A tick credits the task
    its sub-task sits under when the sub-task is the requesting agent's; a
    handover credits its card when the card is open and its `[to::]` still
    names that agent (drainHandover()); a move only on the content list, from
    the content agent, into Reviewing, on an open card (drainMove())."""
    if todo is None:
        return
    parent = {}
    cards = {}
    for t in todo.parse_doc(text or ""):
        if t.stable_id:
            cards[t.stable_id] = t
        for st in todo.split_body(t)[1]:
            step = st["task"]
            if step.stable_id and t.stable_id:
                parent[step.stable_id] = (t.stable_id, step.to)
    now = time.time()
    got = _agent_credits.setdefault(ds, {})
    for e in entries:
        by = str(e.get("by") or "").strip()
        if not by:
            continue
        if e.get("handover"):
            tid = str(e["handover"]).strip().lower()
            card = cards.get(tid)
            want = todo.agent_of(e.get("to")).lower()
            if not card or card.done or not want or want != by.lower() or todo.agent_of(card.to).lower() != want:
                tid = ""
        elif e.get("move"):
            tid = str(e["move"]).strip().lower()
            card = cards.get(tid)
            if (ds != MOVE_DATASET or by != MOVE_AGENT or str(e.get("column") or "").strip() != "Reviewing"
                    or not card or card.done):
                tid = ""
        else:
            tid, to = parent.get(str(e.get("sub") or "").strip().lower(), ("", ""))
            if tid and todo.agent_of(to).lower() != by.lower():
                tid = ""
        if tid:
            got[tid] = {"who": agent_slug(by), "name": by, "at": now}


def take_credits(ds):
    """The agents' cards still waiting for their save, without the stale ones."""
    now = time.time()
    got = {k: v for k, v in _agent_credits.get(ds, {}).items() if now - v["at"] < AGENT_CREDIT_S}
    _agent_credits[ds] = got
    return {k: {"who": v["who"], "name": v["name"]} for k, v in got.items()}


def spend_credits(ds, changes):
    for c in changes:
        if "who" in c:
            _agent_credits.get(ds, {}).pop(c.get("id"), None)


def known_path(ds):
    """The version of todo.md the server last wrote or last accounted for.
    A dotfile, so no route serves it."""
    return os.path.join(dataset_dir(ds), ".known-todo.md")


def remember(ds, text):
    tmp = known_path(ds) + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)
    os.replace(tmp, known_path(ds))


def pa_busy(ds):
    """pa says it is editing the list right now (pa-working.json, less than
    ten minutes old, the same rule the board uses)."""
    try:
        return time.time() - os.path.getmtime(pa_working_path(ds)) < 600
    except OSError:
        return False


# How long the file must have been left alone before the server takes what it
# reads for a finished outside edit. pa and an editor write outside the save
# lock, and a write that is not atomic shows a partial file for as long as it
# takes; a version younger than this is left for the next read.
OUTSIDE_QUIET_S = 1.0


def _steady_read(path):
    """(text, stat) for todo.md, or (None, stat) when the read cannot be
    trusted: the size or modification time moved while it was read, the bytes
    read are not the size the file says, or they are not whole UTF-8 (a write
    cut mid-character). (None, None) when there is no file."""
    try:
        before = os.stat(path)
        with open(path, "rb") as fh:
            raw = fh.read()
        after = os.stat(path)
    except OSError:
        return None, None
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns) or len(raw) != after.st_size:
        return None, after
    try:
        return raw.decode("utf-8"), after
    except UnicodeDecodeError:
        return None, after


def notice_outside_edit(ds, wait=False):
    """Accounts for an edit written straight to todo.md since the server last
    wrote it: the pa skill, or anything else. The difference from the last
    version the server knows goes in the activity log under `pa`, and, signed
    in, the cards it changed are stamped as edited by `pa`. On the Mac only
    the log is written.

    Called before the server reads the list for a tab (GET and HEAD of
    todo.md, which the watcher sends every few seconds) and before a save.
    Held while pa says it is mid-edit, so its edit is accounted for once, as a
    whole, when it finishes, and never stamped under its feet; and while a
    migration holds the list. The first time a list is seen there is nothing
    to compare with, and the version is only remembered.

    The writer is not under the save lock, so nothing here trusts a read the
    writer might still be in the middle of: a changed file is only taken once
    a read of it is steady (_steady_read) and it has been left alone for
    OUTSIDE_QUIET_S, and the stamped version replaces it only if the file is
    still exactly what was read. Otherwise it waits for the next read; a save
    (`wait`) waits here instead, briefly, so it merges with the whole edit."""
    if todo is None or not ds:
        return
    with _save_lock:
        path = todo_path(ds)
        try:
            with open(known_path(ds), encoding="utf-8", newline="") as fh:
                known = fh.read()
        except OSError:
            known = None
        for _ in range(4 if wait else 1):
            text, st = _steady_read(path)
            if st is None:
                return
            if text is not None and text == known:
                return
            age = time.time() - st.st_mtime
            if text is not None and age >= OUTSIDE_QUIET_S:
                break
            if not wait:
                return
            time.sleep(max(0.05, OUTSIDE_QUIET_S - age))
        else:
            return
        if known is None:
            remember(ds, text)
            return
        if pa_busy(ds) or os.path.exists(migrating_path(ds)):
            return
        stamped, changes = todo.stamp_authors(known, text, "pa", write_tags=bool(AUTH))
        if stamped != text:
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8", newline="") as fh:
                fh.write(stamped)
                fh.flush()
                os.fsync(fh.fileno())
            # Compare before replace: a write that landed since the read is
            # not stamped over. It is accounted for on the next read instead.
            try:
                now = os.stat(path)
            except OSError:
                now = None
            if now is None or (now.st_size, now.st_mtime_ns) != (st.st_size, st.st_mtime_ns):
                os.remove(tmp)
                return
            os.replace(tmp, path)
        append_activity(ds, changes, who="pa", name="pa")
        remember(ds, stamped)


def read_activity(ds, limit=50):
    """The newest `limit` entries, newest first, and a name for every email
    the log has seen, the latest name winning. Reads the last 512 KB only,
    which is thousands of entries; an older name falls back to the email."""
    try:
        with open(activity_path(ds), "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - 512 * 1024))
            raw = fh.read().decode("utf-8", "replace")
    except OSError:
        return [], {}
    lines = raw.split("\n")
    if size > 512 * 1024:
        lines = lines[1:]          # the first is most likely cut in half
    entries, names = [], {}
    for line in lines:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if isinstance(e, dict):
            entries.append(e)
            if e.get("who") and e.get("name"):
                names[e["who"]] = board_access.clean_name(e["name"])
    return entries[::-1][:limit], names


def chat_viewed_path(name=None):
    """When each conversation card was last opened, so the drawer's Chats
    field knows which ones to mark unread.

    A separate file from todo.md on purpose, and not a candidate for ever
    being merged into it. When you last looked at something is not task
    content, and todo.md has exactly one writer for reasons the README goes
    into at length. Nothing in here is load-bearing: delete it and every card
    reads as unread once, which is the only thing that is lost.

    """
    return os.path.join(dataset_dir(name or current_dataset()), "chat-viewed.json")


def bucket_colors_path(name=None):
    """Where a bucket's own chosen colour lives: name -> one of the board's
    ten preset swatches (var(--tenon-chart-1) .. var(--tenon-chart-10) — see
    BUCKET_COLOR in kanban/js/02-state.js).

    A separate file for the same reason chat-viewed.json is one: a colour is a
    preference about looking at the list, not a fact the list itself carries,
    and todo.md has exactly one writer. Keyed by name rather than position, on
    purpose — reordering the buckets must not reshuffle which colour each one
    wears, which is what deriving it from the array index always did before.
    Renaming a bucket does orphan its entry here, same as a renamed bucket
    already drops out of anything else keyed by name in this app; picking a
    colour again after a rename costs one click, and losing it silently would
    be a worse failure than that.
    """
    return os.path.join(dataset_dir(name or current_dataset()), "bucket-colors.json")


def bucket_themes_path(name=None):
    """Where a bucket's own declared themes live: name -> an ordered list of
    theme strings (see state.bucketThemes in kanban/js/02-state.js).

    A separate file for the same reason bucket-colors.json is one: which
    themes a bucket is sub-organised into is a fact about how the owner works, not a
    fact any one task carries, and todo.md has exactly one writer. Keyed by
    name rather than position, same trade bucket-colors.json makes: a rename
    orphans the entry, and re-declaring the list after a rename costs less
    than losing it silently would.
    """
    return os.path.join(dataset_dir(name or current_dataset()), "bucket-themes.json")


def column_names_path(name=None):
    """What a column is *called on screen*, when that differs from its heading.

    Backlog, To do, Doing, Reviewing and Done are matched by their
    exact text all through the board and by every other reader of the list —
    the companion, the bucket agents, core/todo.py — so renameTier() refuses
    to rename one. A label here is the way round that: the `### To do` heading
    in todo.md stays exactly as it is and the board draws whatever word is set
    for it, so nothing outside the board is affected and nothing is migrated.

    A separate file for the same reason bucket-colors.json is one: what a
    column is called on screen is a preference about looking at the list, not
    a fact the list carries, and todo.md has exactly one writer. Keyed by the
    real heading, so an entry is orphaned if that heading is ever renamed for
    real — the same trade bucket-colors.json already makes.
    """
    return os.path.join(dataset_dir(name or current_dataset()), "column-names.json")


def bucket_brief_path(bucket, name=None):
    """A bucket's own brief, resolved the way its agent resolves it.

    stream_of() in core/bucket_agents.py maps a heading to its stream, and the
    brief, the folder and the agent are all named off it, so the board edits
    the file the agent actually reads.

    Returns (stream, path), or (None, None) for a heading that names no stream:
    there is no brief to edit there, and the board says so rather than writing
    a file nothing would read.
    """
    ds = name or current_dataset()
    stream = bucket_agents.stream_of(ds, bucket, DATA_ROOT)
    if not stream:
        return None, None
    base = os.path.join(dataset_dir(ds), "buckets")
    return stream, os.path.join(base, stream, "%s.md" % stream)


def brief_template():
    """The template a new brief opens on, read out of
    agents/bucket-agent/bucket-brief.template.md (bucket_agents.TEMPLATE).

    Read rather than copied, because a second copy in here is a second thing to
    keep in step. An empty string if it cannot be found, which costs an empty box.
    """
    try:
        with open(bucket_agents.TEMPLATE, encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return ""


def briefings_path(name=None):
    """Where agents/bucket-agent/brief.py leaves what it has worked out about
    each task — direction, what's done, what's still needed — one per task,
    keyed the same way the ledger is (stable id, falling back to title).

    A separate file for the same reason bucket-colors.json is one: generated
    prose the board only ever reads, never a fact todo.md itself carries, so
    it stays out of the one-writer rule entirely. See IMPROVEMENTS.md, "Every
    place that hands a task to an assistant re-derives its own understanding
    from the same chaotic notes field."
    """
    return os.path.join(dataset_dir(name or current_dataset()), "briefings.json")


def attach_queue_path(name=None):
    """Where /pa-attach leaves what it could not write itself.

    The skill knows a session's id and its own cwd — CLAUDE_CODE_SESSION_ID
    and os.getcwd() — and which task it should be filed against, but it must
    not touch todo.md: the board holds the whole document in memory and
    autosaves it, so a second writer editing the file underneath an open tab
    is exactly the failure this repo is built to avoid. So the skill writes
    what it wants here and stops. loadFile() drains this on every real load,
    once state.locked is confirmed false — minting any `chat:` key it needs
    through the board's own edit path, filing the session, and clearing
    whatever it managed. An entry whose task has since been renamed or
    deleted is left behind rather than dropped, so nothing queued is ever
    silently lost.
    """
    return os.path.join(dataset_dir(name or current_dataset()), "attach-queue.json")


def tick_queue_path(name=None):
    """Where an agent asks for a sub-task to be ticked. See core/tick_queue.py.

    The board reads it on load and applies each request through its own edit
    path, so no agent ever writes todo.md. It takes entries out by id rather than
    rewriting the list, which is why the write route below is a removal and not
    a replacement.
    """
    return os.path.join(dataset_dir(name or current_dataset()), "tick-queue.json")


def pa_working_path(name=None):
    """Where the `pa` skill says which tasks it is about to change.

    Written just before its edit to todo.md and deleted just after, by
    agents/pa_agent/skills/pa/scripts/pa_working.py, so the board can make
    those cards glow while the edit is under way and hold its reload until it
    is finished. The board only ever reads it.
    """
    return os.path.join(dataset_dir(name or current_dataset()), "pa-working.json")


def task_history(task_id, name=None):
    """One task's history, oldest first: which specialist an owning agent brought
    in on it (core/history.py). Read-only; the agents append and nothing here
    writes. An event the work-streams contract refuses is left out rather than
    drawn half-right, and with the package absent every well-formed line passes.
    """
    import history as history_log
    path = os.path.join(dataset_dir(name or current_dataset()), "history.jsonl")
    events = history_log.read(path, about=task_id) if task_id else []
    check = getattr(ws_manifest, "validate_event", None) if ws_manifest else None
    return [e for e in events if not check or not check(e)]


def agent_runs_path(name=None):
    """Where each agent run on a sub-task stands. See core/agent_runs.py.

    The agents write it; the board reads it for the status line on a card and
    the activity feed on a sub-task, and asks for two changes of the owner's through
    POST /agent-runs: retry and clear.
    """
    return os.path.join(dataset_dir(name or current_dataset()), "agent-runs.json")


def reports_dir(name=None):
    # Written reports live beside the list they're about rather than in the
    # repo, because a report names people, dates and internal decisions — the
    # same reasons todo.md itself never leaves data/. One per dataset, same
    # as backups.
    return os.path.join(dataset_dir(name or current_dataset()), "reports")


def projects_dir(name=None):
    # Where a task's own "- Project: data/projects/<name>" note points, and
    # where the board starts a new one: the list's projects folder when
    # settings.json names one (see core/project_folders.py), else
    # data/<list>/projects/.
    # Nothing here is a fact todo.md tracks — a folder appears the moment
    # someone creates it and vanishes the moment someone deletes it, with no
    # signal from the list either way. project_listing() below is what lets a
    # folder be seen before, or after, any task happens to mention it.
    return project_folders.home(dataset_dir(name or current_dataset()))


def project_homes(name=None):
    # Every place a project may be without being approved, in the order a
    # bare name is looked for: projects_dir() first, the list's own after.
    return project_folders.homes(dataset_dir(name or current_dataset()))


# "Opened 26 Aug 2026." — the line every project CLAUDE.md written by the PA
# carries under its lead paragraph. It is the only start date a project folder
# has: nothing on disk records when a folder was made, and a folder's own
# ctime is the day it was last moved rather than the day it was opened.
# The date and nothing after it: several of these carry a clause explaining
# where the folder came from, and "6 Sep 2026, from four files that had been
# sitting loose at the root of the workspace folder since" is not a date.
OPENED_RE = re.compile(r"^Opened\s+(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})", re.I)


def project_about(path):
    """The folder's own description, out of the top of its CLAUDE.md.

    No frontmatter anywhere here, and none worth adding: every one of these
    files already opens the same way, an H1 naming the project and a lead
    paragraph saying what it is, because the PA wrote them all to the same
    shape. That shape is the metadata — read it rather than asking the owner to
    maintain a second copy of it in a header.

    Only the head of the file is read. The rest is the project itself, which
    is exactly what the drawer has always said it does not open.
    """
    out = {"title": "", "blurb": "", "opened": ""}
    try:
        with open(os.path.join(path, "CLAUDE.md"), encoding="utf-8") as fh:
            head = fh.read(4000)
    except (OSError, UnicodeDecodeError):
        return out
    lines = head.splitlines()
    i = 0
    while i < len(lines) and not lines[i].startswith("# "):
        i += 1
    if i < len(lines):
        out["title"] = lines[i][2:].strip()
        i += 1
    # The lead paragraph: everything up to the next blank line or heading,
    # rewrapped, since the file is hard-wrapped at 90 and the drawer is not.
    para = []
    while i < len(lines) and not lines[i].strip():
        i += 1
    while i < len(lines) and lines[i].strip() and not lines[i].startswith("#"):
        para.append(lines[i].strip())
        i += 1
    # Every one of these paragraphs ends the same two ways — "this folder is
    # the context" and "the tasks live in ../../todo.md and only carry the
    # essentials". Both are filing rather than description: the drawer is the
    # folder, and it lists those tasks a few inches below this.
    text = " ".join(para)
    skip = ("todo.md", "this folder is the context")
    kept = [s for s in re.split(r"(?<=\.)\s+", text)
            if not any(w in s.lower() for w in skip)]
    out["blurb"] = " ".join(kept).strip() or text
    for line in lines:
        m = OPENED_RE.match(line.strip())
        if m:
            out["opened"] = m.group(1).strip()
            break
    return out


def project_meta(path, name):
    """One project folder, described without opening every file inside it.

    Nothing on disk declares a title or a status for one of these folders —
    CLAUDE.md's presence is the only signal, and the folder name and its own
    modified time are the rest. Whether it is "live" (a task currently points
    at it) is left to the board: it already holds every task in memory and
    already knows how to scan one for a project note, so repeating that scan
    here would be a second copy of the same rule.
    """
    try:
        st = os.stat(path)
    except OSError:
        return None
    if not os.path.isdir(path):
        return None
    entries = [e for e in os.listdir(path) if not e.startswith(".")]
    latest = st.st_mtime
    for entry in entries:
        try:
            latest = max(latest, os.stat(os.path.join(path, entry)).st_mtime)
        except OSError:
            pass
    about = project_about(path)
    return {
        "name": name,
        # The H1 out of CLAUDE.md — "Individual Role Profiles" where the
        # folder is called career-framework-revisions. The folder name stays the identity
        # (it is what a task's note points at); this is only what to call it
        # on screen.
        "title": about["title"],
        "blurb": about["blurb"],
        "opened": about["opened"],
        "has_claude_md": "CLAUDE.md" in entries,
        "file_count": len(entries),
        # When the project was last touched, not when the folder was: the
        # newest mtime across the folder and everything directly inside it.
        # A file edited two levels down still counts, because writing it bumps
        # its own folder, and that folder is one of the entries here. Nothing
        # has to be written or maintained for this to be true — which is why
        # there is no "last edited" line in CLAUDE.md for anyone to forget.
        "modified": datetime.datetime.fromtimestamp(latest).isoformat(timespec="seconds"),
        # No dataset name in this, deliberately — see the same note on plan_meta.
        "url": "/" + DATA + "/projects/" + name + "/",
    }


def project_entries(path):
    """What is in one project folder, one level down and no further.

    A folder is a row like any other, carrying its own child count rather
    than its contents — a project keeping its documents in sources/ would
    otherwise flood the panel with someone else's filing, and a walk deep
    enough to be useful is deep enough to be slow on a folder holding a
    checkout. Clicking the row opens the folder in the browser's own
    directory listing, which is the walk, on demand.
    """
    out = []
    try:
        names = sorted(os.listdir(path))
    except OSError:
        return out
    for name in names:
        if name.startswith("."):
            continue
        full = os.path.join(path, name)
        try:
            st = os.stat(full)
        except OSError:
            continue
        isdir = os.path.isdir(full)
        kids = None
        if isdir:
            try:
                kids = len([e for e in os.listdir(full) if not e.startswith(".")])
            except OSError:
                kids = None
        out.append({
            "name": name,
            "dir": isdir,
            "size": None if isdir else st.st_size,
            "children": kids,
            "modified": datetime.datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
        })
    # Folders first, then files, each alphabetically — the same order a file
    # manager uses, and the one that keeps sources/ from hiding under n files.
    out.sort(key=lambda e: (not e["dir"], e["name"].lower()))
    return out


def project_subfolder(real, sub):
    """A folder inside a project, for the drawer's in-place folder rows.

    `sub` is a slash path below the project folder. Returns (path, None), or
    (None, (status, message)) for anything that is not a plain folder below it:
    an absolute path, a hop, a hidden name, a backslash, a missing folder, or a
    symlink that leads out. The same bar project_folders.resolve() sets for the
    project itself, since this is a second way to read inside it.
    """
    parts = sub.split("/")
    if os.path.isabs(sub) or "\\" in sub or "\0" in sub or any(
            p in ("", ".", "..") or p.startswith(".") for p in parts):
        return None, (400, "bad folder path")
    top = os.path.realpath(real)
    full = os.path.realpath(os.path.join(top, *parts))
    if full == top or not full.startswith(top + os.sep):
        return None, (403, "outside the project folder")
    if not os.path.isdir(full):
        return None, (404, "no such folder")
    return full, None


def project_listing():
    """Every project folder on disk, alphabetically — live or not.

    taskProject() (kanban/js/06-dates-substeps.js) only ever finds a folder
    some task's own body happens to mention. This walks project_homes()
    directly, so a folder nothing on the list points at yet, or any more,
    still shows up. A name in more than one is listed once, as the folder it
    resolves to. After those come the folders the owner has approved elsewhere on
    disk (data/<dataset>/project-folders.json), each one a project in itself
    and named by its path, which is what a task's note carries for one.
    """
    ddir = dataset_dir(current_dataset())
    names = set()
    for pdir in project_homes():
        if os.path.isdir(pdir):
            names.update(n for n in os.listdir(pdir) if not n.startswith("."))
    out = []
    for name in sorted(names):
        # Through the same check /project.json uses, so a symlink leading
        # out of data/projects/ is not listed as though it were inside.
        real, err = project_folders.resolve(name, ddir)
        meta = project_meta(real, name) if real else None
        if meta:
            out.append(meta)
    for folder in project_folders.read_approved(ddir):
        real, err = project_folders.resolve(folder, ddir)
        meta = project_meta(real, folder) if real else None
        if meta:
            out.append(external_project(meta, real))
    return out


def external_project(meta, real):
    """A project_meta() for a folder outside data/, which is not served over
    HTTP: its url goes, and its real path comes, so the drawer shows where it
    is and offers Open folder rather than links that would 404."""
    meta["url"] = None
    meta["path"] = real
    meta["external"] = True
    return meta


def project_seed(title, when=None):
    """The CLAUDE.md a folder started from the board opens with: an H1 and a
    lead paragraph, the shape project_about() reads back, and the Opened line."""
    when = when or datetime.date.today()
    title = re.sub(r"\s+", " ", title or "").strip() or "Untitled project"
    return ("# %s\n\n"
            "Started from the board for the task \u201c%s\u201d. The background, the "
            "decisions taken and the working files for it go here.\n\n"
            "Opened %d %s.\n" % (title, title, when.day, when.strftime("%b %Y")))


def start_project(name, title):
    """Make a folder under projects_dir() and seed its CLAUDE.md.

    Returns (folder name, None) or (None, (status, message)). The name is
    slugified, so nothing typed can climb out of the default place, and the
    result is checked the same way every other project path is.
    """
    slug = slugify(name or title)
    if not slug:
        return None, (400, "that name has nothing usable in it")
    pdir = projects_dir()
    os.makedirs(pdir, exist_ok=True)
    target = os.path.join(pdir, slug)
    if not project_folders.inside(os.path.realpath(pdir), os.path.realpath(target)):
        return None, (400, "bad project name")
    # The same name in a later home would be shadowed by this one.
    if any(os.path.lexists(os.path.join(h, slug)) for h in project_homes()):
        return None, (409, "there is already a project folder called \u201c%s\u201d" % slug)
    try:
        os.mkdir(target)
    except FileExistsError:
        return None, (409, "there is already a project folder called \u201c%s\u201d" % slug)
    with open(os.path.join(target, "CLAUDE.md"), "w", encoding="utf-8") as fh:
        fh.write(project_seed(title or name))
    return slug, None


# Same five states every other data set starts with, so a brand new list's
# columns read the same on the board as any other's from the first save —
# not because these are special to the board (any heading works, and the
# Columns editor can rename, add to, or remove from all but Done), but
# because nothing is more confusing than a second list whose board looks
# unlike the first for no reason anyone chose. Done is first because the
# board draws a bucket's headings the other way round.
NEW_DATASET_COLUMNS = ("Done", "Reviewing", "Doing", "To do", "Backlog")
NEW_DATASET_TEMPLATE = (
    "# To-do\n\n"
    "## 1. Tasks\n\n"
    "### Done\n\n"
    "### Reviewing\n\n"
    "### Doing\n\n"
    "### To do\n\n"
    "### Backlog\n\n"
)

# The marker the brief template defines: while it is in a brief, no agent is pointed at
# the file. A brief scaffolded with a description the owner typed does not carry it —
# the description is the one line the template asks for, so the file is started
# rather than empty.
BRIEF_EMPTY = "<!-- NOT FILLED IN YET -->"
BRIEF_ABOUT = "<One line: what kind of work lands in this bucket.>"


def buckets_dir(name=None):
    return os.path.join(dataset_dir(name or current_dataset()), "buckets")


def brief_text(name, about=""):
    """One bucket's brief, from the brief template.

    Read through brief_template() rather than held here, for the reason that
    function already gives: a second copy is a second thing to keep in step.

    A description the owner typed becomes the template's own one-line opening, and
    takes the empty marker out with it. That is the whole difference between a
    scaffolded brief and an empty one: the first says what the bucket is for
    and can be planned against, the second is a page of headings no agent will
    be pointed at.
    """
    body = brief_template() or ("# <Bucket name>\n\n%s\n\n%s\n" % (BRIEF_ABOUT, BRIEF_EMPTY))
    about = " ".join((about or "").split())
    body = body.replace("<Bucket name>", name)
    if about:
        body = body.replace(BRIEF_ABOUT, about)
        # The marker and the sentence under it explaining the marker.
        body = re.sub(r"\n?" + re.escape(BRIEF_EMPTY) + r"\n+> [^\n]*\n(> [^\n]*\n)*", "\n", body)
        body = body.replace(BRIEF_EMPTY + "\n", "")
    return body.lstrip("\n")


def buckets_readme(dataset, buckets):
    """The table `stream_map()` in core/bucket_agents.py reads a bucket's stream out of.

    It is what lets a bucket be renamed without moving its brief, so it is
    written at creation rather than left for someone to remember — the entry
    this replaces existed because nobody ever did.
    """
    rows = "".join(
        "| `## %d. %s` | `%s` | `%s/%s.md` |\n" % (i + 1, b["name"], b["stream"],
                                                   b["stream"], b["stream"])
        for i, b in enumerate(buckets))
    return (
        "# The %s list's buckets\n\n"
        "What this dataset actually has. The rules, the template and how a brief "
        "is found are described in `README.md` at the root of the repo.\n\n"
        "| Heading in `todo.md` | Stream | Brief |\n"
        "| --- | --- | --- |\n"
        "%s\n"
        "**This table is what fixes a bucket's stream.** `stream_map()` in\n"
        "`core/bucket_agents.py` reads it, and the bucket editor rewrites a\n"
        "row when a bucket is renamed — which is how a heading can change without\n"
        "the brief, the folder or the planner moving with it.\n\n"
        "A heading with no row here slugifies instead: strip the leading number,\n"
        "lowercase, hyphens for spaces.\n" % (dataset, rows))


def scaffold_bucket(dataset, name, stream, about=""):
    """One bucket's folder, brief and `skills/`, written once.

    Never overwrites: adding a bucket that already has a brief is somebody
    re-adding a heading they deleted, and their brief is the thing worth
    keeping.
    """
    folder = os.path.join(buckets_dir(dataset), stream)
    os.makedirs(os.path.join(folder, "skills"), exist_ok=True)
    path = os.path.join(folder, "%s.md" % stream)
    if not os.path.exists(path):
        with open(path, "w", encoding="utf-8", newline="") as fh:
            fh.write(brief_text(name, about))
    return path


def readme_rows(dataset=None):
    """The table in a dataset's buckets/README.md, as (heading, stream) pairs.

    Read and written here rather than only parsed in core/bucket_agents.py, because the board
    is what keeps it in step: adding a bucket writes a row, renaming one
    rewrites its heading, and nothing else on the machine touches the file.
    """
    path = os.path.join(buckets_dir(dataset), "README.md")
    rows = []
    try:
        with open(path, encoding="utf-8") as fh:
            body = fh.read()
    except OSError:
        return rows, ""
    for line in body.splitlines():
        m = re.match(r"^\|\s*`?([^|`]+)`?\s*\|\s*`?([a-z0-9-]+)`?\s*\|", line.strip())
        if m and m.group(1).strip() not in ("Heading in `todo.md`", "---"):
            rows.append((m.group(1).strip(), m.group(2).strip()))
    return rows, body


def bucket_heading_key(heading):
    """A heading as plan.bucket_slug() would read it, so the board and the
    planner agree on which row belongs to which bucket."""
    key = re.sub(r"^#+\s*", "", heading or "")
    key = re.sub(r"^\d+[.)]\s*", "", key).strip().lower()
    return re.sub(r"[^a-z0-9]+", "-", key).strip("-")


def readme_note_bucket(dataset, heading, stream, was=None):
    """Add a bucket's row to the README, or move an existing one to a new heading.

    A rename is the case this exists for. The stream is fixed when the bucket is
    created, so renaming `Personal Tasks` to `Family stuff` must keep the
    `personal-tasks` folder, brief and planner — and the only thing that can say
    so is this row, since the new heading slugifies to something else entirely.
    """
    rows, body = readme_rows(dataset)
    path = os.path.join(buckets_dir(dataset), "README.md")
    want = "## %s" % heading.lstrip("# ").strip()
    keep = []
    replaced = False
    for h, st in rows:
        if was is not None and bucket_heading_key(h) == bucket_heading_key(was):
            keep.append((want, stream))
            replaced = True
            continue
        if bucket_heading_key(h) == bucket_heading_key(heading):
            keep.append((want, stream))
            replaced = True
            continue
        keep.append((h, st))
    if not replaced:
        keep.append((want, stream))
    table = "".join("| `%s` | `%s` | `%s/%s.md` |\n" % (h, st, st, st) for h, st in keep)
    head = "| Heading in `todo.md` | Stream | Brief |\n| --- | --- | --- |\n"
    if body:
        # Replace the table where it stands, so whatever prose is around it
        # survives — the owner's own notes about the list live in this file too.
        new = re.sub(r"\| Heading in `todo\.md`.*?(?=\n\n|\Z)", (head + table).rstrip("\n"),
                     body, count=1, flags=re.S)
        if new == body:
            new = body.rstrip("\n") + "\n\n" + head + table
    else:
        new = buckets_readme(dataset or current_dataset(), [])
        new = new.replace(head, head + table)
    os.makedirs(buckets_dir(dataset), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(new)
    return stream


def sharing_from(raw, who):
    """The access.json a new list starts with, from the wizard's sharing step.

    Personal (the default, and what the first-list form sends by sending
    nothing) is only the person making it. Shared names teams they are in, or
    people by email, or both."""
    raw = raw if isinstance(raw, dict) else {}
    if raw.get("kind", "personal") == "personal":
        return board_access.clean(who["email"])
    if raw.get("kind") != "shared":
        return None, "sharing is personal or shared"
    access, err = board_access.clean(who["email"], raw.get("people") or [], raw.get("teams") or [])
    if err:
        return None, err
    stray = set(access["teams"]) - set(who["teams"])
    if stray:
        return None, "you are not in %s" % ", ".join(sorted(stray))
    if not access["people"] and not access["teams"]:
        return None, "a shared list needs a team or a person to share it with"
    return access, None


def create_dataset(name, buckets=None):
    """A new list, with everything that makes it work rather than only a todo.md.

    A todo.md alone would leave no brief per bucket and no `buckets/README.md`
    saying which buckets the list has, so every task in it would plan against
    the fallback.

    `buckets` is a list of {name, about}. Nothing passed is the old behaviour,
    one bucket called Tasks, which is what an older board still posts.
    """
    path = dataset_dir(name)
    if os.path.exists(path):
        return False
    os.makedirs(path)
    buckets = [b for b in (buckets or []) if (b.get("name") or "").strip()] or [{"name": "Tasks"}]
    for b in buckets:
        b["name"] = " ".join(str(b["name"]).split())
        b["stream"] = slugify(b["name"]) or "general"
    lines = ["# To-do", ""]
    for i, b in enumerate(buckets):
        lines.append("## %d. %s" % (i + 1, b["name"]))
        lines.append("")
        for col in NEW_DATASET_COLUMNS:
            lines += ["### %s" % col, ""]
    with _save_lock:
        with open(os.path.join(path, "todo.md"), "w", encoding="utf-8", newline="") as fh:
            fh.write("\n".join(lines))
        remember(name, "\n".join(lines))
    os.makedirs(buckets_dir(name), exist_ok=True)
    with open(os.path.join(buckets_dir(name), "README.md"), "w",
              encoding="utf-8", newline="") as fh:
        fh.write(buckets_readme(name, buckets))
    for b in buckets:
        scaffold_bucket(name, b["name"], b["stream"], b.get("about", ""))
    return True


SESSION_PREFIX = "todo-backup-"
WEEKLY_PREFIX = "todo-backup-week-"
KEEP_BACKUPS = 50      # rolling snapshots, one per run of the board
KEEP_WEEKLY = 12       # weekly snapshots, roughly a quarter of history


def is_weekly(name):
    return name.startswith(WEEKLY_PREFIX)


def week_tag(when=None):
    """ISO week label, e.g. 2026-W33. Weeks start on Monday."""
    year, week, _ = (when or datetime.date.today()).isocalendar()
    return "%04d-W%02d" % (year, week)


def backup_names():
    bdir = backup_dir()
    if not os.path.isdir(bdir):
        return []
    return sorted(n for n in os.listdir(bdir)
                  if n.startswith(SESSION_PREFIX) and n.endswith(".md"))


def prune_backups():
    """Keep the folder small without ever touching the weekly snapshots.

    The rolling backups exist to undo the last few sessions, so ten is plenty.
    The weekly ones are the long memory and are pruned on their own, far slower
    schedule — otherwise a busy fortnight of saves would quietly delete the
    only copy of how the list looked last month.
    """
    bdir = backup_dir()
    names = backup_names()
    session = [n for n in names if not is_weekly(n)]
    weekly = [n for n in names if is_weekly(n)]
    for old in session[:-KEEP_BACKUPS] + weekly[:-KEEP_WEEKLY]:
        try:
            os.remove(os.path.join(bdir, old))
        except OSError:
            pass


def weekly_backup():
    """One snapshot per calendar week, the first time the board notices a new week.

    Taken whether or not anything was saved, so a week that opened with the
    board running is captured as it was before that week's edits started.
    Returns the file name if one was written, otherwise None.
    """
    path = todo_path()
    if not os.path.exists(path):
        return None
    bdir = backup_dir()
    name = WEEKLY_PREFIX + week_tag() + ".md"
    dest = os.path.join(bdir, name)
    if os.path.exists(dest):
        return None
    os.makedirs(bdir, exist_ok=True)
    shutil.copy2(path, dest)
    prune_backups()
    return name


def weekly_backup_watcher(every=1800):
    """Check for a new week while the board runs, so crossing midnight on a
    Sunday is enough to trigger the snapshot — no save required. Runs against
    whichever dataset is current at the moment it fires, same as a save does."""
    while True:
        try:
            ds = current_dataset()
            name = weekly_backup()
            if name:
                sys.stdout.write("weekly backup: %s/%s/backups/%s\n" % (DATA, ds, name))
                sys.stdout.flush()
        except OSError as err:
            sys.stdout.write("weekly backup failed: %s\n" % err)
        time.sleep(every)


# ---- The schedule, and what the usage windows have been doing ---------------
#
# Three things around this app run on a clock rather than on demand, and until
# now the only way to know whether any of them had actually fired was to go and
# look in three different places. This is that, as one list.
#
# Two sources, and they are not alternatives:
#
#   Live   whether a job is installed and armed, and when it fires next. Only
#          the system knows that, and a log will happily describe a job that was
#          unloaded a week ago.
#   Ledger what actually happened. launchctl cannot tell you the bucket agents
#          wrote three plans and stopped on a usage limit.
#
# Everything here is read-only and local. `launchctl` is shelled out to with a
# short timeout, and its absence is a real and expected answer rather than an
# error: an uninstalled job is exactly the thing this view is most useful for
# saying out loud.

def _launchctl(args, timeout=3):
    import subprocess
    # launchd is the Mac's. Anywhere else nothing is loaded in it, which is
    # the same answer as a Mac with the job not installed.
    if sys.platform != "darwin":
        return ""
    try:
        p = subprocess.run(["/bin/launchctl"] + args, capture_output=True,
                           text=True, timeout=timeout)
        return p.stdout if p.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def _tail(path, n=12):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return [l.rstrip("\n") for l in fh.readlines()[-n:]]
    except OSError:
        return []


def board_holiday_regions(board):
    """A board's holiday regions for its banners, from its own profile
    (owner_profile.board_holiday_regions)."""
    import owner_profile
    return owner_profile.board_holiday_regions(dataset_dir(board), DATA_ROOT)


# The thread notify_due.start() returned, or None when banners are off here.
NOTIFIER = {"thread": None}


def _banners_job():
    """Desktop banners for due tasks: a thread inside this server (core/
    notify_due.py), so armed means the server is up on a Mac with
    terminal-notifier. The Electron companion that did this is retired."""
    import notify_due
    on = NOTIFIER["thread"] is not None and NOTIFIER["thread"].is_alive()
    if on:
        hint = ""
    elif os.environ.get("BENCH_NOTIFY") == "0":
        hint = "switched off by BENCH_NOTIFY=0"
    elif sys.platform != "darwin":
        hint = "banners are Mac only"
    elif not notify_due.find_notifier():
        hint = "install terminal-notifier (brew install terminal-notifier)"
    else:
        hint = "not started on this server"
    last = notify_due.STATUS["last_tick"]
    nxt = ""
    if on and todo is not None:
        boards = list_datasets(everyone=True)
        days = notify_due.calendars(boards, board_holiday_regions)
        import owner_profile
        regions = owner_profile.holiday_regions(DATA_ROOT)
        nxt = notify_due.next_banner(
            DATA_ROOT, boards, datetime.datetime.now(),
            lambda d: todo.is_working_day(d, regions),
            lambda p: _steady_read(p)[0], working_for=days.get).isoformat(timespec="minutes")
    return {
        "id": "banners",
        "name": "Desktop banners",
        "what": "A banner when a task or sub-task falls due, one the next working day if it is still open, and the lines agents queue.",
        "schedule": "every minute while the board is running",
        "armed": on,
        "state": "running" if on else "not running",
        "next": nxt,
        "last": "checked at %s" % last.strftime("%H:%M") if last else "has not checked yet",
        "recent": [],
        "hint": hint,
        "lock": False,
    }


def _weekly_job():
    """A thread inside this server, so armed means the server is up."""
    weekly = [b for b in backup_listing() if b.get("kind") == "weekly"]
    return {
        "id": "weekly-backup",
        "name": "Weekly backup",
        "what": "One snapshot of todo.md a week, kept for %d weeks." % KEEP_WEEKLY,
        "schedule": "checked every 30 minutes while the board is running",
        "armed": True,
        "state": "running, in this server",
        "next": "",
        "last": ("%s, %s" % (weekly[0]["name"], weekly[0]["modified"])
                 if weekly else "none taken yet"),
        "recent": [b["name"] for b in weekly[:4]],
        "hint": "",
    }


def schedule_listing():
    out = []
    for fn in (_banners_job, _weekly_job):
        try:
            out.append(fn())
        except Exception as exc:                     # noqa: BLE001
            # One job failing to describe itself must not empty the whole view.
            out.append({"id": "?", "name": fn.__name__, "state": "could not read",
                        "what": str(exc)[:200], "armed": False, "schedule": "",
                        "next": "", "last": "", "recent": [], "hint": ""})
    return out


_usage_cache = {"at": 0.0, "data": None}


def ceiling(wins, roll, state):
    """What counts as 100% on the usage chart, and where the figure came from.

    The chart is a percentage of an allowance, and no allowance appears anywhere
    on disk: `core/windows.py` reconstructs what each window spent, and the error
    a real limit returns names the reset time but not the ceiling. So there are
    two sources and they are not equal.

      measured  a run was actually refused, and the runner wrote what the window
                had spent at that moment into window.json. A real floor under
                the true allowance, and the honest answer.
      observed  no limit has been hit yet, so the busiest window in the period
                stands in for the ceiling. That is not the allowance and the
                card says so — it is "against the heaviest session you have
                had", which still answers whether today is unusual.

    The week has no measured source at all. Nothing here has any notion of a
    weekly allowance, so it is always the busiest seven days seen.
    """
    seen = max((w["tok"] for w in wins), default=0)
    measured = (state or {}).get("limit_tok") or 0
    return {
        "session": max(measured, seen, 1),
        "week": max((r["tok"] for r in roll), default=0) or 1,
        "source": "measured" if measured >= seen and measured else "observed",
        "measuredAt": (state or {}).get("limit_tok_at", ""),
    }


def rolling_week(wins, days):
    """Tokens used in the seven days ending on each day of the range.

    The weekly half of the usage chart, and a rolling total rather than a share
    of anything, because nothing here knows what the ceiling is. `core/windows.py`
    reconstructs windows from the transcripts and can say what each one used; no
    limit figure appears anywhere on disk, and the error a real limit returns
    names the reset time but not the allowance. So the chart answers "is this
    trending down" rather than "how much is left", which is the question actually
    being asked of it.

    A window is counted on the day it opened. Windows run five hours and some
    cross midnight, and splitting one across two days would be more precise about
    a number nobody reads and less honest about the thing being counted, which is
    sessions rather than hours.

    The first six days of the range are short by construction — a seven-day total
    needs seven days behind it — so they are not returned at all. A line that
    ramps up from nothing for its first week looks like a trend and is an
    artefact.
    """
    if not wins:
        return []
    per_day = {}
    for w in wins:
        day = w["start"].date()
        per_day[day] = per_day.get(day, 0) + w["tok"]
    last = datetime.date.today()
    first = last - datetime.timedelta(days=days - 1)
    out = []
    day = first + datetime.timedelta(days=6)
    while day <= last:
        total = sum(per_day.get(day - datetime.timedelta(days=n), 0) for n in range(7))
        out.append({"day": day.isoformat(), "tok": total})
        day += datetime.timedelta(days=1)
    return out


def window_shape(w, steps=14):
    """A window's spend curve, thinned to something worth sending.

    `shape` off reconstruct() is one point per turn, and a busy window holds
    several hundred — thirty days of them is megabytes of JSON to draw a box
    two hundred pixels wide. Sampled at even points across the window's own
    five hours rather than every nth turn, because the chart plots it against
    time: a window with four hundred turns in its first ten minutes and none
    after should draw as a step, and taking every nth turn would draw it as a
    ramp. The last point is the window's total, always, so the curve ends
    where the box's top edge is.

    Each point is (fraction of the window elapsed, fraction of its spend), both
    0 to 1, so the client needs neither the window's clock nor its total to
    draw it.
    """
    pts = w.get("shape") or []
    if not pts or not w["tok"]:
        return []
    span = (w["end"] - w["start"]).total_seconds() or 1
    out, i = [], 0
    for s in range(1, steps + 1):
        at = s / steps
        cutoff = w["start"] + datetime.timedelta(seconds=span * at)
        while i < len(pts) and pts[i][0] <= cutoff:
            i += 1
        # i is now the first turn after the cutoff, so i-1 is the running total
        # as at the cutoff. Nothing yet spent reads as a flat 0, which is right.
        run = pts[i - 1][1] if i else 0
        out.append([round(at, 4), round(run / w["tok"], 4)])
    return out


BASELINE_DAYS = 30


def usage_summary(days=30, ttl=60):
    """The rolling 5-hour usage windows, from core/windows.py.

    Cached, because reconstructing a month is about forty thousand transcript
    lines and a second or so — fine on demand, not fine on every render. Keyed
    on `days`, since the card's range buttons ask for four different spans and
    a cache that ignored which one was asked for would answer the wrong one.

    Always reconstructs the full baseline and then narrows, rather than
    reconstructing only what is being looked at. The reason is the axis: 100%
    is the heaviest session seen, so a three-day view that worked out its own
    ceiling would call its own busiest window 100% and every range would mean
    something different. The chart is there to answer "is today unusual", and
    the comparison has to be against the month either way. The rolling
    seven-day line needs the same — seven days of history behind each point.

    So the range buttons buy legibility, not speed. That was always the
    complaint: eighty-three windows in a 380px column is a barcode.
    """
    if windows is None:
        return {"available": False}
    now = time.time()
    if _usage_cache.get("days") == days and _usage_cache["data"] and now - _usage_cache["at"] < ttl:
        return _usage_cache["data"]

    span = max(days, BASELINE_DAYS)
    since = datetime.datetime.now().astimezone() - datetime.timedelta(days=span)
    every = windows.reconstruct(windows.turns(since=since))
    state = windows.read_state(os.path.join(plans_dir(), "window.json"))
    win = windows.current(state=state)
    # The ceiling and the weekly line are worked out over the whole baseline;
    # only what is drawn is cut back to the range asked for.
    roll = rolling_week(every, span)
    cap = ceiling(every, roll, state)

    cut = datetime.datetime.now().astimezone() - datetime.timedelta(days=days)
    wins = [w for w in every if w["end"] > cut]
    firstDay = cut.date().isoformat()
    roll = [r for r in roll if r["day"] >= firstDay]
    toks = sorted(w["tok"] for w in wins) or [0]
    data = {
        "rolling": roll,
        "ceiling": cap,
        "baseline": span,
        "available": True,
        "days": days,
        # The window open right now, and nothing gates on it. It is here because "how much of this window is
        # left" is still the honest answer to "is there room to run something".
        "window": {"expires": win["expires"].isoformat() if win["expires"] else None,
                   "source": win["source"]},
        "median": toks[len(toks) // 2],
        "p90": toks[int(len(toks) * 0.9)],
        "max": toks[-1],
        "windows": [{
            "start": w["start"].isoformat(timespec="minutes"),
            "end": w["end"].isoformat(timespec="minutes"),
            "tok": w["tok"],
            "turns": w["turns"],
            "open": w["end"] > datetime.datetime.now().astimezone(),
            # A window that both starts and ends inside the night is one the
            # bucket agents could have spent in without touching the morning.
            "night": w["start"].hour >= 19 or w["start"].hour < 7,
            # How the spend arrived across the five hours — see window_shape.
            "shape": window_shape(w),
        } for w in wins],
    }
    _usage_cache.update(at=now, data=data, days=days)
    return data


def plans_dir(name=None):
    """Where the bucket agents leave the plans they write.

    A different folder from reports/ on purpose, and not a candidate for being
    merged into it. A report is the owner's own record of what happened, written in
    their voice and finished the day it is written. A plan is a proposal about
    what to do next, written by an agent, and it expires the moment the owner acts on
    it. Putting the two together would put machine output into the Reports view,
    which is a view of the owner's own writing.
    """
    return os.path.join(dataset_dir(name or current_dataset()), "plans")


# The three the board writes, as against the two a plan's agent writes.
# "after a conversation" is
# the marker saying the quote is a chat the owner had about the plan rather than a
# sentence the owner typed, which is the one thing the modal shows differently.
BOARD_HISTORY_RE = re.compile(
    r"^(Accepted|Sent back|Turned down) by `([^`]*)`( after a conversation)?\.\s*(.*)$")


def history_entry(date, revision, rest):
    """One line of a plan's History section, split into what the modal draws.

    history() in agents/bucket-agent/plans.py writes two shapes after the bold date and revision:
    "Planned by `agent`." and "Re-planned by `agent` after revision N was sent
    back: <the owner's reason>." The second is two events on one line, the send-back
    and the revision that answered it, so the reason comes back on its own
    rather than left inside the note for the board to cut out again. The line
    carries one date, so the send-back is dated the day the answer was written.

    The board writes three more — accepted, sent back, turned
    down — each carrying what the owner said about the plan, and each saying whether
    that was a sentence or a conversation. A line in none of the five shapes
    comes back whole, which is how a plan written by hand still reads.
    """
    rest = rest.strip()
    sent_back = ""
    conversation = False
    m = re.match(r"^Re-planned by `([^`]*)` after revision \d+ was sent back:\s*(.*)$", rest)
    if m:
        agent, sent_back = m.group(1), m.group(2).strip()
        note = "Re-planned by `%s`." % agent
        return {"date": date, "revision": revision, "agent": agent,
                "note": note, "sent_back": sent_back, "conversation": False}
    m = BOARD_HISTORY_RE.match(rest)
    if m:
        verb, agent, chat, said = m.group(1), m.group(2), m.group(3), m.group(4).strip()
        return {"date": date, "revision": revision, "agent": agent,
                "note": "%s by `%s`." % (verb, agent), "sent_back": said,
                "conversation": bool(chat)}
    m = re.match(r"^Planned by `([^`]*)`", rest)
    agent = m.group(1) if m else ""
    return {"date": date, "revision": revision, "agent": agent,
            "note": rest, "sent_back": sent_back, "conversation": conversation}


def plan_meta(path, name):
    """One task's plan, described from its frontmatter.

    Same idea as report_meta and deliberately not the same function: a plan
    carries the task it belongs to, the agent that wrote it and whether it has
    been actioned, and folding four extra fields into the report reader would
    make both harder to follow than keeping them apart.
    """
    fields = {}
    revisions = []
    # One entry per line in the file's own History section — the record of
    # every time this task has been re-planned, not just the count in
    # `revision:`. Read here rather than only by the runner so the card can name
    # it without fetching the whole document: history()'s own line shape is
    # "- **YYYY-MM-DD, revision N.** ...", so that is what is matched.
    try:
        with open(path, encoding="utf-8") as fh:
            if fh.readline().strip() != "---":
                return None
            for line in fh:
                if line.strip() == "---":
                    break
                key, _, value = line.partition(":")
                fields[key.strip().lower()] = value.strip()
            in_history = False
            for line in fh:
                if line.startswith("## "):
                    in_history = line.strip() == "## History"
                    continue
                if not in_history:
                    continue
                m = re.match(r"^- \*\*(\d{4}-\d{2}-\d{2}), revision (\d+)\.\*\*\s*(.*)$", line)
                if m:
                    revisions.append(history_entry(m.group(1), int(m.group(2)), m.group(3)))
    except OSError:
        return None
    try:
        st = os.stat(path)
    except OSError:
        return None
    # One file per task now, flat under plans_dir() — nothing in the path
    # says which night this was (re)planned, only the frontmatter does.
    night = fields.get("night") or fields.get("date") or ""
    return {
        "name": name,
        "night": night,
        "title": fields.get("title") or name[:-3].replace("-", " "),
        "task": fields.get("task", ""),
        "bucket": fields.get("bucket", ""),
        "column": fields.get("column", ""),
        "ai": fields.get("ai", ""),
        "agent": fields.get("agent", ""),
        "slug": fields.get("slug", ""),
        "date": fields.get("date", night),
        # The canonical shape. `status` is still read below
        # so a plan restored from an older backup still renders —
        # the same permanent-fallback rule the tag syntax follows rather than a
        # migration window.
        "id": fields.get("id", ""),
        "about": fields.get("about", ""),
        "group": fields.get("group", fields.get("bucket", "")),
        "state": fields.get("state", ""),
        "owner": fields.get("owner", ""),
        "seen": fields.get("seen", "") == "yes",
        "needs_you": fields.get("needs_you", "") == "yes",
        "resolution": fields.get("resolution", ""),
        # How far the work has got, on a plan the owner accepted.
        # Its own field rather than more values on `state` because the contract
        # allows one state per document and this is a second question about the
        # same one: `state` says where the plan is, `production` says what has
        # happened to the work it describes. Written by the fold migration and
        # by do; "" on every plan that has not been accepted.
        #
        # This is also the field the eight-column version of the Plans view
        # would draw as columns, if the work ever becomes
        # autonomous enough to be worth watching — see IMPROVEMENTS.md.
        "production": fields.get("production", ""),
        "production_summary": fields.get("production_summary", ""),
        # Which Claude Code session opened for this plan, if any. Written by
        # nothing now: the board button that opened one went with the Plans view.
        "production_session": fields.get("production_session", ""),
        "feedback": fields.get("feedback", fields.get("redo_note", "")),
        "revisions": revisions,
        "created": fields.get("created", fields.get("generated", "")),
        # When the file was actually written, to the second. Missing on any
        # plan from before this field existed — the board falls back to
        # `modified` for those, which is the file's mtime and moves whenever
        # mark_plan flips the status, so it is only a fallback and not what
        # this field is for.
        "generated": fields.get("generated", ""),
        "status": fields.get("status", "unread"),
        # An agent that decided the task could not be planned without a
        # decision only the owner can make writes `outcome: folded`. See the folding
        # rule in agents/bucket-agent/PLAN-BRIEF.md. Passed through as written rather than
        # reduced to a boolean, so a value this server has never heard of
        # reaches the board instead of being swallowed here.
        "outcome": fields.get("outcome", ""),
        # Why the owner sent it back, on a plan the owner sent back. Shown on the card so the
        # reason is visible without opening it, and read by the next run.
        "redo_note": fields.get("redo_note", ""),
        "summary": fields.get("summary", ""),
        "bytes": st.st_size,
        "modified": datetime.datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
        # No dataset name in this, deliberately, and it is easy to get wrong:
        # translate_path puts the current one in for every /data/ URL, so naming
        # it here asks for data/work/work/plans/... and 404s. Reports and
        # backups build their URLs the same way, for the same reason.
        "url": "/" + DATA + "/plans/" + name,
    }


def plan_listing():
    """Every plan a bucket agent has written, newest first.

    One file per task, flat under plans_dir(). What is skipped is everything
    that is not a plan: the sidecar files (ledger, queue order, the log, the
    lock) and the dated subfolders that still hold a night's own index.md and
    run.json, from before the bucket agents, neither of which is a plan.
    """
    root = plans_dir()
    if not os.path.isdir(root):
        return []
    out = []
    for name in sorted(os.listdir(root)):
        if not name.endswith(".md") or name.startswith("."):
            continue
        meta = plan_meta(os.path.join(root, name), name)
        if meta:
            out.append(meta)
    out.sort(key=lambda p: (p["night"], p["modified"]), reverse=True)
    return out


def ledger_path():
    return os.path.join(plans_dir(), "ledger.json")


def bucket_agent_lock():
    """The bucket agents' lock for the list the board is showing, the one the
    hourly wake, Run now and core/bucket_wake.py all take or check."""
    return bucket_wake.lock_path(DATA_ROOT, current_dataset())


# The log lines the bucket agents' runner writes (plans.log() in
# agents/bucket-agent/), and which of them mean what. Matched here rather than
# exported from the runner because the log is a human artefact first: it is
# read at a terminal far more often than it is parsed, and pinning its wording
# to a format string the board depends on would stop it being edited freely.
# When one of these stops matching, the fold goes quiet — it does not lie.
_LOG_RE = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s\s+(.*)$")
_FLIGHT_RE = re.compile(r"^>\s+(.*?)\s+\(([^,()]+),\s*([a-z]+)\)\s*$")
_DONE_RE = re.compile(r"^(?:planned|folded)\s+(.*?)\s+(\d+)s\s+\$([0-9.]+)\s*$")
# Greedy up to 50 rather than lazy to a run of spaces: the runner pads the
# title into a 50-character field, so a title that fills it is followed by a
# single space and a lazy match would take the message as part of the title.
_FAIL_RE = re.compile(r"^failed\s(.{1,50})\s+(\S.*)$")


def agents_status():
    """Whether the agents can run on this machine: the `claude` CLI on the
    path, and agents-engine next to this repo. Either missing and every run
    dies the moment it starts, so the board hides what would start one and the
    run routes refuse rather than answer "started".

    AGENTS_RUNNER_CLAUDE is the binary agents-engine's runner uses in place of
    `claude`, so it counts here too."""
    claude = bool(os.environ.get("AGENTS_RUNNER_CLAUDE") or shutil.which("claude"))
    engine = agents_routes is not None
    if AUTH:
        # The shared board runs no agents (shared_refusal), so the board
        # leaves out everything that would start one.
        claude = engine = False
    return {"claude": claude, "engine": engine, "ready": claude and engine}


def agents_missing():
    """Why no agent can run here, in a line for the owner, or None."""
    st = agents_status()
    if not st["claude"]:
        return "Claude Code is not installed on this machine, so no agent can run"
    if not st["engine"]:
        return "agents-engine is not next to this repo, so no agent can run"
    return None


def bucket_agent_run():
    """What the bucket agents are doing on this list, or did last, from the
    lock and the log.

    Two sources again, and neither is enough alone. The lock directory says
    whether a run is going on right now — it is held for the life of the batch
    and cleared by a trap on the way out. The log says what that run has got
    through. A log with a task in flight and no lock is a run that died between
    the two, which is worth saying out loud rather than showing as live.

    Only ever one item is in flight: the runner works through them one at a
    time, on purpose, so this is a single card rather than a list of them.
    """
    lock = bucket_agent_lock()
    live = os.path.isdir(lock)
    since = ""
    if live:
        try:
            since = datetime.datetime.fromtimestamp(
                os.path.getmtime(lock)).isoformat(timespec="minutes")
        except OSError:
            live = False

    lines = []
    for raw in _tail(os.path.join(plans_dir(), "bucket-agent.log"), 400):
        m = _LOG_RE.match(raw)
        if m:
            lines.append((m.group(1), m.group(2).strip()))

    # Everything since the last "start:" is this run. Before that is last night.
    begun = ""
    for i in range(len(lines) - 1, -1, -1):
        if lines[i][1].startswith("start:"):
            begun, lines = lines[i][0], lines[i:]
            break
    else:
        lines = []

    to_plan = 0
    current, done, failed, stopped = None, [], [], ""
    for stamp, body in lines:
        m = re.match(r"^start:\s+(\d+) to run", body)
        if m:
            to_plan = int(m.group(1))
            continue
        m = _FLIGHT_RE.match(body)
        if m:
            current = {"title": m.group(1), "agent": m.group(2).strip(), "kind": m.group(3), "since": stamp}
            continue
        m = _DONE_RE.match(body)
        if m:
            done.append({"title": m.group(1).strip(), "took": int(m.group(2)),
                         "cost": float(m.group(3)), "at": stamp})
            current = None
            continue
        m = _FAIL_RE.match(body)
        if m:
            failed.append({"title": m.group(1).strip(), "why": m.group(2), "at": stamp})
            current = None
            continue
        if body.startswith("stopped:") or body.startswith("STOPPED"):
            stopped, current = body, None

    orphan = bool(current) and not live
    return {
        "live": live,
        "since": since,
        "started": begun,
        "toPlan": to_plan,
        "current": None if orphan else current,
        "orphan": orphan and current or None,
        "done": done,
        "failed": failed,
        "stopped": stopped,
        "left": max(0, to_plan - len(done) - len(failed)) if to_plan else 0,
    }


def report_meta(path, name):
    """Title, date and standfirst for one report, read from its frontmatter.

    A report is a plain Markdown file, so the board must be able to describe one
    without opening it. Frontmatter carries what the list needs; everything below
    it is the report itself and is only fetched when someone opens it.
    """
    title, date, covers, topic, summary = "", "", "", "", ""
    try:
        with open(path, encoding="utf-8") as fh:
            first = fh.readline()
            if first.strip() == "---":
                for line in fh:
                    if line.strip() == "---":
                        break
                    key, _, value = line.partition(":")
                    key, value = key.strip().lower(), value.strip()
                    if key == "title":
                        title = value
                    elif key == "date":
                        date = value
                    elif key == "covers":
                        covers = value
                    elif key == "topic":
                        topic = value
                    elif key == "summary":
                        summary = value
    except OSError:
        return None
    try:
        st = os.stat(path)
    except OSError:
        return None
    # A file with no frontmatter is still a report. Fall back to the name so a
    # dropped-in Markdown file shows up rather than being silently ignored.
    if not title:
        title = name[:-3].replace("-", " ").strip()
    return {
        "name": name,
        "title": title,
        "date": date,
        "covers": covers,
        "topic": topic,
        "summary": summary,
        "bytes": st.st_size,
        "modified": datetime.datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
        "url": "/" + DATA + "/reports/" + name,
    }


def report_listing():
    """Every written report, newest first by the date it covers up to.

    Sorted on the frontmatter date rather than the file's mtime: fixing a typo in
    a report from three weeks ago should not move it to the top of the list.
    """
    rdir = reports_dir()
    if not os.path.isdir(rdir):
        return []
    out = []
    for name in sorted(os.listdir(rdir)):
        if not name.endswith(".md") or name.startswith("."):
            continue
        meta = report_meta(os.path.join(rdir, name), name)
        if meta:
            out.append(meta)
    out.sort(key=lambda r: (r["date"] or "", r["modified"]), reverse=True)
    return out


ARCHIVE = "done-archive.md"


def archive_done(text):
    """Append finished work lifted out of todo.md, under a dated heading.

    A separate file rather than a reliance on the backups: a backup is a copy of
    the whole list at a moment, and every one of them is eventually pruned, so
    work archived today would quietly stop existing in twelve weeks. This file is
    never pruned and never written to by anything else — it only grows.
    """
    bdir = backup_dir()
    os.makedirs(bdir, exist_ok=True)
    path = os.path.join(bdir, ARCHIVE)
    new = not os.path.exists(path)
    with open(path, "a", encoding="utf-8", newline="") as fh:
        if new:
            fh.write("# Finished and archived\n\n"
                     "Tasks lifted out of todo.md once they had been ticked off for more\n"
                     "than a month. Newest section last. Nothing here is ever deleted.\n")
        fh.write("\n## Archived %s\n\n" % datetime.date.today().isoformat())
        fh.write(text.rstrip("\n") + "\n")
        fh.flush()
        os.fsync(fh.fileno())
    return ARCHIVE


AGENDA_ARCHIVE = "agenda-history.md"


def archive_agenda(text):
    """Append one recurring meeting's previous agenda, cut by the roll.

    A card keeps one cycle of history — that is what writing the next agenda
    needs — but the one being replaced is a record of a meeting that actually
    happened, not scratch state. Same shape as archive_done: append-only,
    never pruned, written to by nothing else.
    """
    bdir = backup_dir()
    os.makedirs(bdir, exist_ok=True)
    path = os.path.join(bdir, AGENDA_ARCHIVE)
    new = not os.path.exists(path)
    with open(path, "a", encoding="utf-8", newline="") as fh:
        if new:
            fh.write("# Agenda history\n\n"
                     "Previous agendas, filed here by the roll the moment a newer one\n"
                     "replaces them on the card. Newest section last. Nothing here is ever\n"
                     "deleted.\n")
        fh.write("\n" + text.rstrip("\n") + "\n")
        fh.flush()
        os.fsync(fh.fileno())
    return AGENDA_ARCHIVE


def archive_info():
    """The archive is not a backup and is not listed as one — it is the only file
    here that is never pruned, and it holds work that is in no current copy of
    todo.md at all."""
    path = os.path.join(backup_dir(), ARCHIVE)
    try:
        st = os.stat(path)
    except OSError:
        return None
    sections = 0
    try:
        with open(path, encoding="utf-8") as fh:
            sections = sum(1 for line in fh if line.startswith("## Archived "))
    except OSError:
        pass
    return {
        "name": ARCHIVE,
        "bytes": st.st_size,
        "modified": datetime.datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
        "url": "/" + DATA + "/backups/" + ARCHIVE,
        "sections": sections,
    }


def backup_listing():
    """What the backup index page reads. Newest first."""
    out = []
    bdir = backup_dir()
    for name in backup_names():
        full = os.path.join(bdir, name)
        try:
            st = os.stat(full)
        except OSError:
            continue
        out.append({
            "name": name,
            "kind": "weekly" if is_weekly(name) else "session",
            "bytes": st.st_size,
            "modified": datetime.datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
            "url": "/" + DATA + "/backups/" + name,
        })
    out.sort(key=lambda b: b["modified"], reverse=True)
    return out


# ---- Claude, on a task -----------------------------------------------------
#
# The engine that runs Claude Code and the index of which sessions sit under
# which task now live one level up, in ai_chat_engine/ — a module any local
# tool can load, not just this one. See its README.md for the HTTP contract
# this wires up below, and its engine.py for what it actually does: run the
# CLI, stream its output, and read a transcript back from the file Claude
# Code itself writes.
#
# A prompt written on a task already had a way out of the board before any of
# this: Open in Claude, a link to claude.ai with the text sitting in the box.
# That is a hand-over and it ends there — the chat it opens runs in a tab that
# has never seen this machine. AI_CHAT_DIR below is where the module that
# fixes that lives; STATIC_PREFIX is where its own JS and CSS are served from.

AI_CHAT_DIR = os.path.join(PACKAGES_DIR, "ai_chat_engine")
STATIC_PREFIX = "/ai-chat/"

# The work-item model every stream in here shares. Same wiring as AI_CHAT_DIR
# above, and the same failure: a checkout without PACKAGES answers 404 on
# /streams.json and /work-streams/* and serves the board exactly as it did
# before either existed. Nothing the board needs in order to start may come
# from here, because on the static deployment this path does not exist at all.
WORK_STREAMS_DIR = os.path.join(PACKAGES_DIR, "work-streams")
WS_PREFIX = "/work-streams/"

if os.path.isdir(WORK_STREAMS_DIR):
    sys.path.insert(0, WORK_STREAMS_DIR)
try:
    import manifest as ws_manifest
except ImportError:
    ws_manifest = None
try:
    import writer as ws_writer
except ImportError:
    ws_writer = None

# The Agents view. Its routes are agents-engine's own, answered under
# /agents-api so they cannot collide with this server's, and pointed at this
# repo's agents/ folder rather than at the workspace folder: the board shows the bucket
# agents it hands work to, and nothing else on the machine. Same
# failure as the two above: without PACKAGES the view says it has nothing to
# show and the board is otherwise unchanged. The engine never opens an agent's
# files; it runs the agent's own commands, so this adds no second writer for
# any schedule.
AGENTS_ENGINE_DIR = os.path.join(PACKAGES_DIR, "agents-engine", "python")
AGENTS_ROOT = os.path.join(ROOT, "agents")
AGENTS_PREFIX = "/agents-api"
# Runs started from the Agents tab count towards the same daily ceiling, and
# record spend in the same place, as the hourly wake scripts/install.sh sets up.
os.environ["AGENTS_FENCES"] = os.path.join(DATA_ROOT, "agents", "fences.json")
agents_routes = None
if os.path.isdir(AGENTS_ENGINE_DIR):
    sys.path.insert(0, AGENTS_ENGINE_DIR)
    try:
        from agents_engine import routes as agents_routes  # noqa: E402
    except ImportError:
        agents_routes = None

Engine = ChatEndpoints = server_chat = None
if os.path.isdir(AI_CHAT_DIR):
    sys.path.insert(0, AI_CHAT_DIR)
    try:
        from engine import ASK_DENIES, Engine  # noqa: E402  (path set just above)
        from http_glue import ChatEndpoints  # noqa: E402
    except ImportError:
        # ai_chat_engine exists but is missing a file, or is an incompatible
        # version.
        # Same rule as a missing folder: no engine, no buttons — not a crash.
        Engine = ChatEndpoints = None
    # On its own, so a problem in the shared board's half never switches off
    # the Mac board's chat.
    try:
        import server_chat  # noqa: E402  (imports engine itself)
    except ImportError:
        server_chat = None

# One engine per dataset, built the first time something asks for it. Each
# dataset owns its own claude.json and sessions.json exactly as it owns its
# own todo.md, so a chat started against one list has no business appearing
# under another — and switching lists must not lose track of the sessions
# recorded against the one just left.
_ai_chat_cache = {}

# Permission-rule path patterns, relative to the chat's cwd (the folder a
# list's claude.json names, to-dos itself for a list with no claude.json).
CHAT_WRITE_DENIES = ["**/data/*/todo.md"]


_shared_chat_cache = {}
_shared_chat_lock = threading.Lock()


def shared_chat_for(name):
    """The signed-in board's chat (kanban/server_chat.py), or None without
    ANTHROPIC_API_KEY or with an engine older than ask_tools. Each run
    starts in the board's own folder, so dontAsk refuses every other board,
    data/users/ and anything added to data/ later; it may read the PA's
    instructions and the board's outside project folders, and nothing else
    beyond it. See docs/superpowers/specs/2026-11-04-server-chat-api-design.md, §3."""
    if not server_chat or not os.environ.get("ANTHROPIC_API_KEY"):
        return None
    with _shared_chat_lock:
        inst = _shared_chat_cache.get(name)
        if inst is None:
            inst = _build_shared_chat(name)
            if inst is not None:
                _shared_chat_cache[name] = inst
        return inst


def _build_shared_chat(name):
    board_dir = dataset_dir(name)
    # The sessions index names every PA chat on the board, the person's own
    # titles and prompts included, so it is kept outside the run's folder.
    sessions_dir = os.path.join(DATA_ROOT, "agents", "chat-sessions")
    os.makedirs(sessions_dir, exist_ok=True)
    try:
        engine = Engine(default_cwd=board_dir,
                        config_path=os.path.join(board_dir, "claude.json"),
                        sessions_path=os.path.join(sessions_dir, name + ".json"),
                        ask_denies=list(ASK_DENIES) + server_chat.EXTRA_DENIES,
                        ask_tools=server_chat.ASK_TOOLS,
                        ask_allows=server_chat.read_allows(ROOT, DATA_ROOT, board_dir,
                                                           project_homes(name)))
    except TypeError:
        return None
    read_config = engine.config

    def held_config():
        cfg = read_config()
        cfg["cwd"] = board_dir
        cfg["work"] = False
        # claude.json may shorten a run, never stretch it.
        cfg["timeout"] = min(cfg["timeout"], engine.default_timeout)
        if not cfg.get("model"):
            cfg["model"] = settings.model_for("chat", DATA_ROOT)
        return cfg
    engine.config = held_config
    return server_chat.SharedChat(engine, name, requester,
                                  os.path.join(DATA_ROOT, "agents", "chat-spend.json"),
                                  os.environ["AGENTS_FENCES"])


def ai_chat_for(name):
    if not Engine or not name:
        return None
    # Signed in, a chat runs only on the server's own API key, never on the
    # login of whoever started the server (shared_chat_for).
    if AUTH:
        return shared_chat_for(name)
    inst = _ai_chat_cache.get(name)
    if inst is None:
        paths = dict(
            default_cwd=ROOT,
            config_path=os.path.join(dataset_dir(name), "claude.json"),
            sessions_path=os.path.join(dataset_dir(name), "sessions.json"),
        )
        # A chat switched to "Can write" may edit only inside the list's
        # project folders, and never a list: every change to todo.md goes
        # through the board, from a pa-changes block. An engine older than
        # write mode takes neither and has no write mode to guard either.
        try:
            engine = Engine(write_denies=CHAT_WRITE_DENIES,
                            write_allows=project_homes(name), **paths)
        except TypeError:
            engine = Engine(**paths)
        # A list's claude.json names its own model and wins. Without one, the
        # chat runs on settings.json's, and without that, as before.
        read_config = engine.config

        def config_with_settings_model():
            cfg = read_config()
            if not cfg.get("model"):
                cfg["model"] = settings.model_for("chat", DATA_ROOT)
            return cfg
        engine.config = config_with_settings_model
        inst = ChatEndpoints(engine)
        _ai_chat_cache[name] = inst
    return inst


def ai_chat_static(rel_path):
    """A file under ai_chat_engine/dist/, or None. Kept to that one folder —
    this is a static-file route for the widget's own built script and
    stylesheet, not a general file server onto a sibling directory."""
    if not AI_CHAT_DIR or ".." in rel_path.split("/"):
        return None
    full = os.path.join(AI_CHAT_DIR, "dist", rel_path)
    if not os.path.isfile(full):
        return None
    return full


def work_streams_static(rel_path):
    """A file under work-streams/interface/, or None. Kept to that one folder,
    exactly like ai_chat_static above: a route for the package's own assets,
    not a way to read a sibling directory."""
    if not WORK_STREAMS_DIR or ".." in rel_path.split("/"):
        return None
    full = os.path.join(WORK_STREAMS_DIR, "interface", rel_path)
    if not os.path.isfile(full):
        return None
    return full


def stream_name(path, root):
    """Where a manifest is, for the board: relative to the workspace folder,
    and signed in only the name of the folder it sits in."""
    return os.path.basename(os.path.dirname(path)) if AUTH else os.path.relpath(path, root)


def stream_listing():
    """Every stream manifest under the workspace folder, with whatever is wrong with each.

    The errors travel with the manifest rather than being raised, so one badly
    written stream is one card saying so rather than a blank page. Same choice
    the agents dashboard makes about an agent whose state command fails.
    """
    if ws_manifest is None:
        return {"streams": [], "problem": "the work-streams package is not on this machine"}
    root = os.path.normpath(os.path.join(ROOT, ".."))
    out = []
    for path in ws_manifest.discover(root):
        m, errors = ws_manifest.load(path)
        if m is None:
            out.append({"path": stream_name(path, root), "errors": errors})
            continue
        out.append({
            "id": m.get("id"), "name": m.get("name"), "blurb": m.get("blurb", ""),
            "path": stream_name(path, root),
            "manifest": {k: v for k, v in m.items() if not k.startswith("_")},
            "lanes": ws_manifest.lanes(m),
            "ownsItsFile": ws_manifest.owns_its_file(m),
            "errors": errors,
        })
    return {"streams": out, "contract": ws_manifest.CONTRACT,
            "canonical": list(ws_manifest.CANONICAL)}


def settings_reply(saved):
    """/settings.json's body: the settings, the daily budgets from the fences
    file (see settings.budgets), and the choices the form offers."""
    return dict(saved, **settings.budgets(os.environ["AGENTS_FENCES"]),
                choices={"models": list(settings.MODELS), "starts": list(settings.STARTS)})


def _nager_has(code):
    """Whether Nager.Date has public holidays for this country."""
    import holidays as nager
    return code in {c["code"] for c in nager.countries(DATA_ROOT)}


def _all_countries():
    """Every country, each marked with whether a holiday list exists for it."""
    import holidays as nager
    have = {c["code"] for c in nager.countries(DATA_ROOT)}
    return [{"code": c, "name": n, "holidays": c in have} for c, n in iso_countries.ISO_COUNTRIES]


def shared_refusal(method, path):
    """(status, body) for a route the shared board does not offer, else None.

    What only makes sense on the owner's Mac: revealing a folder in Finder,
    approving a folder on its disk, the agents and their launchd schedules, the
    companion and the usage windows read from local Claude Code transcripts,
    and starting the bucket agents on the owner's own subscription. A 404, which
    is what the board already copes with from a host that has none of them.
    The chat routes need no entry here: ai_chat_for() answers None without the
    server's API key, and kanban/server_chat.py's SharedChat with it.

    The settings are the server's, not any one visitor's, and a folder named
    in them is a path on the server, so they are read-only. The profile is
    each person's own (_put_profile_basics()), less its paths.
    """
    gone = (404, {"error": "not on the shared board"})
    if path.startswith(AGENTS_PREFIX + "/"):
        return gone
    if method == "POST" and path in ("/project/open", "/project-folders"):
        return gone
    if method in ("GET", "HEAD") and path in ("/schedule.json", "/usage.json"):
        return gone
    if method == "PUT" and path == "/settings.json":
        return (403, {"error": "the shared board's settings are changed on the server"})
    return None


def pinned_refusal(method, path):
    """(status, body) for anything a request held to one board may not do,
    else None. It reads and writes that board's list, and asks who it is."""
    if path.lstrip("/") == TARGET and method in ("GET", "HEAD", "PUT"):
        return None
    if path == "/whoami" and method == "GET":
        return None
    return (403, {"error": "a request held to one board only reads and writes its list"})


# What a signed-in person with no board yet can still ask for: the page, who
# they are, the list of boards (empty) and the route that makes one.
BOARDLESS_GET = ("/datasets.json", "/settings.json", "/profile-basics.json",
                 "/holiday-countries.json", "/holiday-regions.json", "/streams.json")
BOARDLESS_POST = ("/datasets", "/dataset/select")


def needs_board(method, path):
    """Whether a route reads or writes a board. On the shared board, one asked
    for by someone with no board is a 404 rather than a read of the empty
    placeholder folder every such person would share."""
    if method in ("GET", "HEAD"):
        if path == "/" + DATA or path.startswith("/" + DATA + "/"):
            return True
        return path.endswith(".json") and path not in BOARDLESS_GET
    return path not in BOARDLESS_POST


def _holiday_place_json(address=None, board=None):
    """The profile's holiday country and region, "" for neither."""
    import owner_profile
    country, region = owner_profile.holiday_place(DATA_ROOT, address, board)
    prof = owner_profile.read(DATA_ROOT, address, board)
    # An old `Holidays:` line with no `Country:` beside it: the calendars it
    # names, so Settings can offer to keep them rather than rewrite them.
    legacy = []
    if "holidays" in prof and not re.fullmatch(r"[A-Za-z]{2}", prof.get("country", "")):
        legacy = list(owner_profile.holiday_regions(DATA_ROOT, address, board))
    return {"country": country or "", "region": region, "legacy_holidays": legacy}


# Parts of the profile that name a path, which on the shared board would be a
# path on the server, so a signed-in person neither sees nor sets them.
SHARED_HIDES = {"about": ("facts_file",), "sections": ("setup",)}


def profile_reply():
    """The profile as Settings shows it: on the Mac the owner's, signed in the
    person's own, read from the shared profile until they save one. Signed
    in there is nothing to set up, and until they save, the shared profile's
    Name is not theirs, so the name is the one they signed in with. The
    profile is the board's on screen (owner_profile.profile_path), which is
    the owner's unless settings.json gives the board a memory folder of its
    own or none."""
    import owner_profile
    who = requester()
    address = who["email"] if who else None
    board = current_dataset()
    about = owner_profile.about_fields(DATA_ROOT, address, board)
    texts = owner_profile.section_texts(DATA_ROOT, address, board)
    hints = owner_profile.section_hints()
    if who:
        own = os.path.isfile(owner_profile.own_profile_path(address, DATA_ROOT))
        name = (owner_profile.read(DATA_ROOT, address, board).get("name") if own else None) or who["name"]
        for key in SHARED_HIDES["about"]:
            about.pop(key, None)
        for key in SHARED_HIDES["sections"]:
            texts.pop(key, None)
            hints.pop(key, None)
        setup = False
    else:
        setup = owner_profile.needs_setup(DATA_ROOT, board=board)
        name = "" if setup else owner_profile.owner_name(DATA_ROOT, board=board)
    return {"name": name, **_holiday_place_json(address, board), "about": about,
            "sections": texts, "hints": hints, "needs_setup": setup}


def url_segments(path):
    """(folder names, trailing slash) for a URL's path, decoded exactly once,
    or None when any part of it is refused: empty, a dot name (`.`, `..`,
    `.git`, any dotfile), or holding `%`, a backslash or a NUL once decoded,
    which only a second decoding or another platform would read as more."""
    from urllib.parse import unquote
    raw = path.split("?", 1)[0].split("#", 1)[0]
    try:
        decoded = unquote(raw, errors="strict")
    except UnicodeDecodeError:
        return None
    if not decoded.startswith("/"):
        return None
    segs = decoded[1:].split("/")
    trailing = segs[-1] == ""
    if trailing:
        segs = segs[:-1]
    for seg in segs:
        if not seg or seg.startswith(".") or any(c in seg for c in "%\\\x00"):
            return None
    return segs, trailing


def within(path, base):
    """Whether `path`, symlinks followed, is `base` or inside it."""
    real, root = os.path.realpath(path), os.path.realpath(base)
    return real == root or real.startswith(root.rstrip(os.sep) + os.sep)


def inside(base, segs):
    """`base` joined with `segs`, or None when following symlinks leads out."""
    full = os.path.join(base, *segs)
    return full if within(full, base) else None


# What the shared board serves from outside /data/: the page and what it
# loads (kanban/index.html), its built assets, the format's script, and the
# example list. Everything else in the repo, its source and its git history
# included, is refused, along with folder listings.
STATIC_FILES = ("kanban/index.html", "kanban/board.css", "kanban/demo.md",
                "kanban/jira.demo.json", "kanban/icon.svg", "core/todo.js", "core/avatar.js")
STATIC_FOLDERS = ("kanban/js/", "kanban/dist/", "kanban/brand/")


def static_allowed(segs, trailing):
    rel = "/".join(segs)
    if trailing or not segs:
        return False
    return rel in STATIC_FILES or any(rel.startswith(f) and "/" not in rel[len(f):]
                                      for f in STATIC_FOLDERS)


class BoardHTTPServer(http.server.ThreadingHTTPServer):
    """ThreadingHTTPServer without the reverse DNS lookup its server_bind()
    does (socket.getfqdn), only to fill in a server_name nothing here reads.
    On a machine whose resolver is slow, that lookup kept the board from
    listening for longer than a test waits, and could stall a real start."""

    def server_bind(self):
        import socketserver
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = host
        self.server_port = port


class Handler(http.server.SimpleHTTPRequestHandler):
    # Markdown as text rather than a download. The project drawer links
    # straight at the files in a project folder, and most of them are .md —
    # macOS has no mapping for it, so without this every one of those links
    # saved a file to Downloads instead of opening it in a tab.
    extensions_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map)
    extensions_map[".md"] = "text/plain"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def parse_request(self):
        """Who is asking, worked out once per request before any route runs.

        Off, nobody is, and the board is exactly what it was. Signed in, a
        request with no email from nginx is refused here, so no route below has
        to remember to check. So is a route the shared board does not offer,
        and a POST without X-Board: from a public address the board's cookie
        travels with a form on any site, and that header is what a form cannot
        send. A request held to one board by X-Offdesk-Board (pinned_board())
        may only read and write that board's list, signed in or not.
        """
        if not super().parse_request():
            return False
        _request.who = None
        _request.board = (self.headers.get("X-Offdesk-Board") or "").strip() or None
        route = self.path.split("?")[0]
        refusal = None
        if not AUTH:
            if _request.board:
                refusal = pinned_refusal(self.command, route)
                if not refusal and current_dataset() is None:
                    refusal = (404, {"error": "no list called “%s”" % _request.board})
        else:
            who = self._signed_in()
            if not who:
                refusal = (401, {"error": "sign in first"})
            else:
                _request.who = who
                seen_person(who)
                refusal = shared_refusal(self.command, route)
                if not refusal and _request.board:
                    refusal = pinned_refusal(self.command, route)
                if not refusal and self.command == "POST" and self.headers.get("X-Board") != "1":
                    refusal = (403, {"error": "not from the board"})
                if not refusal and current_dataset() is None and needs_board(self.command, route):
                    refusal = (404, {"error": "no list you can see"})
        if refusal:
            # The body, if any, is never read, so the connection cannot be
            # reused for a next request.
            self.close_connection = True
            self._json(*refusal)
            return False
        return True

    def _signed_in(self):
        """{email, name, teams} out of nginx's three headers, or None."""
        from urllib.parse import unquote
        addr = board_access.email(self.headers.get("X-Offdesk-Email"))
        if not addr:
            return None
        name = board_access.clean_name(unquote(self.headers.get("X-Offdesk-Name") or "", errors="replace"))
        return {"email": addr, "name": name or addr.split("@")[0],
                "teams": board_access.teams(self.headers.get("X-Offdesk-Teams") or "")}

    def log_message(self, fmt, *args):
        # Only saves are worth a line. Everything else is noise.
        #
        # args[0] is a request line for a normal hit but an HTTPStatus when the
        # base class logs an error, and "in" against one of those raises — which
        # killed the connection mid-response, so the browser reported a network
        # failure instead of the 404 the server had actually decided on. Any
        # missing file became an unexplainable "Failed to fetch".
        first = args[0] if args else ""
        if not isinstance(first, str) or "PUT" not in first:
            return
        # Only a write that landed. do_PUT refuses far more than it accepts —
        # every precondition failure on todo.md, and everything that is not one
        # of the two files written with PUT at all — and a refusal printing
        # "saved" is the line you would read while looking for why nothing was.
        code = args[1] if len(args) > 1 else ""
        if not str(code).startswith("2"):
            return
        # Two files are written with PUT, so the line says which.
        what = ("a bucket brief" if "/bucket-brief" in first
                else "the board's about text" if "PUT /about" in first
                else "the board's context" if "PUT /context" in first
                else "the board's people" if "PUT /people" in first
                else "%s/%s/todo.md" % (DATA, current_dataset()))
        sys.stdout.write("saved %s\n" % what)
        sys.stdout.flush()

    def _agents_get(self, route):
        if not agents_routes:
            return self._json(404, {"error": "agents-engine is not next to this repo"})
        if route == "/state.json":
            return self._json(200, agents_routes.state_view(AGENTS_ROOT))
        return self._json(404, {"error": "no route %s" % route})

    def _agents_post(self, route):
        if not agents_routes:
            return self._json(404, {"error": "agents-engine is not next to this repo"})
        # Before the body is read, for the reason routes.ApiHandler.do_POST
        # gives: a form on any website can post to loopback, and /run starts an
        # agent.
        if not agents_routes.origin_allowed(self.headers.get("Origin")):
            return self._json(403, {"error": "origin not allowed"})
        if route == "/run":
            missing = agents_missing()
            if missing:
                return self._json(409, {"error": missing})
        try:
            body = json.loads((self._body() or b"{}").decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return self._json(400, {"error": "body was not valid JSON"})
        return self._json(*agents_routes.post_view(route, body, AGENTS_ROOT))

    def _json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        # Every read of todo.md carries the hash of what was read, so the tab
        # can hand it back on the next save and do_PUT can check content rather
        # than a second-precision timestamp. GET and HEAD both — the watcher
        # polls with HEAD and never sees a body.
        if self.command in ("GET", "HEAD") and self.path.split("?")[0].lstrip("/") == TARGET:
            digest = file_hash(todo_path())
            if digest:
                self.send_header("X-Todo-Hash", digest)
                # Which list this is, so pa_save.py can check it has the board
                # it named before it builds an edit on it.
                self.send_header("X-Bench-Board", current_dataset())
        super().end_headers()

    def translate_path(self, path):
        # Every file the board reads under /data/ — todo.md, views.md,
        # backups/*, jira.json — is asked for at a path with no dataset name
        # in it, because the board only ever knows "the current list". This is
        # the one place that fact gets resolved: swap /data/... for
        # /data/<current>/... before handing off to the normal file server.
        # GET and HEAD both funnel through here (send_head calls this), so a
        # dataset switch takes effect for every read without the board's own
        # fetch calls changing at all.
        #
        # The file path is built here from the URL decoded once, and never
        # handed back to the base class, which would decode it a second time:
        # %252e%252e is %2e%2e after one pass and .. after two. Anything that
        # does not resolve to a file the request may read points at a path
        # that cannot exist, which the base class answers with a 404.
        got = url_segments(path)
        out = self._resolve(*got) if got else None
        if out is None:
            return os.path.join(DATA_ROOT, ".refused", "nothing")
        return out + "/" if got[1] and not out.endswith("/") else out

    def _resolve(self, segs, trailing):
        if segs[:1] == [DATA]:
            ds = current_dataset()
            if not ds:
                return None
            rest = segs[1:]
            if len(rest) >= 2 and rest[0] == "projects":
                shared = self._shared_project(ds, rest[1], rest[2:])
                if shared:
                    return shared
            return inside(dataset_dir(ds), rest)
        if AUTH and not static_allowed(segs, trailing):
            return None
        full = inside(ROOT, segs)
        # Nothing under data/ is served except through the branch above: not
        # settings.json, not anyone's data/users/ file, not another list.
        if full is None or any(within(full, base) for base in (DEFAULT_DATA_ROOT, DATA_ROOT)):
            return None
        return full

    def _shared_project(self, ds, name, more):
        # /data/projects/<name>/... for a folder that resolves under the
        # list's projects folder, outside data/: the file inside it, or None
        # to serve from data/ as before.
        ddir = dataset_dir(ds)
        chosen = project_folders.chosen_dir(ddir)
        if not chosen:
            return None
        real, err = project_folders.resolve(name, ddir)
        if err or not project_folders.inside(os.path.realpath(chosen), real):
            return None
        return inside(real, more)

    def list_directory(self, path):
        # A folder's own listing names every file in it. Signed in, the board
        # never asks for one, so nobody gets one.
        if AUTH:
            self.send_error(404, "File not found")
            return None
        return super().list_directory(path)

    def do_HEAD(self):
        if self.path.split("?")[0].lstrip("/") == TARGET:
            notice_outside_edit(current_dataset())
        return super().do_HEAD()

    def do_GET(self):
        path = self.path.split("?")[0]
        # Before the list is read, an edit made to it outside the server is
        # logged and, signed in, stamped. See notice_outside_edit().
        if path.lstrip("/") == TARGET:
            notice_outside_edit(current_dataset())
        if path.startswith(AGENTS_PREFIX + "/"):
            return self._agents_get(path[len(AGENTS_PREFIX):])
        # Who is signed in. The Mac board has nobody, and answers the way a
        # server from before sign-in would, so the board shows no name.
        # Signed in, the root is the board rather than a listing of the repo.
        if AUTH and path == "/":
            self.send_response(302)
            self.send_header("Location", "/kanban/index.html")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path == "/whoami":
            if not AUTH:
                return self._json(404, {"error": "nobody signs in to this board"})
            return self._json(200, requester())
        # Who did what on this list, newest first, for the status line and for
        # the names on the cards. `me` is the signed-in email, "" on the Mac.
        # Who on this board a task can be given to, for Delegate to: its
        # owner, named people and signed-in team members. Signed in only; the
        # Mac board offers its agents and people.md's names, as it always has.
        # A board outside the asker's access never gets this far.
        if path == "/board-people.json":
            if not AUTH:
                return self._json(404, {"error": "nobody signs in to this board"})
            access = board_access.read(dataset_dir(current_dataset()))
            return self._json(200, {"people": board_access.board_people(DATA_ROOT, access)})
        if path == "/activity.json":
            entries, names = read_activity(current_dataset())
            who = requester()
            if who:
                names[who["email"]] = who["name"]
            return self._json(200, {"entries": entries, "names": names, "me": who["email"] if who else ""})
        if path == "/settings.json":
            saved = settings.load(DATA_ROOT)
            if AUTH:
                saved = settings.for_boards(saved, list_datasets())
            return self._json(200, settings_reply(saved))
        # Who may see the board on screen, for its sharing in Settings.
        if path == "/dataset/access.json":
            if not AUTH:
                return self._json(404, {"error": "nobody signs in to this board"})
            ds = current_dataset()
            got = board_access.read(dataset_dir(ds)) or {"owner": "", "people": [], "teams": []}
            return self._json(200, dict(got, board=ds, mine=got["owner"] == requester()["email"]))
        if path == "/profile-basics.json":
            return self._json(200, profile_reply())
        if path == "/holiday-countries.json":
            import holidays as nager
            import owner_profile
            who = requester()
            country = owner_profile.holiday_place(DATA_ROOT, who["email"] if who else None,
                                                  current_dataset())[0]
            return self._json(200, {
                "countries": _all_countries(),
                "regions": {country: nager.regions(country, DATA_ROOT)} if country and _nager_has(country) else {}})
        if path == "/holiday-regions.json":
            import holidays as nager
            from urllib.parse import parse_qs, urlparse
            country = (parse_qs(urlparse(self.path).query).get("country") or [""])[0].strip().upper()
            if country not in {c for c, _ in iso_countries.ISO_COUNTRIES}:
                return self._json(400, {"error": "unknown country"})
            return self._json(200, nager.regions(country, DATA_ROOT) if _nager_has(country) else [])
        if path == "/datasets.json":
            return self._json(200, {"datasets": list_datasets(), "current": current_dataset()})
        if path == "/chat-viewed.json":
            try:
                with open(chat_viewed_path(), encoding="utf-8") as fh:
                    return self._json(200, json.load(fh))
            except (OSError, ValueError):
                # No file yet, or one written by hand and broken. Either way
                # "nothing has been opened" is the honest answer and the next
                # save fixes it.
                return self._json(200, {"version": 1, "viewed": {}})
        if path == "/owner.js":
            # The owner's first name, ahead of the board's scripts so a const
            # in 02-state.js can read it. A page with no server falls back to "Me".
            import owner_profile
            # Signed in, "me" is whoever is signed in, by first name.
            owner = ((requester()["name"].split() or [""])[0] if AUTH
                     else owner_profile.owner_name(DATA_ROOT, board=current_dataset()))
            body = ("window.OWNER_NAME = %s;\n" % json.dumps(owner)).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/bucket-agents":
            from urllib.parse import parse_qs, urlparse
            q = parse_qs(urlparse(self.path).query)
            ds = (q.get("list") or [""])[0].strip() or current_dataset()
            if not ds or ds not in list_datasets():
                return self._json(404, {"error": "there is no list called %r" % (ds,)})
            out = []
            for b in bucket_agents.all_buckets(ds, DATA_ROOT):
                out.append(bucket_agents.api_row(b))
            # Which bucket's agent each column of the board hands to: the
            # column's name -> its bucket (stream), the way its brief is found.
            columns = {}
            for heading, label in bucket_headings(ds):
                try:
                    columns[label] = bucket_brief_path(heading, ds)[0]
                except LookupError:
                    pass
            return self._json(200, {"buckets": out, "columns": columns})
        if path == "/people.json":
            try:
                with open(people_path(), encoding="utf-8") as fh:
                    return self._json(200, {"people": read_people(fh.read())})
            except OSError:
                # A dataset with no people.md yet: nobody to offer but the agents.
                return self._json(200, {"people": []})
        if path == "/about.json":
            ds = current_dataset()
            where = about_path(ds)
            text, exists = _read_text(where)
            # Signed in, the file's name alone: no folder on the server is shown.
            return self._json(200, {"text": text, "exists": exists,
                                    "path": os.path.basename(where) if AUTH else os.path.relpath(where, ROOT)})
        if path == "/context.json":
            ds = current_dataset()
            where = context_path(ds)
            text, exists = _read_text(where)
            return self._json(200, {"text": text, "exists": exists,
                                    "path": os.path.basename(where) if AUTH else os.path.relpath(where, ROOT)})
        if path == "/memory.json":
            ds = current_dataset()
            about, about_exists = _read_text(about_path(ds))
            context, context_exists = _read_text(context_path(ds))
            people, _ = _read_text(people_path(ds))
            buckets = []
            for heading, label in bucket_headings(ds):
                try:
                    stream, bpath = bucket_brief_path(heading, ds)
                except LookupError:
                    stream, bpath = None, None
                text, exists = _read_text(bpath) if bpath else ("", False)
                buckets.append({"name": label, "heading": heading, "slug": stream,
                                "text": text, "exists": exists,
                                "filled": bool(exists and bucket_agents.NOT_FILLED not in text)})
            return self._json(200, {"board": ds,
                                    "about": {"text": about, "exists": about_exists},
                                    "context": {"text": context, "exists": context_exists},
                                    "people": read_people(people),
                                    "buckets": buckets,
                                    "profile": profile_reply()})
        if path == "/attach-queue.json":
            try:
                with open(attach_queue_path(), encoding="utf-8") as fh:
                    items = json.load(fh)
                    return self._json(200, items if isinstance(items, list) else [])
            except (OSError, ValueError):
                # No file yet, or one written by hand and broken. Either way an
                # empty queue is the honest answer.
                return self._json(200, [])
        if path == "/tick-queue.json":
            import tick_queue
            return self._json(200, tick_queue.read(tick_queue_path()))
        if path == "/pa-working.json":
            # Absent is the ordinary case: pa is not editing. The age is the
            # file's, so the board can ignore one a crashed session left behind.
            try:
                p = pa_working_path()
                age = max(0, int(time.time() - os.path.getmtime(p)))
                with open(p, encoding="utf-8") as fh:
                    got = json.load(fh)
                tasks = got.get("tasks") if isinstance(got, dict) else None
                tasks = [str(t) for t in tasks if str(t).strip()] if isinstance(tasks, list) else []
                return self._json(200, {"working": True, "tasks": tasks, "age": age})
            except (OSError, ValueError):
                return self._json(200, {"working": False, "tasks": [], "age": 0})
        # One task's history, `?task=ab12cd`. See task_history() above.
        if path == "/history.json":
            from urllib.parse import parse_qs, urlparse
            want = (parse_qs(urlparse(self.path).query).get("task") or [""])[0].strip().lower()
            if not re.match(r"^[0-9a-z]{6}$", want):
                return self._json(400, {"error": "task should be a six-character id"})
            return self._json(200, {"task": want, "events": task_history(want)})
        if path == "/agent-runs.json":
            import agent_runs
            return self._json(200, {"subs": agent_runs.read(agent_runs_path())})
        if path == "/briefings.json":
            try:
                with open(briefings_path(), encoding="utf-8") as fh:
                    got = json.load(fh)
                    return self._json(200, got if isinstance(got, dict) else {"version": 1, "briefed": {}})
            except (OSError, ValueError):
                # No file yet — nothing has been briefed — or one written by
                # hand and broken. Either way every chat falls back to raw
                # notes, same as before this existed.
                return self._json(200, {"version": 1, "briefed": {}})
        if path == "/bucket-colors.json":
            try:
                with open(bucket_colors_path(), encoding="utf-8") as fh:
                    colors = json.load(fh)
                    return self._json(200, colors if isinstance(colors, dict) else {})
            except (OSError, ValueError):
                # No file yet, or one written by hand and broken. Either way
                # every bucket falls back to its position in the list.
                return self._json(200, {})
        if path == "/bucket-themes.json":
            try:
                with open(bucket_themes_path(), encoding="utf-8") as fh:
                    themes = json.load(fh)
                    return self._json(200, themes if isinstance(themes, dict) else {})
            except (OSError, ValueError):
                # No file yet, or one written by hand and broken. Either way
                # every bucket falls back to having no themes declared, which
                # is what it always had.
                return self._json(200, {})
        if path == "/column-names.json":
            try:
                with open(column_names_path(), encoding="utf-8") as fh:
                    labels = json.load(fh)
                    return self._json(200, labels if isinstance(labels, dict) else {})
            except (OSError, ValueError):
                # No file yet, or one written by hand and broken. Either way
                # every column falls back to its own heading, which is the
                # only name that was ever load-bearing.
                return self._json(200, {})
        if path == "/bucket-brief.json":
            from urllib.parse import parse_qs, urlparse
            q = parse_qs(urlparse(self.path).query)
            bucket = (q.get("bucket") or [""])[0]
            if not bucket.strip():
                return self._json(400, {"error": "which bucket?"})
            try:
                stream, bpath = bucket_brief_path(bucket)
            except LookupError as err:
                # No list chosen yet (data/.current missing and none to pick).
                # Answer rather than let the request die with a traceback.
                return self._json(404, {"error": "no list is chosen yet, so there is no brief to edit"})
            if not bpath:
                return self._json(404, {"error": "that column names no bucket, so there is no brief to edit"})
            try:
                with open(bpath, encoding="utf-8") as fh:
                    text, exists = fh.read(), True
            except OSError:
                # No brief yet. The template is the honest starting point, and
                # it is what the folder would have been scaffolded with anyway.
                text, exists = brief_template(), False
            marker = bucket_agents.NOT_FILLED
            return self._json(200, {
                "bucket": bucket,
                "stream": stream,
                # Shown in the editor as where the brief is saved. Signed in,
                # the folder inside the list rather than a path on the server.
                "path": os.path.relpath(bpath, dataset_dir(current_dataset()) if AUTH else ROOT),
                "text": text,
                "exists": exists,
                # What the agents themselves ask: a file still carrying the
                # marker line is treated as absent, so the editor says so
                # rather than letting an untouched template read as written.
                "filled": exists and marker not in text,
                "marker": marker,
                # What the board compares the sections with to tell a brief
                # someone wrote from one scaffolded with a one-line summary,
                # which carries no marker but only the template's own prose.
                "template": brief_template(),
                # Whether the bucket's agent could take a task as the brief
                # stands, core/bucket_agents.py being the one judge of that.
                "ready": exists and bucket_agents.parse(text)["ready"],
            })
        if path == "/reports.json":
            return self._json(200, {"reports": report_listing()})
        if path == "/projects.json":
            return self._json(200, {"projects": project_listing()})
        # One folder's contents, asked for by the project drawer alone. Kept
        # off /projects.json on purpose: the Projects view needs a count and
        # nothing else, and shipping every folder's file list to draw it would
        # be the whole of data/projects/ on every render.
        if path == "/project.json":
            from urllib.parse import parse_qs, urlparse
            q = parse_qs(urlparse(self.path).query)
            name = (q.get("name") or [""])[0]
            # A bare folder name under data/projects/, or a path inside a
            # folder the owner approved. project_folders.resolve() is the one check.
            real, err = project_folders.resolve(name, dataset_dir(current_dataset()))
            if err:
                return self._json(err[0], {"error": err[1]})
            sub = (q.get("sub") or [""])[0]
            if sub:
                full, serr = project_subfolder(real, sub)
                if serr:
                    return self._json(serr[0], {"error": serr[1]})
                return self._json(200, {"sub": sub, "entries": project_entries(full)})
            meta = project_meta(real, name)
            if not meta:
                return self._json(404, {"error": "no such project"})
            if os.path.isabs(name):
                external_project(meta, real)
            meta["entries"] = project_entries(real)
            return self._json(200, meta)
        # The folders a Project: note may point at besides data/projects/.
        if path == "/project-folders.json":
            return self._json(200, {
                "default": projects_dir(),
                "folders": project_folders.read_approved(dataset_dir(current_dataset())),
            })
        if path == "/plans.json":
            return self._json(200, {"plans": plan_listing()})
        # The run: a tail of the bucket agents' log for this list, read for
        # the run-cost fold and to see a run started from the board finish.
        if path == "/bucket-agent.json":
            return self._json(200, bucket_agent_run())
        if path == "/agents-status.json":
            return self._json(200, agents_status())
        # Every stream manifest under the workspace folder, with whatever is wrong with each.
        # Read-only and read by nobody yet: the board still gets its columns
        # from 02-state.js. This is here so the views can be moved onto it one
        # at a time rather than all at once.
        if path == "/streams.json":
            return self._json(200, stream_listing())
        # Two routes rather than one, because the jobs are instant and the
        # windows are a second: the view paints the jobs and fetches the usage
        # after, instead of waiting on both.
        if path == "/schedule.json":
            return self._json(200, {"jobs": schedule_listing()})
        if path == "/usage.json":
            # ?days= is the card's range buttons. Clamped rather than trusted:
            # this walks every transcript on disk, so an unbounded span is a
            # way to make the board sit there for a minute.
            from urllib.parse import parse_qs, urlparse
            q = parse_qs(urlparse(self.path).query)
            try:
                days = int((q.get("days") or ["30"])[0])
            except ValueError:
                days = 30
            return self._json(200, usage_summary(days=max(1, min(days, 90))))
        if path == "/backups.json":
            return self._json(200, {
                "backups": backup_listing(),
                "archive": archive_info(),
                "keep": {"session": KEEP_BACKUPS, "weekly": KEEP_WEEKLY},
                "week": week_tag(),
            })
        ai_chat = ai_chat_for(current_dataset())
        # What the board asks before it draws an Ask Claude button. No
        # ai_chat module on disk, or no CLI behind it, answers the same way
        # as static hosting would: a 404, and the board draws no button.
        if ai_chat and path == "/claude.json":
            return self._json(200, ai_chat.status())
        # The whole index in one go. It is a few lines per task and the board
        # already reads whole files rather than querying them.
        if ai_chat and path == "/claude/sessions.json":
            return self._json(200, ai_chat.sessions())
        if ai_chat and path == "/claude/transcript.json":
            from urllib.parse import parse_qs, urlparse
            q = parse_qs(urlparse(self.path).query)
            got, err = ai_chat.transcript((q.get("session") or [""])[0], (q.get("cwd") or [""])[0])
            return self._json(404 if err else 200, err or got)
        # The second check's verdict on the asker's last PA reply, signed in
        # only (server_chat.SharedChat.pa_check). The tab reads it before it
        # applies the reply's changes; none found means they wait.
        if AUTH and ai_chat and path == "/claude/pa-check.json":
            from urllib.parse import parse_qs, urlparse
            q = parse_qs(urlparse(self.path).query)
            got, err = ai_chat.pa_check((q.get("session") or [""])[0])
            return self._json(404 if err else 200, err or got)
        # Sessions Claude Code has on disk that aren't filed here yet — the
        # drawer's "Attach a session…" reads this list. ?q= narrows it
        # server-side, before the newest-60 cap inside list_sessions().
        if ai_chat and path == "/claude/attachable.json":
            from urllib.parse import parse_qs, urlparse
            q = parse_qs(urlparse(self.path).query)
            return self._json(200, ai_chat.attachable((q.get("q") or [""])[0]))
        # The work-item model's browser half, read straight from the package.
        # Same shape as the ai-chat block below, and the same degradation: on a
        # checkout or a deployment without PACKAGES this 404s and the board
        # carries on, which is why nothing it needs to boot comes from here.
        if path.startswith(WS_PREFIX):
            full = work_streams_static(path[len(WS_PREFIX):])
            if not full:
                return self._json(404, {"error": "not found under work-streams/interface"})
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            with open(full, "rb") as fh:
                body = fh.read()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        # The chat window's built script and stylesheet, read straight from
        # ai_chat_engine/dist/ rather than copied in — see AI_CHAT_DIR above.
        if ai_chat and path.startswith(STATIC_PREFIX):
            full = ai_chat_static(path[len(STATIC_PREFIX):])
            if not full:
                return self._json(404, {"error": "not found under ai_chat_engine/dist"})
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            with open(full, "rb") as fh:
                body = fh.read()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        return super().do_GET()

    def _body(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            return None
        if length <= 0 or length > MAX_BYTES:
            return None
        return self.rfile.read(length)

    def _project_upload(self):
        if self.headers.get("X-Board") != "1":
            return self._json(403, {"error": "not from the board"})
        # Signed in, a board's access.json is read and write alike (the PUT
        # save has no stricter test), so the person must be on this board's.
        if AUTH and not board_visible(current_dataset()):
            self.close_connection = True
            return self._json(403, {"error": "you cannot add files to this board"})
        from urllib.parse import parse_qs, urlparse
        q = parse_qs(urlparse(self.path).query)
        name = (q.get("name") or [""])[0]
        sub = (q.get("sub") or [""])[0]
        fname = (q.get("file") or [""])[0]
        if (not fname or fname.startswith(".") or "/" in fname or "\\" in fname
                or ".." in fname or fname != os.path.basename(fname)
                or any(ord(c) < 0x20 or ord(c) == 0x7F for c in fname)):
            self.close_connection = True
            return self._json(400, {"error": "that file name cannot be used"})
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self.close_connection = True
            return self._json(411, {"error": "Content-Length needed"})
        if length < 0:
            self.close_connection = True
            return self._json(400, {"error": "bad Content-Length"})
        if length > MAX_UPLOAD_BYTES:
            self.close_connection = True
            return self._json(413, {"error": "file too large (25 MB at most)"})
        real, err = project_folders.resolve(name, dataset_dir(current_dataset()))
        if err:
            self.close_connection = True
            # Tells the drawer which fix to offer: a folder the task names that
            # is not there (make one), or one that is there but not approved
            # (ask the owner). Never on the shared board, where it would say
            # which paths exist on the server's disk.
            code = None
            if err[0] == 404:
                code = "missing"
            elif err[0] == 403 and os.path.isabs(name) and not AUTH:
                code = "unapproved" if os.path.isdir(os.path.realpath(name)) else "missing"
                if code == "missing":
                    err = (404, "no such project")
            body = {"error": err[1]}
            if code:
                body["code"] = code
            return self._json(err[0], body)
        if sub:
            real, err = project_subfolder(real, sub)
            if err:
                self.close_connection = True
                return self._json(err[0], {"error": err[1]})
        fd, tmp = tempfile.mkstemp(prefix=".upload-", dir=real)
        saved = None
        try:
            with os.fdopen(fd, "wb") as out:
                left = length
                while left > 0:
                    chunk = self.rfile.read(min(65536, left))
                    if not chunk:
                        raise OSError("the upload stopped early")
                    out.write(chunk)
                    left -= len(chunk)
            stem, ext = os.path.splitext(fname)
            n = 1
            while True:
                saved = fname if n == 1 else "%s (%d)%s" % (stem, n, ext)
                dest = os.path.join(real, saved)
                try:
                    # A hard link fails if the name exists, so two uploads of
                    # one name cannot both take it, and nothing is overwritten.
                    os.link(tmp, dest)
                    break
                except FileExistsError:
                    n += 1
        except OSError as exc:
            self.close_connection = True
            return self._json(500, {"error": "could not save it: %s" % exc})
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        return self._json(200, {"ok": True, "name": saved})

    def do_POST(self):
        path = self.path.split("?")[0]
        if path.startswith(AGENTS_PREFIX + "/"):
            return self._agents_post(path[len(AGENTS_PREFIX):])
        if path == "/datasets":
            data = self._body()
            try:
                payload = json.loads((data or b"{}").decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                return self._json(400, {"error": "body was not valid JSON"})
            name = slugify(payload.get("name"))
            if not name:
                return self._json(400, {"error": "that name has nothing usable in it"})
            if name in board_access.RESERVED:
                return self._json(400, {"error": "“%s” is a folder Bench keeps for itself" % name})
            if name in list_datasets(everyone=True):
                return self._json(409, {"error": "there is already a list called “%s”" % name})
            # Signed in, a list is someone's from the moment it exists: worked
            # out before anything is made, so a refusal makes nothing.
            access = None
            if AUTH:
                access, err = sharing_from(payload.get("sharing"), requester())
                if err:
                    return self._json(400, {"error": err})
            # The wizard posts the buckets it collected, each with the one-line
            # description that becomes its brief's opening. An older board posts
            # a name and nothing else, which create_dataset() still answers.
            buckets = payload.get("buckets")
            if not create_dataset(name, buckets if isinstance(buckets, list) else None):
                return self._json(409, {"error": "there is already a folder called “%s”" % name})
            # Until this lands the list has no access.json, which signed in
            # means nobody sees it, so there is no moment it is open to all.
            if access:
                board_access.write(dataset_dir(name), access)
            set_current_dataset(name)
            publish_boards()
            return self._json(200, {"ok": True, "name": name,
                                    "datasets": list_datasets(), "current": name})
        if path == "/dataset/select":
            data = self._body()
            try:
                payload = json.loads((data or b"{}").decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                return self._json(400, {"error": "body was not valid JSON"})
            name = str(payload.get("name") or "")
            if name not in list_datasets():
                return self._json(404, {"error": "no list called “%s”" % name})
            set_current_dataset(name)
            publish_boards()
            return self._json(200, {"ok": True, "current": name})
        # The owner changes who else sees the board on screen. Personal is
        # neither people nor teams.
        if path == "/dataset/access":
            if not AUTH:
                return self._json(404, {"error": "nobody signs in to this board"})
            try:
                payload = json.loads((self._body() or b"{}").decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                return self._json(400, {"error": "body was not valid JSON"})
            if not isinstance(payload, dict):
                return self._json(400, {"error": "expected people and teams"})
            ds = str(payload.get("name") or current_dataset() or "")
            if ds not in list_datasets():
                return self._json(404, {"error": "no list called “%s”" % ds})
            was = board_access.read(dataset_dir(ds))
            who = requester()
            if not was or was["owner"] != who["email"]:
                return self._json(403, {"error": "only the list’s owner can change who sees it"})
            access, err = board_access.clean(who["email"], payload.get("people") or [],
                                             payload.get("teams") or [])
            if not err:
                # A team kept from before may stay even if its owner has since
                # left it; a new one has to be theirs.
                new = set(access["teams"]) - set(was["teams"]) - set(who["teams"])
                if new:
                    err = "you are not in %s" % ", ".join(sorted(new))
            if err:
                return self._json(400, {"error": err})
            board_access.write(dataset_dir(ds), access)
            return self._json(200, dict(access, board=ds, mine=True))
        ai_chat = ai_chat_for(current_dataset())
        # Both routes below are refused unless the request carries X-Board: 1.
        # Any page in any tab can POST to 127.0.0.1 — that is what CSRF is —
        # but a header a form cannot set forces a preflight this server does
        # not answer, so the request never leaves the other page. See
        # ai_chat/README.md for the rest of that story.
        if ai_chat and path == "/claude":
            if not ai_chat.guard_ok(self):
                return self._json(403, {"error": "not from the board"})
            data = self._body()
            try:
                payload = json.loads((data or b"{}").decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                return self._json(400, {"error": "body was not valid JSON"})
            err = ai_chat.stream(self, payload)
            if err:
                return self._json(err[0], err[1])
            return
        if ai_chat and path == "/claude/forget":
            if not ai_chat.guard_ok(self):
                return self._json(403, {"error": "not from the board"})
            data = self._body()
            try:
                payload = json.loads((data or b"{}").decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                return self._json(400, {"error": "body was not valid JSON"})
            if not isinstance(payload, dict):
                return self._json(400, {"error": "body was not a JSON object"})
            got, err = ai_chat.forget(payload.get("owner"), payload.get("session"))
            return self._json(400 if err else 200, err or got)
        # Start a project: a folder under projects_dir() with a CLAUDE.md in it.
        # The Project: note on the task is written by the board, in memory, and
        # saved by autosave — this server never writes todo.md.
        if path == "/project/start":
            if self.headers.get("X-Board") != "1":
                return self._json(403, {"error": "not from the board"})
            try:
                payload = json.loads((self._body() or b"{}").decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                return self._json(400, {"error": "body was not valid JSON"})
            slug, err = start_project(str(payload.get("name") or ""),
                                      str(payload.get("title") or ""))
            if err:
                return self._json(err[0], {"error": err[1]})
            return self._json(200, {"ok": True, "name": slug,
                                    "note": "data/projects/" + slug})
        # Add a file to a project folder (or a folder inside it), from the
        # drawer's Files section. ?name=<project>&sub=<folder>&file=<name>, the
        # body the raw bytes. Never overwrites: a clash is saved as "name (2).ext".
        if path == "/project/upload":
            return self._project_upload()
        # Reveal a project folder in Finder. Only on the machine the server
        # runs on, which is why the board leaves the button off its static copy.
        if path == "/project/open":
            if self.headers.get("X-Board") != "1":
                return self._json(403, {"error": "not from the board"})
            try:
                payload = json.loads((self._body() or b"{}").decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                return self._json(400, {"error": "body was not valid JSON"})
            real, err = project_folders.resolve(str(payload.get("name") or ""),
                                                dataset_dir(current_dataset()))
            if err:
                return self._json(err[0], {"error": err[1]})
            try:
                platform_calls.open_path(real)
            except OSError as exc:
                return self._json(500, {"error": "could not open it: %s" % exc})
            return self._json(200, {"ok": True})
        # Approve a folder of the owner's own for Project: notes to point into. The
        # board asks the owner to confirm before it posts here.
        if path == "/project-folders":
            if self.headers.get("X-Board") != "1":
                return self._json(403, {"error": "not from the board"})
            try:
                payload = json.loads((self._body() or b"{}").decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                return self._json(400, {"error": "body was not valid JSON"})
            folders, err = project_folders.approve(dataset_dir(current_dataset()),
                                                   str(payload.get("path") or ""))
            if err:
                return self._json(err[0], {"error": err[1]})
            return self._json(200, {"ok": True, "folders": folders})
        if path == "/chat-viewed":
            # Same guard as the Claude routes. Nothing here is dangerous —
            # worst case is a card reading as unread — but this server's rule is
            # that anything a page can POST carries the header, and one
            # exception is how a rule stops being a rule.
            if self.headers.get("X-Board") != "1":
                return self._json(403, {"error": "not from the board"})
            data = self._body()
            try:
                payload = json.loads((data or b"{}").decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                return self._json(400, {"error": "body was not valid JSON"})
            if not isinstance(payload, dict):
                return self._json(400, {"error": "expected an object"})
            path_out = chat_viewed_path()
            os.makedirs(os.path.dirname(path_out), exist_ok=True)
            tmp = path_out + ".tmp"
            with open(tmp, "w", encoding="utf-8", newline="") as fh:
                json.dump(payload, fh, indent=2)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, path_out)
            return self._json(200, {"ok": True})
        if path == "/bucket/scaffold":
            """A bucket added or renamed on the board, given what a bucket needs.

            Without this a bucket would have no brief, no folder and no row in
            the README, and would be planned against the fallback with nothing
            for the agent to read. It is the same
            action as naming one at list creation, so it writes the same things.

            A rename is the other half and it is deliberately not the same
            thing: the stream is fixed when the bucket is created, so renaming
            moves the README row and nothing else. Nothing on disk is renamed,
            which is the point.
            """
            if self.headers.get("X-Board") != "1":
                return self._json(403, {"error": "not from the board"})
            data = self._body()
            try:
                payload = json.loads((data or b"{}").decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                return self._json(400, {"error": "body was not valid JSON"})
            name = " ".join(str(payload.get("name") or "").split())
            was = payload.get("was")
            if not name or len(name) > 200:
                return self._json(400, {"error": "a bucket needs a name"})
            rows, _ = readme_rows()
            pinned = dict((bucket_heading_key(h), st) for h, st in rows)
            # A rename keeps whatever stream the old heading was pinned to; an
            # add takes the new heading's own slug.
            stream = (pinned.get(bucket_heading_key(was)) if was else None) \
                or pinned.get(bucket_heading_key(name)) \
                or slugify(name)
            if not stream:
                return self._json(400, {"error": "that name has nothing usable in it"})
            readme_note_bucket(None, name, stream, was)
            brief = scaffold_bucket(None, name, stream, payload.get("about") or "")
            return self._json(200, {"ok": True, "stream": stream,
                                    "brief": os.path.relpath(brief, dataset_dir(current_dataset()) if AUTH else ROOT),
                                    "renamed": bool(was)})
        if path == "/bucket-colors":
            # Same guard, same shape as /chat-viewed: the whole map is sent and
            # written back whole, and nothing here is dangerous to get wrong —
            # worst case is a bucket in the wrong colour.
            if self.headers.get("X-Board") != "1":
                return self._json(403, {"error": "not from the board"})
            data = self._body()
            try:
                payload = json.loads((data or b"{}").decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                return self._json(400, {"error": "body was not valid JSON"})
            if not isinstance(payload, dict) or len(payload) > 200:
                return self._json(400, {"error": "expected a name -> colour map"})
            for k, v in payload.items():
                if not isinstance(k, str) or not isinstance(v, str) or len(k) > 200 or len(v) > 40:
                    return self._json(400, {"error": "bad name or colour"})
            path_out = bucket_colors_path()
            os.makedirs(os.path.dirname(path_out), exist_ok=True)
            tmp = path_out + ".tmp"
            with open(tmp, "w", encoding="utf-8", newline="") as fh:
                json.dump(payload, fh, indent=2, sort_keys=True)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, path_out)
            return self._json(200, {"ok": True})
        if path == "/bucket-themes":
            # Same guard, same shape as /bucket-colors: the whole map is sent
            # and written back whole. A list rather than a string per entry,
            # since a bucket declares several themes at once — worst case of
            # getting one wrong is a pill on the board that says the wrong
            # thing.
            if self.headers.get("X-Board") != "1":
                return self._json(403, {"error": "not from the board"})
            data = self._body()
            try:
                payload = json.loads((data or b"{}").decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                return self._json(400, {"error": "body was not valid JSON"})
            if not isinstance(payload, dict) or len(payload) > 200:
                return self._json(400, {"error": "expected a name -> theme list map"})
            for k, v in payload.items():
                if not isinstance(k, str) or len(k) > 200 or not isinstance(v, list) or len(v) > 100:
                    return self._json(400, {"error": "bad bucket name or theme list"})
                if not all(isinstance(x, str) and len(x) <= 60 for x in v):
                    return self._json(400, {"error": "bad theme value"})
            path_out = bucket_themes_path()
            os.makedirs(os.path.dirname(path_out), exist_ok=True)
            tmp = path_out + ".tmp"
            with open(tmp, "w", encoding="utf-8", newline="") as fh:
                json.dump(payload, fh, indent=2, sort_keys=True)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, path_out)
            return self._json(200, {"ok": True})
        if path == "/column-names":
            # Same guard and same shape as /bucket-colors: the whole map is
            # sent and written back whole, and the worst a bad one can do is
            # put the wrong word above a column.
            if self.headers.get("X-Board") != "1":
                return self._json(403, {"error": "not from the board"})
            data = self._body()
            try:
                payload = json.loads((data or b"{}").decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                return self._json(400, {"error": "body was not valid JSON"})
            if not isinstance(payload, dict) or len(payload) > 200:
                return self._json(400, {"error": "expected a heading -> label map"})
            for k, v in payload.items():
                if not isinstance(k, str) or not isinstance(v, str) or len(k) > 200 or len(v) > 200:
                    return self._json(400, {"error": "bad heading or label"})
            path_out = column_names_path()
            os.makedirs(os.path.dirname(path_out), exist_ok=True)
            tmp = path_out + ".tmp"
            with open(tmp, "w", encoding="utf-8", newline="") as fh:
                json.dump(payload, fh, indent=2, sort_keys=True)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, path_out)
            return self._json(200, {"ok": True})
        if path == "/attach-queue.json":
            # Same guard, same shape as /chat-viewed. Only the board calls this,
            # after draining what it could — see attach_queue_path() — to
            # write back whatever it could not file, or an empty list.
            if self.headers.get("X-Board") != "1":
                return self._json(403, {"error": "not from the board"})
            data = self._body()
            try:
                payload = json.loads((data or b"{}").decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                return self._json(400, {"error": "body was not valid JSON"})
            if not isinstance(payload, list):
                return self._json(400, {"error": "expected an array"})
            path_out = attach_queue_path()
            os.makedirs(os.path.dirname(path_out), exist_ok=True)
            tmp = path_out + ".tmp"
            with open(tmp, "w", encoding="utf-8", newline="") as fh:
                json.dump(payload, fh, indent=2)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, path_out)
            return self._json(200, {"ok": True})
        if path == "/agent-runs":
            # The owner's two requests about an agent's run: retry a failed one, or
            # clear one the owner has taken back. Everything else in the file is the
            # agents' to write (core/agent_runs.py). Same guard as the queues.
            if self.headers.get("X-Board") != "1":
                return self._json(403, {"error": "not from the board"})
            try:
                payload = json.loads((self._body() or b"{}").decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                return self._json(400, {"error": "body was not valid JSON"})
            import agent_runs
            action = payload.get("action") if isinstance(payload, dict) else None
            sub = str((payload or {}).get("sub") or "").strip().lower()
            if action not in ("retry", "clear") or not re.fullmatch(r"[a-z0-9]{6}", sub):
                return self._json(400, {"error": "expected {\"action\": \"retry\" or \"clear\", \"sub\": id}"})
            if action == "retry":
                agent_runs.retry(sub, path=agent_runs_path())
            else:
                agent_runs.clear(sub, path=agent_runs_path())
            return self._json(200, {"ok": True, "subs": agent_runs.read(agent_runs_path())})
        if path == "/tick-queue.json":
            # The board says which requests it dealt with, applied or refused,
            # and they come out. Anything an agent queued since it read the
            # list stays. Same guard as /attach-queue.json.
            if self.headers.get("X-Board") != "1":
                return self._json(403, {"error": "not from the board"})
            data = self._body()
            try:
                payload = json.loads((data or b"{}").decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                return self._json(400, {"error": "body was not valid JSON"})
            ids = payload.get("done") if isinstance(payload, dict) else None
            if not isinstance(ids, list):
                return self._json(400, {"error": "expected {\"done\": [ids]}"})
            import tick_queue
            # What the board dealt with is about to be saved as the board's
            # change, so the cards it touches are credited to the agents that
            # asked first, against the list as it stands now.
            with _save_lock:
                ds = current_dataset()
                wanted = set(str(i) for i in ids)
                dealt = [e for e in tick_queue.read(tick_queue_path()) if str(e.get("id")) in wanted]
                try:
                    with open(todo_path(ds), encoding="utf-8") as fh:
                        credit_agents(ds, dealt, fh.read())
                except OSError:
                    pass
                return self._json(200, {"removed": tick_queue.remove(sorted(wanted), tick_queue_path())})
        if ai_chat and path == "/claude/assign":
            if not ai_chat.guard_ok(self):
                return self._json(403, {"error": "not from the board"})
            data = self._body()
            try:
                payload = json.loads((data or b"{}").decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                return self._json(400, {"error": "body was not valid JSON"})
            if not isinstance(payload, dict):
                return self._json(400, {"error": "body was not a JSON object"})
            got, err = ai_chat.assign(
                payload.get("owner"), payload.get("session"), payload.get("to")
            )
            return self._json(400 if err else 200, err or got)
        if ai_chat and path == "/claude/note":
            if not ai_chat.guard_ok(self):
                return self._json(403, {"error": "not from the board"})
            data = self._body()
            try:
                payload = json.loads((data or b"{}").decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                return self._json(400, {"error": "body was not valid JSON"})
            if not isinstance(payload, dict):
                return self._json(400, {"error": "body was not a JSON object"})
            got, err = ai_chat.note(
                payload.get("owner"), payload.get("session"), payload.get("prompt")
            )
            return self._json(400 if err else 200, err or got)
        if ai_chat and path == "/claude/attach":
            if not ai_chat.guard_ok(self):
                return self._json(403, {"error": "not from the board"})
            data = self._body()
            try:
                payload = json.loads((data or b"{}").decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                return self._json(400, {"error": "body was not valid JSON"})
            got, err = ai_chat.attach(
                payload.get("owner"), payload.get("session"),
                payload.get("cwd"), payload.get("title")
            )
            return self._json(400 if err else 200, err or got)
        if path == "/agenda-history":
            data = self._body()
            if data is None:
                return self._json(400, {"error": "bad or empty body"})
            try:
                payload = json.loads(data.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                return self._json(400, {"error": "body was not valid JSON"})
            text = payload.get("text") or ""
            if not text.strip():
                return self._json(400, {"error": "nothing to file"})
            name = archive_agenda(text)
            sys.stdout.write("filed a previous agenda to %s/%s/backups/%s\n" % (DATA, current_dataset(), name))
            sys.stdout.flush()
            return self._json(200, {"ok": True, "archive": name})
        if path != "/archive":
            return self._json(404, {"error": "nothing to post there"})
        data = self._body()
        if data is None:
            return self._json(400, {"error": "bad or empty body"})
        try:
            payload = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return self._json(400, {"error": "body was not valid JSON"})
        text = payload.get("text") or ""
        if not text.strip():
            return self._json(400, {"error": "nothing to archive"})
        name = archive_done(text)
        sys.stdout.write("archived finished work to %s/%s/backups/%s\n" % (DATA, current_dataset(), name))
        sys.stdout.flush()
        return self._json(200, {"ok": True, "archive": name})

    def _put_bucket_brief(self):
        """A bucket's brief, replaced whole.

        A PUT rather than a POST beside /bucket-colors because that is what it
        is — one file replaced by one file, with no merge and nothing partial
        about it. None of todo.md's preconditions apply: the brief has no
        second writer, the board holds no cached copy of it between openings,
        and it is read fresh every time the sheet opens.
        """
        if self.headers.get("X-Board") != "1":
            return self._json(403, {"error": "not from the board"})
        data = self._body()
        try:
            payload = json.loads((data or b"{}").decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return self._json(400, {"error": "body was not valid JSON"})
        if not isinstance(payload, dict):
            return self._json(400, {"error": "expected a bucket and its brief"})
        bucket, text = payload.get("bucket"), payload.get("text")
        if not isinstance(bucket, str) or not bucket.strip() or not isinstance(text, str):
            return self._json(400, {"error": "expected a bucket and its brief"})
        stream, bpath = bucket_brief_path(bucket)
        if not bpath:
            return self._json(404, {"error": "that column names no bucket, so there is no brief to write"})
        os.makedirs(os.path.dirname(bpath), exist_ok=True)
        # Same temp-then-swap as every other write in here, so a crash
        # mid-write cannot leave a half-written brief for the night to read.
        tmp = bpath + ".tmp"
        with open(tmp, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, bpath)
        return self._json(200, {"ok": True, "stream": stream,
                                "filled": bucket_agents.NOT_FILLED not in text})

    def _put_json_from_board(self):
        """(payload, None), or (None, True) once a refusal has been sent: the
        same checks _put_bucket_brief() makes before it looks at the body."""
        if self.headers.get("X-Board") != "1":
            self._json(403, {"error": "not from the board"})
            return None, True
        try:
            payload = json.loads((self._body() or b"{}").decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            self._json(400, {"error": "body was not valid JSON"})
            return None, True
        if not isinstance(payload, dict):
            self._json(400, {"error": "body must be an object"})
            return None, True
        return payload, False

    def _put_about(self):
        """The board's company text, replaced whole. Like a brief it has no
        second writer and no cached copy to merge with."""
        payload, refused = self._put_json_from_board()
        if refused:
            return
        text = payload.get("text")
        if not isinstance(text, str):
            return self._json(400, {"error": "expected the text"})
        ds = current_dataset()
        if not ds:
            return self._json(404, {"error": "no list you can see"})
        write_text_file(about_path(ds, write=True), text)
        return self._json(200, {"ok": True})

    def _put_context(self):
        """The board's Context, replaced whole in context.md. Same rules as
        the company text."""
        payload, refused = self._put_json_from_board()
        if refused:
            return
        text = payload.get("text")
        if not isinstance(text, str):
            return self._json(400, {"error": "expected the text"})
        ds = current_dataset()
        if not ds:
            return self._json(404, {"error": "no list you can see"})
        write_text_file(context_path(ds, write=True), text)
        return self._json(200, {"ok": True})

    def _put_people(self):
        """The board's team: the rows replace the people table in people.md,
        and the rest of the file stays as it is (write_people_table())."""
        payload, refused = self._put_json_from_board()
        if refused:
            return
        rows = payload.get("people")
        if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
            return self._json(400, {"error": "expected a list of people"})
        names = []
        for r in rows:
            for key in ("name", "role", "team", "reports_to", "notes"):
                if not isinstance(r.get(key, ""), str):
                    return self._json(400, {"error": "%s must be text" % key})
            name = _cell(r.get("name")).replace("**", "")
            if not name:
                return self._json(400, {"error": "every person needs a name"})
            if name in names:
                return self._json(400, {"error": "%s is listed twice" % name})
            names.append(name)
        ds = current_dataset()
        if not ds:
            return self._json(404, {"error": "no list you can see"})
        # Read from wherever it is now, written to the memory folder when one is set.
        text, _ = _read_text(people_path(ds))
        try:
            table = write_people_table(text, rows)
        except ValueError:
            return self._json(409, {"error": "people.md has more than one people table; tidy it by hand first"})
        path = people_path(ds, write=True)
        write_text_file(path, table)
        text, _ = _read_text(path)
        return self._json(200, {"ok": True, "people": read_people(text)})

    def _put_settings(self):
        if self.headers.get("X-Board") != "1":
            return self._json(403, {"error": "not from the board"})
        try:
            body = json.loads((self._body() or b"").decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return self._json(400, {"error": "body was not valid JSON"})
        # Both halves are checked before either is written, so a refusal writes nothing.
        err = settings.validate(body, DATA_ROOT) or settings.budgets_error(body)
        if err:
            return self._json(400, {"error": err})
        settings.save_budgets(os.environ["AGENTS_FENCES"], body)
        saved, err = settings.save(DATA_ROOT, body)
        if err:
            return self._json(400, {"error": err})
        # boards.md names the memory folder and marks a list with its agents off.
        if "memory_root" in body or "boards" in body:
            publish_boards()
        return self._json(200, settings_reply(saved))

    def _put_profile_basics(self):
        if self.headers.get("X-Board") != "1":
            return self._json(403, {"error": "not from the board"})
        import owner_profile
        try:
            body = json.loads((self._body() or b"").decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return self._json(400, {"error": "body was not valid JSON"})
        if not isinstance(body, dict):
            return self._json(400, {"error": "body must be an object"})
        about, sections = body.get("about") or {}, body.get("sections") or {}
        if not isinstance(about, dict) or not isinstance(sections, dict):
            return self._json(400, {"error": "about and sections must be objects"})
        who = requester()
        if who and (set(about) & set(SHARED_HIDES["about"]) or set(sections) & set(SHARED_HIDES["sections"])):
            return self._json(400, {"error": "a path on the shared board is not yours to set"})
        country, region = body.get("country"), body.get("region")
        if country in (None, ""):
            country = None      # Not set: the holiday lines stay as they are
        else:
            import holidays as nager
            country = str(country).strip().upper()
            region = str(region or "").strip().upper()
            if country not in {c for c, _ in iso_countries.ISO_COUNTRIES}:
                return self._json(400, {"error": "unknown country"})
            if region and (not _nager_has(country) or region not in {r["code"] for r in nager.regions(country, DATA_ROOT)}):
                return self._json(400, {"error": "unknown region for %s" % country})
        # Signed in, the person's own file and nobody else's: who they are is
        # nginx's header, never anything in the body.
        err = owner_profile.write_basics(DATA_ROOT, body.get("name"), country=country, region=region,
                                         about=about, sections=sections,
                                         address=who["email"] if who else None,
                                         board=current_dataset())
        if err:
            return self._json(400, {"error": err})
        return self._json(200, profile_reply())

    def do_PUT(self):
        # Answered before the guard below, which is written to refuse
        # everything that is not todo.md. A brief is a different file with a
        # different contract — see _put_bucket_brief().
        if self.path.split("?")[0] == "/bucket-brief":
            return self._put_bucket_brief()
        if self.path.split("?")[0] == "/about":
            return self._put_about()
        if self.path.split("?")[0] == "/context":
            return self._put_context()
        if self.path.split("?")[0] == "/people":
            return self._put_people()
        if self.path.split("?")[0] == "/settings.json":
            return self._put_settings()
        if self.path.split("?")[0] == "/profile-basics.json":
            return self._put_profile_basics()
        if self.path.split("?")[0].lstrip("/") != TARGET:
            return self._json(404, {"error": "only %s can be written" % TARGET})

        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            return self._json(400, {"error": "bad Content-Length"})
        # The board sends the list as JSON, {text, base}: the document, and the
        # version of the file it was built on, so a save that arrives after
        # someone else's can be merged with it (see below). A bare document
        # is still taken, from a script or a tab from before this, and is
        # refused rather than merged when the file has moved under it.
        as_json = (self.headers.get("Content-Type") or "").startswith("application/json")
        if length <= 0:
            return self._json(400, {"error": "empty body refused"})
        if length > (2 * MAX_BYTES + 4096 if as_json else MAX_BYTES):
            return self._json(413, {"error": "file too large"})

        data = self.rfile.read(length)
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            return self._json(400, {"error": "body was not valid UTF-8"})
        base = board = None
        if as_json:
            try:
                sent = json.loads(text)
                text, base, board = sent["text"], sent.get("base"), sent.get("board")
            except (ValueError, KeyError, TypeError):
                return self._json(400, {"error": "body was not {text, base}"})
            if not isinstance(text, str) or not (base is None or isinstance(base, str)) \
                    or not (board is None or isinstance(board, str)):
                return self._json(400, {"error": "body was not {text, base}"})
            if len(text.encode("utf-8")) > MAX_BYTES:
                return self._json(413, {"error": "file too large"})
        if "## " not in text:
            return self._json(400, {"error": "that does not look like the to-do file, refusing to write"})

        # One save at a time, from reading the file to writing it. A merge
        # reads the file, works, and writes, and a second save landing in
        # between would be written over unseen.
        with _save_lock:
            return self._write_list(text, base, len(data), board)

    def _write_list(self, text, base, size, board=None):
        ds = current_dataset()
        path = todo_path(ds)

        # The list the tab read, named by the tab (`board`, the X-Bench-Board
        # its GET carried). A tab is on whatever list it loaded, and the
        # server's current one can move under it: another tab's dropdown, or a
        # banner link. Merged against the wrong file, a save writes one list's
        # tasks into another, so a save naming another list is refused whole
        # and the tab reloads onto the one now current. A save naming none
        # (pa_save.py, which pins its board with X-Offdesk-Board, or a script)
        # goes to the current list as before.
        if board is not None and board != ds:
            return self._json(409, {"error": "this tab holds %s, but the board is now on %s, "
                                             "so nothing was written" % (board or "no list", ds or "no list"),
                                    "wrongBoard": True, "board": ds})

        # A migration is working on this list directly, with the board shut. A
        # tab left open from before it started holds the pre-migration document
        # and would put it back. See migrating_path().
        if os.path.exists(migrating_path(ds)):
            return self._json(409, {"error": "a migration is running on this list, so nothing was written",
                                    "migrating": True})

        # The tab sends back the Last-Modified it last agreed with (state.diskStamp,
        # set by rememberStamp in 24-autosave-watching.js). If the file has moved
        # since, this document was built on a version that no longer exists and
        # writing it whole would drop whatever changed in between.
        #
        # Until now there was no check of any kind here: do_PUT took a whole
        # document from any tab and replaced the file with it. That is the hole
        # both real losses went through, and the board already has a conflict
        # modal (23-conflict-modal.js) built to answer the 409.
        #
        # Second precision, because that is all Last-Modified carries. The string
        # is built the same way SimpleHTTPRequestHandler built the one the tab was
        # given, so the two compare directly without parsing either. What that
        # second cannot see is checked below, by If-Match against the content.
        # One writer per stream, checked rather than assumed. The board is the
        # writer for this list, so it takes the claim and keeps it; what this
        # refuses is a second live process writing underneath it. Advisory: a
        # claim held by a process that has gone is ignored, so a crash cannot
        # leave the board unable to save. See PACKAGES/work-streams/writer.py.
        if ws_writer is not None:
            lock = os.path.join(dataset_dir(ds), ".board.lock")
            refusal = ws_writer.refusal(lock, "the board")
            if refusal:
                return self._json(409, {"error": refusal, "locked": True})
            ws_writer.claim(lock, "the board")

        since = self.headers.get("If-Unmodified-Since")
        if not since and base is None:
            # Required, not optional, unless the save names its version by
            # content (`base`, below). Every legitimate writer has read the file
            # first: loadFile() takes the stamp off its own GET, and a tab that
            # has not read it is in demo mode and locked, so it cannot save at
            # all. That makes a header-less PUT something no board ever sends —
            # which is exactly what an ad-hoc script or a test harness sends,
            # and those are what took the list both times.
            return self._json(428, {"error": "a write must say which version of todo.md it is replacing "
                                             "(If-Unmodified-Since); nothing was written",
                                    "precondition": True})

        # Built on an old version, and saying which: merged rather than
        # refused. The version is the text itself, so the check is exact and
        # needs nothing remembered here between saves. Fields only one side
        # changed are taken from that side; the same field changed apart on
        # both, or a task deleted on one side and edited on the other, is a
        # conflict, and nothing is written until the tab says which wins. The
        # 409 carries the file as it is, so the tab can answer without
        # reading it again. todo.merge_saves() is the board's mergeSaves().
        # Anything written straight to the file since the server last did is
        # accounted for first, so it is credited to `pa` rather than to this
        # save, and the merge below sees the file as it now stands.
        notice_outside_edit(ds, wait=True)

        merged = False
        sent = text
        current_text = None
        if os.path.exists(path):
            with open(path, encoding="utf-8", newline="") as fh:
                current_text = fh.read()
        if base is not None and current_text is not None:
            if current_text != base:
                if todo is None:
                    return self._json(409, {"error": "todo.md changed on disk since this tab last read it",
                                            "stale": True, "disk": self.date_time_string(os.stat(path).st_mtime),
                                            "hash": file_hash(path)})
                got = todo.merge_saves(base, text, current_text)
                if got["text"] is None:
                    return self._json(409, {"error": "todo.md changed on disk, and the same thing was changed here",
                                            "stale": True, "conflicts": got["conflicts"],
                                            "current": current_text,
                                            "disk": self.date_time_string(os.stat(path).st_mtime),
                                            "hash": file_hash(path)})
                merged = got["text"] != text
                text = got["text"]

        if base is None and os.path.exists(path):
            current = self.date_time_string(os.stat(path).st_mtime)
            if since != current:
                return self._json(409, {"error": "todo.md changed on disk since this tab last read it",
                                        "stale": True, "disk": current,
                                        "hash": file_hash(path)})

        # And the same question asked of the content, which is the half the
        # stamp above cannot answer. Last-Modified is second-precision, so a
        # write landing in the same second as the read this document was built
        # on passes that check while replacing a file it never saw. The hash
        # does not have that blind spot.
        #
        # Checked when offered rather than demanded the way the stamp is. The
        # board always offers it — every read sets state.diskHash — so a write
        # without one is either a tab from before this landed or a script, and
        # both are already held by the 428 above. Making it required as well
        # would refuse the first save after an upgrade for no gain.
        match = self.headers.get("If-Match")
        if base is None and match and os.path.exists(path):
            digest = file_hash(path)
            if digest and match != digest:
                return self._json(409, {"error": "todo.md changed on disk since this tab last read it",
                                        "stale": True,
                                        "disk": self.date_time_string(os.stat(path).st_mtime),
                                        "hash": digest})

        # Who wrote each task and who last changed it, measured against the file
        # this replaces, and set here so a tab cannot claim either for anyone:
        # what it sent for them is put back to what the file says. Signed in,
        # that is the email nginx vouched for; on the Mac nobody signs in, no
        # tag is written and the text goes out as sent. Either way the
        # changes go to the list's activity log once the write has landed.
        # With no file yet it is measured against an empty one, so every task
        # in a first save is the signer's, whatever the tab wrote on it.
        # A card an agent's request changed goes under the agent (take_credits).
        # Signed in, an assignee is a board person's email, but the PA and
        # anyone typing hand over by name: `[to:: Jerome]`. A name on a line
        # this save adds or changes becomes the one person on the board it
        # means; a name meaning nobody or more than one refuses the whole save,
        # naming the line and who it could be, rather than store a name no
        # card, Mine filter or "your move" will ever match. The Mac board has
        # no people and keeps names as written.
        if todo is not None and AUTH and requester():
            people = board_access.board_people(DATA_ROOT, board_access.read(dataset_dir(ds)))
            text, unknown = todo.resolve_assignees(current_text or "", text,
                                                   lambda name: board_access.people_named(people, name))
            if unknown:
                return self._json(422, {"error": "not saved: " + "; ".join(
                    "line %d gives a task to %s, who %s on this board" % (
                        u["line"], u["name"],
                        "could be %s" % " or ".join(u["candidates"]) if u["candidates"] else "is nobody")
                    for u in unknown), "assignees": unknown})

        changes = []
        if todo is not None:
            who = requester()
            text, changes = todo.stamp_authors(current_text if current_text is not None else "", text,
                                               who["email"] if who else "", credits=take_credits(ds),
                                               write_tags=bool(AUTH))
            spend_credits(ds, changes)

        backup_name = None

        # A save is also a chance to notice the week turned over.
        weekly_name = weekly_backup()

        # A write that removes tasks asks for its own backup, whether or not this
        # run has already taken one. One per session is the right amount for
        # ordinary edits and the wrong amount for the save that empties something
        # out of the file.
        forced = "backup=force" in self.path
        if forced:
            backup_made.discard(ds)

        # One backup per run, before the first write of this session.
        if ds not in backup_made and os.path.exists(path):
            stamp = datetime.datetime.now().strftime("%Y-%m-%d-%H%M%S")
            backup_name = "todo-backup-%s.md" % stamp
            bdir = backup_dir(ds)
            os.makedirs(bdir, exist_ok=True)
            shutil.copy2(path, os.path.join(bdir, backup_name))
            backup_made.add(ds)
            prune_backups()

        if not current_dataset():
            return self._json(409, {"error": "there is no list yet to save into"})
        # Write to a neighbouring temp file first, then swap it in, so a crash
        # mid-write cannot leave todo.md half-written.
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        remember(ds, text)

        # The stamp and hash of what was just written, both taken inside the
        # save lock, so they describe this write and no later one. A tab that
        # sent `base` adopts them rather than asking with a HEAD, which could
        # land after somebody else's save and hand it a version its document
        # was never built on. A merged save also carries the text written, so
        # the tab can show what the other side changed.
        # On the Mac nobody signs in, and the one sender that holds a request
        # to a board is pa_save.py, so the save is the PA's, as it was when
        # the PA wrote the file and notice_outside_edit() found it.
        if not AUTH and pinned_board():
            append_activity(ds, changes, who="pa", name="pa")
        else:
            append_activity(ds, changes)
        reply = {"ok": True, "board": ds, "bytes": size, "backup": backup_name, "weekly": weekly_name,
                 "hash": file_hash(path), "disk": self.date_time_string(os.stat(path).st_mtime)}
        # The text as written, whenever it is not what the tab sent: merged
        # with somebody else's save, or carrying who wrote what.
        if text != sent:
            reply["text"] = text
        if merged:
            reply["merged"] = True
        self._json(200, reply)


def main():
    os.chdir(ROOT)
    if AUTH_ERROR:
        print(AUTH_ERROR)
        return 2
    if AUTH and HOST not in ("127.0.0.1", "::1"):
        # The sign-in headers are only true when nginx is the only thing that
        # can reach this port.
        print("BENCH_AUTH=header listens on 127.0.0.1 only, not %s." % HOST)
        return 2
    ds = current_dataset()
    if not ds:
        # A fresh checkout. The board opens on its welcome screen, which makes
        # the first list, so this is a start and not a failure.
        print("No list under %s/ yet; the board will ask for one when it opens." % DATA)
    if not os.path.exists(os.path.join(ROOT, PAGE)):
        print("Cannot find %s in %s" % (PAGE, ROOT))
        return 1
    # board.css names --tenon-* and defines none of them, so without this file
    # every colour on the page falls back to the browser's. That reads as a
    # broken stylesheet rather than a missing build, so say which it is.
    # run.command builds on every launch, so this only fires when the server
    # was started by hand.
    if not os.path.isfile(os.path.join(ROOT, "kanban", "dist", "tenon.css")):
        print("The design system's tokens have not been built, so the board will")
        print("have no colours. Build them and start again:")
        print("")
        print("    cd \"%s\" && npm install && npm run build" % ROOT)
        print("")

    try:
        httpd = BoardHTTPServer((HOST, PORT), Handler)
    except OSError as err:
        if err.errno in (48, 98):
            # Attaching to whatever already holds the port is usually right, but
            # not always: a helper left running from days ago is an older copy of
            # this file, and the board it serves will be missing anything added
            # since. Say so here, because from the browser it looks like a bug.
            print("Port %d is already in use — the board is already running." % PORT)
            print("Opening that one: http://127.0.0.1:%d/%s" % (PORT, PAGE))
            print("")
            print("If the board is missing something that should be there, that copy is")
            print("out of date. Stop it and start this one instead:")
            print("")
            print("    lsof -ti tcp:%d | xargs kill" % PORT)
            print("")
            print("then start run.command again.")
            print("")
            if OPEN_BROWSER:
                webbrowser.open("http://127.0.0.1:%d/%s" % (PORT, PAGE))
            return 0
        raise

    publish_boards()
    first_weekly = weekly_backup()
    if first_weekly:
        print("weekly backup: %s/%s/backups/%s" % (DATA, ds, first_weekly))
    threading.Thread(target=weekly_backup_watcher, daemon=True).start()
    # Desktop banners for due tasks and the agents' queue. Mac only, and only
    # with terminal-notifier; the Linux server never starts it, and nor does a
    # throwaway copy under TODOS_DATA_ROOT (the test runner), which holds demo data.
    import notify_due
    import owner_profile
    if todo is not None and not SCRATCH:
        NOTIFIER["thread"] = notify_due.start(
            DATA_ROOT, lambda: list_datasets(everyone=True), board_holiday_regions,
            "http://127.0.0.1:%d/%s" % (PORT, PAGE),
            read_text=lambda p: _steady_read(p)[0])
        if NOTIFIER["thread"]:
            print("Desktop banners for due tasks are on.")
        # On-assign bucket agents start within a minute of a handover.
        bucket_wake.start(DATA_ROOT)

    url = "http://127.0.0.1:%d/%s" % (PORT, PAGE)
    print("To-do board running at %s" % url)
    if AUTH:
        print("Signed-in mode: every request needs nginx's X-Offdesk-Email header.")
    print("Leave this window open while you use the board. Press Ctrl-C to stop.")
    # If this window is ever closed without stopping first, the helper keeps
    # running with nothing attached to it — no window left to press Ctrl-C in,
    # and the next launch just opens a tab against this stale copy. Printing the
    # way out here means it is in the scrollback when it is needed.
    print("Running as process %d. If this window is gone, stop it with:" % os.getpid())
    print("    lsof -ti tcp:%d | xargs kill" % PORT)
    if OPEN_BROWSER:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
