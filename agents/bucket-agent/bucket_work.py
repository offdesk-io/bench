#!/usr/bin/env python3
"""Which sub-tasks on a list are work for one of its bucket agents.

A task reaches a bucket's agent by being handed over on the board, which lays
out sub-tasks on its card (handOver() in kanban/js/04-tier-two-the-one-thing.js),
each with a slug made of the task's id and its kind:

    `#<id>-plan`         Plan, [to:: <the bucket's agent>]       plan-first only
    `#<id>-plan-review`  Review the plan, the owner's            plan-first only
    `#<id>-implement`    Implement, [to:: <the bucket's agent>]
    `#<id>-work-review`  Review the work, the owner's

The agent's name is core/bucket_agents.py agent_name(), and it is the name in
`[to::]` that says which bucket's agent the work is for. Only the Plan and
Implement sub-tasks are ever work: a review is the owner's whoever it is
assigned to, so nothing here returns one and nothing in the runner ticks one.

A sub-task is work while it is open and what it waits on (`blocked-by:`) is
ticked. Three things set it aside with a reason rather than drop it, the same
three the Plan agent's picker used, since two readers of one list disagreeing
about what is actionable is worse than either answer: the card sits in
Reviewing, the task itself is blocked, or its `start:` has not arrived.

`[to:: <a bucket's agent>]` on a task with none of those sub-tasks is not
work either, because a plan is read from the review behind it. unhanded() finds
those, and the runner asks the board to hand them over.

No format knowledge lives here. Everything about how todo.md is written comes
from core/todo.py.

    python3 agents/bucket-agent/bucket_work.py [<list>]     what the list holds for its bucket agents
"""

import datetime as dt
import hashlib
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(HERE)), "core"))
sys.path.insert(0, HERE)

import bucket_agents  # noqa: E402
import paths  # noqa: E402
import todo  # noqa: E402

KINDS = ("plan", "implement")
PARKED = {"reviewing"}
PARKED_WHY = "its card is in %s"
BLOCKED_WHY = "blocked by something unfinished"
STARTS_WHY = "not startable until %s"

# The plan the review names, as the board writes it under Review the plan.
PLAN_NOTE = re.compile(r"^\s*-\s*Plan:\s*plans/([\w./-]+\.md)\s*$", re.I)
FEEDBACK_NOTE = re.compile(r"^\s*-\s*feedback:\s*(.*)$", re.I)

# Tokens that say which task this is, not what it says. Taken out of a
# fingerprint, so minting ids does not read as every task changing.
IDENTITY_TOKENS = re.compile(r"`(?:id|created):[^`]*`|\[(?:id|created)::[^\]]*\]")


def _norm(name):
    return " ".join((name or "").split()).lower()


def agents(dataset, root=None):
    """{agent name, lowercased: its definition (bucket_agents.load())} for a list."""
    out = {}
    for d in bucket_agents.all_buckets(dataset, root):
        out[_norm(d["name"])] = d
    return out


def agent_for(to, known):
    """The definition `[to:: to]` names among `known`, or None."""
    return known.get(_norm(to))


def fingerprint(task):
    """A hash of the task as written, title line and notes together, with
    identity tokens taken out and whitespace flattened."""
    text = task.raw + "\n" + "\n".join(task.body)
    text = IDENTITY_TOKENS.sub("", text)
    return hashlib.sha1(" ".join(text.split()).encode("utf-8")).hexdigest()[:12]


def key_of(task):
    """The id on the task's own line, or its title for a list with none."""
    return getattr(task, "stable_id", "") or task.title


def _made(task):
    return re.compile(re.escape(task.stable_id) + r"-(plan|implement)") if task.stable_id else None


def handed_over(task):
    """Whether the task carries a Plan or Implement sub-task a handover laid
    out, with someone in its `[to::]`. Ticked, waiting or open makes no
    difference."""
    made = _made(task)
    return bool(made) and any((s["task"].to or "").strip() and made.fullmatch(s["task"].slug or "")
                              for s in todo.split_body(task)[1])


