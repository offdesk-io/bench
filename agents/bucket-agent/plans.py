#!/usr/bin/env python3
"""What the bucket agents' hooks call about plans and the list: plan files, the
todo.md guard, the usage window, banners.

Ported from agents/plan-agent/plan.py with what a plan-first bucket's agent
still needs. A plan is one file per task, flat under `data/<list>/plans/`,
overwritten in place on a replan with its History carried forward, and the
frontmatter the board reads is completed here rather than trusted.

The runner is suspicious of its own agents. They are never given a tool that
can write todo.md, and the file is hashed before each run and checked after it
anyway. A run now often happens while the owner is at the board, which saves
todo.md within seconds of every change, so a change alone is not the agent's:
todo_moved() asks whether anything other than the board wrote it.
"""

import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "core"))
sys.path.insert(0, HERE)

import bucket_work  # noqa: E402
import check_plan  # noqa: E402
import owner_profile  # noqa: E402
import paths  # noqa: E402
import plan_types  # noqa: E402
import project_folders  # noqa: E402
import todo  # noqa: E402
import windows  # noqa: E402

TASK_TIMEOUT = 10 * 60        # one plan's ceiling, seconds
BUDGET_PER_TASK = 2.00        # dollars, handed to --max-budget-usd
FOLDED = "folded"
FLOOR = dt.timedelta(minutes=20)   # do not start another item below this
KEEP_DAYS = 30
RESET_RE = re.compile(r"resets? (?:at )?([0-9]{1,2}:[0-9]{2}\s*(?:am|pm)?|[0-9T:\-\+]{10,})", re.I)
FRONT_RE = re.compile(r"^---\n(.*?)\n---\n", re.S)
SECTION_RE = re.compile(r"^(#{1,4})\s+(.*?)\s*$")


def file_hash(path):
    try:
        with open(path, "rb") as fh:
            return hashlib.sha256(fh.read()).hexdigest()
    except OSError:
        return None


def slugify(title):
    s = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return (s or "task")[:60]


def log(line):
    path = paths.log_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with open(path, "a", encoding="utf-8", newline="") as fh:
        fh.write("%s  %s\n" % (stamp, line))


def read_front(path):
    """A plan file's frontmatter as a dict. {} for anything unreadable."""
    fields = {}
    try:
        with open(path, encoding="utf-8") as fh:
            if fh.readline().strip() != "---":
                return {}
            for line in fh:
                if line.strip() == "---":
                    break
                key, _, value = line.partition(":")
                fields[key.strip().lower()] = value.strip()
    except OSError:
        return {}
    return fields


def plan_filename(task):
    """`<title slug>-<task id>.md`, the one file the task's plan lives in."""
    tid = getattr(task, "stable_id", "")
    base = slugify(task.title)
    return "%s-%s.md" % (base, tid) if tid else "%s.md" % base


def existing_plan(task):
    """The path of the task's plan when one is on disk, else None."""
    path = os.path.join(paths.plans_dir(), plan_filename(task))
    return path if os.path.isfile(path) else None


def read_sections(path, names):
    """Named `##` sections of a plan file, as {lowercased name: text}. A section
    runs to the next heading at its own level or above, as the board renders."""
    want = {n.strip().lower() for n in names}
    found, current, buf, level = {}, None, [], 0
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return {}
    for line in lines:
        m = SECTION_RE.match(line)
        if m:
            if current and len(m.group(1)) <= level:
                found[current] = "\n".join(buf).strip()
                current, buf = None, []
            if not current and m.group(2).strip().lower() in want:
                current, buf, level = m.group(2).strip().lower(), [], len(m.group(1))
                continue
        if current:
            buf.append(line)
    if current:
        found[current] = "\n".join(buf).strip()
    return found


def drop_section(body, name):
    """`body` without its `## <name>` section, by the rule read_sections uses."""
    want = name.strip().lower()
    out, skip_at = [], 0
    for line in body.splitlines():
        m = SECTION_RE.match(line)
        if m:
            level = len(m.group(1))
            if skip_at and level <= skip_at:
                skip_at = 0
            if not skip_at and m.group(2).strip().lower() == want:
                skip_at = level
                continue
        if not skip_at:
            out.append(line)
    return "\n".join(out).strip()


def feedback_on(task):
    """What the owner said when sending the plan back: the `feedback:` notes
    under the task's Plan sub-task, joined."""
    return " ".join(bucket_work.feedback(todo.split_body(task)[1], task, kinds=("plan",)))


def rejection(task):
    """(summary, note, context, proposal) of the plan the owner sent back, or None.

    Sent back is a `feedback:` note under the Plan sub-task with a plan already
    on disk. The prior plan's Context and Proposed plan come with it, so the
    next plan starts from what was established rather than reading it all again.
    """
    note = feedback_on(task)
    path = existing_plan(task)
    if not note or not path:
        return None
    front = read_front(path)
    was = read_sections(path, ("Context", "Proposed plan"))
    return front.get("summary", ""), note, was.get("context", ""), was.get("proposed plan", "")


