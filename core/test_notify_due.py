#!/usr/bin/env python3
"""notify_due.py on a fake clock and a fake calendar.

    python3 core/test_notify_due.py

Nothing here posts a banner: `post` is a list that remembers what it was given.
"""

import datetime as dt
import json
import os
import sys
import tempfile
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import notify_due
import todo

D = dt.date
failures = 0


def check(name, got, want):
    global failures
    if got != want:
        print("FAIL %s\n     got  %r\n     want %r" % (name, got, want))
        failures += 1


# 2026-10-26 is a Monday. Mon 2 Nov is made a holiday, as is Sat/Sun as ever.
HOLIDAYS = {D(2026, 11, 2)}


def working(day):
    return day.weekday() < 5 and day not in HOLIDAYS


def at(day, hhmm="09:00"):
    h, m = hhmm.split(":")
    return dt.datetime.combine(day, dt.time(int(h), int(m)))


def doc(*lines):
    return "\n".join(["# To-do", "", "## 1. Work", "", "### Doing", ""] + list(lines) + [""])


def banners(text, now, fired=()):
    return notify_due.due_banners(todo.parse_doc(text), now, working, set(fired), "Work")


def summary(bs):
    return [(b["title"], b["body"]) for b in bs]


MON, TUE, FRI, SAT = D(2026, 10, 26), D(2026, 10, 27), D(2026, 10, 30), D(2026, 10, 31)

t = doc("- [ ] **Call Ana** [due:: 2026-10-26] [time:: 15:00]")
check("timed task: nothing before its time", banners(t, at(MON, "14:59")), [])
check("timed task: fires at its time", summary(banners(t, at(MON, "15:00"))), [("Call Ana", "Due 15:00 · Work")])

u = doc("- [ ] **Send report** [due:: 2026-10-26]")
check("untimed: quiet before 09:00", banners(u, at(MON, "08:59")), [])
check("untimed: 09:00", summary(banners(u, at(MON, "09:00"))), [("Send report", "Due today · Work")])

s = doc("- [ ] **Parent** `#parent`", "  - [ ] Book room [due:: 2026-10-26] [time:: 10:15]", "  - [ ] No date of its own")
b = banners(s, at(MON, "10:15"))
check("sub-task: own date and time, linked to its task", [(x["title"], x["body"], x["task"]) for x in b],
      [("Book room", "Due 10:15 · Work", "parent")])
check("sub-task: a parent's date is not copied down",
      banners(doc("- [ ] **P** [due:: 2026-10-26]", "  - [ ] child"), at(MON, "09:00"))[0]["title"], "P")

r = doc("- [ ] **1:1** [due:: 2026-10-28] `repeat:wed-9:15`")
check("repeat task: the rule's time", summary(banners(r, at(D(2026, 10, 28), "09:15"))), [("1:1", "Due 09:15 · Work")])
r2 = doc("- [ ] **1:1** [due:: 2026-10-21] `repeat:wed-9:15`")
check("repeat task: a stale date rolls to the next occurrence",
      summary(banners(r2, at(D(2026, 10, 28), "09:20"))), [("1:1", "Due 09:15 · Work")])

done = doc("- [x] **Done one** [due:: 2026-10-26] `done:2026-10-26`", "- [ ] **Open** [due:: 2026-10-26]", "  - [x] ticked step [due:: 2026-10-26]",
           "### Done", "- [ ] **In Done** [due:: 2026-10-26]")
check("done tasks, tasks under Done and ticked sub-tasks are skipped",
      [x["title"] for x in banners(done, at(MON, "12:00"))], ["Open"])

o = doc("- [ ] **Late** [due:: 2026-10-26]")
first = banners(o, at(MON, "09:00"))
check("overdue: due banner on the day", [x["body"] for x in first], ["Due today · Work"])
check("overdue: the day after, one more", [x["body"] for x in banners(o, at(TUE, "09:00"), {first[0]["key"]})],
      ["Overdue since Mon 26 Oct · Work"])
check("overdue: not before 09:00", banners(o, at(TUE, "08:00")), [])
over = banners(o, at(TUE, "09:00"))
check("overdue: silent after that", banners(o, at(D(2026, 10, 28), "09:00"), {over[0]["key"]}), [])
check("overdue: silent the day after that, even unfired", banners(o, at(D(2026, 10, 28), "12:00")), [])

f = doc("- [ ] **Friday job** [due:: 2026-10-30]")
check("Friday due: fires Friday", len(banners(f, at(FRI, "09:00"))), 1)
check("Friday due: quiet on Saturday and Sunday",
      [banners(f, at(SAT, "10:00")), banners(f, at(D(2026, 11, 1), "10:00"))], [[], []])
check("Friday due: overdue lands on Tuesday when Monday is a holiday",
      [len(banners(f, at(D(2026, 11, 2), "10:00"))), summary(banners(f, at(D(2026, 11, 3), "09:00")))],
      [0, [("Friday job", "Overdue since Fri 30 Oct \u00b7 Work")]])

