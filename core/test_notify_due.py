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
