"""Turns a parsed todo.md into the fields agents/pa_agent/skills/pa/references/templates.md
documents, so a report is rendered from real arithmetic rather than typed out
by hand against the same rules every time.

See IMPROVEMENTS.md, "Every report the PA sends is rendered by hand, so the
templates are instructions rather than code." The arithmetic mostly already
existed, in two half-written, hand-agreeing copies: check_overdue() in
check_todo.py and the headline-first ranking in the old Plan agent's picker. This is
the one copy, built on core/todo.py the way both of those already read the
file, and it produces the whole of a template's context — not asked to know
about Mustache, chevron or any particular skill.

Two things are deliberately not here. `checker_flags`, `slipped` and
`context_dates` — the "what the read turned up" fields templates.md marks as
desk-only — have no aggregation built yet: nothing in this file fakes them,
so a template asking for one gets an empty list rather than a wrong answer.
And the change-report fields (`changes`, `needs_you`, `pending_count`) are
never read from todo.md at all — they come from the session that made the
change, and the caller supplies them directly to core/render.py alongside
whatever this module returns.
"""

import datetime as dt
import re

import archive
import todo

# Top-level columns read verbatim off `column`, matching the board's own
# names rather than a slug — a renamed column would need renaming here too,
# the same cost every other string-matched column name in this repo carries.
DOING = "Doing"
TO_DO = "To do"
WAITING = "Reviewing"
BACKLOG = "Backlog"

# The check-in offers at most this many process matches, so the brief stays
# a brief. A match needs two words in common with the process, a word of its
# name counting twice when the task says at least half the name, so a task
# that says Chase matches Chase and one word buried in a description does not.
PROCESS_OFFERS = 3
MIN_MATCH = 2

# Words that say nothing about which process a task is: grammar, and the verbs
# every task title starts with.
STOP = frozenset("""
    a an and are as at be by for from has have i in into is it its me my of on
    or our out so than that the their them then this to up was we what when
    where which who will with you your about after again all also any before
    each how just more most new not off only other over some such too very
    do does done get got make made set put take sort start finish look think
    add one two next first last thing things stuff bit week day today tomorrow
    run work help need use try plan whether way ways between against actual
    via within without
""".split())


def _stem(word):
    """Crude, and only ever compared with itself: audits and audit, reviewing
    and review, meetings and meeting land on one key."""
    if word.endswith("ies") and len(word) > 5:
        return word[:-3] + "y"
    if word.endswith("sses"):
        return word[:-2]
    if word.endswith("ss"):
        return word
    for end in ("ing", "ed", "s"):
        if word.endswith(end) and len(word) - len(end) >= 3:
            return word[:-len(end)]
    return word


def _words(text):
    return {_stem(w) for w in re.findall(r"[a-z0-9]+", (text or "").lower())
            if len(w) >= 3 and w not in STOP}


def _with_agent(task):
    """Already handed to an agent, on the task or an open sub-task of it, so
    the help is on its way and offering it again is noise."""
    if todo.agent_of(task.to):
        return True
    _, steps = todo.split_body(task)
    return any(not s["done"] and todo.agent_of(s["task"].to) for s in steps)


def process_matches(tasks, processes_of, today=None, limit=PROCESS_OFFERS):
    """Open To do and Doing tasks that read as a process their bucket's brief
    already names, best first, at most `limit` of them.

    `processes_of(bucket)` is core/bucket_agents.py's processes() for one list,
    handed in rather than imported, because the brief is the bucket agent's
    file and this module reads only todo.md. It returns None for a bucket
    with no written brief, which leaves that bucket's tasks out.

    Word overlap on prose, so every row is a candidate: the check-in reads
    the brief before offering it, and a wrong one costs the owner one line to
    wave off. Words of the bucket's own name and the brief's title are
    ignored, since every task in a design system bucket says design.
    """
    today = today or dt.date.today()
    briefs, found = {}, []
    for t in tasks:
        if t.done or t.column not in (DOING, TO_DO) or _with_agent(t):
            continue
        if t.bucket not in briefs:
            briefs[t.bucket] = processes_of(t.bucket)
        brief = briefs[t.bucket]
        if not brief:
            continue
        ignore = _words(t.bucket) | _words(brief.get("title"))
        mine = _words(t.title) - ignore
        best = None
        for p in brief.get("processes", []):
            if not (p.get("skills") or brief.get("planner")):
                continue
            named = _words(p["process"]) - ignore
            shared = mine & (named | _words(p.get("text")))
            in_name = mine & named
            # The name counts twice only where the task says at least half
            # of it: Chase is a chase, one word of AI adoption in the design
            # team is not adoption.
            score = len(shared) + (len(in_name) if 2 * len(in_name) >= len(named) else 0)
            if score >= MIN_MATCH and (best is None or score > best[0]):
                best = (score, p, shared)
        if best:
            found.append((t, brief) + best)

    found.sort(key=lambda m: (m[2], m[0].column == DOING, todo.priority_score(m[0])),
               reverse=True)
    rows = []
    for t, brief, score, p, shared in found[:limit]:
        row = _row(t, today)
        row.update({
            "process": p["process"],
            "covered_by": ", ".join(p.get("skills") or []) or brief.get("planner", ""),
            "via": "skill" if p.get("skills") else "planner",
            "words": sorted(shared), "brief": brief.get("brief", ""),
        })
        rows.append(row)
    return rows