w = doc("- [ ] **Weekend job** [due:: 2026-10-31] [time:: 15:00]")
check("due on a Saturday: quiet that day", banners(w, at(SAT, "15:00")), [])
check("due on a Saturday: Monday 09:00 (not its own time)", banners(w, at(D(2026, 11, 2), "09:00")), [])
check("due on a Saturday with a holiday Monday: Tuesday 09:00, as an overdue",
      summary(banners(w, at(D(2026, 11, 3), "09:00"))), [("Weekend job", "Overdue since Sat 31 Oct · Work")])
check("due on a Saturday: once", banners(w, at(D(2026, 11, 3), "09:30"), {banners(w, at(D(2026, 11, 3), "09:00"))[0]["key"]}), [])
sat = doc("- [ ] **Plain Saturday** [due:: 2026-10-24]")
check("plain Saturday: quiet on the Saturday and Sunday",
      [banners(sat, at(D(2026, 10, 24), "12:00")), banners(sat, at(D(2026, 10, 25), "12:00"))], [[], []])
mon = banners(sat, at(MON, "09:00"))
check("plain Saturday: one banner on the Monday, already saying overdue",
      summary(mon), [("Plain Saturday", "Overdue since Sat 24 Oct \u00b7 Work")])
check("plain Saturday: nothing further on the Tuesday, fired or not",
      [banners(sat, at(TUE, "09:00"), {mon[0]["key"]}), banners(sat, at(TUE, "12:00"))], [[], []])

h = doc("- [ ] **Bank holiday job** [due:: 2026-11-02]")
check("due on a holiday: quiet on it, out the next working day as overdue",
      [len(banners(h, at(D(2026, 11, 2), "12:00"))), summary(banners(h, at(D(2026, 11, 3), "09:00")))],
      [0, [("Bank holiday job", "Overdue since Mon 2 Nov \u00b7 Work")]])
check("due on a holiday: nothing the day after that",
      banners(h, at(D(2026, 11, 4), "09:00")), [])

c = doc("- [ ] **Morning** [due:: 2026-10-26] [time:: 09:30]", "- [ ] **Noon** [due:: 2026-10-26] [time:: 12:00]",
        "- [ ] **Later** [due:: 2026-10-26] [time:: 17:00]")
check("catch-up: a late start sends what was owed earlier today, in order, and not what is still to come",
      [x["title"] for x in banners(c, at(MON, "13:00"))], ["Morning", "Noon"])
check("catch-up: nothing from earlier days is replayed", banners(o, at(D(2026, 10, 28), "13:00")), [])

# next_banner: what the schedule page shows.
with tempfile.TemporaryDirectory() as root:
    os.makedirs(os.path.join(root, "b"))
    with open(os.path.join(root, "b", "todo.md"), "w") as fh:
        fh.write(doc("- [ ] **Soon** [due:: 2026-10-26] [time:: 15:00]", "- [ ] **Sooner** [due:: 2026-10-26] [time:: 12:00]",
                     "- [ ] **Earlier** [due:: 2026-10-26] [time:: 08:00]"))
    nb = lambda now, **k: notify_due.next_banner(root, ["b"], now, working, **k)
    check("next banner: the earliest still to come today", nb(at(MON, "10:00")), at(MON, "12:00"))
    check("next banner: skips what has gone out already",
          nb(at(MON, "13:00")), at(MON, "15:00"))
    check("next banner: nothing left today, so 09:00 on the next working day", nb(at(MON, "16:00")), at(TUE, "09:00"))
    check("next banner: the day before a holiday weekend skips to a working day", notify_due.next_banner(root, ["b"], at(FRI, "20:00"), working), at(D(2026, 11, 3), "09:00"))