def unhanded(tasks, known):
    """(task, agent name) for every open task tagged to one of `known` with no handover."""
    out = []
    for t in tasks:
        agent = agent_for(t.to, known)
        if t.done or not t.stable_id or not agent:
            continue
        if not handed_over(t):
            out.append((t, agent["name"]))
    return out


def plan_rel(steps, task):
    """The plan its Review the plan names, `- Plan: plans/<file>`, or ""."""
    for s in steps:
        if s["task"].slug == task.stable_id + "-plan-review":
            for line in s["notes"]:
                m = PLAN_NOTE.match(line)
                if m and ".." not in m.group(1).split("/"):
                    return m.group(1)
    return ""


def feedback(steps, task, kinds=KINDS):
    """What the owner said in `feedback:` notes under the task's Plan and Implement."""
    said = []
    for s in steps:
        if s["task"].slug in ["%s-%s" % (task.stable_id, k) for k in kinds]:
            for line in s["notes"]:
                m = FEEDBACK_NOTE.match(line)
                if m and m.group(1).strip():
                    said.append(m.group(1).strip())
    return said


def work(text, known, day=None):
    """Every Plan or Implement sub-task assigned to one of `known` that is open
    with what it waits on ticked, in in_order()'s order.

    Each is a dict: `task`, `sub` (the sub-task), `kind` (plan or implement),
    `agent` (the definition), `plan_rel`, `feedback`, `review_done` (the
    task's Review the plan sub-task is there and ticked), and `skip`, a reason
    it is set aside or None.
    """
    day = day or dt.date.today()
    tasks = todo.parse_doc(text)
    slugs = todo.slug_states(tasks)
    out = []
    for t in in_order([t for t in tasks if not t.done and t.stable_id], day):
        steps = todo.split_body(t)[1]
        review_done = any(s["task"].slug == t.stable_id + "-plan-review" and s["task"].done for s in steps)
        for s in steps:
            sub = s["task"]
            kind = next((k for k in KINDS if sub.slug == "%s-%s" % (t.stable_id, k)), None)
            agent = agent_for(sub.to, known) if kind else None
            if not agent or sub.done or todo.is_blocked(sub, slugs):
                continue
            skip = None
            if t.column.strip().lower() in PARKED:
                skip = PARKED_WHY % t.column
            elif todo.is_blocked(t, slugs):
                skip = BLOCKED_WHY
            elif t.start and (todo.parse_date(t.start) or day) > day:
                skip = STARTS_WHY % t.start
            out.append({"task": t, "sub": sub, "kind": kind, "agent": agent,
                        "plan_rel": plan_rel(steps, t), "feedback": feedback(steps, t),
                        "review_done": review_done, "skip": skip})
    return out


def in_order(tasks, today=None):
    """The list's own order of work: the headline first, then the soonest date,
    then impact against effort, highest first. Bucket is never a key, so
    buckets interleave on merit (pick.in_order() in the Plan agent, unchanged)."""
    today = today or dt.date.today()

    def sort_key(t):
        due = todo.effective_due(t, today)
        return (0 if t.headline else 1, (due - today).days if due else 10 ** 6, -todo.priority_score(t))

    return sorted(tasks, key=sort_key)


def main(argv):
    name = argv[0] if argv else paths.dataset()
    with paths.using(name):
        with open(paths.todo_path(), encoding="utf-8") as fh:
            text = fh.read()
        known = agents(name, paths.DATA_ROOT)
        rows = work(text, known)
    if not rows:
        print("Nothing for the bucket agents on %s." % name)
    for r in rows:
        print("  %-9s %-28s %-50s %s" % (r["kind"], r["agent"]["name"][:28], r["task"].title[:50],
                                       r["skip"] or ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
