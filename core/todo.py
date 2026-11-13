#!/usr/bin/env python3
"""Reading todo.md, in Python.

The board's own reader is the JavaScript in kanban/index.html, and it stays the
authority on writing the file: only the board and the pa-* skills ever change a
task. This module is the read-only half of the same knowledge, for the things
that are not a browser tab — the desktop companion in companion/, the bucket
agents in agents/bucket-agent/, the PA's consistency checker, and anything else later
that needs to know what is due without opening the board.

It lives in core/ rather than beside the board because of that list. It sat in
kanban/ while the board was its only caller, which stopped being true the moment
the companion imported it, and by the time four things did, a module every one of
them depended on was filed inside one of them.

It is a port of the parsing in index.html rather than a second design: the same
two tag syntaxes, the same `repeat:` grammar, the same occurrence maths. Where
the two disagree the board is right and this file is the bug. Ported functions
carry the name they have over there — parse_doc, read_repeat, occurrence_from —
so the pair can be read side by side.

It parses, and serialises for one caller only. Writing todo.md back out is a
whole second problem — the board keeps every blank line, rule and stray note
verbatim so a save that changed nothing gives back the same bytes — and the one
thing outside the board that needs it is the server merging two saves
(merge_saves(), at the bottom). That serialiser is private to the merge and
held to the board's answers by core/fixtures/merge.json; every other reader
here still only reads.

It also owns the UK working calendar — which days are weekends and which are
bank holidays. That is not file format, so it sits here on sufferance rather than
by right; it is here because three things need the same answer (the board, the
companion and the PA's consistency checker) and a second list of holidays
is a second list to keep in step. Everything that needs it can reach this file,
either by importing it or by having the skill build step copy it in.

The one thing it deliberately does that the board does not: rolling a recurring
task forward happens in memory only. The board rewrites the date into the file
on load; this works out the same date and keeps it to itself, so a reader can
run every minute of a day the board is never opened without ever racing it.
"""

import calendar
import datetime as dt
import re

# ---- The file's grammar, straight across from index.html ---------------------

TASK_RE = re.compile(r"^-\s+\[([ xX])\]\s?(.*)$")
BUCKET_RE = re.compile(r"^##\s+(\d+)\.\s+(.*)$")
TIER_RE = re.compile(r"^###\s+(.*)$")

# Column headings that have been renamed, old name to new, the same table as
# TIER_RENAMED in core/todo.js. Waiting review and Waiting for review are now Reviewing; a backup still carrying either old
# heading reads as the new one.
TIER_RENAMED = {"Waiting review": "Reviewing", "Waiting for review": "Reviewing"}


# The heading a finished task lives under, the same name as DONE_HEADING in
# core/todo.js. A ticked task is read as sitting under it wherever the file has
# it, which is what the board does on load and writes on the next save.
DONE_HEADING = "Done"


def column_name(heading):
    """A column heading as the board names it, old names translated."""
    heading = heading.strip()
    return TIER_RENAMED.get(heading, heading)

# Both accepted syntaxes in one pass. impact, effort, due, ai, start, done and to
# are written as Dataview inline fields because views.md queries them and
# Dataview cannot see inside a code span; everything else stays a code span
# because a line carrying eight bracketed fields is unreadable. The older
# `due:2026-08-21` form is still read and always will be — the backups and the
# done archive are full of it.
ANY_TAG_RE = re.compile(r"\[([A-Za-z][\w-]*)::\s*([^\]]*)\]|`([A-Za-z][\w-]*):([^`]*)`")
SLUG_RE = re.compile(r"`#([a-z0-9][a-z0-9-]*)`", re.I)
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

INLINE_KEYS = {"impact", "effort", "due", "time", "start", "done", "to", "theme"}

# The two old agents a task can be handed to, spelt the way `[to::]` writes them.
# A bucket's agent is any other name ending in " agent" (agent_of). Anything else is a person. `ai:` is retired and is
# dropped on read, the same as the board does. See AGENT_NAMES in core/todo.js.
AGENT_NAMES = ("Plan agent", "Implement agent")
PLAN_AGENT, IMPLEMENT_AGENT = AGENT_NAMES


def agent_of(to):
    """The agent `to` names, or "" for a person or nobody. The two old agents
    are spelt canonically; a bucket's agent ("Personal family agent") is any
    other name ending in " agent", as written."""
    v = (to or "").strip()
    old = next((a for a in AGENT_NAMES if a.lower() == v.lower()), "")
    if old:
        return old
    return v if re.search(r"\S\s+agent$", v, re.I) else ""


class Task:
    """One top-level task, or one sub-step: the parser makes no distinction and
    the caller decides by indent. Only the fields a reader asks about are
    promoted to attributes; anything else stays in `extra` exactly as written."""

    __slots__ = ("done", "title", "bold", "impact", "effort", "due", "time", "start", "done_on",
                 "to", "theme", "urgent", "week", "doing", "slug", "blocked_by", "rank",
                 "tlrank", "headline", "chat", "repeat", "stable_id",
                 "cancelled", "archived", "created_by", "edited_by", "extra",
                 "body", "raw", "bucket", "column")

    def __init__(self):
        self.done = False
        self.title = ""
        # Whether the title was written in bold, which is how a task line is
        # written and a sub-task line usually is not. Only the merge reads it,
        # to write a line back the way it was.
        self.bold = False
        self.impact = self.effort = self.due = self.time = self.start = ""
        self.done_on = self.to = self.theme = ""
        self.urgent = self.week = self.doing = False
        self.slug = self.headline = self.chat = self.repeat = ""
        # The task's own identity, minted once and written on the line. See
        # `id` in core/todo.js, which is where it is generated.
        self.stable_id = ""
        # Why a ticked task was ticked, when the answer is "it wasn't done".
        # `cancelled` is decided against; `archived` is no longer relevant.
        # Both carry the date the decision was made, which is not necessarily
        # done_on. See CONVENTIONS.md, Cancelling a task — and every count of
        # finished work has to leave both out.
        self.cancelled = self.archived = ""
        # Who wrote the task and who last changed it, by sign-in email. Set by
        # stamp_authors() below on the shared board, and nowhere else.
        self.created_by = self.edited_by = ""
        self.blocked_by = []
        self.rank = None
        self.tlrank = None
        self.extra = []
        self.body = []
        self.raw = ""
        self.bucket = ""
        self.column = ""

    def __repr__(self):
        return "<Task %r %s %s>" % (self.title, self.column, self.due or "-")


def counts_as_finished(task):
    """Whether a ticked task counts as work that was done.

    A cancellation is a tick plus `cancelled:` or `archived:` (CONVENTIONS.md,
    Cancelling a task), so the box being ticked no longer means "finished" on
    its own, and every count of completed work has to ask this rather than
    asking `task.done`. Undated finished work is not counted either: `done:` is
    what puts it in a window. The port of countsAsFinished() in core/todo.js.
    """
    return bool(task.done and task.done_on and not task.cancelled and not task.archived)


def parse_task(raw_lines):
    m = TASK_RE.match(raw_lines[0])
    task = Task()
    task.done = m.group(1).lower() == "x"
    task.raw = raw_lines[0]
    task.body = list(raw_lines[1:])
    rest = m.group(2)

    def take(match):
        whole = match.group(0)
        if match.group(1) is not None:
            key, val = match.group(1), match.group(2)
        else:
            key, val = match.group(3), match.group(4)
        key = key.lower()
        val = val.strip()
        if key == "ai":
            return " "
        if key in INLINE_KEYS:
            setattr(task, "done_on" if key == "done" else key, val)
        elif key == "blocked-by":
            task.blocked_by = [s.strip() for s in val.split(",") if s.strip()]
        elif key == "rank":
            # parseInt in the board, so a leading integer is taken and whatever
            # follows it is ignored: `rank:3px` is rank 3 there, and has to be
            # rank 3 here. int() would refuse the whole thing and silently drop
            # a rank the board is honouring.
            lead = re.match(r"[+-]?\d+", val)
            if lead:
                task.rank = int(lead.group(0))
        elif key == "tlrank":
            # Same leading-integer handling as rank, above, for the same reason.
            lead = re.match(r"[+-]?\d+", val)
            if lead:
                task.tlrank = int(lead.group(0))
        elif key == "headline":
            task.headline = val
        elif key == "chat":
            task.chat = val.lower()
        elif key == "repeat":
            task.repeat = val.lower()
        elif key == "id":
            task.stable_id = val.lower()
        elif key == "cancelled":
            task.cancelled = val
        elif key == "archived":
            task.archived = val
        elif key == "created-by":
            task.created_by = val.lower()
        elif key == "edited-by":
            task.edited_by = val.lower()
        else:
            task.extra.append(whole)
            return " "
        return " "

    rest = ANY_TAG_RE.sub(take, rest)

    def take_slug(match):
        task.slug = match.group(1).lower()
        return " "

    rest = SLUG_RE.sub(take_slug, rest)
    if "`urgent`" in rest:
        task.urgent = True
        rest = rest.replace("`urgent`", " ")
    if "`week`" in rest:
        task.week = True
        rest = rest.replace("`week`", " ")
    # The only state a sub-task carries: an agent is working on it now. See
    # `doing` in readTags() in core/todo.js.
    if "`doing`" in rest:
        task.doing = True
        rest = rest.replace("`doing`", " ")
    title = re.sub(r"\s+", " ", rest).strip()
    # The board's guard is a regex needing four characters to match at all
    # (`^\*\*[\s\S]*\*\*$`), so `****` is an empty title there and `***` is
    # left as written. Four, not five.
    if len(title) >= 4 and title.startswith("**") and title.endswith("**"):
        title = title[2:-2].strip()
        task.bold = True
    task.title = title
    return task