# Restart: state on disk, no double-fire.
with tempfile.TemporaryDirectory() as root:
    bdir = os.path.join(root, "work-and-career")
    os.makedirs(bdir)
    with open(os.path.join(bdir, "todo.md"), "w") as fh:
        fh.write(t)
    posted = []
    logs = []

    def post(title, body, task, view, group, board):
        posted.append((title, body, task, view, group, board))
        return True, "exit 0"

    def tick(now, poster=post, retries=None):
        return notify_due.run_tick(root, ["work-and-career"], now, working, poster, retries=retries, log=logs.append)

    n = tick(at(MON, "15:01"))
    check("tick: one banner, labelled with the board", (n, posted[0][:3]), (1, ("Call Ana", "Due 15:00 \u00b7 Work and career", "Call Ana")))
    check("tick: its group is its fired key", posted[0][4], "2026-10-26|Call Ana|due")
    check("tick: not again", tick(at(MON, "15:02")), 0)
    check("restart: state read back from the file, still not again", tick(at(MON, "16:00")), 0)
    check("state file keeps the key", json.load(open(os.path.join(bdir, "notify-state.json")))["fired"], ["2026-10-26|Call Ana|due"])

    # Failed posts: retried every 10 minutes at most, first failure per key logged.
    os.remove(os.path.join(bdir, "notify-state.json"))
    calls, retries = [], {}

    def failing(*a):
        calls.append(a)
        return False, "exit 1"

    tick(at(MON, "15:01"), failing, retries)
    tick(at(MON, "15:02"), failing, retries)
    tick(at(MON, "15:10"), failing, retries)
    check("failed post: not retried inside 10 minutes", len(calls), 1)
    tick(at(MON, "15:11"), failing, retries)
    tick(at(MON, "15:25"), failing, retries)
    check("failed post: retried after 10 minutes", len(calls), 3)
    check("failed post: only the first failure is logged", logs, ["notify: Call Ana failed: exit 1"])
    check("failed post: succeeds later, then never again",
          (tick(at(MON, "15:40"), post, retries), tick(at(MON, "15:50"), post, retries)), (1, 0))

    old = {"2026-10-01|x|due", "2026-10-20|y|due"}
    check("prune: entries older than 14 days go", sorted(notify_due.prune(old, MON)), ["2026-10-20|y|due"])

    # Queue.
    q = os.path.join(bdir, "notify-queue.json")
    lines = [{"title": "Plan agent", "body": "3 plans", "view": "plans"}, {"title": "A", "body": "", "task": "x"},
             {"title": "B", "body": "b", "task": "slug"}, {"body": "no title"}, {"title": "Z", "body": "left"}]
    json.dump(lines, open(q, "w"))
    check("queue: held before 08:30", (notify_due.queue_batch(bdir, "work-and-career", at(MON, "07:00")), len(json.load(open(q)))), ([], 5))
    posted.clear()
    tick(at(MON, "10:00"))
    check("queue: three taken, an empty body dropped",
          [p[:4] for p in posted if p[0] != "Call Ana"], [("Plan agent", "3 plans", None, "plans"), ("B", "b", "slug", None)])
    check("queue: the rest stays", [e.get("title") for e in json.load(open(q))], [None, "Z"])
    posted.clear()
    tick(at(MON, "10:01"))
    check("queue: next tick takes the rest, title defaulted",
          [p[:4] for p in posted], [("To-do", "no title", None, None), ("Z", "left", None, None)])

    # A line comes off only once it has posted.
    json.dump([{"title": "K", "body": "keep"}, {"title": "G", "body": "go"}], open(q, "w"))
    only_g = lambda title, body, task, view, group, board: (title == "G", "exit 1")
    retries = {}
    tick(at(MON, "11:00"), only_g, retries)
    check("queue: a line that failed to post stays, the one that posted goes",
          [e["title"] for e in json.load(open(q))], ["K"])
    seen = []
    tick(at(MON, "11:05"), lambda *a: seen.append(a[0]) or (True, ""), retries)
    check("queue: a failed line waits out its 10 minutes", seen, [])
    tick(at(MON, "11:11"), lambda *a: seen.append(a[0]) or (True, ""), retries)
    check("queue: then goes", (seen, json.load(open(q))), (["K"], []))

    # A line appended while one is being posted survives the removal.
    json.dump([{"title": "First", "body": "1"}], open(q, "w"))

    def appends_meanwhile(title, body, task, view, group, board):
        cur = json.load(open(q))
        cur.append({"title": "Arrived", "body": "mid-post"})
        json.dump(cur, open(q, "w"))
        return True, ""

    tick(at(MON, "12:00"), appends_meanwhile)
    check("queue: a line appended during a post is kept", [e["title"] for e in json.load(open(q))], ["Arrived"])
    check("queue: removal is atomic, no temp file left", os.path.exists(q + ".tmp"), False)
    # notify.py's append, landing in the middle of a drain, waits for it and survives.
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "companion"))
    import notify as notify_py
    json.dump([{"title": "Old", "body": "o"}], open(q, "w"))
    appended = threading.Event()
    waited = []

    def append_line():
        notify_py.queue("Mid-drain", "arrives while the drain holds the lock", path=q)
        appended.set()

    with notify_due.queue_lock(q):
        items = notify_due._read_queue(q)
        threading.Thread(target=append_line).start()
        waited.append(appended.wait(0.5))
        notify_due._write_queue(q, [e for e in items if e["title"] != "Old"])
    appended.wait(5)
    check("lock: an append during a drain waits for it", waited, [False])
    check("lock: and is not lost", [e["title"] for e in json.load(open(q))], ["Mid-drain"])
    check("lock: the lock file sits beside the queue", os.path.exists(os.path.join(bdir, "notify-queue.lock")), True)

    json.dump([{"title": "N", "body": "night"}], open(q, "w"))
    check("queue: the content board has no window", len(notify_due.queue_batch(bdir, "content", at(MON, "02:00"))), 1)

check("url: card", notify_due.board_url("http://h/k", "My task!"), "http://h/k#!task=My%20task%21")
check("url: view and card", notify_due.board_url("http://h/k", "s", "plans"), "http://h/k#plans!task=s")
check("url: board and card", notify_due.board_url("http://h/k", "My task", None, "work-and-career"),
      "http://h/k#!board=work-and-career!task=My%20task")
