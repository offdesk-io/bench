#!/usr/bin/env python3
"""The queue an agent leaves a request in when it has finished a sub-task.

An agent never writes todo.md: the board holds the whole document in the
browser and writes all of it back, so a second writer is overwritten within
seconds. What an agent can do is say "I have finished sub-task aa0001", and this
is where it says it, in `data/<dataset>/tick-queue.json`. The board drains the
file when it loads (`drainTickQueue()` in kanban/js/10-reference-sections.js),
through its own edit path, the way it drains attach-queue.json.

Each entry is one request:

    {"id": "3f9a1c2b", "sub": "aa0001", "by": "Plan agent",
     "at": "2026-09-22T02:14:09", "note": "plan written", "plan": "2026-09-22/ab12cd-x.md",
     "type": "write-up"}

`sub` is the six-character id written on the sub-task's line, and `by` is who is
asking. The board applies a tick only when `by` is the agent the sub-task is
assigned to, so an agent cannot tick a review and approve its own work. Nothing
is lost when the board is closed: the request waits for the next load.

`type` is the plan's own `type:` (core/plan_types.py), written only by the
retired Plan agent. No type is approved on arrival any more, so the bucket
agents (agents/bucket-agent/) leave it out and the owner ticks every Review the
plan.

The other kind of request asks for a handover rather than a tick:

    {"id": "7c1d0e4a", "handover": "ab12cd", "to": "Plan agent", "by": "Plan agent",
     "at": "2026-09-26T02:00:03", "note": "tagged with no handover"}

`handover` is the task's own id. A bucket's agent leaves one for a task carrying
`[to::]` its name with none of the sub-tasks a handover lays out
(agents/bucket-agent/bucket_work.py unhanded()),
and the board runs handOver() on it, as Delegate to would. It is applied only
while the task's `[to::]` still names that agent, and does nothing to a task
that has since been handed over.

The third asks for a card to move column, and is the content board's alone:

    {"id": "b2e4f6a8", "move": "0q3ym0", "column": "Reviewing",
     "by": "Content strategist agent", "at": "2026-10-06T23:04:11",
     "note": "draft written", "draft": "/path/to/data/content/posts/2026-10-08-x.md"}

`move` is the task's own id. The content strategist agent's evening run leaves
one for each post it drafts, and the board moves the card to Reviewing and puts
`- Draft: <path>` on it (drainMove() in kanban/js/10-reference-sections.js). The
board applies it only on the `content` list, only from that agent and only to
Reviewing: it is a way to say "this draft is ready", not a general way for an
agent to rearrange a board.

The file is appended to and removed from under a lock, and the board removes
only the ids it dealt with rather than rewriting the list, so a request that
lands while the board is draining is not written over.

    python3 core/tick_queue.py tick aa0001 --by "Plan agent" --note "plan written"
    python3 core/tick_queue.py move 0q3ym0 --by "Content strategist agent" --draft <path> --dataset content
"""

import argparse
import datetime as dt
import json
import os
import sys
import uuid

import dataset as _dataset
from platform_calls import Locked as _Locked

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# $TODOS_DATA_ROOT moves the datasets, as it does for kanban/server.py.
DATA_ROOT = os.environ.get("TODOS_DATA_ROOT") or os.path.join(ROOT, "data")


def current_dataset():
    return _dataset.current(DATA_ROOT)


def queue_path(dataset=None):
    return os.path.join(DATA_ROOT, dataset or current_dataset(), "tick-queue.json")



def read(path=None):
    """Every request waiting, oldest first. Unreadable or hand-broken is empty."""
    try:
        with open(path or queue_path(), encoding="utf-8") as fh:
            got = json.load(fh)
    except (OSError, ValueError):
        return []
    return [e for e in got if isinstance(e, dict)] if isinstance(got, list) else []


def _write(path, items):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as fh:
        json.dump(items, fh, indent=2)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def append(sub, by, note="", path=None, now=None, plan="", kind=""):
    """Asks the board to tick sub-task `sub`, on behalf of `by`. Returns the entry.

    `plan` is the path of a plan just written, relative to the plans folder. The
    board puts it on the review waiting behind the sub-task as a `Plan:` note,
    so that opening the review can read it. `kind` is that plan's `type:`."""
    path = path or queue_path()
    entry = {
        "id": uuid.uuid4().hex[:8],
        "sub": str(sub).strip().lower(),
        "by": str(by).strip(),
        "at": (now or dt.datetime.now()).replace(microsecond=0).isoformat(),
        "note": note,
    }
    if plan:
        entry["plan"] = str(plan)
    if kind:
        entry["type"] = str(kind).strip().lower()
    with _Locked(path):
        items = read(path)
        items.append(entry)
        _write(path, items)
    return entry


def append_handover(task_id, to, by, note="", path=None, now=None):
    """Asks the board to hand task `task_id` over to `to`, on behalf of `by`."""
    path = path or queue_path()
    entry = {
        "id": uuid.uuid4().hex[:8],
        "handover": str(task_id).strip().lower(),
        "to": str(to).strip(),
        "by": str(by).strip(),
        "at": (now or dt.datetime.now()).replace(microsecond=0).isoformat(),
        "note": note,
    }
    with _Locked(path):
        items = read(path)
        items.append(entry)
        _write(path, items)
    return entry


def append_move(task_id, column, by, note="", draft="", path=None, now=None):
    """Asks the board to move task `task_id` to `column`, on behalf of `by`.

    `draft` is the absolute path of the file the card should link to. The board
    decides whether to honour it; see the module's docstring for when it does."""
    path = path or queue_path()
    entry = {
        "id": uuid.uuid4().hex[:8],
        "move": str(task_id).strip().lower(),
        "column": str(column).strip(),
        "by": str(by).strip(),
        "at": (now or dt.datetime.now()).replace(microsecond=0).isoformat(),
        "note": note,
    }
    if draft:
        entry["draft"] = str(draft)
    with _Locked(path):
        items = read(path)
        items.append(entry)
        _write(path, items)
    return entry


def remove(ids, path=None):
    """Takes the entries with these ids out, and nothing else."""
    path = path or queue_path()
    gone = set(ids)
    with _Locked(path):
        items = read(path)
        keep = [e for e in items if e.get("id") not in gone]
        if len(keep) != len(items):
            _write(path, keep)
    return len(items) - len(keep)


def main(argv):
    ap = argparse.ArgumentParser(description="Ask the board to tick a sub-task, or move a card.")
    ap.add_argument("action", choices=["tick", "move"])
    ap.add_argument("sub", help="the six-character id on the sub-task's line, or the card's for move")
    ap.add_argument("--by", required=True, help='who is asking: the agent the sub-task is assigned to')
    ap.add_argument("--note", default="")
    ap.add_argument("--plan", default="", help="a plan just written, relative to the plans folder")
    ap.add_argument("--type", default="", help="the plan's type:, on the Plan agent's tick")
    ap.add_argument("--column", default="Reviewing", help="where move sends the card")
    ap.add_argument("--draft", default="", help="the draft move links the card to, by absolute path")
    ap.add_argument("--dataset")
    args = ap.parse_args(argv)
    if args.action == "move":
        entry = append_move(args.sub, args.column, args.by, args.note, args.draft, path=queue_path(args.dataset))
        print("queued: move %s to %s by %s (%s)" % (entry["move"], entry["column"], entry["by"], entry["id"]))
        return 0
    entry = append(args.sub, args.by, args.note, path=queue_path(args.dataset), plan=args.plan, kind=args.type)
    print("queued: tick %s by %s (%s)" % (entry["sub"], entry["by"], entry["id"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
