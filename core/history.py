#!/usr/bin/env python3
"""Each task's history: which specialist an owning agent brought in, and when.

The PA and the bucket agents own tasks. A specialist never does: it is called in
to give a view or do part of the work and hand the task back. So the only
record that one touched a task is a line here, in
`data/<dataset>/history.jsonl`, one JSON object a line:

    {"at": "2026-09-27T02:14:09", "about": "task:ab12cd", "by": "Work ds agent",
     "kind": "call", "called": "work-people-agent", "bucket": "people",
     "did": "work", "note": "wrote the plan"}

The shape is PACKAGES/work-streams/CONTRACT.md's "An item's history". Written
by the agents, read by the board through `/history.json` (kanban/server.py),
and never read back to decide anything. It is appended to and never rewritten,
one `write` a line, which is what lets more than one agent write it without a
lock: two at once give two whole lines.

It is not todo.md, and writing here is not writing the list.

    python3 core/history.py call ab12cd --by "Work ds agent" --called work-people-agent --did view
"""

import argparse
import datetime as dt
import json
import os
import sys

import dataset as _dataset

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# $TODOS_DATA_ROOT moves the datasets, as it does for kanban/server.py.
DATA_ROOT = os.environ.get("TODOS_DATA_ROOT") or os.path.join(ROOT, "data")

DID = ("view", "work")


def current_dataset():
    return _dataset.current(DATA_ROOT)


def history_path(dataset=None):
    return os.path.join(DATA_ROOT, dataset or current_dataset(), "history.jsonl")


def call(task_id, by, called, did="work", bucket="", note="", path=None, now=None):
    """Records that `by` brought `called` in on task `task_id`. Returns the event,
    or None when there is nothing to record against: a task with no id, or a
    call an owner made to itself."""
    task_id = str(task_id or "").strip().lower()
    by, called = str(by or "").strip(), str(called or "").strip()
    if not task_id or not by or not called or called == by:
        return None
    event = {
        "at": (now or dt.datetime.now()).replace(microsecond=0).isoformat(),
        "about": "task:" + task_id,
        "by": by,
        "kind": "call",
        "called": called,
        "did": did if did in DID else "work",
    }
    if bucket:
        event["bucket"] = str(bucket)
    if note:
        event["note"] = " ".join(str(note).split())[:500]
    path = path or history_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    line = (json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8")
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    try:
        os.write(fd, line)
    finally:
        os.close(fd)
    return event


def read(path=None, about=None):
    """Every event, oldest first, or only those about one task (`ab12cd` or
    `task:ab12cd`). A line that is not a JSON object is skipped; a missing file
    is an empty history."""
    want = None
    if about:
        want = str(about).strip().lower()
        if ":" not in want:
            want = "task:" + want
    out = []
    try:
        with open(path or history_path(), encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(ev, dict):
                    continue
                if want and ev.get("about") != want:
                    continue
                out.append(ev)
    except OSError:
        return []
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("call", help="record a specialist brought in on a task")
    c.add_argument("task")
    c.add_argument("--by", required=True)
    c.add_argument("--called", required=True)
    c.add_argument("--did", choices=DID, default="work")
    c.add_argument("--bucket", default="")
    c.add_argument("--note", default="")
    r = sub.add_parser("read", help="print a task's history, or all of it")
    r.add_argument("task", nargs="?")
    a = ap.parse_args(argv)
    if a.cmd == "call":
        ev = call(a.task, a.by, a.called, did=a.did, bucket=a.bucket, note=a.note)
        print(json.dumps(ev) if ev else "nothing recorded")
        return 0 if ev else 1
    for ev in read(about=a.task):
        print(json.dumps(ev))
    return 0


if __name__ == "__main__":
    sys.exit(main())
