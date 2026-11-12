#!/usr/bin/env python3
"""What the companion thinks is owed today.

Kept apart from the menu bar app on purpose: this half is plain data in, plain
data out, so it can be run and read at a terminal without an app bundle, a
status icon or a notification permission anywhere in the way:

    python3 companion/digest.py            what is owed today
    python3 companion/digest.py 2026-09-07 what would be owed on that day
    python3 companion/digest.py --json     the same, as one line of JSON —
                                            what the Electron companion polls

The format knowledge is not here — that is core/todo.py, which every reader of
the list shares.
What is here is the policy, and the policy is one question: which tasks are
actually owed today, as opposed to merely carrying a date.

Three things take a task out, all three matching what the board's Quick wins
view already does, because two views of one list disagreeing about what is
actionable is worse than either answer:

  - Reviewing. It means the next move belongs to somebody else. Nothing is
    owed on it until it comes back, so a notification about one is a
    notification the owner can do nothing with.
  - An unticked `blocked-by:`. The blocker is the real task; this one is not
    startable and saying so in the morning is noise.
  - Sub-steps. A step has no state of its own, it inherits its parent's, so
    counting steps would count the same work twice.

`start:` is deliberately ignored. It says the earliest work can begin, and a
task whose deadline has arrived is owed whether or not its start date has —
those two disagreeing is a tagging mistake worth seeing, not one worth hiding.

It also collects the suggested messages waiting to be sent — see read_messages
below. That is a second question and it is here for the same reason as the
first: what stalls a contact step for days is writing the opening line, not
doing the thing, and a message already sitting in the menu turns a five minute
task into a ten second one.

Both are read-only, which is the whole of what this process is allowed to be.
"""

import datetime as dt
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "core"))
import todo  # noqa: E402
import owner_profile  # noqa: E402

# The one list this watches, chosen in the companion's tray menu and kept in
# data/companion-list.json. It reads that list by name rather than following
# data/.current, which is the pointer the board's dropdown moves: switching the
# board to another list for ten minutes should not silently change what gets
# notified tomorrow morning. The Electron app passes its choice as --list (and any other board's name for its morning notification); run
# from a terminal the file is read, and with neither it is the first list on
# disk, in name order. The lists are the folders under data/ that hold a todo.md.
DEFAULT_LIST = "default"

PARKED_COLUMNS = {"reviewing"}


class Digest:
    def __init__(self, day, path=None):
        self.day = day
        self.path = path       # the todo.md read, whose list's profile sets the calendar
        self.overdue = []      # deadline gone, still open
        self.today = []        # due today
        self.headline = None   # the one thing, whatever its date
        self.parked = 0        # open, dated, but sitting with someone else
        self.messages = []     # contact steps with a message ready to copy
        self.buckets = []      # bucket names, in the order the file declares them
        self.timed_meetings = []  # today's repeat: meetings that carry a time and an agenda
        self.meetings = []     # every repeat: meeting on today with a time, agenda or not
        self.error = None      # the file could not be read

    @property
    def count(self):
        return len(self.overdue) + len(self.today)

    def line(self):
        """The one sentence the notification and the menu header both use."""
        if self.error:
            return "The list could not be read"
        bits = []
        if self.today:
            bits.append("%d due today" % len(self.today))
        if self.overdue:
            bits.append("%d overdue" % len(self.overdue))
        if self.messages:
            bits.append("%d to send" % len(self.messages))
        return ", ".join(bits) if bits else "Nothing due today"


def default_root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def available_lists(root=None):
    """Every folder under data/ holding a todo.md, sorted."""
    import dataset
    return dataset.names(os.path.join(root or default_root(), "data"))


def chosen_list(root=None, override=None):
    """The list to watch: the argument if it names one, else what
    data/companion-list.json holds, else the first list on disk."""
    # Any board: the companion notifies for every data/<name>/ with a todo.md,
    # not only the ones in its menu. A name with a path separator is not one.
    if override and os.path.basename(override) == override and override not in (".", ".."):
        if os.path.isfile(os.path.join(root or default_root(), "data", override, "todo.md")):
            return override
    try:
        with open(os.path.join(root or default_root(), "data", "companion-list.json"), encoding="utf-8") as fh:
            saved = json.load(fh).get("list")
        if saved in available_lists(root):
            return saved
    except (OSError, ValueError, AttributeError):
        pass
    found = available_lists(root)
    return found[0] if found else DEFAULT_LIST


def todo_path(root=None, dataset=None):
    root = root or default_root()
    return os.path.join(root, "data", dataset or chosen_list(root), "todo.md")