def parse_doc(text):
    """Every top-level task in the file, tagged with the bucket and column it
    was found under. Sub-steps stay on their parent's `body`, unparsed, because
    no reader outside the board has needed one yet — and a step has no state of
    its own anyway, it inherits its parent's.

    A ticked task is in Done wherever the file has it, and comes out in the
    order the board gathers them: see gather_done().

    Anything above the first `## N. Name` heading, and the Context section
    below the last bucket, are skipped: they are prose, not work."""
    lines = re.sub(r"\r\n?", "\n", text).split("\n")
    tasks = []
    bucket = column = ""
    tiers = []          # [column, [tasks]] for the bucket being read, in file order
    i = 0
    in_buckets = False
    while i < len(lines):
        line = lines[i]
        bm = BUCKET_RE.match(line)
        if bm:
            gather_done(tiers, tasks)
            tiers = []
            bucket, column, in_buckets = bm.group(2).strip(), "", True
            i += 1
            continue
        # A `##` that is not a numbered bucket ends the buckets, and the board
        # stops reading there rather than waiting for the next one — everything
        # below goes into doc.post untouched. That is what Context is: notes
        # about people, some of it written as bullets that would otherwise
        # parse. A numbered bucket underneath it would be read by the board as
        # prose too, so it is read as prose here.
        #
        # `in_buckets` is load-bearing and was missing for a few hours on 5 Sep
        # 2026. Without it this breaks on `## How this works`, the first heading
        # in the file, and every Python reader of the list — the companion, the
        # agents, the checker — quietly saw an empty document. The board
        # was never affected: parseDoc skips everything before the first
        # numbered bucket into doc.pre, and this is the line that ports that.
        if in_buckets and line.startswith("## "):
            break
        tm = TIER_RE.match(line)
        if tm:
            column = column_name(tm.group(1))
            tiers.append([column, []])
            i += 1
            continue
        if in_buckets and TASK_RE.match(line):
            raw = [line]
            i += 1
            # The task owns every indented line under it, and any blank line
            # that still has indented content after it.
            while i < len(lines):
                l = lines[i]
                if l.strip() == "":
                    j = i
                    while j < len(lines) and lines[j].strip() == "":
                        j += 1
                    if j < len(lines) and re.match(r"^\s+\S", lines[j]):
                        raw.extend(lines[i:j])
                        i = j
                        continue
                    break
                if re.match(r"^\s+\S", l):
                    raw.append(l)
                    i += 1
                    continue
                break
            task = parse_task(raw)
            task.bucket, task.column = bucket, column
            if not tiers:
                tiers.append([column, []])
            tiers[-1][1].append(task)
            continue
        i += 1
    gather_done(tiers, tasks)
    return tasks


def gather_done(tiers, out):
    """Appends one bucket's tasks to `out`, ticked ones gathered under Done.

    The same rule as gatherDone() in core/todo.js, in the order the board ends
    up with: each heading's own open tasks, and every ticked one appended to
    Done after what it already held. A bucket with no Done heading gets one,
    first, but only if something ticked needs it. A task in Done that is not
    ticked stays put."""
    stray, kept = [], []
    for name, ts in tiers:
        if name == DONE_HEADING:
            kept.append([name, list(ts)])
            continue
        stray.extend(t for t in ts if t.done)
        kept.append([name, [t for t in ts if not t.done]])
    if stray:
        target = next((k for k in kept if k[0] == DONE_HEADING), None)
        if target is None:
            target = [DONE_HEADING, []]
            kept.insert(0, target)
        for t in stray:
            t.column = DONE_HEADING
        target[1].extend(stray)
    for _, ts in kept:
        out.extend(ts)


def parse_date(s):
    if not s or not DATE_RE.match(s.strip()):
        return None
    try:
        return dt.date.fromisoformat(s.strip())
    except ValueError:
        return None


# ---- Recurring tasks ---------------------------------------------------------
#
# The grammar, in full:
#
#     repeat:wed          every Wednesday
#     repeat:wed-9:15     every Wednesday at 9:15
#     repeat:15           the 15th of every month
#     repeat:wd5          the fifth working day of every month
#     repeat:tue2         the 2nd Tuesday of every month
#     repeat:~thu-14:00   roughly weekly on Thursday, but the day moves
#     repeat:wed/2        every other Wednesday
#     repeat:15/3         the 15th, quarterly
#     repeat:tue2/3       the 2nd Tuesday, quarterly
#
# `[due:: ]` is the occurrence the card currently points at, and the tag says
# how often. Neither is derivable from the other, which is why both are written.
#
# The `/n` suffix multiplies whatever base comes before it, and the phase it
# counts from is the card's own date — which is why it applies in
# occurrence_after and nowhere else.

REPEAT_VAL = re.compile(
    r"^(~?)(?:([a-z]{3})([1-5])?(?:[-\s]+(\d{1,2}:\d{2}))?|wd(\d{1,2})|(\d{1,2}))"
    r"(?:/(\d{1,2}))?$", re.I)
REPEAT_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
# Two years either way. Past that a cycle is an anniversary, and a date typed
# once is clearer than a rule nobody remembers the phase of.
MAX_EVERY = 24


def ordinal(n):
    suffix = ["th", "st", "nd", "rd"]
    v = n % 100
    if 11 <= v <= 13:
        return "%dth" % n
    return "%d%s" % (n, suffix[v % 10] if v % 10 < 4 else "th")


def every_label(n, unit):
    """How the `/n` suffix is said out loud. Empty at n == 1, where the base
    form's own wording already covers it."""
    if n == 1:
        return ""
    if unit == "week":
        return "fortnightly" if n == 2 else "every %d weeks" % n
    if n == 3:
        return "quarterly"
    if n == 6:
        return "twice a year"
    return "every %d months" % n


def read_repeat(val):
    """The tag as a dict, or None when it is not a cycle this understands. The
    board draws its `label` on the card, so the wording here matches it."""
    m = REPEAT_VAL.match(str(val or "").strip())
    if not m:
        return None
    loose = m.group(1) == "~"
    every = int(m.group(7)) if m.group(7) else 1
    if every < 1 or every > MAX_EVERY:
        return None
    monthly_cyc = every_label(every, "month") or "monthly"
    if m.group(5):
        nth = int(m.group(5))
        if nth < 1 or nth > 23:        # 23 working days is a long month
            return None
        return {"kind": "workday", "nth": nth, "time": "", "loose": loose, "every": every,
                "label": "%s, %s working day" % (monthly_cyc, ordinal(nth))}
    if m.group(6):
        dom = int(m.group(6))
        if dom < 1 or dom > 31:
            return None
        return {"kind": "monthly", "dom": dom, "time": "", "loose": loose, "every": every,
                "label": "%s, %s" % (monthly_cyc, ordinal(dom))}
    try:
        dow = REPEAT_DAYS.index(m.group(2).lower())
    except ValueError:
        return None
    time = m.group(4) or ""
    if m.group(3):
        nth = int(m.group(3))
        return {"kind": "monthly-dow", "dow": dow, "nth": nth, "time": time,
                "loose": loose, "every": every,
                "label": "%s, %s %s%s" % (monthly_cyc, ordinal(nth), DAY_NAMES[dow],
                                          (" " + time) if time else "")}
    head = (("weekly, usually " if loose else "every ") if every == 1
            else every_label(every, "week") + ", " + ("usually " if loose else ""))
    return {"kind": "weekly", "dow": dow, "time": time, "loose": loose, "every": every,
            "label": head + DAY_NAMES[dow] + ((" " + time) if time else "")}


def dow_of(date):
    """Sunday-first, the way the tag counts days — Python's weekday() is
    Monday-first and the grammar came from JavaScript. Public because anything
    comparing a real date against a rep["dow"] has to count the same way, and
    getting that wrong is a bug that only shows up on one day of the week."""
    return (date.weekday() + 1) % 7


_dow = dow_of                     # the name the rest of this file was written with


def _nth_day_matching(y, mo, nth, test):
    """The nth day in a month passing `test`, or the last match when the month
    is too short to have an nth. A date somebody meant to hit is better clamped
    than skipped."""
    last = calendar.monthrange(y, mo)[1]
    seen, fallback = 0, 1
    for day in range(1, last + 1):
        if not test(_dow(dt.date(y, mo, day))):
            continue
        fallback = day
        seen += 1
        if seen == nth:
            return dt.date(y, mo, day)
    return dt.date(y, mo, fallback)


