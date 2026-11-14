"""Desktop banners for tasks that fall due, and for lines agents queue.

The board server runs this on a minute tick (kanban/server.py) and posts what it
returns through alerter, or terminal-notifier where alerter is missing. It
replaces the Electron companion's notifier, which only spoke for one list at a
time and only once a morning (companion/ stays on disk, retired).

The rules for a due banner, one per task or sub-task with a due date of its
own that is not done:

  - It fires on the due date at the item's time (`effective_time`), or at 09:00
    when it has none. A repeat task is read through `effective_due`.
  - On a weekend or public holiday it stays quiet and fires once on the next
    working day at 09:00 instead. That one reads "Overdue since ...", since the
    date has already gone by, and nothing follows it.
  - Due on a working day, one more banner, "Overdue since ...", goes out at
    09:00 on the next working day. After that it is silent.
  - A banner only goes out on its own day. A server that starts late sends what
    was owed earlier that day on its first tick, and nothing from before.

What has been sent lives per board in data/<board>/notify-state.json, so a
restart does not repeat a banner. Entries older than 14 days are dropped.

The queue half drains the agents' lines for each board, by the rules the
companion used: nothing before 08:30 or after 20:00 (the `content` board is
exempt), at most three per tick, the rest left for the next one, and a line
with no body is dropped. The queue belongs to the notifier, a folder in PACKAGES
(bench_root.notify_home(), ~/Code/PACKAGES/notify on the owner's Mac),
whose own poster drains it whether or not the board is running; the board
drains its boards' queues there too, so a Mac where the poster was never
started loses nothing. Both hold the queue's lock from reading a line to
taking it off, so a line goes out once whichever reaches it first. The old
place, data/<board>/notify-queue.json, is drained as well: it is where lines go
when there is no notifier folder, and where a throwaway data root (the test
runner's) keeps its own (queue_file()).

A board whose `banners` is false in settings.json's `boards` (core/settings.py)
is skipped whole: no due banner, no catch-up, nothing written to its state, and
whatever its queues hold is taken off unposted, so turning it back on does not
bring a backlog with it. companion/notify.py queues nothing for it meanwhile.

Each board keeps its own working calendar: `working_for(board)` gives the
day test for one board, which the server builds from that board's profile
(owner_profile.board_holiday_regions), so a board with a memory folder of its
own or none goes by its own profile's holidays. Without it every board uses
`is_working`.

Snooze. Through alerter every banner is an alert with Snooze 1h, Tomorrow
(09:00 the next day) and Dismiss; terminal-notifier has no buttons, so without
alerter nothing can be snoozed. A snoozed due banner gets an entry of its own
under `snoozed` in notify-state.json, and the tick posts it again once its time
comes, unless the item is done by then or another banner for it goes out in
the same tick. A snoozed agent's line goes back on its queue with `not_before`,
which queue_batch() honours, as the notifier's poster does. alerter does not
return until the alert is answered, so `post` starts it and returns, and a
thread waits for the answer holding neither the tick nor the queue's lock.
The poster in the notifier's folder has the same alert code; change both.

Everything that needs a clock or a calendar takes it as an argument, so the
tests run on a fake one. Only `post` and `start` touch the machine.
"""

import contextlib
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import threading
import urllib.parse

try:
    import fcntl
except ImportError:          # no flock off a Unix
    fcntl = None

import bench_root
import settings
import todo

STATE_FILE = "notify-state.json"
QUEUE_FILE = "notify-queue.json"
KEEP_DAYS = 14
DEFAULT_TIME = dt.time(9, 0)
QUEUE_FROM = dt.time(8, 30)
QUEUE_UNTIL = dt.time(20, 0)
QUEUE_BATCH = 3
IMMEDIATE_BOARDS = ("content",)
TICK_SECONDS = 60
NOTIFIER_DIRS = ("/opt/homebrew/bin", "/usr/local/bin")
RVM_NOTIFIER_DIR = "/Users/tiagopedras/.rvm/gems/ruby-3.0.0/bin"
MAX_QUEUED = 20
SNOOZE_HOUR = "Snooze 1h"
SNOOZE_TOMORROW = "Tomorrow"
DISMISS = "Dismiss"
TOMORROW_AT = dt.time(9, 0)