def companion_state_path(root=None, dataset=None):
    root = root or default_root()
    return os.path.join(root, "data", dataset or chosen_list(root), "companion.json")


def read_dismissed(root=None, dataset=None):
    """The set of message keys the companion has hidden, straight off
    companion.json — read here rather than passed in, so anything that just
    wants a digest (a terminal, the Electron app's --json call) gets the same
    answer the app itself would, without first having to read its own state."""
    try:
        with open(companion_state_path(root, dataset), encoding="utf-8") as fh:
            return set(json.load(fh).get("dismissed", []))
    except (OSError, ValueError):
        return set()


def task_key(task):
    """How a card is named in a link: its `#slug` where it has one, its title
    where it does not — the two things in todo.md stable enough to point at,
    since the board mints a fresh id for every task on every parse."""
    return task.slug or task.title


def message_key(m):
    """A stable id for one message, for remembering it has been dismissed.

    Built from the task, the step and the text rather than from a position in
    the file, so re-ordering the board does not resurrect everything, and
    rewording a message deliberately does — a changed message is a different
    message and is worth seeing again.
    """
    raw = "%s\u241f%s\u241f%s" % (m["task"], m["where"], m["text"])
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


def read_messages(text, day, dismissed=()):
    """Suggested messages that are still waiting to go out.

    The extraction is core/todo.py's — this is only the policy on top of it, and
    the policy is the same three exclusions the rest of this file applies, for
    the same reason. A message under a task sitting with somebody else, or
    waiting on an unfinished blocker, is not one the owner can send today.

    `start:` is honoured here, unlike in the dated half above. There the
    argument is that a passed deadline is owed whatever its start date says;
    here there is no deadline in play, so a step that cannot begin yet is
    genuinely not ready and putting its message up would be noise.

    Undated ones sort last rather than dropping out, which is what the board's
    Quick wins does, because those are the ones that rot quietly.
    """
    tasks = todo.parse_doc(text)
    slugs = todo.slug_states(tasks)
    out = []
    for t in tasks:
        if t.column.strip().lower() in PARKED_COLUMNS or todo.is_blocked(t, slugs):
            continue
        for m in todo.messages(t):
            if m["due"]:
                start = todo.parse_date(t.start) if t.start else None
                if start and start > day:
                    continue
            m["key"] = message_key(m)
            # The bucket its task sits in, so anything drawing a message as a
            # card can colour it the way the board colours that bucket.
            m["bucket"] = t.bucket
            if m["key"] in dismissed:
                continue
            out.append(m)
    out.sort(key=lambda m: (m["due"] or "9999-99-99", m["task"], m["where"]))
    return out


def minutes(hhmm):
    """"9:15" as 555, so "9:15" sorts before "10:00" rather than after it."""
    hour, _, minute = hhmm.partition(":")
    return int(hour) * 60 + int(minute or 0)


def build(day=None, path=None, dismissed=()):
    day = day or dt.date.today()
    path = path or todo_path()
    d = Digest(day, path)
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
    except OSError as exc:
        d.error = str(exc)
        return d

    tasks = todo.parse_doc(text)
    slugs = todo.slug_states(tasks)
    for t in tasks:
        if t.bucket and t.bucket not in d.buckets:
            d.buckets.append(t.bucket)
        # Before the done and parked checks: a ticked meeting card means the
        # agenda is prepared, and the meeting still happens today.
        if t.repeat:
            rep = todo.read_repeat(t.repeat)
            if rep and rep["time"] and todo.effective_due(t, day) == day:
                d.meetings.append((rep["time"], t))
        if t.done:
            continue
        if t.headline and not d.headline:
            d.headline = t
        due = todo.effective_due(t, day)
        if not due or due > day:
            continue
        if t.column.strip().lower() in PARKED_COLUMNS or todo.is_blocked(t, slugs):
            d.parked += 1
            continue
        (d.overdue if due < day else d.today).append((due, t))
        if due == day and t.repeat:
            rep = todo.read_repeat(t.repeat)
            # Only when there is something to say beyond "it's on": an agenda
            # ready is real news, and its absence is the signal to leave the
            # meeting to the calendar notification the owner already gets — see the
            # comment above timed_meetings in to_json() below.
            if rep and rep["time"] and todo.agenda_topics(t):
                d.timed_meetings.append((rep["time"], t))

    # Oldest deadline first in each group: the thing that has been owed longest
    # is the thing worth reading first.
    d.overdue.sort(key=lambda p: p[0])
    d.today.sort(key=lambda p: (p[1].bucket, p[1].title))
    d.timed_meetings.sort(key=lambda p: minutes(p[0]))
    d.meetings.sort(key=lambda p: minutes(p[0]))
    d.messages = read_messages(text, day, dismissed)
    return d


