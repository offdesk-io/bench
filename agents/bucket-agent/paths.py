#!/usr/bin/env python3
"""Where everything the bucket agents' runner touches lives.

One module so that the list a run is for is read in one place. Every path
below hangs off a list's name, and that name comes from one of three places,
in order: `using()` around the call, `$PLANNING_DATASET` in the environment,
then `data/.current`. The variable keeps the Plan agent's name, because the
board server and the scripts brief.py and report.py run under already set it.

The runner answers about several lists in one process (one target per board),
so hooks.py sets the variable for whichever list a hook is answering about and
every function here follows it.
"""

import contextlib
import os
import sys

_CORE = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "core")
sys.path.insert(0, _CORE)
import bench_root  # noqa: E402
ROOT = bench_root.root()
sys.path.insert(0, os.path.join(ROOT, "core"))
import dataset as _dataset  # noqa: E402
# The folder the lists sit in. $TODOS_DATA_ROOT moves it, the same variable
# kanban/server.py reads, so a test over a scratch root never has this module
# look at the real lists behind it.
DATA_ROOT = os.environ.get("TODOS_DATA_ROOT") or os.path.join(ROOT, "data")

_ACTIVE = None


def pointer():
    """What `data/.current` says, ignoring both overrides."""
    return _dataset.current(DATA_ROOT)


def dataset():
    return _ACTIVE or os.environ.get("PLANNING_DATASET") or pointer()


@contextlib.contextmanager
def using(name):
    """Point every path below at one list for the length of a block."""
    global _ACTIVE
    before = _ACTIVE
    _ACTIVE = name
    try:
        yield name
    finally:
        _ACTIVE = before


def datasets():
    """Every list under DATA_ROOT with a todo.md, less fixtures (a leading
    underscore), sorted. See core/dataset.py."""
    return _dataset.names(DATA_ROOT)


def data_dir():
    return os.path.join(DATA_ROOT, dataset())


def todo_path():
    return os.path.join(data_dir(), "todo.md")


def known_todo_path():
    """The version of todo.md the board server last wrote or accounted for
    (known_path() in kanban/server.py). Read by plans.todo_moved()."""
    return os.path.join(data_dir(), ".known-todo.md")


def activity_path():
    """The board's activity log, one JSON line per change it saved
    (activity_path() in kanban/server.py)."""
    return os.path.join(data_dir(), "activity.jsonl")


def tick_queue_path():
    """Where a finished sub-task is asked to be ticked. See core/tick_queue.py."""
    return os.path.join(data_dir(), "tick-queue.json")


def history_path():
    return os.path.join(data_dir(), "history.jsonl")


def agent_runs_path():
    """Where each agent run on a sub-task stands. See core/agent_runs.py."""
    return os.path.join(data_dir(), "agent-runs.json")


def notify_queue_path():
    """The banner queue for this list. See core/notify_due.py."""
    import notify_due
    return notify_due.queue_file(DATA_ROOT, dataset())


def buckets_dir():
    return os.path.join(data_dir(), "buckets")


def plans_dir():
    return os.path.join(data_dir(), "plans")


def briefings_path():
    """Where brief.py leaves what it has worked out about each task, which the
    board's chat and the pa skill read (briefings_path() in kanban/server.py)."""
    return os.path.join(data_dir(), "briefings.json")


def window_path():
    """The usage window's last known reset, shared with the Plan agent's
    record of it so the board's usage chart keeps one source."""
    return os.path.join(plans_dir(), "window.json")


def log_path():
    return os.path.join(plans_dir(), "bucket-agent.log")


def attach_queue_path():
    return os.path.join(data_dir(), "attach-queue.json")