def nth_workday(y, mo, nth):
    return _nth_day_matching(y, mo, nth, lambda wd: wd not in (0, 6))


def nth_weekday(y, mo, dow, nth):
    return _nth_day_matching(y, mo, nth, lambda wd: wd == dow)


def occurrence_from(rep, frm):
    """The first occurrence on or after `frm`. On the morning of the meeting
    that is still today, which is right: the agenda is wanted before it starts,
    so the day of it is not yet the next one."""
    if rep["kind"] == "weekly":
        return frm + dt.timedelta(days=(rep["dow"] - _dow(frm)) % 7)
    y, mo = frm.year, frm.month
    nxt = (y + 1, 1) if mo == 12 else (y, mo + 1)
    if rep["kind"] == "workday":
        hit = nth_workday(y, mo, rep["nth"])
        return hit if hit >= frm else nth_workday(nxt[0], nxt[1], rep["nth"])
    if rep["kind"] == "monthly-dow":
        hit = nth_weekday(y, mo, rep["dow"], rep["nth"])
        return hit if hit >= frm else nth_weekday(nxt[0], nxt[1], rep["dow"], rep["nth"])
    # A monthly day a short month does not have lands on that month's last day
    # rather than skipping the month. The 31st in February is a date the owner still
    # means to hit, and skipping is the one answer that is certainly wrong.
    if frm.day > min(rep["dom"], calendar.monthrange(y, mo)[1]):
        y, mo = nxt
    return dt.date(y, mo, min(rep["dom"], calendar.monthrange(y, mo)[1]))


def _add_months(y, mo, n):
    """(year, month) n months on, months being 1-12."""
    i = (y * 12 + mo - 1) + n
    return i // 12, i % 12 + 1


def occurrence_after(rep, date):
    """The occurrence strictly after this one, which is what rolling needs.

    Where an interval applies, and the only place it does. occurrence_from
    answers "the next Wednesday", which needs no phase; this answers "the next
    one of mine", which is entirely phase, counted from the date handed in. The
    roll always hands in the card's current date, so moving that date by hand
    moves the whole series with it."""
    n = rep.get("every", 1)
    if n == 1:
        return occurrence_from(rep, date + dt.timedelta(days=1))
    if rep["kind"] == "weekly":
        nxt = date + dt.timedelta(days=7 * n)
        # Zero unless the date was moved onto another weekday by hand, in which
        # case this snaps back onto the tagged day rather than drifting on it.
        return nxt + dt.timedelta(days=(rep["dow"] - _dow(nxt)) % 7)
    y, mo = _add_months(date.year, date.month, n)
    if rep["kind"] == "workday":
        return nth_workday(y, mo, rep["nth"])
    if rep["kind"] == "monthly-dow":
        return nth_weekday(y, mo, rep["dow"], rep["nth"])
    return dt.date(y, mo, min(rep["dom"], calendar.monthrange(y, mo)[1]))


# ---------------------------------------------------------------------------
# Tier one: impact against effort
#
# The port of the same three names in core/todo.js. agents/bucket-agent/bucket_work.py needs the same
# answer to order its queue, and a second copy of "high is 3" would be the drift
# this pair of files exists to stop.
# ---------------------------------------------------------------------------

IMPACT_N = {"high": 3, "med": 2, "low": 1}
EFFORT_N = {"S": 1, "M": 2, "L": 3}


def unscored(task):
    """Whether either score is missing, in which case the task has no position."""
    return not IMPACT_N.get(task.impact) or not EFFORT_N.get(task.effort)


def priority_score(task):
    """Higher comes first. -1 for anything unscored, which sinks it below
    everything that is scored rather than sorting it as a zero.

    Impact divided by effort rather than minus: a high/S beats a high/L, and a
    med/S beats a high/L too, which is the whole point of favouring lighter
    lifts."""
    if unscored(task):
        return -1.0
    return IMPACT_N[task.impact] / float(EFFORT_N[task.effort])


def effective_due(task, today):
    """The date this task is really pointing at, with any recurrence rolled
    forward in memory — the same answer the board writes into the file when it
    loads, worked out without touching it.

    A recurring task with no date at all gets its next occurrence, which is what
    the board does too: the tag already says which day, so the date is derivable
    and flagging it would be busywork."""
    rep = read_repeat(task.repeat) if task.repeat else None
    due = parse_date(task.due)
    if not rep:
        return due
    if not due:
        return occurrence_from(rep, today)
    if due >= today:
        return due
    nxt = occurrence_after(rep, due)
    while nxt < today:
        nxt = occurrence_after(rep, nxt)
    return nxt


TIME_RE = re.compile(r"^(\d{1,2}):(\d{2})$")


def _hhmm(val):
    """`val` as zero-padded 24h HH:MM, or "" when it is not a time of day."""
    m = TIME_RE.match(str(val or "").strip())
    if not m or int(m.group(1)) > 23 or int(m.group(2)) > 59:
        return ""
    return "%02d:%s" % (int(m.group(1)), m.group(2))


def effective_time(task):
    """The time of day this task falls due at, as HH:MM, or "".

    The task's own `[time:: ]` wins, and only counts beside a due date, the way
    the board writes it. Failing that, the time inside a `repeat:` rule such as
    `repeat:wed-9:15` stands in. A sub-task is asked on its own and does not
    take its task's time."""
    own = _hhmm(task.time)
    if own and task.due:
        return own
    rep = read_repeat(task.repeat) if task.repeat else None
    return _hhmm(rep["time"]) if rep else ""


# ---- notes, and the suggested messages inside them --------------------------
#
# A suggested message lives as a note under the thing it serves, indented one
# level deeper than the step it belongs to so it is unambiguous which step that
# is. `(draft)` marks one the owner has to edit before sending — anything about
# a person's outcome, performance, pay or contract. It used to be free prose mid-sentence,
# which nothing could read reliably, so the bracket is the marker now and the
# prose after it is the explanation.
#
# Ported from MSG_NOTE, splitBody and quoted in kanban/index.html. The board is
# the authority; core/test_todo.py holds a frozen table of the board's own
# answers so the two cannot drift apart quietly.
MSG_NOTE = re.compile(r"^\s*-\s+Suggested message(\s*\(draft\))?\s*:", re.I)
PROMPT_NOTE = re.compile(r"^\s*-\s+Prompt\s*:", re.I)
SUB_RE = re.compile(r"^(\s*)-\s+\[([ xX])\]\s?(.*)$")


def quoted(line):
    """What a note actually says: between its first and last quote.

    Falls back to everything after the colon when there are not two quotes, so a
    message written without them still reads. Curly quotes count, because they
    are what arrives when a message has been through anything with autocorrect
    in it.
    """
    marks = [i for i, ch in enumerate(line) if ch in '"“”']
    if len(marks) >= 2:
        return line[marks[0] + 1:marks[-1]].strip()
    return line[line.index(":") + 1:].strip() if ":" in line else line.strip()


def split_body(task):
    """A task's own notes, and its sub-steps with the notes under each.

    The board's splitBody. A step's notes are the lines after it, up to the next
    step at the same indent or shallower — which is what makes a message
    unambiguous about which step it belongs to even when a parent carries both
    notes and steps.
    """
    notes, steps = [], []
    base = None
    into_steps = False
    for line in task.body:
        m = SUB_RE.match(line)
        if m and (base is None or len(m.group(1)) <= base):
            base = len(m.group(1))
            step = parse_task(["- [%s] %s" % (m.group(2), m.group(3))])
            step.bucket, step.column = task.bucket, task.column
            steps.append({"task": step, "done": step.done, "notes": []})
            into_steps = True
            continue
        # A line back at the step indent or shallower ends the run of notes
        # under the last step and hands the rest of the body back to the task,
        # taking the lines deeper than it along with it. Without that, an
        # `Agenda:` written below the steps became notes on the last step.
        if line.strip() and base is not None and lead_indent(line) <= base:
            into_steps = False
        (steps[-1]["notes"] if steps and into_steps else notes).append(line)
    return notes, steps


# What a sub-task takes from the task it sits under when it does not carry its
# own, the same list and the same order as INHERITED in core/todo.js. Bucket and
# project come with it too, from where the task is filed, and are the caller's to
# add. State (the tick, `doing`), the assignee, `seen`, `feedback` and
# `resolution` are never taken: a task handed to an agent does not hand its
# sub-tasks over too.
INHERITED = ("due", "impact", "urgent", "week")


def inherited_fields(parent, step):
    """The effective due, impact, urgent and week of a sub-task, and which of
    them came from the parent. `parent` and `step` are Tasks."""
    out, took = {}, []
    for key in INHERITED:
        own, theirs = getattr(step, key), getattr(parent, key)
        if own:
            out[key] = own
        else:
            out[key] = theirs
            if theirs:
                took.append(key)
    out["inherited"] = took
    return out


def lead_indent(line):
    return len(line) - len(line.lstrip())