check("url: view, board and card", notify_due.board_url("http://h/k", "s", "plans", "a b"), "http://h/k#plans!board=a%20b!task=s")
check("url: a board alone", notify_due.board_url("http://h/k", None, None, "content"), "http://h/k#!board=content")
check("tick: the post names its board", {p[5] for p in posted}, {"work-and-career"})
# The link a tick really builds, for a task carrying an id: the base is the
# board's page, not the server's root (which is a directory listing).
BASE = "http://127.0.0.1:8765/kanban/index.html"
idt = todo.parse_task(["- [ ] **Build a hallway bench to cover the robot vacuum** [due:: 2026-10-25] `id:b7k2qw`"])
check("key: the id first", notify_due.task_key(idt), "b7k2qw")
check("key: then the slug", notify_due.task_key(todo.parse_task(["- [ ] **T** `#the-slug`"])), "the-slug")
check("url: what a tick builds for a task with an id", notify_due.board_url(BASE, notify_due.task_key(idt), None, "personal"),
      "http://127.0.0.1:8765/kanban/index.html#!board=personal!task=b7k2qw")
check("url: neither", notify_due.board_url("http://h/k"), "http://h/k")

# The notifier's queues, beside the checkout (bench_root.notify_home()).
import subprocess  # noqa: E402
import time  # noqa: E402
saved_home = os.environ.pop("NOTIFY_HOME", None)
with tempfile.TemporaryDirectory() as root:
    data, home = os.path.join(root, "data"), os.path.join(root, "notify")
    old_q = os.path.join(data, "work", notify_due.QUEUE_FILE)
    new_q = os.path.join(home, "data", "work", notify_due.QUEUE_FILE)
    os.makedirs(os.path.join(data, "work"))
    os.environ["NOTIFY_HOME"] = home
    check("notifier: none there, a line goes to data/<board>/ as before", notify_due.queue_file(data, "work"), old_q)
    check("notifier: none there, the board drains its own folder only", notify_due.queue_dirs(data, "work"),
          [os.path.join(data, "work")])
    os.makedirs(home)
    open(os.path.join(home, "notify.py"), "w").close()
    check("notifier: there, a line goes to its queue", notify_due.queue_file(data, "work"), new_q)
    check("notifier: there, the board drains both", notify_due.queue_dirs(data, "work"),
          [os.path.join(data, "work"), os.path.join(home, "data", "work")])
    os.environ.pop("NOTIFY_HOME")
    check("notifier: a throwaway data root keeps its own lines", notify_due.queue_file(data, "work"), old_q)
    os.environ["NOTIFY_HOME"] = home

    notify_due._write_queue(old_q, [{"title": "Old place", "body": "o"}])
    os.makedirs(os.path.dirname(new_q))
    notify_due._write_queue(new_q, [{"title": "New place", "body": "n", "view": "plans"}])
    got = []
    notify_due.run_tick(data, ["work"], at(TUE, "10:00"), working, lambda *a: got.append(a) or (True, ""))
    check("notifier: a tick posts from both places, naming the board",
          [(a[0], a[3], a[5]) for a in got], [("Old place", None, "work"), ("New place", "plans", "work")])
    check("notifier: and empties both", (json.load(open(old_q)), json.load(open(new_q))), ([], []))

    # A board whose banners are off in settings.json: skipped whole.
    with open(os.path.join(data, "work", "todo.md"), "w") as fh:
        fh.write(doc("- [ ] **Due now** [due:: 2026-10-27] [time:: 09:30]",
                     "- [ ] **Overdue** [due:: 2026-10-26]"))
    os.makedirs(os.path.join(data, "home"))
    with open(os.path.join(data, "home", "todo.md"), "w") as fh:
        fh.write(doc("- [ ] **Home task** [due:: 2026-10-27] [time:: 09:30]"))
    with open(os.path.join(data, "settings.json"), "w") as fh:
        json.dump({"boards": {"work": {"banners": False}, "home": {"memory_root": None}}}, fh)
    notify_due._write_queue(old_q, [{"title": "Old place", "body": "o"}])
    notify_due._write_queue(new_q, [{"title": "New place", "body": "n"}])
    home_q = os.path.join(data, "home", notify_due.QUEUE_FILE)
    notify_due._write_queue(home_q, [{"title": "Home line", "body": "h"}])
    check("quiet board: not counted for the next banner",
          notify_due.next_banner(data, ["work"], at(TUE, "08:00"), working), at(D(2026, 10, 28), "09:00"))
    check("quiet board: the others are", notify_due.next_banner(data, ["work", "home"], at(TUE, "08:00"), working),
          at(TUE, "09:30"))
    got = []
    notify_due.run_tick(data, ["work", "home"], at(TUE, "10:00"), working, lambda *a: got.append(a) or (True, ""))
    check("quiet board: nothing posted for it, its due and catch-up banners included",
          sorted((a[0], a[5]) for a in got), [("Home line", "home"), ("Home task", "home")])
    check("quiet board: its queued lines are dropped from both places",
          (json.load(open(old_q)), json.load(open(new_q))), ([], []))
    check("quiet board: no state written for it", os.path.exists(os.path.join(data, "work", notify_due.STATE_FILE)), False)
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "companion"))
    import notify as notify_py  # noqa: E402
    saved_root = os.environ.get("TODOS_DATA_ROOT")
    os.environ["TODOS_DATA_ROOT"] = data
    check("quiet board: notify.py queues nothing for it",
          (notify_py.queue("T", "b", dataset="work"), notify_py.queue("T", "b", path=old_q), json.load(open(old_q))),
          (None, None, []))
    check("quiet board: notify.py says so and exits 0", notify_py.main(["--dataset", "work", "T", "b"]), 0)
    os.environ["NOTIFY_HOME"] = os.path.join(root, "no-notifier")
    check("quiet board: a board with banners on still queues",
          (notify_py.queue("T", "b", dataset="home"), [e["title"] for e in json.load(open(home_q))]),
          (home_q, ["T"]))
    os.environ["NOTIFY_HOME"] = home
    if saved_root is None:
        os.environ.pop("TODOS_DATA_ROOT")
    else:
        os.environ["TODOS_DATA_ROOT"] = saved_root
    os.remove(os.path.join(data, "settings.json"))
    os.remove(os.path.join(data, "work", "todo.md"))

    # The poster, holding the lock while it posts a line and takes it off:
    # the board waits for it and finds the line gone, so it is posted once.
    notify_due._write_queue(new_q, [{"title": "Once", "body": "only"}])
    ready = os.path.join(root, "ready")
    holder = subprocess.Popen([sys.executable, "-c", (
        "import fcntl, json, os, time\n"
        "fh = open(%r, 'a'); fcntl.flock(fh, fcntl.LOCK_EX)\n"
        "open(%r, 'w').close(); time.sleep(0.6)\n"
        "json.dump([], open(%r, 'w')); fcntl.flock(fh, fcntl.LOCK_UN)\n"
    ) % (os.path.splitext(new_q)[0] + ".lock", ready, new_q)])
    for _ in range(100):
        if os.path.exists(ready):
            break
        time.sleep(0.05)
    got = []
    started = time.time()
    notify_due.run_tick(data, ["work"], at(TUE, "10:05"), working, lambda *a: got.append(a[0]) or (True, ""))
    holder.wait(10)
    check("notifier: a line another drainer holds is not posted twice", got, [])
    check("notifier: the board waited for its lock", time.time() - started > 0.3, True)