def board_label(name):
    """"work-and-career" -> "Work and career"."""
    spaced = name.replace("-", " ")
    return spaced[:1].upper() + spaced[1:]


def task_key(task):
    """How a card is named in a link, in the order the board's own taskKey()
    and findTaskByKey() read it: the id on its line, else its `#slug`, else its
    title. The id is the only one that is unique and survives a retitle."""
    return task.stable_id or task.slug or task.title


def board_url(base, task=None, view=None, board=None):
    """The board's address with a view, a board and a card in the fragment:
    #<view>!board=<name>!task=<key>. The companion's links carry no board; this
    one does, so a click lands on the right list. It stays a fragment so the tab
    already open is the one that moves."""
    if not task and not view and not board:
        return base
    frag = view or ""
    if board:
        frag += "!board=" + urllib.parse.quote(board, safe="")
    if task:
        frag += "!task=" + urllib.parse.quote(task, safe="")
    return base + "#" + frag


def _next_working_day(day, is_working):
    day += dt.timedelta(days=1)
    for _ in range(60):
        if is_working(day):
            return day
        day += dt.timedelta(days=1)
    return day


def _time_of(hhmm):
    if not hhmm:
        return DEFAULT_TIME
    h, m = hhmm.split(":")
    return dt.time(int(h), int(m))


def _items(tasks):
    """Every open task and sub-task as (id, link key, title, task), where `task`
    is what carries the due date and time."""
    for t in tasks:
        if t.done or t.column == todo.DONE_HEADING:
            continue
        yield task_key(t), task_key(t), t.title, t
        _, steps = todo.split_body(t)
        for s in steps:
            step = s["task"]
            if step.done or not step.due:
                continue
            ident = task_key(t) + "::" + (step.stable_id or step.title)
            yield ident, task_key(t), step.title, step


def _fmt_day(day):
    return "%s %d %s" % (day.strftime("%a"), day.day, day.strftime("%b"))


def due_banners(tasks, now, is_working, fired, label):
    """The banners owed at `now`, oldest first, as dicts with `key` (the fired
    key), `title`, `body`, `task` (the link key) and `group`. `fired` is the set
    of keys already sent; nothing here changes it."""
    today = now.date()
    out = []
    for ident, link, title, item in _items(tasks):
        due = todo.effective_due(item, today)
        if not due:
            continue
        hhmm = todo.effective_time(item)
        fire_day = due if is_working(due) else _next_working_day(due, is_working)
        at = _time_of(hhmm) if fire_day == due else DEFAULT_TIME
        overdue_day = _next_working_day(fire_day, is_working)
        plans = []
        if today == fire_day:
            if fire_day != due:
                body = "Overdue since %s" % _fmt_day(due)
            elif hhmm:
                body = "Due %s" % hhmm
            else:
                body = "Due today"
            plans.append(("due", at, body))
        # A quiet-day item has had its one banner, and that one already says it is
        # overdue, so only an item due on a working day gets a second.
        if today == overdue_day and fire_day == due:
            plans.append(("overdue", DEFAULT_TIME, "Overdue since %s" % _fmt_day(due)))
        for kind, when, body in plans:
            key = "%s|%s|%s" % (today.isoformat(), ident, kind)
            if key in fired or now < dt.datetime.combine(today, when):
                continue
            out.append({"key": key, "ident": ident, "title": title, "body": "%s · %s" % (body, label),
                        "task": link, "group": key, "at": dt.datetime.combine(today, when)})
    out.sort(key=lambda b: (b["at"], b["key"]))
    return out


# ---- what has been sent --------------------------------------------------------

# The tick writes `fired` and an alert's answer writes `snoozed`, from two
# threads, so every write re-reads the file under this lock and keeps the half
# it was not given.
_state_lock = threading.Lock()