def history(task, day, agent):
    """(revision, the plan's History section): one line per revision, appended."""
    path = existing_plan(task)
    was = read_sections(path, ("History",)).get("history", "") if path else ""
    rev = 1
    if path:
        try:
            rev = int(read_front(path).get("revision", "1")) + 1
        except ValueError:
            rev = 2
    line = "- **%s, revision %d.** " % (day.isoformat(), rev)
    said = rejection(task)
    if said and rev > 1:
        line += "Re-planned by %s after revision %d was sent back: %s" % (agent, rev - 1, said[1].rstrip("."))
        if not line.endswith("."):
            line += "."
    else:
        line += "Planned by %s." % agent
    lines = [l for l in was.splitlines() if l.strip().startswith("-")] + [line]
    return rev, "\n".join(lines)


def task_briefing(task):
    """The cached briefing brief.py wrote for this task, or ""."""
    try:
        with open(paths.briefings_path(), encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return ""
    row = (data.get("briefed") or {}).get(bucket_work.key_of(task))
    return (row or {}).get("text", "")


def extra_dirs(dataset=None):
    """[the workspace folder] the list's profile names (`Workspace folder:`), or [].
    Read-only for a plan; see hooks.options()."""
    folder = owner_profile.workspace_folder(paths.DATA_ROOT, board=dataset or paths.dataset())
    return [folder] if folder else []


def project_dirs(task):
    """The task's own project folder, when its `Project:` note resolves to one
    outside the repo and the workspace folder, for this one run."""
    ref = project_folders.note_ref(getattr(task, "body", None))
    if not ref:
        return []
    real, err = project_folders.resolve(ref, paths.data_dir())
    if err:
        return []
    if project_folders.inside(os.path.realpath(ROOT), real):
        return []
    extra = extra_dirs()
    if extra and project_folders.inside(os.path.realpath(os.path.expanduser(extra[0])), real):
        return []
    return [real]


def write_plan(task, text, session, day, agent):
    """One plan file, its frontmatter completed rather than trusted.

    Returns (path, summary, folded, faults): faults are check_plan.py's
    reasons the plan is too long or missing a section, logged and shown on the
    run but never a refusal."""
    body = text.strip()
    summary, outcome, kind = "", "", ""
    m = FRONT_RE.match(body + "\n")
    if m:
        for line in m.group(1).splitlines():
            low = line.lower()
            if low.startswith("summary:"):
                summary = line.split(":", 1)[1].strip()
            elif low.startswith("outcome:"):
                outcome = line.split(":", 1)[1].strip().lower()
            elif low.startswith("type:"):
                kind = line.split(":", 1)[1]
        body = body[m.end():].lstrip("\n")
    if not summary:
        summary = "The agent wrote no summary line."

    rev, told = history(task, day, agent)
    body = drop_section(body, "History")
    body = (body.rstrip("\n") + "\n\n## History\n\n" + told).strip()

    front = [
        "---",
        "title: %s" % task.title,
        "task: %s" % task.title,
        "about: task:%s" % getattr(task, "stable_id", ""),
        "group: %s" % task.bucket,
        "column: %s" % task.column,
        "to: %s" % agent,
        "agent: %s" % agent,
        "date: %s" % day.isoformat(),
        "created: %s" % dt.datetime.now().isoformat(timespec="seconds"),
        "night: %s" % day.isoformat(),
    ]
    if task.slug:
        front.append("slug: %s" % task.slug)
    if session:
        front.append("session: %s" % session)
    front.append("revision: %d" % rev)
    front.append("needs_you: %s" % ("yes" if outcome == FOLDED else "no"))
    if outcome and outcome != FOLDED:
        front.append("outcome: %s" % outcome)
    # Always written, `other` when the agent named none or a word off the list.
    front.append("type: %s" % plan_types.read(kind))
    front.append("summary: %s" % summary)
    front.append("---")

    out = os.path.join(paths.plans_dir(), plan_filename(task))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    whole = "\n".join(front) + "\n\n" + body.rstrip("\n") + "\n"
    with open(out, "w", encoding="utf-8", newline="") as fh:
        fh.write(whole)
    faults = [] if outcome == FOLDED else check_plan.check(whole)
    return out, summary, outcome == FOLDED, faults


def queue_attach(task, session):
    """File the run's conversation against its task, through pa-attach's own writer."""
    if not session:
        return
    script = os.path.join(paths.ROOT, "agents", "pa_agent", "skills", "pa-attach", "scripts", "attach_session.py")
    if not os.path.exists(script):
        return
    try:
        subprocess.run([sys.executable, script, paths.attach_queue_path(), "--title", task.title,
                        "--cwd", paths.ROOT, "--session", session],
                       capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as exc:
        log("  attach failed for %r: %s" % (task.title, exc))


def _parse_iso(text):
    try:
        when = dt.datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    except ValueError:
        return None
    return when if when.tzinfo else when.astimezone()


def todo_moved(before_hash, since):
    """Why todo.md must be taken to have been written by something other than
    the board while a run was going, or None.

    Unchanged is None. Changed, it is the board's own save (the owner at the
    board, or a tick it applied) only when the file is exactly the version the
    board server last wrote (`.known-todo.md`) and the board logged no outside
    edit since `since`. The server accounts for an outside write on its next
    read and logs it under `pa` in activity.jsonl, so an agent's write
    is caught whether or not the server has seen it yet. With no server
    running, any change is an outside one, which is the old rule exactly.
    """
    path = paths.todo_path()
    if file_hash(path) == before_hash:
        return None
    try:
        with open(path, encoding="utf-8", newline="") as fh:
            now = fh.read()
        with open(paths.known_todo_path(), encoding="utf-8", newline="") as fh:
            known = fh.read()
    except OSError:
        return "todo.md changed during the run, and the board did not write it"
    if now != known:
        return "todo.md changed during the run, and the board did not write it"
    try:
        with open(paths.activity_path(), encoding="utf-8") as fh:
            lines = fh.readlines()[-500:]
    except OSError:
        lines = []
    for line in lines:
        try:
            row = json.loads(line)
        except ValueError:
            continue
        at = _parse_iso(row.get("at") or "")
        if row.get("who") == "pa" and at and at >= since:
            return "todo.md was written outside the board during the run"
    return None


def record_limit(err):
    """Keep the reset time out of a usage limit message, for should_stop()."""
    state = windows.read_state(paths.window_path())
    state["limited_at"] = dt.datetime.now().astimezone().isoformat()
    state["message"] = (err or "")[:300]
    m = RESET_RE.search(err or "")
    if m:
        state["expires_raw"] = m.group(1)
        parsed = _parse_reset(m.group(1))
        if parsed:
            state["expires"] = parsed.isoformat()
    windows.write_state(paths.window_path(), state)
    return state.get("expires")


def _parse_reset(text):
    """"3:45pm", "03:45" or an ISO timestamp, as the next moment that reads."""
    text = text.strip()
    when = _parse_iso(text)
    if when:
        return when
    m = re.match(r"^(\d{1,2}):(\d{2})\s*(am|pm)?$", text, re.I)
    if not m:
        return None
    hour, minute = int(m.group(1)), int(m.group(2))
    ampm = (m.group(3) or "").lower()
    if ampm == "pm" and hour < 12:
        hour += 12
    if ampm == "am" and hour == 12:
        hour = 0
    now = dt.datetime.now().astimezone()
    when = now.replace(hour=hour % 24, minute=minute, second=0, microsecond=0)
    return when if when > now else when + dt.timedelta(days=1)


def prune(day, tasks):
    """Delete a plan whose task left the list more than KEEP_DAYS ago."""
    root = paths.plans_dir()
    if not os.path.isdir(root):
        return
    known = {bucket_work.key_of(t) for t in tasks}
    cutoff = day - dt.timedelta(days=KEEP_DAYS)
    for name in sorted(os.listdir(root)):
        if not name.endswith(".md"):
            continue
        path = os.path.join(root, name)
        about = read_front(path).get("about", "")
        task_id = about[len("task:"):] if about.startswith("task:") else ""
        if not task_id or task_id in known:
            continue
        try:
            touched = dt.date.fromtimestamp(os.stat(path).st_mtime)
        except OSError:
            continue
        if touched < cutoff:
            os.remove(path)
            log("pruned an orphaned plan: %s (its task is gone)" % name)


def announce(planned, folded, done):
    """One banner for a run that wrote a plan or finished work, never one per
    item. Failures have their own, from core/agent_runs.py."""
    if not (planned or folded or done):
        return
    sys.path.insert(0, os.path.join(paths.ROOT, "companion"))
    try:
        import notify  # noqa: E402
    except ImportError:
        return
    parts = []
    if planned:
        parts.append("%d plan%s to review" % (len(planned), "" if len(planned) == 1 else "s"))
    if folded:
        parts.append("%d waiting on you" % len(folded))
    if done:
        parts.append("%d piece%s of work to review" % (len(done), "" if len(done) == 1 else "s"))
    first = (folded or planned or done)[0]
    body = ", ".join(parts) + ".\n" + (first if len(first) < 60 else first[:59].rstrip() + "…")
    notify.queue("Bucket agents", body, view="plans" if (planned or folded) else None,
                 path=paths.notify_queue_path())