def _fmt_long(date):
    return date.strftime("%A, %d %B %Y") if date else ""


def _fmt_short(date):
    return date.strftime("%a %-d %b") if date else ""


WAITING_ON_RE = re.compile(r"Waiting on:\s*([^,.\n]*)", re.I)


def _who(task):
    """From `[to:: ]`, or a `Waiting on:` note — the first clause of it,
    since the note itself is usually a full sentence about why."""
    if task.to:
        return task.to
    for line in task.body:
        m = WAITING_ON_RE.search(line)
        if m:
            return m.group(1).strip()
    return ""


def _row(task, today, due_override=None):
    due = due_override if due_override is not None else todo.parse_date(task.due)
    days = abs((due - today).days) if due else ""
    return {
        "title": task.title, "bucket": task.bucket, "state": task.column,
        "impact": task.impact, "effort": task.effort, "to": task.to,
        "due": _fmt_long(due), "due_short": _fmt_short(due),
        "days": days, "who": _who(task),
    }


def _meeting_row(task, today, due_override):
    row = _row(task, today, due_override)
    row["agenda_state"] = "written" if todo.agenda_topics(task) else "not written"
    return row


def _has_message(task):
    return bool(todo.messages(task, live_only=True))


def _actionable(task, slugs, today):
    if todo.is_blocked(task, slugs):
        return False
    start = todo.parse_date(task.start)
    return not (start and start > today)


def today_view(tasks, today=None, processes_of=None):
    """Every "about today" field templates.md documents, minus the desk-only
    three named in this module's own docstring.

    `process_matches` is empty unless `processes_of` is given, see
    process_matches(); pa-checkin is the one caller that gives it."""
    today = today or dt.date.today()
    open_tasks = [t for t in tasks if not t.done]
    slugs = todo.slug_states(tasks)
    horizon_week = today + dt.timedelta(days=(6 - today.weekday()))  # this Sunday
    week_start = today - dt.timedelta(days=today.weekday())

    overdue, due_today, due_tomorrow, due_this_week = [], [], [], []
    for t in open_tasks:
        if t.column == WAITING:
            # The work is done as far as the owner is concerned and it is sitting
            # with someone else — the date belongs to them now. Same
            # reasoning check_overdue() already applies, extended to every
            # date list here rather than only the overdue one: a "due today"
            # card sitting in Reviewing is not actionable by the owner today
            # either.
            continue
        due = todo.effective_due(t, today)
        if not due:
            continue
        if due < today:
            overdue.append(_row(t, today, due))
        elif due == today:
            due_today.append(_row(t, today, due))
        elif due == today + dt.timedelta(days=1):
            due_tomorrow.append(_row(t, today, due))
        if today <= due <= horizon_week:
            due_this_week.append(_row(t, today, due))

    doing = [_row(t, today) for t in open_tasks if t.column == DOING]
    waiting = [_row(t, today) for t in open_tasks if t.column == WAITING]

    week = []
    for t in open_tasks:
        if t.week:
            week.append(_row(t, today))
        _, steps = todo.split_body(t)
        for s in steps:
            if not s["done"] and s["task"].week:
                st = s["task"]
                st.bucket, st.column = t.bucket, t.column
                week.append(_row(st, today))

    # counts_as_finished(), not t.done: a cancelled task is ticked, and
    # counting it says work was done that was not.
    done_today = [_row(t, today) for t in tasks
                  if todo.counts_as_finished(t) and t.done_on == today.isoformat()]

    quick_wins = []
    for t in open_tasks:
        if todo.agent_of(t.to) == todo.IMPLEMENT_AGENT or t.column == BACKLOG:
            continue
        if not _actionable(t, slugs, today):
            continue
        if t.effort == "S" or _has_message(t):
            quick_wins.append(_row(t, today))

    delegate = sorted(
        (t for t in open_tasks if todo.agent_of(t.to) == todo.IMPLEMENT_AGENT),
        key=todo.priority_score, reverse=True)
    delegate = [_row(t, today) for t in delegate]

    meetings_next_two_days, meetings_this_week = [], []
    for t in open_tasks:
        if not t.repeat:
            continue
        due = todo.effective_due(t, today)
        if not due:
            continue
        if today <= due <= today + dt.timedelta(days=1):
            meetings_next_two_days.append(_meeting_row(t, today, due))
        if today <= due <= horizon_week:
            meetings_this_week.append(_meeting_row(t, today, due))

    headline_task = next((t for t in open_tasks if t.headline), None)
    headline_age = ""
    headline_next_step = ""
    if headline_task:
        set_on = todo.parse_date(headline_task.headline)
        if set_on:
            headline_age = (today - set_on).days
        _, steps = todo.split_body(headline_task)
        nxt = next((s for s in steps if not s["done"]), None)
        if nxt:
            headline_next_step = nxt["task"].title

    matches = process_matches(tasks, processes_of, today) if processes_of else []

    return {
        "date": _fmt_long(today), "date_short": _fmt_short(today),
        "week_start": _fmt_short(week_start),
        "headline": headline_task.title if headline_task else "",
        "headline_bucket": headline_task.bucket if headline_task else "",
        "headline_age": headline_age,
        "headline_next_step": headline_next_step,
        "overdue": overdue, "due_today": due_today,
        "due_tomorrow": due_tomorrow, "due_this_week": due_this_week,
        "doing": doing, "waiting": waiting,
        "week": week, "done_today": done_today,
        "quick_wins": quick_wins, "delegate": delegate,
        "meetings_next_two_days": meetings_next_two_days,
        "meetings_this_week": meetings_this_week,
        "process_matches": matches, "process_match_count": len(matches),
        # Not built yet — see this module's own docstring.
        "checker_flags": [], "slipped": [], "context_dates": [],
        "overdue_count": len(overdue), "doing_count": len(doing),
        "waiting_count": len(waiting),
        "week_count": len(week),
        "unscored_count": len([t for t in open_tasks if todo.unscored(t)]),
        "delegate_count": len(delegate),
    }