def to_json(d):
    """The digest as plain data, for anything that isn't Python — today that
    is the Electron companion, which shells out to `--json` once a tick rather
    than re-deriving this policy (effective due dates, blocked-by, message
    extraction, the holiday calendar) a second time in JavaScript. See
    `read_messages` and `build` above for what each field actually means;
    this only flattens it.
    """
    return {
        "day": d.day.isoformat(),
        "line": d.line(),
        "count": d.count,
        "error": d.error,
        "parked": d.parked,
        "headline": {"title": d.headline.title, "task": task_key(d.headline)}
                    if d.headline else None,
        "overdue": [{"title": t.title, "bucket": t.bucket, "task": task_key(t),
                      "due": due.isoformat()} for due, t in d.overdue],
        "today": [{"title": t.title, "bucket": t.bucket, "task": task_key(t),
                    "due": due.isoformat()} for due, t in d.today],
        # A meeting with a repeat: time and an agenda ready, for the Electron
        # side to fire a light popup at that exact minute rather than saying
        # so only once, at whatever minute the morning briefing happens to
        # land. `time` is "hh:mm", 24-hour, straight off read_repeat().
        "timed_meetings": [{"title": t.title, "task": task_key(t), "time": time}
                            for time, t in d.timed_meetings],
        # Every timed meeting on today, for the window's Meetings today list.
        # Wider than timed_meetings on purpose: a meeting with no agenda yet
        # is still on, and the empty agenda is itself worth seeing.
        "meetings": [{"title": t.title, "task": task_key(t), "time": time,
                      "prepared": t.done, "agenda": todo.agenda_topics(t)}
                     for time, t in d.meetings],
        "messages": [{"key": m["key"], "task": m["task"], "where": m["where"],
                       "text": m["text"], "draft": m["draft"], "due": m["due"],
                       "bucket": m.get("bucket", "")}
                      for m in d.messages],
        # The buckets in the order the file declares them, which is what the
        # board colours cards by — bucketColor(name, index) in
        # kanban/js/02-state.js falls through to a bucket's position when
        # nothing is chosen for it in bucket-colors.json. Taken from the order
        # tasks are parsed in, which is the order their headings appear.
        "buckets": d.buckets,
        # So the Electron side never needs its own copy of the UK/PT holiday
        # calendar, which core/todo.js deliberately doesn't carry — see
        # todo.is_working_day/holiday_names, the only place this lives.
        "today_status": _today_status(d),
    }


def _today_status(d):
    """Whether the digest's day is a working day, by the calendar of the list's
    own profile (owner_profile.board_holiday_regions), which is the owner's
    unless settings.json gives the list a memory folder of its own or none."""
    regions = owner_profile.list_holiday_regions(d.path) if d.path else owner_profile.holiday_regions()
    return {"working": todo.is_working_day(d.day, regions),
            "holidays": list(todo.holiday_names(d.day, regions))}


def main():
    argv = sys.argv[1:]
    as_json = "--json" in argv
    argv = [a for a in argv if a != "--json"]
    override = None
    if "--list" in argv:
        i = argv.index("--list")
        override = argv[i + 1] if i + 1 < len(argv) else None
        del argv[i:i + 2]
    dataset = chosen_list(override=override)
    day = dt.date.fromisoformat(argv[0]) if argv else None
    d = build(day, path=todo_path(dataset=dataset), dismissed=read_dismissed(dataset=dataset))
    if as_json:
        print(json.dumps(to_json(d)))
        return 1 if d.error else 0
    print("%s — %s" % (d.day.strftime("%A %-d %B %Y"), d.line()))
    if d.error:
        return 1
    if d.headline:
        print("\nThe one thing: %s" % d.headline.title)
    for label, group in (("Overdue", d.overdue), ("Due today", d.today)):
        if not group:
            continue
        print("\n%s" % label)
        for due, t in group:
            when = "" if due == d.day else "  (%s)" % due.isoformat()
            print("  %-14s %s%s" % (t.bucket[:14], t.title, when))
    if d.timed_meetings:
        print("\nWill pop at their own time")
        for time, t in d.timed_meetings:
            print("  %-6s %s" % (time, t.title))
    if d.parked:
        print("\n%d more dated but sitting with somebody else or blocked." % d.parked)
    if d.messages:
        print("\nMessages to send")
        for m in d.messages:
            mark = " (draft)" if m["draft"] else ""
            print("  %-10s %s%s" % (m["due"] or "—", m["where"] or m["task"], mark))
            print("             %s" % m["text"][:88])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
