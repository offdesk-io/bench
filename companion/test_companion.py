#!/usr/bin/env python3
"""The companion's policy, tested without an app bundle in the way.

`digest.py` is deliberately the half with no AppKit in it, so everything worth
checking here can be checked at a terminal: which tasks are owed, which messages
are still waiting, and what the notification queue does with what it is given.

The menu drawing in app.py is not covered and does not need to be — it is a
handful of NSMenuItem calls over these answers.

    python3 companion/test_companion.py
"""

import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "core"))
sys.path.insert(0, HERE)

import digest  # noqa: E402
import notify  # noqa: E402
import todo  # noqa: E402

FAILED = []


def check(name, got, want):
    if got != want:
        FAILED.append("%s\n    got  %r\n    want %r" % (name, got, want))


DAY = dt.date(2026, 9, 7)          # a Monday

DOC = """# List

## 1. People

### Doing

- [ ] **Live task** [impact:: high] [effort:: M] [ai:: none]
  - [ ] Chase the nominees [due:: 2026-09-08] [ai:: none]
    - Suggested message: "Hey 👋 Could you fill in the form?"
  - [ ] Share with Priya [due:: 2026-09-10] [ai:: none]
    - Suggested message (draft): "Hey Priya 👋 Needs editing first."
  - [x] Already sent [ai:: none]
    - Suggested message: "This one has gone."

- [ ] **Undated one** [impact:: med] [effort:: S] [ai:: none]
  - [ ] Ask about the form [ai:: none]
    - Suggested message: "Hey 👋 Quick one about the form."

- [ ] **Waiting on a blocker** [impact:: high] [effort:: S] [ai:: none] `blocked-by:gate`
  - [ ] Ask them [ai:: none]
    - Suggested message: "Blocked, so not ready."

- [ ] **Not startable yet** [impact:: high] [effort:: S] [ai:: none] `start:2099-01-01`
  - [ ] Ask them [due:: 2026-09-09] [ai:: none]
    - Suggested message: "Too early."

### Waiting for review

- [ ] **Sitting with somebody** [impact:: high] [effort:: S] [ai:: none]
  - [ ] Nudge them [due:: 2026-09-08] [ai:: none]
    - Suggested message: "With someone else, so not mine to send."

### To do

- [ ] **The gate** [impact:: high] [effort:: S] [ai:: none] `#gate`
- [ ] **Weekly design review** [impact:: med] [effort:: S] [ai:: none] `due:2026-09-07` `repeat:mon-9:15`
  - Agenda:
    - Rebrand colours
      - Confirm the palette before Friday.
- [ ] **Standup, no agenda yet** [impact:: med] [effort:: S] [ai:: none] `due:2026-09-07` `repeat:mon-8:45`
- [ ] **All-hands, no time on the tag** [impact:: med] [effort:: S] [ai:: none] `due:2026-09-07` `repeat:mon`
  - Agenda:
    - Only item
"""


def test_messages():
    got = digest.read_messages(DOC, DAY)
    check("only the sendable ones, soonest first, undated last",
          [m["where"] for m in got],
          ["Chase the nominees", "Share with Priya", "Ask about the form"])
    check("a draft is marked", [m["draft"] for m in got], [False, True, False])
    check("and carries the step's own date",
          [m["due"] for m in got], ["2026-09-08", "2026-09-10", ""])

    # Dismissing is by content, so re-ordering the file cannot resurrect one and
    # rewording a message deliberately brings it back.
    key = got[0]["key"]
    fewer = digest.read_messages(DOC, DAY, dismissed={key})
    check("a dismissed message stays hidden",
          [m["where"] for m in fewer], ["Share with Priya", "Ask about the form"])

    reworded = DOC.replace("Could you fill in the form?", "Could you fill the form in?")
    back = digest.read_messages(reworded, DAY, dismissed={key})
    check("rewording it brings it back",
          [m["where"] for m in back],
          ["Chase the nominees", "Share with Priya", "Ask about the form"])

    # Same key from the same content, every time, or dismissal is useless.
    check("the key is stable", digest.read_messages(DOC, DAY)[0]["key"], key)


def test_digest_line():
    d = digest.Digest(DAY)
    check("a quiet day says so", d.line(), "Nothing due today")
    d.messages = [1, 2]
    check("messages are counted into the line", d.line(), "2 to send")