def messages(task, live_only=True):
    """Every suggested message on this task, from the task and from its steps.

    `live_only` leaves out the ones there is nothing to do about: a message under
    a ticked step has been sent, and one under a ticked task went with it. That
    is the same reasoning the board's Quick wins applies, and the caller that
    wants everything — a checker, say — passes False.

    Each entry carries the text, whether it is a draft, and the step it belongs
    to, which is what a reader shows so the owner can tell two chases apart.
    """
    if live_only and task.done:
        return []
    notes, steps = split_body(task)
    out = []

    def take(lines, where, where_done):
        if live_only and where_done:
            return
        for line in lines:
            if MSG_NOTE.search(line):
                out.append({
                    "text": quoted(line),
                    "draft": "(draft)" in line.lower(),
                    "where": where,
                    "task": task.title,
                    "bucket": task.bucket,
                    "column": task.column,
                    "due": "",
                    "raw": line.strip(),
                })

    take(notes, "", False)
    for s in steps:
        take(s["notes"], s["task"].title, s["done"])
        for entry in out:
            if entry["where"] == s["task"].title and not entry["due"]:
                entry["due"] = s["task"].due or task.due
    for entry in out:
        if not entry["due"]:
            entry["due"] = task.due
    return out


# A block-shaped note rather than a line, the same as MSG_NOTE and PROMPT_NOTE
# above are lines: what the owner pastes into the shared meeting notes is a bullet
# list, so the note is a heading with the content indented beneath it. Ported
# from AGENDA_NOTE / PREV_AGENDA_NOTE in check_todo.py, which reads it off raw
# file lines for its own line-numbered findings; this reads it off task.body,
# which is the shape core/render.py's aggregation actually has in hand.
AGENDA_RE = re.compile(r"^(\s*)-\s+Agenda\s*:\s*$", re.I)
PREV_AGENDA_RE = re.compile(r"^(\s*)-\s+Previous agenda(?:\s*\([^)]*\))?\s*:\s*$", re.I)


def agenda_topics(task, previous=False):
    """This task's Agenda (or Previous agenda) block, as a list of
    {topic, context}. [] when there is no such block.

    Topics are every line one level deeper than the heading; a topic's own
    context is everything deeper again, joined with a space rather than kept
    as separate lines — a rendered agenda reads it as one line per topic.
    """
    heading_re = PREV_AGENDA_RE if previous else AGENDA_RE
    body = task.body
    start = head_indent = None
    for i, line in enumerate(body):
        m = heading_re.match(line)
        if m:
            start, head_indent = i, len(m.group(1))
            break
    if start is None:
        return []
    topics = []
    i = start + 1
    while i < len(body) and body[i].strip():
        indent = len(body[i]) - len(body[i].lstrip(" "))
        if indent <= head_indent:
            break
        topic_indent = indent
        topic = body[i].strip().lstrip("-").strip()
        i += 1
        context = []
        while i < len(body) and body[i].strip() and \
                len(body[i]) - len(body[i].lstrip(" ")) > topic_indent:
            context.append(body[i].strip().lstrip("-").strip())
            i += 1
        topics.append({"topic": topic, "context": " ".join(context)})
    return topics


def slug_states(tasks):
    """Every `#slug` in the file against whether the line carrying it is ticked.
    Steps are included as well as whole tasks, because several of the blockers
    on the list are steps — `blocked-by:` resolves against either."""
    out = {}
    for t in tasks:
        if t.slug:
            out[t.slug] = t.done
        for line in t.body:
            m = TASK_RE.match(line.strip())
            if not m:
                continue
            s = SLUG_RE.search(m.group(2))
            if s:
                out[s.group(1).lower()] = m.group(1).lower() == "x"
    return out


def is_blocked(task, slugs):
    """True when something this task names as a blocker is not ticked off, or
    does not exist at all. A slug that has gone missing counts as blocking: a
    dependency nobody can find is not one that has been satisfied."""
    return any(not slugs.get(s, False) for s in task.blocked_by)


# ---- The working calendar ----------------------------------------------------
#
# Two countries, because the work spans two: the owner takes Portuguese public holidays
# and the owner's team takes UK ones, and a date is awkward if either side is away.
# `REGIONS` is the union, and every function here takes a narrower set if a
# caller only cares about one of them.
#
# Worked out from the rules rather than typed in as a table. A table has to be
# extended a year at a time by somebody who remembers to, and the year it runs
# out is the year it silently starts calling every day a working day. These
# rules are stable — the last change to either country's set was Portugal
# restoring four holidays in 2016 — so a generated year is right for as long as
# that holds, and wrong loudly rather than quietly if it stops.
#
# What is not derivable goes in the EXTRA dicts below: one-off holidays granted
# by government (a coronation, a jubilee, a funeral) and municipal holidays,
# neither of which follows a rule. Both are empty today.
#
# This is not file format, so it sits in this module on sufferance. It is here
# because three things need the same answer — the companion staying quiet on a
# day off, the PA's checker flagging a deadline that lands on one, and the
# board's own idea of a working day — and the alternative is a second list to
# keep in step.

REGIONS = ("UK", "PT")

# What the rules cannot produce. A name adds a holiday on that date; None takes
# one away, which is what a year needs when the government moves a standing
# holiday rather than adding to them. Both happen every few years, so this is
# the maintenance surface: two lines per event, and nothing else changes.
#
# The five below are every England-and-Wales departure from the rules since the
# gov.uk feed begins in 2019, and they are here because they are what proves the
# override works, not because anything reads a date in the past.
UK_EXTRA = {
    "2020-05-04": None,                 # moved for the 75th anniversary of VE Day
    "2020-05-08": "Early May bank holiday (VE day)",
    "2022-05-30": None,                 # moved to sit beside the Platinum Jubilee
    "2022-06-02": "Spring bank holiday",
    "2022-06-03": "Platinum Jubilee bank holiday",
    "2022-09-19": "Bank Holiday for the State Funeral of Queen Elizabeth II",
    "2023-05-08": "Bank holiday for the coronation of King Charles III",
}
# Portugal's municipal holidays are one per council, and the Azores and Madeira
# have their own on top, so none is assumed here. Add the relevant one if it
# matters: Porto is 24 June, Lisbon 13 June.
PT_EXTRA = {}


def easter_sunday(year):
    """Gregorian Easter, the anonymous algorithm. Three of the UK's holidays and
    four of Portugal's are counted from it."""
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month, day = divmod(h + l - 7 * m + 114, 31)
    return dt.date(year, month, day + 1)


def _mondays(year, month):
    first = dt.date(year, month, 1)
    first += dt.timedelta(days=(7 - first.weekday()) % 7)
    out = []
    while first.month == month:
        out.append(first)
        first += dt.timedelta(days=7)
    return out


def _apply_extra(out, extra, year):
    """The overrides for one year. A None removes rather than adds, and removing
    something the rules never produced is not an error — it just means the rule
    has since changed to agree."""
    for iso, name in extra.items():
        date = dt.date.fromisoformat(iso)
        if date.year != year:
            continue
        if name is None:
            out.pop(date, None)
        else:
            out[date] = name


def _uk_holidays(year):
    """England and Wales.

    A holiday landing on a weekend is not lost, it moves to the next weekday
    that is not already one — which is why Christmas and Boxing Day can push
    each other along by two days, as they do in 2027."""
    easter = easter_sunday(year)
    out = {}
    taken = set()

    def fixed(date, name):
        moved = date
        while moved.weekday() >= 5 or moved in taken:
            moved += dt.timedelta(days=1)
        taken.add(moved)
        out[moved] = name + (" (substitute)" if moved != date else "")

    fixed(dt.date(year, 1, 1), "New Year's Day")
    # Not substituted: they are defined as days of the week already.
    for date, name in ((easter - dt.timedelta(days=2), "Good Friday"),
                       (easter + dt.timedelta(days=1), "Easter Monday"),
                       (_mondays(year, 5)[0], "Early May bank holiday"),
                       (_mondays(year, 5)[-1], "Spring bank holiday"),
                       (_mondays(year, 8)[-1], "Summer bank holiday")):
        taken.add(date)
        out[date] = name
    fixed(dt.date(year, 12, 25), "Christmas Day")
    fixed(dt.date(year, 12, 26), "Boxing Day")
    _apply_extra(out, UK_EXTRA, year)
    return out