def _read_state_file(board_dir):
    try:
        with open(os.path.join(board_dir, STATE_FILE), encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def read_state(board_dir):
    fired = _read_state_file(board_dir).get("fired", [])
    return {k for k in fired if isinstance(k, str)} if isinstance(fired, list) else set()


def _when(text):
    """An ISO time as a local datetime, or None for one that cannot be read or
    carries a zone (which could not be compared with the tick's clock)."""
    try:
        when = dt.datetime.fromisoformat(str(text))
    except (TypeError, ValueError):
        return None
    return None if when.tzinfo else when


def read_snoozed(board_dir):
    """The snoozed due banners, each {key, ident, at, title, body, task}: `key`
    is the banner's fired key and `at` when it goes out again. Any that cannot
    be read is left out."""
    snoozed = _read_state_file(board_dir).get("snoozed", [])
    return [s for s in snoozed if isinstance(s, dict) and isinstance(s.get("key"), str)
            and isinstance(s.get("title"), str) and _when(s.get("at"))] if isinstance(snoozed, list) else []


def prune(fired, today):
    """Without the keys dated more than KEEP_DAYS before `today`."""
    cut = (today - dt.timedelta(days=KEEP_DAYS)).isoformat()
    return {k for k in fired if k.split("|", 1)[0] >= cut}


def _save_state(board_dir, today, fired=None, change_snoozed=None):
    """Write the state file. `fired` None keeps the file's, and
    `change_snoozed(list)` returns the new snoozed list from the file's."""
    path = os.path.join(board_dir, STATE_FILE)
    with _state_lock:
        if fired is None:
            fired = read_state(board_dir)
        snoozed = read_snoozed(board_dir)
        if change_snoozed:
            snoozed = change_snoozed(snoozed)
        cut = dt.datetime.combine(today - dt.timedelta(days=KEEP_DAYS), dt.time())
        data = {"fired": sorted(prune(fired, today))}
        snoozed = [s for s in snoozed if _when(s["at"]) >= cut]
        if snoozed:
            data["snoozed"] = snoozed
        try:
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8", newline="") as fh:
                json.dump(data, fh, indent=2)
            os.replace(tmp, path)
        except OSError:
            pass


def write_state(board_dir, fired, today):
    _save_state(board_dir, today, fired=fired)


def snooze_due(board_dir, key, title, body, task, until, today):
    """Hold a due banner for `until`: an entry under `snoozed`, replacing any
    the banner already had. `key` is its fired key, `date|ident|kind`."""
    ident = key.split("|", 1)[-1].rsplit("|", 1)[0]
    entry = {"key": key, "ident": ident, "at": until.isoformat(timespec="seconds"),
             "title": title, "body": body, "task": task}
    _save_state(board_dir, today, change_snoozed=lambda xs: [s for s in xs if s["key"] != key] + [entry])


# ---- the agents' queue ------------------------------------------------------------

# companion/notify.py appends by reading the file, adding a line and replacing it
# whole. Both sides take an exclusive flock on `notify-queue.lock` beside the
# queue file around that read-and-replace, so a line appended while this
# removes the ones it posted is neither lost nor overwritten. A line comes off
# the file only after it has been posted.
_queue_lock = threading.Lock()


@contextlib.contextmanager
def queue_lock(path):
    """The queue's cross-process lock, the same file and call as notify.py's.
    The thread lock keeps this module's own threads in line; flock does the
    rest. A lock that cannot be had lets the work go ahead without it."""
    with _queue_lock:
        fh = None
        if fcntl is not None:
            try:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                fh = open(os.path.splitext(path)[0] + ".lock", "a")
                fcntl.flock(fh, fcntl.LOCK_EX)
            except OSError:
                if fh:
                    fh.close()
                fh = None
        try:
            yield
        finally:
            if fh:
                fcntl.flock(fh, fcntl.LOCK_UN)
                fh.close()


def _read_queue(path):
    try:
        with open(path, encoding="utf-8") as fh:
            queued = json.load(fh)
    except (OSError, ValueError):
        return []
    return queued if isinstance(queued, list) else []


def _write_queue(path, items):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as fh:
        json.dump(items, fh, indent=2)
    os.replace(tmp, path)


def notifier_data(data_root):
    """The notifier's data/ folder, or None: when there is no notifier beside
    this checkout, or when `data_root` is a throwaway one rather than the
    checkout's own data/, whose lines stay with it unless $NOTIFY_HOME says
    otherwise."""
    home = bench_root.notify_home()
    if not os.path.isfile(os.path.join(home, "notify.py")):
        return None
    own = os.path.join(bench_root.root(), "data")
    if not os.environ.get("NOTIFY_HOME") and os.path.realpath(data_root) != os.path.realpath(own):
        return None
    return os.path.join(home, "data")


def queue_file(data_root, board):
    """Where a new line for `board` goes: the notifier's queue for it, else
    data/<board>/ as before."""
    return os.path.join(notifier_data(data_root) or data_root, board, QUEUE_FILE)


def queue_dirs(data_root, board):
    """Every folder the board drains for `board`: its own, then the notifier's."""
    out = [os.path.join(data_root, board)]
    notifier = notifier_data(data_root)
    if notifier:
        out.append(os.path.join(notifier, board))
    return out


def queue_batch(board_dir, board, now, skip=()):
    """The next lines to post, as (raw entry, (title, body, task, view)), at most
    QUEUE_BATCH of them, none of them in `skip` and none held by a `not_before`
    still to come. Nothing comes off the file here. A line with no body comes
    back with None for its message, to be dropped."""
    if board not in IMMEDIATE_BOARDS and not QUEUE_FROM <= now.time() <= QUEUE_UNTIL:
        return []
    out = []
    for entry in _read_queue(os.path.join(board_dir, QUEUE_FILE)):
        if len(out) == QUEUE_BATCH:
            break
        if not isinstance(entry, dict) or json.dumps(entry, sort_keys=True) in skip:
            continue
        held = _when(entry["not_before"]) if entry.get("not_before") else None
        if held and held > now and entry.get("body"):
            continue
        body = str(entry.get("body") or "")[:400]
        msg = None
        if body:
            msg = (str(entry.get("title") or "To-do")[:120], body,
                   str(entry["task"])[:200] if entry.get("task") else None,
                   str(entry["view"])[:40] if entry.get("view") else None)
        out.append((entry, msg))
    return out


def queue_remove(board_dir, entries):
    """Take `entries` off the file, each once, re-reading it first so a line
    appended meanwhile is kept. Written atomically."""
    if not entries:
        return
    with queue_lock(os.path.join(board_dir, QUEUE_FILE)):
        _remove(board_dir, entries)


def requeue(path, title, body, task, view, until):
    """Put a snoozed line back on the queue at `path`, held until `until`, the
    way notify.queue() appends one."""
    entry = {"title": str(title)[:120], "body": str(body)[:400],
             "queued": dt.datetime.now().isoformat(timespec="seconds"),
             "not_before": until.isoformat(timespec="seconds")}
    if task:
        entry["task"] = str(task)[:200]
    if view:
        entry["view"] = str(view)[:40]
    with queue_lock(path):
        try:
            _write_queue(path, (_read_queue(path) + [entry])[-MAX_QUEUED:])
        except OSError:
            pass


def _remove(board_dir, entries):
    """queue_remove() for a caller already holding the lock."""
    if not entries:
        return
    path = os.path.join(board_dir, QUEUE_FILE)
    items = _read_queue(path)
    for e in entries:
        if e in items:
            items.remove(e)
    try:
        _write_queue(path, items)
    except OSError:
        pass


# ---- one tick -----------------------------------------------------------------------

RETRY_AFTER = dt.timedelta(minutes=10)

# When the thread last finished a tick, for the schedule page.
STATUS = {"last_tick": None}


def quiet_boards(data_root, boards):
    """The boards in `boards` whose banners settings.json switches off."""
    own = settings.load(data_root).get("boards", {})
    return {b for b in boards if (own.get(b) or {}).get("banners") is False}


def next_banner(data_root, boards, now, is_working, read_text=None, working_for=None):
    """When the next due banner goes out: the earliest one still to come today
    across `boards`, else 09:00 on the next working day (the first moment a
    banner can come out of a new day), by `is_working`. A datetime.
    `working_for(board)`, when given, is each board's own day test."""
    read_text = read_text or read_plain
    end = dt.datetime.combine(now.date(), dt.time(23, 59, 59))
    soonest = None
    quiet = quiet_boards(data_root, boards)
    for board in boards:
        if board in quiet:
            continue
        board_dir = os.path.join(data_root, board)
        text = read_text(os.path.join(board_dir, "todo.md"))
        if text is None:
            continue
        own = (working_for(board) if working_for else None) or is_working
        tasks = todo.parse_doc(text)
        times = [b["at"] for b in due_banners(tasks, end, own, read_state(board_dir), "")]
        live = _open_idents(tasks)
        times += [_when(s["at"]) for s in read_snoozed(board_dir) if s.get("ident") in live]
        for at in times:
            if now < at <= end and (soonest is None or at < soonest):
                soonest = at
    if soonest:
        return soonest
    return dt.datetime.combine(_next_working_day(now.date(), is_working), DEFAULT_TIME)


def _open_idents(tasks):
    return {ident for ident, _, _, _ in _items(tasks)}


def read_plain(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return None


def run_tick(data_root, boards, now, is_working, post, read_text=read_plain, retries=None, log=print,
             working_for=None):
    """Post everything owed across `boards`. `post(title, body, task, view,
    group, board)` returns (ok, detail). A banner that fails is tried again after
    RETRY_AFTER, and only its first failure of the day is logged; `retries` is
    that memory and the caller keeps it between ticks. `read_text(path)` returns
    the file's text, or None when it cannot be trusted this tick (the server
    passes a read that refuses a half-written file). `working_for(board)`, when
    given, is each board's own day test in place of `is_working`. Returns how
    many went out."""
    retries = {} if retries is None else retries
    sent = 0

    def attempt(key, args):
        nonlocal sent
        last = retries.get(key)
        if last and now - last < RETRY_AFTER:
            return False
        ok, detail = post(*args)
        if ok:
            retries.pop(key, None)
            sent += 1
            return True
        if last is None:
            log("notify: %s failed: %s" % (args[0], detail))
        retries[key] = now
        return False

    for stale in [k for k in retries if k.split("|", 1)[0] < now.date().isoformat()]:
        del retries[stale]
    quiet = quiet_boards(data_root, boards)
    for board in boards:
        if board in quiet:
            _drop_queues(data_root, board)
            continue
        board_dir = os.path.join(data_root, board)
        text = read_text(os.path.join(board_dir, "todo.md"))
        tasks = todo.parse_doc(text) if text is not None else []
        fired = read_state(board_dir)
        changed = False
        own = (working_for(board) if working_for else None) or is_working
        posted = set()
        for b in due_banners(tasks, now, own, fired, board_label(board)):
            if attempt(b["key"], (b["title"], b["body"], b["task"], None, b["group"], board)):
                fired.add(b["key"])
                changed = True
                posted.add(b["ident"])
        if changed:
            write_state(board_dir, fired, now.date())
        # Snoozed due banners whose time has come go out again, grouped with the
        # banner they came from. One whose item is done, or that another banner
        # for the same item has just said (Tomorrow landing on the overdue one
        # at 09:00), is spent unposted. Left alone on a tick the file is not
        # trusted, since its items cannot be told from done ones.
        if text is not None:
            live, spent = _open_idents(tasks), []
            for s in sorted(read_snoozed(board_dir), key=lambda s: (_when(s["at"]), s["key"])):
                if _when(s["at"]) > now:
                    continue
                if s.get("ident") not in live or s.get("ident") in posted:
                    spent.append(s)
                elif attempt("%s|snooze|%s|%s" % (now.date().isoformat(), s["key"], s["at"]),
                             (s["title"], s.get("body") or "", s.get("task"), None, s["key"], board)):
                    spent.append(s)
            if spent:
                _save_state(board_dir, now.date(), change_snoozed=lambda xs: [x for x in xs if x not in spent])
        waiting = {k.split("|q|", 1)[1] for k, t in retries.items() if "|q|" in k and now - t < RETRY_AFTER}
        for qdir in queue_dirs(data_root, board):
            path = os.path.join(qdir, QUEUE_FILE)
            if not os.path.isfile(path):
                continue
            # Held from reading to taking off, posts included, so the
            # notifier's poster draining the same queue never posts a line
            # this has posted, nor this one of its.
            with queue_lock(path):
                done = []
                for entry, msg in queue_batch(qdir, board, now, skip=waiting):
                    if msg is None:
                        done.append(entry)
                    elif attempt("%s|q|%s" % (now.date().isoformat(), json.dumps(entry, sort_keys=True)), msg + (None, board)):
                        done.append(entry)
                _remove(qdir, done)
    return sent


def _drop_queues(data_root, board):
    """Take every line off a quiet board's queues, unposted."""
    for qdir in queue_dirs(data_root, board):
        path = os.path.join(qdir, QUEUE_FILE)
        if not os.path.isfile(path):
            continue
        with queue_lock(path):
            _remove(qdir, _read_queue(path))


# ---- posting and the thread ---------------------------------------------------------------

def find_notifier():
    """terminal-notifier's path, or None. The server can be started by the app
    without the user's PATH, so the usual install folders are tried too."""
    # Homebrew first: the old Intel-only Ruby copy on PATH makes macOS warn about Intel-based apps.
    for folder in NOTIFIER_DIRS:
        found = shutil.which("terminal-notifier", path=folder)
        if found:
            return found
    return shutil.which("terminal-notifier") or shutil.which("terminal-notifier", path=RVM_NOTIFIER_DIR)


def find_alerter():
    """alerter's path, or None, looked for where terminal-notifier is."""
    for folder in NOTIFIER_DIRS:
        found = shutil.which("alerter", path=folder)
        if found:
            return found
    return shutil.which("alerter")


def enabled():
    return (sys.platform == "darwin" and os.environ.get("BENCH_NOTIFY") != "0"
            and bool(find_alerter() or find_notifier()))


def notify_sound():
    """The macOS sound for a banner: "default" unless BENCH_NOTIFY_SOUND names
    another, or "0" to play none (None)."""
    name = os.environ.get("BENCH_NOTIFY_SOUND", "")
    if name == "0":
        return None
    return name or "default"


def snooze_until(choice, now):
    """When a snooze pressed at `now` ends, or None for any other answer."""
    if choice == SNOOZE_HOUR:
        return now + dt.timedelta(hours=1)
    if choice == SNOOZE_TOMORROW:
        return dt.datetime.combine(now.date() + dt.timedelta(days=1), TOMORROW_AT)
    return None


def answer(out):
    """What alerter printed: the label of the action pressed, "open" for the
    alert itself, or None for Dismiss, a timeout or nothing readable. Read
    from --json, and from the plain form in case a version prints that."""
    out = (out or "").strip()
    try:
        got = json.loads(out)
    except ValueError:
        got = None
    if isinstance(got, dict):
        kind, value = got.get("activationType"), got.get("activationValue")
        if kind == "contentsClicked":
            return "open"
        return str(value) if kind == "actionClicked" and value else None
    if out == "@CONTENTCLICKED":
        return "open"
    return out if out in (SNOOZE_HOUR, SNOOZE_TOMORROW) else None


def open_in_browser(url):
    try:
        subprocess.run(["open", url], capture_output=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        pass


def alert(args, url, on_snooze, log=print, spawn=subprocess.Popen, clock=dt.datetime.now, opener=None):
    """Put an alert up and return at once, (ok, detail). alerter keeps running
    until the alert is answered, so a thread waits for it, holding no lock, and
    carries the answer out: a snooze calls `on_snooze(until)`, pressing the
    alert opens `url`. `spawn`, `clock` and `opener` are there for the tests."""
    try:
        proc = spawn(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                     stderr=subprocess.DEVNULL, text=True)
    except (OSError, subprocess.SubprocessError) as err:
        return False, "could not run alerter: %s" % err

    def wait():
        try:
            out, _ = proc.communicate()
            choice = answer(out)
            until = snooze_until(choice, clock())
            if until:
                on_snooze(until)
            elif choice == "open" and url:
                (opener or open_in_browser)(url)
        except Exception as err:   # an answer that goes wrong must not reach the tick
            log("notify: alert answer failed: %r" % err)

    threading.Thread(target=wait, name="alert-answer", daemon=True).start()
    return True, "alert up"


def post(notifier, base_url, title, body, task=None, view=None, group=None, log=print, board=None,
         alerter=None, on_snooze=None, spawn=subprocess.Popen, clock=dt.datetime.now, opener=None):
    """One banner: through `alerter` when given, as an alert whose snooze calls
    `on_snooze(until)`, else through `notifier`, terminal-notifier."""
    url = board_url(base_url, task, view, board)
    if alerter:
        args = [alerter, "--title", title, "--message", body,
                "--actions", SNOOZE_HOUR + "," + SNOOZE_TOMORROW, "--dropdown-label", "Snooze",
                "--close-label", DISMISS, "--json"]
        if group:
            args += ["--group", group]
        if notify_sound():
            args += ["--sound", notify_sound()]
        ok, detail = alert(args, url, on_snooze or (lambda until: None), log, spawn, clock, opener)
        if ok:
            log("notify: %r alert up" % title)
        return ok, detail
    args = [notifier, "-title", title, "-message", body, "-open", url]
    if group:
        args += ["-group", group]
    sound = notify_sound()
    if sound:
        args += ["-sound", sound]
    try:
        rc = subprocess.run(args, capture_output=True, timeout=15).returncode
    except (OSError, subprocess.SubprocessError) as err:
        return False, "could not run terminal-notifier: %s" % err
    if rc == 0:
        log("notify: %r exit 0" % title)
    return rc == 0, "exit %d" % rc


def calendars(boards, regions_for):
    """{board: day test} from `regions_for(board)`, the holiday regions of each
    board's own profile, read once per tick."""
    return {b: (lambda regions: lambda d: todo.is_working_day(d, regions))(regions_for(b)) for b in boards}


def make_poster(data_root, base_url, notifier, alerter=None, log=print, **fakes):
    """The `post` run_tick calls, (title, body, task, view, group, board). A
    due banner carries its fired key as `group`, so its snooze is an entry in
    the board's state; a queued line has none, so its snooze puts it back on the
    board's queue, held. `fakes` (spawn, clock, opener) are passed to post()."""
    def poster(title, body, task, view, group, board):
        clock = fakes.get("clock") or dt.datetime.now

        def snoozed(until):
            if group:
                snooze_due(os.path.join(data_root, board), group, title, body, task, until, clock().date())
            else:
                requeue(queue_file(data_root, board), title, body, task, view, until)
            log("notify: %r snoozed until %s" % (title, until.isoformat(timespec="minutes")))

        return post(notifier, base_url, title, body, task, view, group, log, board,
                    alerter=alerter, on_snooze=snoozed, **fakes)
    return poster


def start(data_root, list_boards, regions_for, base_url, log=print, read_text=read_plain):
    """Start the daemon thread that ticks every minute. Returns it, or None
    when this machine should stay quiet (not a Mac, neither alerter nor
    terminal-notifier, or BENCH_NOTIFY=0). `regions_for(board)` is that board's
    holiday regions. Banners play a sound unless BENCH_NOTIFY_SOUND says
    otherwise (see notify_sound)."""
    if not enabled():
        return None
    poster = make_poster(data_root, base_url, find_notifier(), find_alerter(), log)

    def loop():
        stop = threading.Event()
        retries = {}
        while True:
            try:
                boards = list_boards()
                days = calendars(boards, regions_for)
                STATUS["last_tick"] = dt.datetime.now()
                run_tick(data_root, boards, dt.datetime.now(),
                         lambda d: todo.is_working_day(d, tuple(todo.REGIONS)), poster,
                         read_text, retries, log, working_for=days.get)
            except Exception as err:   # a bad tick must not end the thread
                log("notify: tick failed: %r" % err)
            if stop.wait(TICK_SECONDS):
                return

    thread = threading.Thread(target=loop, name="notify-due", daemon=True)
    thread.start()
    return thread