os.environ.pop("NOTIFY_HOME", None)
if saved_home is not None:
    os.environ["NOTIFY_HOME"] = saved_home

# Each board's own calendar: Portugal Day is a working day on a board that
# inherits the owner's UK calendar, and a holiday on a board kept apart with
# a Portuguese profile of its own.
import owner_profile  # noqa: E402
with tempfile.TemporaryDirectory() as data:
    portugal_day = D(2026, 6, 10)
    for name in ("uk", "pt"):
        os.makedirs(os.path.join(data, name))
        with open(os.path.join(data, name, "todo.md"), "w") as fh:
            fh.write(doc("- [ ] **%s task** [due:: 2026-06-10]" % name))
    with open(os.path.join(data, "profile.md"), "w") as fh:
        fh.write("# PA profile\n\n## About\n\n- Holidays: UK\n")
    with open(os.path.join(data, "pt", "profile.md"), "w") as fh:
        fh.write("# PA profile\n\n## About\n\n- Holidays: PT\n")
    with open(os.path.join(data, "settings.json"), "w") as fh:
        json.dump({"boards": {"pt": {"memory_root": None}}}, fh)
    days = notify_due.calendars(["uk", "pt"], lambda b: owner_profile.board_holiday_regions(os.path.join(data, b), data))
    check("calendar: each board's day test is its own profile's",
          (days["uk"](portugal_day), days["pt"](portugal_day)), (True, False))
    check("calendar: next banner follows each board's calendar",
          notify_due.next_banner(data, ["pt"], at(portugal_day, "08:00"), lambda d: True,
                                 working_for=days.get), at(D(2026, 6, 11), "09:00"))
    check("calendar: without working_for every board uses is_working",
          notify_due.next_banner(data, ["pt"], at(portugal_day, "08:00"), lambda d: True), at(portugal_day, "09:00"))
    got = []
    notify_due.run_tick(data, ["uk", "pt"], at(portugal_day, "10:00"), lambda d: True,
                        lambda *a: got.append((a[0], a[5])) or (True, ""), working_for=days.get)
    check("calendar: a board on its own holiday stays quiet", got, [("uk task", "uk")])
    got = []
    notify_due.run_tick(data, ["uk", "pt"], at(D(2026, 6, 11), "09:00"), lambda d: True,
                        lambda *a: got.append((a[0], a[1], a[5])) or (True, ""), working_for=days.get)
    check("calendar: and goes out the next working day as overdue",
          [(t, b) for t, _, b in got if b == "pt"], [("pt task", "pt")])