def _pt_holidays(year):
    """Portugal, national only.

    No substitution: a holiday on a Saturday is simply lost, which is why 2027
    is a thin year — Liberdade, Trabalhador, Assunção and Natal all fall at a
    weekend.

    Carnaval is the one entry that is not statutory. It is a tolerância de
    ponto, granted by the government most years rather than owed, so its name
    says so — a deadline flagged for landing on it is worth a second look rather
    than an automatic move."""
    easter = easter_sunday(year)
    out = {
        dt.date(year, 1, 1): "Ano Novo",
        dt.date(year, 4, 25): "Dia da Liberdade",
        dt.date(year, 5, 1): "Dia do Trabalhador",
        # Shortened. The full name is "Dia de Portugal, de Camões e das
        # Comunidades Portuguesas", which no menu line can hold.
        dt.date(year, 6, 10): "Dia de Portugal",
        dt.date(year, 8, 15): "Assunção de Nossa Senhora",
        dt.date(year, 10, 5): "Implantação da República",
        dt.date(year, 11, 1): "Dia de Todos-os-Santos",
        dt.date(year, 12, 1): "Restauração da Independência",
        dt.date(year, 12, 8): "Imaculada Conceição",
        dt.date(year, 12, 25): "Natal",
        easter - dt.timedelta(days=47): "Carnaval (tolerância de ponto)",
        easter - dt.timedelta(days=2): "Sexta-feira Santa",
        easter: "Domingo de Páscoa",
        easter + dt.timedelta(days=60): "Corpo de Deus",
    }
    _apply_extra(out, PT_EXTRA, year)
    return out


_BUILDERS = {"UK": _uk_holidays, "PT": _pt_holidays}
_CACHE = {}

# Beyond the two built-in calendars a region key is "CC:REGION" (REGION may be
# empty), read from core/holidays.py: Nager.Date, cached under data/holidays/.
# The built-in tables stand in when that has nothing and the place is one they
# cover, England and Wales or Portugal.


def _place(key):
    cc, _, region = key.partition(":")
    return cc.upper(), region.upper()


def _fallback(cc, region):
    if cc == "PT":
        return "PT"
    if cc == "GB" and region in ("", "GB-ENG", "GB-WLS"):
        return "UK"
    return None


def _place_holidays(key, year):
    """{date: name} for one "CC:REGION" key, or None when it is not known yet
    (nothing cached, no network) so the answer is not remembered."""
    import holidays as nager  # sits beside this file
    cc, region = _place(key)
    got = nager.holidays(year, cc, region or None)
    if got is not None:
        return got
    builtin = _fallback(cc, region)
    if builtin:
        return _BUILDERS[builtin](year)
    nager.warn("no holidays for %s %d: offline and not cached" % (key.rstrip(":"), year))
    return None


def holidays(year, regions=REGIONS):
    """{region: {date: name}} for one year. Cached, because the companion asks
    once a minute and the answer for a given year never changes."""
    out = {}
    for region in regions:
        key = (region, year)
        if key not in _CACHE:
            if region in _BUILDERS:
                _CACHE[key] = _BUILDERS[region](year)
            else:
                got = _place_holidays(region, year)
                if got is None:
                    out.setdefault(region, {})
                    continue
                _CACHE[key] = got
        out.setdefault(region, _CACHE[key])
    return out


def holiday_names(date, regions=REGIONS):
    """[(region, name)] for every region this date is a holiday in — two entries
    on Christmas Day, which both countries keep."""
    return [(r, names[date]) for r, names in holidays(date.year, regions).items()
            if date in names]


def holiday_name(date, regions=REGIONS):
    """The name of the holiday this date falls on, or None. The first region's
    name where both have one, since the day is the same day either way."""
    hits = holiday_names(date, regions)
    return hits[0][1] if hits else None


WHOSE = {"UK": "a UK bank holiday", "PT": "a Portuguese public holiday"}
COUNTRY = {"UK": "the UK", "PT": "Portugal"}


def _whose(key):
    if key in WHOSE:
        return WHOSE[key]
    return "a public holiday in %s" % _country(key)


def _country(key):
    if key in COUNTRY:
        return COUNTRY[key]
    import holidays as nager
    return nager.country_name(_place(key)[0])


def non_working_reason(date, regions=REGIONS):
    """Why this is not a working day, phrased to drop into a sentence, or None.

    Reads as "Dia da Liberdade, a Portuguese public holiday" or "the 4th is a
    Saturday", which is what the checker's findings and the companion's menu
    both want to say. A weekend wins over a holiday that falls on one: on a
    Saturday the useful thing to say is that it is a Saturday."""
    if date.weekday() == 5:
        return "a Saturday"
    if date.weekday() == 6:
        return "a Sunday"
    hits = holiday_names(date, regions)
    if not hits:
        return None
    if len(hits) == 1:
        return "%s, %s" % (hits[0][1], _whose(hits[0][0]))
    return "%s, a public holiday in %s" % (
        hits[0][1], " and ".join(_country(h[0]) for h in hits))


def is_working_day(date, regions=REGIONS):
    return non_working_reason(date, regions) is None


# ---- Merging two saves -------------------------------------------------------
#
# The port of mergeSaves() in core/todo.js, which says what it is for: a save
# built on an old version of the list is merged with the file as it is now,
# task by task and field by field, rather than refused. The server is what
# calls this, so it can write the merged list without asking the tab first.
#
# Line for line the same as the board's, down to the order conflicts are found
# in, because core/fixtures/merge.json compares the whole answer. The board's
# document model is ported with it (_parse_tree, _serialize_tree): parse_doc()
# above reads tasks and drops everything else, and a merge has to give back
# every line it was not asked to change.

HR_RE = re.compile(r"^---\s*$")
# The board's SUB_RE, which wants a space after the box. SUB_RE above takes
# none, and a merge has to see sub-tasks exactly where the board does.
_STEP_RE = re.compile(r"^(\s*)-\s+\[([ xX])\]\s+(.*)$")
_INDENTED = re.compile(r"^\s+\S")
_HEADING2 = re.compile(r"^##\s")

MERGE_FIELDS = ("title", "bold", "done", "impact", "effort", "due", "time", "start", "doneOn", "to",
                "theme", "urgent", "week", "doing", "slug", "blockedBy", "rank", "tlrank",
                "headline", "chat", "repeat", "stableId", "cancelled", "archived", "createdBy",
                "editedBy", "extra")
_PY_NAME = {"doneOn": "done_on", "blockedBy": "blocked_by", "stableId": "stable_id",
            "createdBy": "created_by", "editedBy": "edited_by"}
_ABSENT = object()


def _parse_tree(text):
    """parseDoc() in core/todo.js: the whole document, every line kept."""
    lines = re.sub(r"\r\n?", "\n", text).split("\n")
    n = len(lines)
    doc = {"pre": [], "buckets": [], "post": []}
    i = 0
    while i < n and not BUCKET_RE.match(lines[i]):
        doc["pre"].append(lines[i])
        i += 1
    while i < n:
        bm = BUCKET_RE.match(lines[i])
        if not bm:
            break
        bucket = {"num": bm.group(1), "name": bm.group(2).strip(), "raw": lines[i],
                  "intro": [], "tiers": [], "tail": []}
        i += 1
        while i < n and not TIER_RE.match(lines[i]) and not _HEADING2.match(lines[i]):
            bucket["intro"].append(lines[i])
            i += 1
        while i < n and TIER_RE.match(lines[i]):
            heading = TIER_RE.match(lines[i]).group(1).strip()
            renamed = TIER_RENAMED.get(heading)
            tier = {"name": renamed or heading, "raw": None if renamed else lines[i],
                    "lead": None, "tasks": [], "tail": []}
            i += 1
            gap = []
            while i < n and not TIER_RE.match(lines[i]) and not _HEADING2.match(lines[i]):
                line = lines[i]
                if TASK_RE.match(line):
                    if tier["tasks"]:
                        tier["tasks"][-1]["sep"] = gap
                    else:
                        tier["lead"] = gap
                    gap = []
                    raw = [line]
                    i += 1
                    while i < n:
                        l = lines[i]
                        if l.strip() == "":
                            j = i
                            while j < n and lines[j].strip() == "":
                                j += 1
                            if j < n and _INDENTED.match(lines[j]):
                                raw.extend(lines[i:j])
                                i = j
                                continue
                            break
                        if _INDENTED.match(l):
                            raw.append(l)
                            i += 1
                            continue
                        break
                    tier["tasks"].append({"raw": raw[0], "body": raw[1:], "sep": None,
                                          "done": TASK_RE.match(raw[0]).group(1).lower() == "x"})
                else:
                    gap.append(line)
                    i += 1
            if tier["tasks"]:
                tier["tail"] = gap
            else:
                k = 0
                while k < len(gap) and gap[k].strip() == "":
                    k += 1
                tier["lead"] = gap[:k]
                tier["tail"] = gap[k:]
            bucket["tiers"].append(tier)
        if bucket["tiers"]:
            last = bucket["tiers"][-1]
            cut = len(last["tail"])
            while cut > 0 and (last["tail"][cut - 1].strip() == "" or HR_RE.match(last["tail"][cut - 1])):
                cut -= 1
            if cut < len(last["tail"]) and last["tail"][cut].strip() == "":
                cut += 1
            bucket["tail"] = last["tail"][cut:]
            last["tail"] = last["tail"][:cut]
        doc["buckets"].append(bucket)
    doc["post"] = lines[i:]
    _gather_tree(doc)
    return doc