def test_notify_queue():
    tmp = tempfile.mkdtemp(prefix="notify-test-")
    real = notify.ROOT
    notify.ROOT = tmp
    try:
        os.makedirs(os.path.join(tmp, "data", "x"))
        notify.queue("Plan agent", "3 plans waiting", dataset="x")
        notify.queue("Plan agent", "and another", dataset="x")
        with open(notify.queue_path("x"), encoding="utf-8") as fh:
            items = json.load(fh)
        check("both are queued, in order",
              [i["body"] for i in items], ["3 plans waiting", "and another"])
        check("each carries a timestamp", all("queued" in i for i in items), True)

        # A queue nobody drains means the companion is not running. It is capped
        # so that comes back as the last few lines rather than a month at once.
        for i in range(40):
            notify.queue("t", "body %d" % i, dataset="x")
        with open(notify.queue_path("x"), encoding="utf-8") as fh:
            items = json.load(fh)
        check("the queue is capped", len(items), notify.MAX_QUEUED)
        check("and keeps the newest", items[-1]["body"], "body 39")

        # Where the banner goes when it is pressed. Absent rather than null when
        # there is nowhere in particular to send it.
        notify.queue("Plan agent", "3 plans waiting", dataset="x", view="plans")
        notify.queue("Due today", "The audit", dataset="x", task="ds-audit")
        with open(notify.queue_path("x"), encoding="utf-8") as fh:
            items = json.load(fh)
        check("a view rides along", items[-2].get("view"), "plans")
        check("and a task", items[-1].get("task"), "ds-audit")
        check("neither is written when neither was given",
              [k for k in ("task", "view") if k in items[0]], [])

        # A failed agent run names its queue outright (core/agent_runs.py
        # resolves the dataset under $TODOS_DATA_ROOT) and points at the
        # sub-task, whose panel holds Read the log, Retry and Take it back.
        elsewhere = os.path.join(tmp, "other", "notify-queue.json")
        os.makedirs(os.path.dirname(elsewhere))
        notify.queue("Implement agent", "Failed on X: it wrote nothing", task="aa0003", path=elsewhere)
        with open(elsewhere, encoding="utf-8") as fh:
            items = json.load(fh)
        check("a queue named by path is the one written", items[-1]["task"], "aa0003")

        # It must never raise: every caller is doing something else as its real
        # job, and a banner is not worth taking that down for.
        notify.ROOT = "/nonexistent/nowhere"
        check("an unwritable queue returns None rather than raising",
              notify.queue("t", "b", dataset="x"), None)
    finally:
        notify.ROOT = real
        shutil.rmtree(tmp, ignore_errors=True)


def test_notify_forwards_to_the_notifier():
    """With the notifier's folder there, a line for a board goes to its queue
    for that board, appended by its own notify.py; a throwaway data root
    keeps its lines; with no notifier the shim appends itself (above)."""
    tmp = tempfile.mkdtemp(prefix="notify-home-test-")
    saved = {k: os.environ.pop(k, None) for k in ("NOTIFY_HOME", "TODOS_DATA_ROOT")}
    real = notify.ROOT
    try:
        home = os.path.join(tmp, "notify")
        os.makedirs(home)
        # A stand-in notifier that says it was the one called.
        with open(os.path.join(home, "notify.py"), "w", encoding="utf-8") as fh:
            fh.write("import json, os\n"
                     "def queue(title, body, dataset=None, task=None, view=None, path=None):\n"
                     "    os.makedirs(os.path.dirname(path), exist_ok=True)\n"
                     "    json.dump([{'title': title, 'body': body, 'task': task, 'view': view, 'by': 'notifier'}],"
                     " open(path, 'w'))\n"
                     "    return path\n")
        os.environ["NOTIFY_HOME"] = home
        want = os.path.join(home, "data", "work", "notify-queue.json")
        check("a board's queue is the notifier's", notify.queue_path("work"), want)
        check("and the line is appended by the notifier", notify.queue("Plan agent", "3 plans", dataset="work", view="plans"), want)
        with open(want, encoding="utf-8") as fh:
            check("with everything the caller gave", json.load(fh),
                  [{"title": "Plan agent", "body": "3 plans", "task": None, "view": "plans", "by": "notifier"}])
        # The command line, as the agents outside Bench call it.
        out = subprocess.run([sys.executable, os.path.join(HERE, "notify.py"), "--dataset", "content", "T", "B"],
                             env=dict(os.environ), capture_output=True, text=True)
        check("the command line forwards too", (out.returncode, os.path.isfile(
            os.path.join(home, "data", "content", "notify-queue.json"))), (0, True))
        os.environ.pop("NOTIFY_HOME")
        notify.ROOT = tmp
        check("a throwaway data root keeps its own lines", notify.queue_path("work"),
              os.path.join(tmp, "data", "work", "notify-queue.json"))
    finally:
        notify.ROOT = real
        for k, v in saved.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v
        shutil.rmtree(tmp, ignore_errors=True)


