"""Desktop banners for tasks that fall due, and for lines agents queue.

The board server runs this on a minute tick (kanban/server.py) and posts what it
returns through terminal-notifier. It replaces the Electron companion's
notifier, which only spoke for one list at a time and only once a morning
(companion/ stays on disk, retired).

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
with no body is dropped. The queue belongs to the notifier, a folder beside
this checkout (bench_root.notify_home(), ~/Code/notify on the owner's Mac),
whose own poster drains it whether or not the board is running; the board
drains its boards' queues there too, so a Mac where the poster was never
started loses nothing. Both hold the queue's lock from reading a line to
taking it off, so a line goes out once whichever reaches it first. The old
place, data/<board>/notify-queue.json, is drained as well: it is where lines go
when there is no notifier folder, and where a throwaway data root (the test
runner's) keeps its own (queue_file()).

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
            out.append({"key": key, "title": title, "body": "%s · %s" % (body, label),
                        "task": link, "group": key, "at": dt.datetime.combine(today, when)})
    out.sort(key=lambda b: (b["at"], b["key"]))
    return out


# ---- what has been sent --------------------------------------------------------

def read_state(board_dir):
    try:
        with open(os.path.join(board_dir, STATE_FILE), encoding="utf-8") as fh:
            data = json.load(fh)
        return {k for k in data.get("fired", []) if isinstance(k, str)}
    except (OSError, ValueError, AttributeError):
        return set()


def prune(fired, today):
    """Without the keys dated more than KEEP_DAYS before `today`."""
    cut = (today - dt.timedelta(days=KEEP_DAYS)).isoformat()
    return {k for k in fired if k.split("|", 1)[0] >= cut}


def write_state(board_dir, fired, today):
    path = os.path.join(board_dir, STATE_FILE)
    try:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8", newline="") as fh:
            json.dump({"fired": sorted(prune(fired, today))}, fh, indent=2)
        os.replace(tmp, path)
    except OSError:
        pass


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
    QUEUE_BATCH of them, none of them in `skip`. Nothing comes off the file here.
    A line with no body comes back with None for its message, to be dropped."""
    if board not in IMMEDIATE_BOARDS and not QUEUE_FROM <= now.time() <= QUEUE_UNTIL:
        return []
    out = []
    for entry in _read_queue(os.path.join(board_dir, QUEUE_FILE)):
        if len(out) == QUEUE_BATCH:
            break
        if not isinstance(entry, dict) or json.dumps(entry, sort_keys=True) in skip:
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


def next_banner(data_root, boards, now, is_working, read_text=None):
    """When the next due banner goes out: the earliest one still to come today
    across `boards`, else 09:00 on the next working day (the first moment a
    banner can come out of a new day). A datetime."""
    read_text = read_text or read_plain
    end = dt.datetime.combine(now.date(), dt.time(23, 59, 59))
    soonest = None
    for board in boards:
        board_dir = os.path.join(data_root, board)
        text = read_text(os.path.join(board_dir, "todo.md"))
        if text is None:
            continue
        for b in due_banners(todo.parse_doc(text), end, is_working, read_state(board_dir), ""):
            if b["at"] > now and (soonest is None or b["at"] < soonest):
                soonest = b["at"]
    if soonest:
        return soonest
    return dt.datetime.combine(_next_working_day(now.date(), is_working), DEFAULT_TIME)


def read_plain(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return None


def run_tick(data_root, boards, now, is_working, post, read_text=read_plain, retries=None, log=print):
    """Post everything owed across `boards`. `post(title, body, task, view,
    group, board)` returns (ok, detail). A banner that fails is tried again after
    RETRY_AFTER, and only its first failure of the day is logged; `retries` is
    that memory and the caller keeps it between ticks. `read_text(path)` returns
    the file's text, or None when it cannot be trusted this tick (the server
    passes a read that refuses a half-written file). Returns how many went out."""
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
    for board in boards:
        board_dir = os.path.join(data_root, board)
        text = read_text(os.path.join(board_dir, "todo.md"))
        tasks = todo.parse_doc(text) if text is not None else []
        fired = read_state(board_dir)
        changed = False
        for b in due_banners(tasks, now, is_working, fired, board_label(board)):
            if attempt(b["key"], (b["title"], b["body"], b["task"], None, b["group"], board)):
                fired.add(b["key"])
                changed = True
        if changed:
            write_state(board_dir, fired, now.date())
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


def enabled():
    return sys.platform == "darwin" and os.environ.get("BENCH_NOTIFY") != "0" and bool(find_notifier())


def notify_sound():
    """The macOS sound for a banner: "default" unless BENCH_NOTIFY_SOUND names
    another, or "0" to play none (None)."""
    name = os.environ.get("BENCH_NOTIFY_SOUND", "")
    if name == "0":
        return None
    return name or "default"


def post(notifier, base_url, title, body, task=None, view=None, group=None, log=print, board=None):
    args = [notifier, "-title", title, "-message", body, "-open", board_url(base_url, task, view, board)]
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


def start(data_root, list_boards, regions_for, base_url, log=print, read_text=read_plain):
    """Start the daemon thread that ticks every minute. Returns it, or None
    when this machine should stay quiet (not a Mac, no terminal-notifier, or
    BENCH_NOTIFY=0). Banners play a sound unless BENCH_NOTIFY_SOUND says
    otherwise (see notify_sound)."""
    if not enabled():
        return None
    notifier = find_notifier()

    def poster(title, body, task, view, group, board):
        return post(notifier, base_url, title, body, task, view, group, log, board)

    def loop():
        stop = threading.Event()
        retries = {}
        while True:
            try:
                regions = regions_for()
                STATUS["last_tick"] = dt.datetime.now()
                run_tick(data_root, list_boards(), dt.datetime.now(),
                         lambda d: todo.is_working_day(d, regions), poster,
                         read_text, retries, log)
            except Exception as err:   # a bad tick must not end the thread
                log("notify: tick failed: %r" % err)
            if stop.wait(TICK_SECONDS):
                return

    thread = threading.Thread(target=loop, name="notify-due", daemon=True)
    thread.start()
    return thread