def _gather_tree(doc):
    """gatherDone() in core/todo.js, on the whole document."""
    for b in doc["buckets"]:
        stray = []
        for tier in b["tiers"]:
            if tier["name"] == DONE_HEADING:
                continue
            keep = [t for t in tier["tasks"] if not t["done"]]
            if len(keep) == len(tier["tasks"]):
                continue
            stray.extend(t for t in tier["tasks"] if t["done"])
            tier["tasks"] = keep
            if not keep:
                tier["lead"] = tier["lead"] if tier["lead"] else [""]
                tier["tail"] = tier["tail"] if any(l.strip() != "" for l in tier["tail"]) else []
        if not stray:
            continue
        done = next((t for t in b["tiers"] if t["name"] == DONE_HEADING), None)
        if done is None:
            done = {"name": DONE_HEADING, "raw": None, "lead": [""], "tasks": [], "tail": [""]}
            b["tiers"].insert(0, done)
        done["tasks"].extend(stray)


def _serialize_tree(doc):
    """serializeDoc() in core/todo.js, for a document whose task lines are all
    written already (`raw`), which is every document a merge makes."""
    out = list(doc["pre"])
    for b in doc["buckets"]:
        out.append(b["raw"] if b["raw"] is not None else "## %s. %s" % (b["num"], b["name"]))
        out.extend(b["intro"])
        for tier in b["tiers"]:
            out.append(tier["raw"] if tier["raw"] is not None else "### " + tier["name"])
            out.extend(tier["lead"] if tier["lead"] is not None else [""])
            for idx, t in enumerate(tier["tasks"]):
                body = list(t["body"])
                while body and body[-1].strip() == "":
                    body.pop()
                out.append(t["raw"])
                out.extend(body)
                last = idx == len(tier["tasks"]) - 1
                if last:
                    out.extend(tier["tail"] if tier["tail"] is not None else [""])
                else:
                    out.extend(t["sep"] if t["sep"] is not None else [""])
            if not tier["tasks"]:
                out.extend(tier["tail"] if tier["tail"] is not None else [])
        out.extend(b["tail"] if b["tail"] is not None else [])
    out.extend(doc["post"])
    return "\n".join(out)


def _mg_key(title):
    return " ".join((title or "").split()).lower()


def _mg_fields(line):
    """A task or sub-task line as fields, named the way the board names them."""
    task = parse_task([line.lstrip()])
    return {f: getattr(task, _PY_NAME.get(f, f)) for f in MERGE_FIELDS}


def _mg_line(f, indent):
    """serializeTask() in core/todo.js, for a line it rewrites."""
    tags = []
    if f["slug"]:
        tags.append("`#" + f["slug"] + "`")
    if f["impact"]:
        tags.append("[impact:: " + f["impact"] + "]")
    if f["effort"]:
        tags.append("[effort:: " + f["effort"] + "]")
    if f["start"]:
        tags.append("`start:" + f["start"] + "`")
    if f["due"]:
        tags.append("[due:: " + f["due"] + "]")
    if f["due"] and f["time"]:
        tags.append("[time:: " + f["time"] + "]")
    if f["done"] and f["doneOn"]:
        tags.append("`done:" + f["doneOn"] + "`")
    if f["cancelled"]:
        tags.append("`cancelled:" + f["cancelled"] + "`")
    if f["archived"]:
        tags.append("`archived:" + f["archived"] + "`")
    if f["urgent"]:
        tags.append("`urgent`")
    if f["week"]:
        tags.append("`week`")
    if f["doing"]:
        tags.append("`doing`")
    if f["to"] and f["to"].strip():
        tags.append("[to:: " + f["to"].strip() + "]")
    if f["theme"] and f["theme"].strip():
        tags.append("[theme:: " + f["theme"].strip() + "]")
    if f["blockedBy"]:
        tags.append("`blocked-by:" + ",".join(f["blockedBy"]) + "`")
    if f["rank"] is not None:
        tags.append("`rank:%d`" % f["rank"])
    if f["tlrank"] is not None:
        tags.append("`tlrank:%d`" % f["tlrank"])
    if f["headline"]:
        tags.append("`headline:" + f["headline"] + "`")
    if f["chat"]:
        tags.append("`chat:" + f["chat"] + "`")
    if f["repeat"]:
        tags.append("`repeat:" + f["repeat"] + "`")
    if f["createdBy"]:
        tags.append("`created-by:" + f["createdBy"] + "`")
    if f["editedBy"]:
        tags.append("`edited-by:" + f["editedBy"] + "`")
    if f["stableId"]:
        tags.append("`id:" + f["stableId"] + "`")
    tags.extend(f["extra"])
    name = f["title"] if f["bold"] is False else "**" + f["title"] + "**"
    return indent + "- " + ("[x]" if f["done"] else "[ ]") + " " + " ".join([name] + tags)


def _mg_body(body):
    """mgBody() in core/todo.js: notes before and after the first step, and
    each step with the lines under it."""
    head, tail, steps = [], [], []
    base = None
    into = False
    for at, line in enumerate(body):
        m = _STEP_RE.match(line)
        if m and (base is None or len(m.group(1)) <= base):
            base = len(m.group(1))
            f = _mg_fields(line)
            steps.append({"fields": f, "head": line, "at": at, "indent": m.group(1), "more": [],
                          "id": f["stableId"], "key": _mg_key(f["title"])})
            into = True
            continue
        if line.strip() and base is not None and lead_indent(line) <= base:
            into = False
        if into:
            steps[-1]["more"].append(line)
        else:
            (tail if steps else head).append(line)
    for s in steps:
        s["notes"] = [l for l in s["more"] if l.strip()]
    return {"head": head, "tail": tail, "steps": steps,
            "notes": [l for l in head + tail if l.strip()]}


def _mg_side(text):
    doc = _parse_tree(text)
    buckets = []
    for b in doc["buckets"]:
        rec = {"name": b["name"], "num": b["num"],
               "header": b["raw"] if b["raw"] is not None else "## %s. %s" % (b["num"], b["name"]),
               "intro": b["intro"], "tail": b["tail"], "tiers": []}
        for tier in b["tiers"]:
            trec = {"name": tier["name"],
                    "header": tier["raw"] if tier["raw"] is not None else "### " + tier["name"],
                    "lead": tier["lead"] if tier["lead"] is not None else [""],
                    "tail": tier["tail"] or [], "tasks": []}
            for t in tier["tasks"]:
                f = _mg_fields(t["raw"])
                trec["tasks"].append({"fields": f, "head": t["raw"], "body": t["body"], "sep": t["sep"],
                                      "parts": _mg_body(t["body"]), "id": f["stableId"],
                                      "key": _mg_key(f["title"]), "tier": tier["name"], "bucket": rec,
                                      "node": t})
            rec["tiers"].append(trec)
        buckets.append(rec)
    return {"pre": doc["pre"], "post": doc["post"], "buckets": buckets, "doc": doc}


def _mg_match_tasks(base, side):
    out, used, by_id = [-1] * len(side), set(), {}
    for i, r in enumerate(base):
        if r["id"] and r["id"] not in by_id:
            by_id[r["id"]] = i
    for j, r in enumerate(side):
        i = by_id[r["id"]] if r["id"] and r["id"] in by_id else -1
        if i >= 0 and i not in used:
            out[j] = i
            used.add(i)
    for j, r in enumerate(side):
        if out[j] >= 0:
            continue
        i = next((k for k, b in enumerate(base)
                  if k not in used and b["key"] == r["key"] and (not b["id"] or not r["id"])), -1)
        if i >= 0:
            out[j] = i
            used.add(i)
    return out


def _mg_match_by(fields):
    def match(base, side):
        out, used = [-1] * len(side), set()
        for by in fields:
            for j, r in enumerate(side):
                if out[j] >= 0:
                    continue
                i = next((k for k, b in enumerate(base) if k not in used and b[by] == r[by]), -1)
                if i >= 0:
                    out[j] = i
                    used.add(i)
        return out
    return match


_mg_match_buckets = _mg_match_by(("name", "num"))
_mg_match_tiers = _mg_match_by(("name",))


def _mg_groups(B, M, T, match, pair):
    groups = [{"b": b, "m": None, "t": None} for b in B]
    mi, ti, added = match(B, M), match(B, T), []
    for j, r in enumerate(M):
        if mi[j] >= 0:
            groups[mi[j]]["m"] = r
        else:
            g = {"b": None, "m": r, "t": None}
            groups.append(g)
            added.append(g)
    for j, r in enumerate(T):
        if ti[j] >= 0:
            groups[ti[j]]["t"] = r
            continue
        g = next((a for a in added if not a["t"] and pair(a["m"], r)), None)
        if g:
            g["t"] = r
        else:
            groups.append({"b": None, "m": None, "t": r})
    for i, g in enumerate(groups):
        g["gid"] = i
        for r in (g["b"], g["m"], g["t"]):
            if r:
                r["g"] = g
    return groups


def _mg_pick(b, m, t, clash):
    if m == t:
        return m
    if b is not _ABSENT and m == b:
        return t
    if b is not _ABSENT and t == b:
        return m
    return clash(m, t)


