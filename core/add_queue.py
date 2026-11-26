#!/usr/bin/env python3
"""The queue a new task from the Offdesk core waits in until the board adds it.

Nothing outside the board writes todo.md: the board holds the whole document in
the browser and writes all of it back, so a second writer is overwritten within
seconds. So when the PA or an agent asks Bench for a task, through the core's
tools (mcp/, bench_mcp, and the /offdesk/add route in kanban/server.py), the
request lands here, in `data/<board>/add-queue.json`, and the board adds it
when it next loads, through its own edit path (`drainAddQueue()` in
kanban/js/10-reference-sections.js), the way it drains tick-queue.json.

Each entry is one task:

    {"id": "k3x9q2", "by": "ana@example.com via routine:r1", "as": "ana@example.com",
     "at": "2026-11-26T09:30:05",
     "title": "Send the deck", "column": "To do", "bucket": "Work",
     "due": "2026-12-01", "refs": ["binder:org/acme-ltd"]}

`id` is the new task's own `id:`, minted here against every id already in the
list and the queue, so the request is applied once: the board adds a task only
while no task carries that id, and a drain that runs twice, or whose clean-up
was lost, finds the task already there and only clears the entry. `by` is who
asked, as core/core_token.py records it, and `as` whoever it acts for (the
person, or `agent:<name>`), whom the new task is written as created by. An entry the board cannot apply (its
bucket or column has gone since) is kept with `refused` saying why and
`refused_at`, is not tried again, and is pruned 30 days later. At most 100
entries wait on a board at once.

The file is appended to and changed under the same lock tick_queue.py uses,
and the board takes out only the ids it dealt with, so a request that lands
while the board is draining is not written over.
"""

import datetime as dt
import json
import os
import random
import string

from platform_calls import Locked as _Locked

FILE = "add-queue.json"
# At most this many entries wait on one board; past it append() refuses (QueueFull, a 429 at the route). Refused
# entries do not count, and are pruned REFUSED_DAYS after they were refused.
MAX_WAITING = 100
REFUSED_DAYS = 30


class QueueFull(Exception):
    pass
_ALPHABET = string.ascii_lowercase + string.digits


def path_for(board_dir):
    return os.path.join(board_dir, FILE)


def read(path):
    """Every entry, oldest first. Unreadable or hand-broken is empty."""
    try:
        with open(path, encoding="utf-8") as fh:
            got = json.load(fh)
    except (OSError, ValueError):
        return []
    return [e for e in got if isinstance(e, dict)] if isinstance(got, list) else []


def waiting(path):
    """The entries still to be applied: every one not refused."""
    return [e for e in read(path) if not e.get("refused")]


def _write(path, items):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as fh:
        json.dump(items, fh, indent=2)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def _mint(taken):
    """Six characters of base36, the shape of a task's `id:` (mintId() in core/todo.js)."""
    while True:
        key = "".join(random.SystemRandom().choice(_ALPHABET) for _ in range(6))
        if key not in taken and not key.isdigit():
            return key


def _pruned(items, now):
    """Without the refused entries older than REFUSED_DAYS."""
    cut = (now - dt.timedelta(days=REFUSED_DAYS)).replace(microsecond=0).isoformat()
    return [e for e in items if not (e.get("refused") and str(e.get("refused_at") or e.get("at") or "") < cut)]


def append(task, by, taken=(), path=None, now=None, acting_for=""):
    """Queues `task` ({title, column, bucket, due?, refs?}), asked for by `by`.
    `taken` is every id already in the list. Returns the entry, or raises
    QueueFull with MAX_WAITING entries already waiting."""
    now = now or dt.datetime.now()
    with _Locked(path):
        items = _pruned(read(path), now)
        if sum(1 for e in items if not e.get("refused")) >= MAX_WAITING:
            raise QueueFull("%d tasks already wait for this board to load" % MAX_WAITING)
        used = set(taken) | {str(e.get("id")) for e in items}
        entry = {
            "id": _mint(used),
            "by": str(by).strip(),
            "as": str(acting_for or by).strip().lower(),
            "at": now.replace(microsecond=0).isoformat(),
            "title": str(task.get("title") or "").strip(),
            "column": str(task.get("column") or "").strip(),
            "bucket": str(task.get("bucket") or "").strip(),
            "due": str(task.get("due") or "").strip(),
            "refs": [str(r).strip() for r in (task.get("refs") or []) if str(r).strip()],
        }
        items.append(entry)
        _write(path, items)
    return entry


def remove(ids, path):
    """Takes the entries with these ids out, and nothing else."""
    gone = set(str(i) for i in ids)
    with _Locked(path):
        items = read(path)
        keep = [e for e in items if str(e.get("id")) not in gone]
        if len(keep) != len(items):
            _write(path, keep)
    return len(items) - len(keep)


def refuse(reasons, path, now=None):
    """Marks the entries named in `reasons` ({id: why}) as refused, and when, keeping them for REFUSED_DAYS."""
    want = {str(k): str(v)[:200] for k, v in (reasons or {}).items()}
    now = now or dt.datetime.now()
    changed = 0
    with _Locked(path):
        was = read(path)
        items = _pruned(was, now)
        for e in items:
            why = want.get(str(e.get("id")))
            if why and not e.get("refused"):
                e["refused"] = why
                e["refused_at"] = now.replace(microsecond=0).isoformat()
                changed += 1
        if changed or len(items) != len(was):
            _write(path, items)
    return changed