def meeting_view(tasks, title, today=None):
    """The fields meeting-prep needs for one named recurring task, or None
    when nothing matches — title matched loosely, the same way brief.py's
    own `--task` does, since the owner asks for a meeting by a shorthand rather
    than pasting the exact line."""
    today = today or dt.date.today()
    want = title.strip().lower()
    hit = next((t for t in tasks if t.title.strip().lower() == want), None)
    if not hit:
        hit = next((t for t in tasks if want in t.title.strip().lower()), None)
    if not hit:
        return None
    due = todo.effective_due(hit, today)
    return {
        "meeting": hit.title,
        "meeting_date_long": _fmt_long(due),
        "agenda": todo.agenda_topics(hit),
        "previous_agenda": todo.agenda_topics(hit, previous=True),
    }


def period_view(tasks, archive_path, start, end, buckets=None):
    """What finished between `start` and `end` (inclusive), live tasks and
    the archive both — the aggregation IMPROVEMENTS.md's written-reports
    entry asks for, pointed at a past window rather than at today. Live and
    archived are joined the same way completedRecently() in
    kanban/js/12-reports.js already does it, since a task ticked recently
    and one lifted into done-archive.md by ARCHIVE_DAYS are the same fact
    told from two files.

    `buckets`, when given, narrows both `completed` and `by_bucket` to those
    named — a report definition's own scope, applied here rather than left
    for the caller to filter afterwards, since filtering after the count
    would leave `by_bucket` naming buckets the report was never about.
    """
    def in_window(done_on):
        d = todo.parse_date(done_on)
        return bool(d and start <= d <= end)

    # Same rule as done_today above, and the same rule the board's own
    # archive collector applies — the archive is where a cancelled task ends
    # up, so it has to be asked there too.
    completed = [t for t in tasks
                 if todo.counts_as_finished(t) and in_window(t.done_on)]
    completed += [t for t in archive.read_archive(archive_path)
                  if todo.counts_as_finished(t) and in_window(t.done_on)]
    if buckets:
        completed = [t for t in completed if t.bucket in buckets]

    by_bucket = {}
    for t in completed:
        by_bucket[t.bucket] = by_bucket.get(t.bucket, 0) + 1

    rows = sorted(
        ({"title": t.title, "bucket": t.bucket, "tier": t.column,
          "effort": t.effort, "done_on": t.done_on} for t in completed),
        key=lambda r: r["done_on"])

    return {
        "completed": rows,
        "completed_count": len(rows),
        "by_bucket": [{"bucket": b, "count": n} for b, n in sorted(by_bucket.items())],
        "window_start": _fmt_long(start), "window_end": _fmt_long(end),
    }