def _mg_keep(g, sig, clash):
    if g["m"] and g["t"]:
        return "both"
    if not g["m"] and not g["t"]:
        return None
    kept = "mine" if g["m"] else "theirs"
    if not g["b"]:
        return kept
    if sig(g["m"] or g["t"]) == sig(g["b"]):
        return None
    return clash("deleted", "mine" if g["m"] else None, "theirs" if g["t"] else None) or None


def _mg_order(primary, secondary, keep):
    want = set(keep)
    out = [k for k in primary if k in want]
    placed = set(out)
    prev = None
    for k in secondary:
        if k not in want:
            continue
        if k not in placed:
            out.insert(0 if prev is None else out.index(prev) + 1, k)
            placed.add(k)
        prev = k
    for k in keep:
        if k not in placed:
            out.append(k)
            placed.add(k)
    return out


# Who wrote and last changed a task are the server's to say (stamp_authors()),
# so a merge takes them from the file and never counts them as an edit.
MERGE_AUTHORS = ("createdBy", "editedBy")


def _mg_plain(f):
    return {k: v for k, v in f.items() if k not in MERGE_AUTHORS}


def _mg_merge_fields(g, clash):
    out = {}
    for f in MERGE_FIELDS:
        b = g["b"]["fields"][f] if g["b"] else _ABSENT
        m, t = g["m"]["fields"][f], g["t"]["fields"][f]
        if f == "stableId" and (b is _ABSENT or not b) and m and t:
            out[f] = t
            continue
        if f in MERGE_AUTHORS:
            out[f] = t
            continue
        out[f] = _mg_pick(b, m, t, lambda mv, tv, f=f: clash(f, mv, tv))
    return out


def _mg_head(f, g, indent):
    if g["t"] and f == g["t"]["fields"]:
        return g["t"]["head"]
    if g["m"] and f == g["m"]["fields"]:
        return g["m"]["head"]
    return _mg_line(f, indent)


def _mg_step_sig(s):
    return {"fields": _mg_plain(s["fields"]), "notes": s["notes"]}


def _mg_task_sig(r):
    return {"fields": _mg_plain(r["fields"]), "where": r["where"], "notes": r["parts"]["notes"],
            "steps": [_mg_step_sig(s) for s in r["parts"]["steps"]]}


def _mg_merge_steps(g, clash):
    groups = _mg_groups(g["b"]["parts"]["steps"] if g["b"] else [], g["m"]["parts"]["steps"],
                        g["t"]["parts"]["steps"], _mg_match_tasks,
                        lambda a, b: bool(a["id"]) and a["id"] == b["id"])
    merged = {}
    for sg in groups:
        title = (sg["m"] or sg["t"] or sg["b"])["fields"]["title"]
        keep = _mg_keep(sg, _mg_step_sig, lambda field, mv, tv, title=title: clash(title, field, mv, tv))
        if not keep:
            continue
        if keep != "both":
            r = sg["m"] if keep == "mine" else sg["t"]
            merged[sg["gid"]] = {"fields": r["fields"], "notes": r["notes"], "lines": [r["head"]] + r["more"]}
            continue
        fields = _mg_merge_fields(sg, lambda f, mv, tv, title=title: clash(title, f, mv, tv))
        notes = _mg_pick(sg["b"]["notes"] if sg["b"] else _ABSENT, sg["m"]["notes"], sg["t"]["notes"],
                         lambda mv, tv, title=title: clash(title, "notes", mv, tv))
        frm = sg["t"] if notes == sg["t"]["notes"] else sg["m"]
        merged[sg["gid"]] = {"fields": fields, "notes": notes,
                             "lines": [_mg_head(fields, sg, sg["t"]["indent"])] + frm["more"]}
    order = _mg_order([s["g"]["gid"] for s in g["t"]["parts"]["steps"]],
                      [s["g"]["gid"] for s in g["m"]["parts"]["steps"]], list(merged.keys()))
    return [merged[k] for k in order]


def merge_saves(base_text, mine_text, theirs_text, prefer=""):
    """Three versions of the list into one: the version a save was built on,
    the save, and the file as it is now. mergeSaves() in core/todo.js, which
    is the authority.

    Returns {"text", "conflicts"}. `prefer` ("mine" or "theirs") answers every
    conflict; without it a merge with conflicts has text None, and each
    conflict is {"task", "step", "field"}, step "" for the task itself and task
    "" for the top or bottom of the file."""
    if mine_text == theirs_text or theirs_text == base_text:
        return {"text": mine_text, "conflicts": []}
    if mine_text == base_text:
        return {"text": theirs_text, "conflicts": []}
    B, M, T = _mg_side(base_text), _mg_side(mine_text), _mg_side(theirs_text)
    conflicts = []

    def clash(task, step, field):
        def answer(mv, tv):
            conflicts.append({"task": task, "step": step, "field": field})
            return tv if prefer == "theirs" else mv
        return answer

    pre = _mg_pick(B["pre"], M["pre"], T["pre"], clash("", "", "top of the file"))
    post = _mg_pick(B["post"], M["post"], T["post"], clash("", "", "bottom of the file"))

    bgroups = _mg_groups(B["buckets"], M["buckets"], T["buckets"], _mg_match_buckets,
                         lambda a, b: a["name"] == b["name"])

    def tasks_of(side):
        return [r for b in side["buckets"] for tier in b["tiers"] for r in tier["tasks"]]

    for side in (B, M, T):
        for r in tasks_of(side):
            r["where"] = "%d\n%s" % (r["bucket"]["g"]["gid"], r["tier"])

    tgroups = _mg_groups(tasks_of(B), tasks_of(M), tasks_of(T), _mg_match_tasks,
                         lambda a, b: bool(a["id"]) and a["id"] == b["id"])
    placed = {}
    for g in tgroups:
        title = (g["m"] or g["t"] or g["b"])["fields"]["title"]

        def on_task(field, mv, tv, title=title):
            return clash(title, "", field)(mv, tv)

        keep = _mg_keep(g, _mg_task_sig, on_task)
        if not keep:
            continue
        if keep != "both":
            r = g["m"] if keep == "mine" else g["t"]
            placed[g["gid"]] = {"where": r["where"], "head": r["head"], "body": r["body"], "sep": r["sep"]}
            continue
        fields = _mg_merge_fields(g, on_task)
        where = _mg_pick(g["b"]["where"] if g["b"] else _ABSENT, g["m"]["where"], g["t"]["where"],
                         lambda mv, tv: on_task("column", mv, tv))
        notes = _mg_pick(g["b"]["parts"]["notes"] if g["b"] else _ABSENT, g["m"]["parts"]["notes"],
                         g["t"]["parts"]["notes"], lambda mv, tv: on_task("notes", mv, tv))
        steps = _mg_merge_steps(g, lambda st, field, mv, tv, title=title: clash(title, st, field)(mv, tv))
        sig = {"notes": notes, "steps": [_mg_step_sig(s) for s in steps]}

        def sig_of(r):
            return {"notes": r["parts"]["notes"], "steps": [_mg_step_sig(s) for s in r["parts"]["steps"]]}

        if sig == sig_of(g["t"]):
            body = g["t"]["body"]
        elif sig == sig_of(g["m"]):
            body = g["m"]["body"]
        else:
            frm = g["t"] if notes == g["t"]["parts"]["notes"] else g["m"]
            body = frm["parts"]["head"] + [l for s in steps for l in s["lines"]] + frm["parts"]["tail"]
        placed[g["gid"]] = {"where": where, "head": _mg_head(fields, g, ""), "body": body,
                            "sep": (g["t"] or g["m"])["sep"]}

    used = set(p["where"] for p in placed.values())

    def holds(bgid, name=None):
        if name is None:
            return any(w.split("\n")[0] == str(bgid) for w in used)
        return "%d\n%s" % (bgid, name) in used

    kept_buckets = [g for g in bgroups
                    if (g["m"] and g["t"]) or (not g["b"] and (g["m"] or g["t"]))
                    or ((g["m"] or g["t"]) and holds(g["gid"]))]
    border = _mg_order([b["g"]["gid"] for b in T["buckets"]], [b["g"]["gid"] for b in M["buckets"]],
                       [g["gid"] for g in kept_buckets])
    buckets = []
    for gid in border:
        g = bgroups[gid]
        src = g["t"] or g["m"]
        both = g["m"] and g["t"]
        header = _mg_pick(g["b"]["header"] if g["b"] else _ABSENT, g["m"]["header"], g["t"]["header"],
                          clash(src["name"], "", "bucket name")) if both else src["header"]
        intro = _mg_pick(g["b"]["intro"] if g["b"] else _ABSENT, g["m"]["intro"], g["t"]["intro"],
                         clash(src["name"], "", "bucket notes")) if both else src["intro"]
        tgr = _mg_groups(g["b"]["tiers"] if g["b"] else [], g["m"]["tiers"] if g["m"] else [],
                         g["t"]["tiers"] if g["t"] else [], _mg_match_tiers,
                         lambda a, b: a["name"] == b["name"])
        kept_tiers = [x for x in tgr
                      if (x["m"] and x["t"]) or (not x["b"] and (x["m"] or x["t"]))
                      or ((x["m"] or x["t"]) and holds(gid, (x["m"] or x["t"])["name"]))]
        torder = _mg_order([x["g"]["gid"] for x in g["t"]["tiers"]] if g["t"] else [],
                           [x["g"]["gid"] for x in g["m"]["tiers"]] if g["m"] else [],
                           [x["gid"] for x in kept_tiers])
        tiers = []
        for tgid in torder:
            x = tgr[tgid]
            tsrc = x["t"] or x["m"]
            here = "%d\n%s" % (gid, tsrc["name"])
            keys = [tg["gid"] for tg in tgroups if tg["gid"] in placed and placed[tg["gid"]]["where"] == here]
            order = _mg_order([r["g"]["gid"] for r in x["t"]["tasks"]] if x["t"] else [],
                              [r["g"]["gid"] for r in x["m"]["tasks"]] if x["m"] else [], keys)
            lead, tail = tsrc["lead"], tsrc["tail"]
            if order and not tsrc["tasks"] and not tail:
                tail = [""]
            if not order and tsrc["tasks"]:
                lead = lead if lead else [""]
                tail = tail if any(l.strip() != "" for l in tail) else []
            tiers.append({"name": tsrc["name"], "raw": tsrc["header"], "lead": lead, "tail": tail,
                          "tasks": [{"raw": placed[k]["head"], "body": placed[k]["body"],
                                     "sep": placed[k]["sep"]} for k in order]})
        buckets.append({"raw": header, "intro": intro, "tiers": tiers, "tail": src["tail"]})

    text = _serialize_tree({"pre": pre, "buckets": buckets, "post": post})
    return {"text": None if conflicts and not prefer else text, "conflicts": conflicts}