# Snooze. alerter is a fake process here: each spawn records its arguments and
# blocks in communicate() until its gate is set, as alerter blocks until the
# alert is answered. Nothing starts the real one.
from unittest import mock  # noqa: E402


class FakeAlerter:
    def __init__(self, reply="", hold=False):
        self.reply, self.calls, self.gate = reply, [], threading.Event()
        if not hold:
            self.gate.set()

    def __call__(self, args, **kw):
        self.calls.append(args)
        fake = self

        class Proc:
            returncode = 0

            def communicate(self):
                fake.gate.wait(5)
                return fake.reply, None
        return Proc()


def settle():
    for th in threading.enumerate():
        if th.name == "alert-answer":
            th.join(5)


def pressed(label):
    return json.dumps({"activationType": "actionClicked", "activationValue": label})


saved_home = os.environ.get("NOTIFY_HOME")
with tempfile.TemporaryDirectory() as data:
    os.environ["NOTIFY_HOME"] = os.path.join(data, "no-notifier")
    wdir = os.path.join(data, "work")
    os.makedirs(wdir)
    q = os.path.join(wdir, notify_due.QUEUE_FILE)

    def write_todo(*lines):
        with open(os.path.join(wdir, "todo.md"), "w") as fh:
            fh.write(doc(*lines))

    def tick_at(now, poster, retries=None):
        return notify_due.run_tick(data, ["work"], now, working, poster, retries=retries, log=lambda *a: None)

    def snoozer(fake, now, opened=None):
        return notify_due.make_poster(data, BASE, "/no/terminal-notifier", "/fake/alerter", lambda *a: None,
                                      spawn=fake, clock=lambda: now,
                                      opener=opened.append if opened is not None else None)

    # A held line stays where it is and does not count against the three.
    notify_due._write_queue(q, [{"title": "Later", "body": "l", "not_before": "2026-10-27T11:00:00"},
                                {"title": "A", "body": "a"}, {"title": "B", "body": "b"}, {"title": "C", "body": "c"}])
    check("not before: a held line is passed over, and the three behind it go",
          [m[0] for _, m in notify_due.queue_batch(wdir, "work", at(TUE, "10:59"))], ["A", "B", "C"])
    check("not before: and goes once its time comes",
          [m[0] for _, m in notify_due.queue_batch(wdir, "work", at(TUE, "11:00"))], ["Later", "A", "B"])
    notify_due._write_queue(q, [{"title": "Bad", "body": "b", "not_before": "soon"},
                                {"title": "Zoned", "body": "z", "not_before": "2099-01-01T00:00:00+00:00"}])
    check("not before: a time that cannot be read or carries a zone holds nothing",
          [m[0] for _, m in notify_due.queue_batch(wdir, "work", at(TUE, "10:00"))], ["Bad", "Zoned"])
    notify_due._write_queue(q, [{"title": "Evening", "body": "e", "not_before": "2026-10-27T20:30:00"}])
    check("not before: past 20:00 it waits for the next window",
          (len(notify_due.queue_batch(wdir, "work", at(TUE, "20:00"))),
           len(notify_due.queue_batch(wdir, "work", at(D(2026, 10, 28), "08:30")))), (0, 1))

    # The alert: three buttons, the board's link opened by hand, the group and sound passed on.
    fake = FakeAlerter()
    with mock.patch.dict(os.environ, {"BENCH_NOTIFY_SOUND": "Glass"}):
        snoozer(fake, at(TUE, "10:00"))("T", "b", "k1", None, "2026-10-27|k1|due", "work")
    settle()
    args = fake.calls[0]
    check("alert: title and message first", args[:5], ["/fake/alerter", "--title", "T", "--message", "b"])
    check("alert: Snooze 1h, Tomorrow and Dismiss",
          (args[args.index("--actions") + 1], args[args.index("--close-label") + 1]), ("Snooze 1h,Tomorrow", "Dismiss"))
    check("alert: grouped, with its sound, read as JSON",
          (args[args.index("--group") + 1], args[args.index("--sound") + 1], "--json" in args, "-open" in args),
          ("2026-10-27|k1|due", "Glass", True, False))
    fake = FakeAlerter()
    with mock.patch.dict(os.environ, {"BENCH_NOTIFY_SOUND": "0"}):
        snoozer(fake, at(TUE, "10:00"))("T", "b", None, None, None, "work")
    settle()
    check("alert: BENCH_NOTIFY_SOUND=0 mutes it", "--sound" in fake.calls[0], False)
    opened = []
    snoozer(FakeAlerter(json.dumps({"activationType": "contentsClicked"})), at(TUE, "10:00"), opened)(
        "T", "b", "k1", None, None, "work")
    settle()
    check("alert: pressing it opens the card on its board", opened, [BASE + "#!board=work!task=k1"])
    check("alert: the plain answers are read too",
          [notify_due.answer(x) for x in ("Tomorrow\n", "@CONTENTCLICKED", "@CLOSED", "", None)],
          ["Tomorrow", "open", None, None, None])

    # A queued line snoozed for an hour goes back on its queue, held, with its link.
    notify_due._write_queue(q, [{"title": "Plan agent", "body": "3 plans", "task": "k1", "view": "plans"}])
    check("queue snooze: posted", tick_at(at(TUE, "10:00"), snoozer(FakeAlerter(pressed("Snooze 1h")), at(TUE, "10:00"))), 1)
    settle()
    check("queue snooze: back on the queue, held for an hour",
          [(e["title"], e["body"], e["task"], e["view"], e["not_before"]) for e in json.load(open(q))],
          [("Plan agent", "3 plans", "k1", "plans", "2026-10-27T11:00:00")])
    seen = []
    tick_at(at(TUE, "10:30"), lambda *a: seen.append(a[0]) or (True, ""))
    tick_at(at(TUE, "11:00"), lambda *a: seen.append(a[0]) or (True, ""))
    check("queue snooze: posted again once the hour is up, not before", seen, ["Plan agent"])
    notify_due._write_queue(q, [{"title": "Night", "body": "n"}])
    tick_at(at(TUE, "19:50"), snoozer(FakeAlerter(pressed("Tomorrow")), at(TUE, "19:50")))
    settle()
    check("queue snooze: Tomorrow is 09:00 the next day", [e["not_before"] for e in json.load(open(q))],
          ["2026-10-28T09:00:00"])
    for reply in (json.dumps({"activationType": "closed", "activationValue": "Dismiss"}), "@TIMEOUT", "garbage"):
        notify_due._write_queue(q, [{"title": "Gone", "body": "g"}])
        tick_at(at(TUE, "10:00"), snoozer(FakeAlerter(reply), at(TUE, "10:00")))
        settle()
        check("queue snooze: %s puts nothing back" % reply[:30], json.load(open(q)), [])

    # A due banner snoozed for an hour: its own entry in notify-state.json, out again at the time.
    write_todo("- [ ] **Call Ana** [due:: 2026-10-27] [time:: 15:00]")
    tick_at(at(TUE, "15:00"), snoozer(FakeAlerter(pressed("Snooze 1h")), at(TUE, "15:02")))
    settle()
    state = json.load(open(os.path.join(wdir, notify_due.STATE_FILE)))
    check("due snooze: the banner is fired, and snoozed in the state file",
          (state["fired"], state["snoozed"]),
          (["2026-10-27|Call Ana|due"], [{"key": "2026-10-27|Call Ana|due", "ident": "Call Ana", "at": "2026-10-27T16:02:00",
                                         "title": "Call Ana", "body": "Due 15:00 · Work", "task": "Call Ana"}]))
    check("due snooze: the next banner is the snoozed one",
          notify_due.next_banner(data, ["work"], at(TUE, "15:30"), working), at(TUE, "16:02"))
    got = []
    tick_at(at(TUE, "16:01"), lambda *a: got.append(a) or (True, ""))
    check("due snooze: nothing before its time", got, [])
    tick_at(at(TUE, "16:02"), lambda *a: got.append(a) or (True, ""))
    check("due snooze: out again, grouped with the banner it came from",
          got, [("Call Ana", "Due 15:00 · Work", "Call Ana", None, "2026-10-27|Call Ana|due", "work")])
    check("due snooze: then gone from the state", "snoozed" in json.load(open(os.path.join(wdir, notify_due.STATE_FILE))), False)
    tick_at(at(TUE, "16:10"), lambda *a: got.append(a) or (True, ""))
    check("due snooze: and not again", len(got), 1)

    # The state file has two writers; neither loses the other's half.
    notify_due.snooze_due(wdir, "2026-10-27|Call Ana|due", "Call Ana", "b", "Call Ana", at(TUE, "17:00"), TUE)
    notify_due.write_state(wdir, {"2026-10-27|Call Ana|due", "2026-10-27|Other|due"}, TUE)
    state = json.load(open(os.path.join(wdir, notify_due.STATE_FILE)))
    check("state: writing fired keeps the snoozes", ([s["at"] for s in state["snoozed"]], len(state["fired"])),
          (["2026-10-27T17:00:00"], 2))
    notify_due.snooze_due(wdir, "2026-10-27|Call Ana|due", "Call Ana", "b", "Call Ana", at(TUE, "18:00"), TUE)
    check("state: snoozing a banner again replaces its entry",
          [s["at"] for s in notify_due.read_snoozed(wdir)], ["2026-10-27T18:00:00"])

    # Done by then: the snooze is spent, unposted.
    write_todo("- [x] **Call Ana** [due:: 2026-10-27] [time:: 15:00] `done:2026-10-27`")
    got = []
    tick_at(at(TUE, "18:00"), lambda *a: got.append(a) or (True, ""))
    check("due snooze: an item done meanwhile is not announced", (got, notify_due.read_snoozed(wdir)), ([], []))
    notify_due.snooze_due(wdir, "2026-10-27|Call Ana|due", "Call Ana", "b", "Call Ana", at(TUE, "18:00"), TUE)
    check("due snooze: kept while the list cannot be read",
          (notify_due.run_tick(data, ["work"], at(TUE, "18:10"), working, lambda *a: (True, ""),
                               read_text=lambda p: None), len(notify_due.read_snoozed(wdir))), (0, 1))

    # Tomorrow on a due banner lands at 09:00 with the overdue one: only one goes out.
    os.remove(os.path.join(wdir, notify_due.STATE_FILE))
    write_todo("- [ ] **Report** [due:: 2026-10-27]")
    tick_at(at(TUE, "09:00"), snoozer(FakeAlerter(pressed("Tomorrow")), at(TUE, "09:05")))
    settle()
    check("due snooze: Tomorrow is 09:00 the next day", [s["at"] for s in notify_due.read_snoozed(wdir)],
          ["2026-10-28T09:00:00"])
    got = []
    tick_at(at(D(2026, 10, 28), "09:00"), lambda *a: got.append(a[1]) or (True, ""))
    check("due snooze: the overdue banner says it, the snooze is spent",
          (got, notify_due.read_snoozed(wdir)), (["Overdue since Tue 27 Oct · Work"], []))

    # alerter blocks until answered: the tick and the queue's lock do not wait for it.
    notify_due._write_queue(q, [{"title": "Waiting", "body": "w"}])
    fake = FakeAlerter(pressed("Snooze 1h"), hold=True)
    started = time.time()
    check("non-blocking: the tick posts", tick_at(at(TUE, "10:00"), snoozer(fake, at(TUE, "10:00"))), 1)
    check("non-blocking: and returns with the alert still up", time.time() - started < 1, True)
    free = threading.Event()

    def take_lock():
        with notify_due.queue_lock(q):
            free.set()
    threading.Thread(target=take_lock).start()
    check("non-blocking: the queue's lock is free while it waits", free.wait(1), True)
    fake.gate.set()
    settle()
    check("non-blocking: the snooze lands when the answer comes",
          [(e["title"], e["not_before"]) for e in json.load(open(q))], [("Waiting", "2026-10-27T11:00:00")])

    # alerter that will not start: the line stays, to be tried again.
    def broken(args, **kw):
        raise OSError("no such file")
    notify_due._write_queue(q, [{"title": "Keep", "body": "k"}])
    logs = []
    notify_due.run_tick(data, ["work"], at(TUE, "12:00"), working,
                        notify_due.make_poster(data, BASE, None, "/gone/alerter", logs.append, spawn=broken),
                        retries={}, log=logs.append)
    check("alerter missing at post time: the line stays", [e["title"] for e in json.load(open(q))], ["Keep"])
    check("alerter missing at post time: said once", logs, ["notify: Keep failed: could not run alerter: no such file"])

    # No alerter: terminal-notifier as before, with no snooze.
    notify_due._write_queue(q, [{"title": "Plain", "body": "p", "task": "k1"}])
    with mock.patch.object(notify_due.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run:
        tick_at(at(TUE, "12:30"), notify_due.make_poster(data, BASE, "/bin/terminal-notifier", None, lambda *a: None))
    args = run.call_args[0][0]
    check("fallback: terminal-notifier, linked to the card",
          (args[:5], args[args.index("-open") + 1]),
          (["/bin/terminal-notifier", "-title", "Plain", "-message", "p"], BASE + "#!board=work!task=k1"))
    check("fallback: no buttons, and the line is gone", ("--actions" in args, json.load(open(q))), (False, []))
    with mock.patch.object(notify_due.sys, "platform", "darwin"), \
            mock.patch.object(notify_due, "find_notifier", return_value=None), \
            mock.patch.object(notify_due, "find_alerter", return_value="/opt/homebrew/bin/alerter"), \
            mock.patch.dict(os.environ, {"BENCH_NOTIFY": "1"}):
        check("enabled: alerter alone is enough", notify_due.enabled(), True)
    with mock.patch.object(notify_due.sys, "platform", "darwin"), \
            mock.patch.object(notify_due, "find_notifier", return_value=None), \
            mock.patch.object(notify_due, "find_alerter", return_value=None):
        check("enabled: neither is off", notify_due.enabled(), False)
if saved_home is None:
    os.environ.pop("NOTIFY_HOME", None)
else:
    os.environ["NOTIFY_HOME"] = saved_home

os.environ["BENCH_NOTIFY"] = "0"
check("BENCH_NOTIFY=0 keeps it off", notify_due.start("/x", list, tuple, "u"), None)

saved = os.environ.pop("BENCH_NOTIFY_SOUND", None)
check("sound: unset is the default sound", notify_due.notify_sound(), "default")
os.environ["BENCH_NOTIFY_SOUND"] = "Glass"
check("sound: a name is that sound", notify_due.notify_sound(), "Glass")
os.environ["BENCH_NOTIFY_SOUND"] = "0"
check("sound: 0 mutes it", notify_due.notify_sound(), None)
os.environ.pop("BENCH_NOTIFY_SOUND", None)
if saved is not None:
    os.environ["BENCH_NOTIFY_SOUND"] = saved

print("notify_due — %s" % ("all agree" if not failures else "%d failed" % failures))
raise SystemExit(1 if failures else 0)