def test_content_queue_ignores_window():
    """notifyQueue.ts, run under node: a content notice posts outside the
    08:30-20:00 window, a work one is held."""
    import subprocess
    tmp = tempfile.mkdtemp(prefix="drain-test-")
    try:
        for ds in ("work", "content"):
            os.makedirs(os.path.join(tmp, "data", ds))
            path = os.path.join(tmp, "data", ds, "notify-queue.json")
            notify.queue("T", "from " + ds, path=path)
        script = (
            "import {drainAll} from %r;"
            "const got=[];"
            "drainAll(%r,'work',false,(t,b)=>got.push(b));"
            "console.log(JSON.stringify(got));"
        ) % (os.path.join(HERE, "src", "main", "notifyQueue.ts"), tmp)
        out = subprocess.run(["node", "--input-type=module", "-e", script],
                             capture_output=True, text=True)
        check("outside the window only the content notice posts",
              json.loads(out.stdout or "null"), ["from content"])
        with open(os.path.join(tmp, "data", "work", "notify-queue.json")) as fh:
            check("the work notice is held on its queue", len(json.load(fh)), 1)
        with open(os.path.join(tmp, "data", "content", "notify-queue.json")) as fh:
            check("the content queue is emptied", len(json.load(fh)), 0)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_json():
    """The shape the Electron companion polls once a tick — see digest.to_json.

    Every field it reads is checked here rather than there, because there is
    no Python left to run in that project: this is the only place the payload
    can be pinned down before the JavaScript side ever sees it.
    """
    tmp = tempfile.mkdtemp(prefix="digest-json-")
    doc_path = os.path.join(tmp, "todo.md")
    try:
        with open(doc_path, "w", encoding="utf-8") as fh:
            fh.write(DOC)
        d = digest.build(DAY, path=doc_path)
        out = digest.to_json(d)
        check("day is ISO", out["day"], "2026-09-07")
        check("line matches", out["line"], d.line())
        check("count matches", out["count"], d.count)
        check("no error on a readable file", out["error"], None)
        check("overdue rows carry a task key",
              [o["task"] for o in out["overdue"]],
              [t.slug or t.title for _, t in d.overdue])
        check("today rows carry a due date",
              [o["due"] for o in out["today"]],
              [due.isoformat() for due, _ in d.today])
        check("messages carry the same keys as the object form",
              [m["key"] for m in out["messages"]],
              [m["key"] for m in d.messages])
        check("today_status names whether it's a working day",
              out["today_status"]["working"], True)   # 2026-09-07 is a Monday

        # The calendar is the list's own profile's when the list is kept apart.
        saved = os.environ.get("TODOS_DATA_ROOT")
        os.environ["TODOS_DATA_ROOT"] = tmp
        try:
            os.makedirs(os.path.join(tmp, "demo"))
            demo = os.path.join(tmp, "demo", "todo.md")
            with open(demo, "w", encoding="utf-8") as fh:
                fh.write(DOC)
            with open(os.path.join(tmp, "profile.md"), "w", encoding="utf-8") as fh:
                fh.write("# PA profile\n\n## About\n\n- Holidays: UK\n")
            with open(os.path.join(tmp, "demo", "profile.md"), "w", encoding="utf-8") as fh:
                fh.write("# PA profile\n\n## About\n\n- Holidays: PT\n")
            with open(os.path.join(tmp, "settings.json"), "w", encoding="utf-8") as fh:
                json.dump({"boards": {"demo": {"memory_root": None}}}, fh)
            portugal_day = dt.date(2026, 6, 10)
            check("today_status follows a kept-apart list's own calendar",
                  digest.to_json(digest.build(portugal_day, path=demo))["today_status"]["working"], False)
            os.remove(os.path.join(tmp, "settings.json"))
            os.remove(os.path.join(tmp, "demo", "profile.md"))
            check("and an inheriting list the owner's",
                  digest.to_json(digest.build(portugal_day, path=demo))["today_status"]["working"], True)
        finally:
            if saved is None:
                os.environ.pop("TODOS_DATA_ROOT", None)
            else:
                os.environ["TODOS_DATA_ROOT"] = saved

        broken = digest.build(DAY, path=os.path.join(tmp, "missing.md"))
        check("a missing file reports an error rather than raising",
              digest.to_json(broken)["error"] is not None, True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_timed_meetings():
    """A repeat: meeting due today pops on its own only once it carries both
    a time and an agenda — see the comment above timed_meetings in
    digest.build(). Three near-misses in DOC: no agenda, no time on the tag,
    and (implicitly, everything else in DOC) no repeat: at all."""
    tmp = tempfile.mkdtemp(prefix="digest-meetings-")
    doc_path = os.path.join(tmp, "todo.md")
    try:
        with open(doc_path, "w", encoding="utf-8") as fh:
            fh.write(DOC)
        d = digest.build(DAY, path=doc_path)
        check("only the one with both a time and an agenda",
              [t.title for _, t in d.timed_meetings], ["Weekly design review"])
        check("its time is read off the tag",
              [time for time, _ in d.timed_meetings], ["9:15"])

        out = digest.to_json(d)
        check("and it carries a task key through to_json",
              out["timed_meetings"],
              [{"title": "Weekly design review",
                "task": digest.task_key(d.timed_meetings[0][1]), "time": "9:15"}])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_meetings():
    """Every repeat: meeting on today with a time, agenda or not, in time
    order, each carrying its agenda for the window to draw."""
    tmp = tempfile.mkdtemp(prefix="digest-meetings-all-")
    doc_path = os.path.join(tmp, "todo.md")
    try:
        with open(doc_path, "w", encoding="utf-8") as fh:
            fh.write(DOC)
        out = digest.to_json(digest.build(DAY, path=doc_path))
        check("timed meetings only, earliest first",
              [(m["time"], m["title"]) for m in out["meetings"]],
              [("8:45", "Standup, no agenda yet"), ("9:15", "Weekly design review")])
        check("the agenda travels with it",
              out["meetings"][1]["agenda"],
              [{"topic": "Rebrand colours", "context": "Confirm the palette before Friday."}])
        check("an empty agenda is an empty list", out["meetings"][0]["agenda"], [])
        check("not prepared until ticked", out["meetings"][1]["prepared"], False)
        check("minutes sorts 9:15 before 10:00",
              sorted(["10:00", "9:15"], key=digest.minutes), ["9:15", "10:00"])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_task_key():
    t = todo.Task()
    t.title, t.slug = "Ship the thing", ""
    check("falls back to the title with no slug", digest.task_key(t), "Ship the thing")
    t.slug = "ship-it"
    check("prefers the slug", digest.task_key(t), "ship-it")


def test_read_dismissed():
    tmp = tempfile.mkdtemp(prefix="companion-state-")
    try:
        check("no state file yet", digest.read_dismissed(tmp), set())
        os.makedirs(os.path.join(tmp, "data", digest.DEFAULT_LIST))
        with open(digest.companion_state_path(tmp), "w", encoding="utf-8") as fh:
            json.dump({"dismissed": ["a", "b"]}, fh)
        check("reads what is there", digest.read_dismissed(tmp), {"a", "b"})
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_chosen_list():
    tmp = tempfile.mkdtemp(prefix="companion-list-")
    try:
        for board in ("personal", "work", "content"):
            os.makedirs(os.path.join(tmp, "data", board))
            open(os.path.join(tmp, "data", board, "todo.md"), "w").close()
        check("nothing saved is the first list on disk", digest.chosen_list(tmp), "content")
        saved = os.path.join(tmp, "data", "companion-list.json")
        with open(saved, "w", encoding="utf-8") as fh:
            json.dump({"list": "work"}, fh)
        check("the file is read", digest.chosen_list(tmp), "work")
        check("the argument wins", digest.chosen_list(tmp, "personal"), "personal")
        check("any board with a todo.md is accepted", digest.chosen_list(tmp, "content"), "content")
        check("a path is not a board", digest.chosen_list(tmp, "../data"), "work")
        check("an unknown argument is ignored", digest.chosen_list(tmp, "nope"), "work")
        with open(saved, "w", encoding="utf-8") as fh:
            fh.write("not json")
        check("a broken file is the first list on disk", digest.chosen_list(tmp), "content")
        check("todo.md follows the list", digest.todo_path(tmp, "work"),
              os.path.join(tmp, "data", "work", "todo.md"))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    test_messages()
    test_digest_line()
    test_notify_queue()
    test_notify_forwards_to_the_notifier()
    test_content_queue_ignores_window()
    test_json()
    test_timed_meetings()
    test_meetings()
    test_task_key()
    test_read_dismissed()
    test_chosen_list()
    if FAILED:
        print("%d failed\n" % len(FAILED))
        for f in FAILED:
            print("  " + f)
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