# ---- Who wrote a task, and who last changed it ---------------------------------
#
# On a shared board every task and sub-task carries `created-by:` and
# `edited-by:`, the email of whoever signed in. The server sets both on every
# save by comparing what it is about to write with what the file holds, and a
# tab has no say: what it sends for either is put back to what the file says.
# Here rather than in the server because it is the merge's own matching (by id,
# then by title) asked a simpler question. The board only reads the two tags.

_AUTHOR_TAG = re.compile(r"\s*(?:\[(?:created-by|edited-by)::[^\]]*\]|`(?:created-by|edited-by):[^`]*`)", re.I)
_ID_TAG = re.compile(r"\s(?:`id:[^`]*`|\[id::[^\]]*\])", re.I)


def _with_authors(line, created, edited):
    """`line` carrying exactly these two tags, in front of its id the way
    serializeTask() in core/todo.js writes them, and otherwise unchanged."""
    bare = _AUTHOR_TAG.sub("", line)
    tags = " ".join(t for t in ("`created-by:%s`" % created if created else "",
                                "`edited-by:%s`" % edited if edited else "") if t)
    if not tags:
        return bare
    m = _ID_TAG.search(bare)
    if m:
        return bare[:m.start()] + " " + tags + bare[m.start():]
    return bare.rstrip() + " " + tags


def _changed_fields(b, t):
    """What changed on a task between two versions, by the names the merge uses.
    Not its id: a tab gives every task without one an id as it loads, which is
    the board tidying up rather than anybody editing."""
    out = [f for f in MERGE_FIELDS if f not in MERGE_AUTHORS and f != "stableId"
           and b["fields"][f] != t["fields"][f]]
    if b["where"] != t["where"]:
        out.append("column")
    if b["parts"]["notes"] != t["parts"]["notes"]:
        out.append("notes")
    if [_mg_plain_step(s) for s in b["parts"]["steps"]] != [_mg_plain_step(s) for s in t["parts"]["steps"]]:
        out.append("sub-tasks")
    return out


def _mg_plain_step(s):
    f = _mg_plain(s["fields"])
    f.pop("stableId", None)
    return {"fields": f, "notes": s["notes"]}


TO_TAG_RE = re.compile(r"\[to::\s*([^\]]*)\]", re.I)


def resolve_assignees(old_text, new_text, people_for):
    """`new_text` with a bare name in `[to:: ]` swapped for the one person it
    means, on a signed-in board where an assignee is an email.

    Only task and sub-task lines `new_text` adds or changes against
    `old_text`, the file it is about to replace, so a line nobody touched
    keeps what it says. An email, an agent's name (AGENT_NAMES) or an empty
    tag is left alone. `people_for(name)` answers the emails the name can
    mean (board_access.people_named()).

    Returns (text, problems): problems is one entry per name that matched
    nobody or more than one person, {"line", "text", "name", "candidates"},
    the line counted from 1 in `new_text`. With any problem the caller
    refuses the save, so text is only worth writing when problems is empty."""
    before = set((old_text or "").split("\n"))
    lines = new_text.split("\n")
    problems = []
    for i, line in enumerate(lines):
        if line in before or not SUB_RE.match(line):
            continue

        def swap(m, i=i, line=line):
            name = m.group(1).strip()
            if not name or "@" in name or agent_of(name):
                return m.group(0)
            found = people_for(name)
            if len(found) == 1:
                return "[to:: %s]" % found[0]
            problems.append({"line": i + 1, "text": line.strip(), "name": name, "candidates": found})
            return m.group(0)

        lines[i] = TO_TAG_RE.sub(swap, line)
    return "\n".join(lines), problems


def stamp_authors(old_text, new_text, who, credits=None, write_tags=None):
    """`new_text` with who wrote and who last changed each task and sub-task,
    measured against `old_text`, the file it is about to replace. A task or
    sub-task that is new is created by `who`; one that changed is last edited
    by `who`, and a task counts as changed when anything on its card did; every
    other keeps what the file says.

    `who` is an email, an agent's name as a slug (`personal-family-agent`), `pa` for
    an edit made to the file outside the server, or "" for a tab on a board
    nobody signs in to. `credits` names a different author for some tasks,
    {task id: {"who", "name"}}: a card an agent's request changed in this save,
    which goes under the agent, sub-tasks and log line included. `write_tags`
    says whether to write the tags at all, and is whether there is a `who`
    unless given; the Mac board passes False, keeping the log and leaving the
    file as sent.

    Returns (text, changes): changes is one entry per task added, edited or
    deleted, {"task", "id", "what", "fields"}, for the activity log, with
    "who" and "name" on the ones `credits` answered for."""
    if old_text is None:
        return new_text, []
    credits = credits or {}
    if write_tags is None:
        write_tags = bool(who)
    old, new = _mg_side(old_text), _mg_side(new_text)
    _mg_groups(old["buckets"], [], new["buckets"], _mg_match_buckets, lambda a, b: a["name"] == b["name"])

    def tasks_of(side):
        return [r for b in side["buckets"] for tier in b["tiers"] for r in tier["tasks"]]

    for side in (old, new):
        for r in tasks_of(side):
            r["where"] = "%d\n%s" % (r["bucket"]["g"]["gid"], r["tier"])
    groups = _mg_groups(tasks_of(old), [], tasks_of(new), _mg_match_tasks,
                        lambda a, b: bool(a["id"]) and a["id"] == b["id"])
    who = (who or "").strip().lower()
    changes, touched = [], False
    for g in groups:
        b, t = g["b"], g["t"]
        credit = credits.get((t or b)["id"]) if (t or b)["id"] else None
        author = credit["who"] if credit else who
        say = {"who": credit["who"], "name": credit["name"]} if credit else {}
        if not t:
            changes.append(dict({"task": b["fields"]["title"], "id": b["id"], "what": "deleted", "fields": []}, **say))
            continue
        if not b:
            changes.append(dict({"task": t["fields"]["title"], "id": t["id"], "what": "added", "fields": []}, **say))
            authors = (author, "")
        else:
            fields = _changed_fields(b, t)
            if fields:
                changes.append(dict({"task": t["fields"]["title"], "id": t["id"], "what": "edited",
                                     "fields": fields}, **say))
            authors = (b["fields"]["createdBy"], author if fields else b["fields"]["editedBy"])
        if not write_tags or not author:
            continue
        node = t["node"]
        if authors != (t["fields"]["createdBy"], t["fields"]["editedBy"]):
            node["raw"] = _with_authors(node["raw"], *authors)
            touched = True
        body = list(node["body"])
        steps = _mg_groups(b["parts"]["steps"] if b else [], [], t["parts"]["steps"], _mg_match_tasks,
                           lambda x, y: bool(x["id"]) and x["id"] == y["id"])
        for sg in steps:
            s = sg["t"]
            if not s:
                continue
            if sg["b"]:
                same = _mg_plain_step(sg["b"]) == _mg_plain_step(s)
                want = (sg["b"]["fields"]["createdBy"], sg["b"]["fields"]["editedBy"] if same else author)
            else:
                want = (author, "")
            if want != (s["fields"]["createdBy"], s["fields"]["editedBy"]):
                body[s["at"]] = _with_authors(body[s["at"]], *want)
        if body != node["body"]:
            node["body"] = body
            touched = True
    return (_serialize_tree(new["doc"]) if touched else new_text), changes
