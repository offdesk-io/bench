#!/usr/bin/env python3
"""Starts a board's bucket agents as soon as a task is handed to one.

A bucket whose agent is `start: on-assign` (core/bucket_agents.py) begins when
a task is handed to it, rather than at the hours set for the board. The hourly
wake (agents-engine's, through agents/bucket-agent/agent.json) only comes
round once an hour and only in those hours, so the board server runs this
alongside its banners: a thread that ticks once a minute and, for each board,
asks the runner whether an on-assign bucket holds work it would run now.

    agents/bucket-agent/run.py --pending --target <board>   what it would run, as JSON
    agents/bucket-agent/run.py --now --target <board>       the run, with
                                                            BUCKET_AGENT_TRIGGER=on-assign

The runner decides everything about the work: readiness, the board's agents
switch, the hours of a scheduled bucket, what is already done. This only
decides when to ask, and keeps two runs on one board from overlapping, three
ways: one run at a time per board from this thread, no start while the
runner's own lock for the board is held by a live process (a scheduled run,
or Run now on the dashboard), and the runner taking that same lock itself.

One thread per data root: a second board server started on the same data
(a second checkout, a second copy of the app) finds the root claimed by a lock
held for the first server's lifetime and starts none of its own, so the two
never start runs side by side.

It never starts on a throwaway data root (TODOS_DATA_ROOT set, the test
runner's), with BENCH_AGENTS=0, off a Mac, or where `claude` cannot be found:
the agents have only ever run on the owner's Mac, and the agency server runs
the board too.
"""

import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bucket_agents  # noqa: E402
import dataset as _dataset  # noqa: E402
import settings  # noqa: E402

ROOT = os.path.dirname(HERE)
AGENT_DIR = os.path.join(ROOT, "agents", "bucket-agent")
RUN = os.path.join(AGENT_DIR, "run.py")
TICK_SECONDS = 60
PENDING_TIMEOUT = 120
TRIGGER_ENV = "BUCKET_AGENT_TRIGGER"
STATUS = {"last_tick": None, "running": {}}


def lock_path(data_root, board):
    """The runner's lock for one board. A directory holding the pid of the run
    that holds it (agents_engine/runner/lock.py)."""
    return os.path.join(data_root, ".bucket-agent-%s.lock" % board)


def _alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, TypeError, ValueError):
        return False


def held(path):
    """Whether a live process holds the lock at `path`."""
    try:
        with open(os.path.join(path, "pid"), encoding="utf-8") as fh:
            pid = int(fh.read().strip() or 0)
    except (OSError, ValueError):
        return os.path.isdir(path)
    return bool(pid) and _alive(pid)


def enabled():
    if os.environ.get("BENCH_AGENTS") == "0" or os.environ.get("TODOS_DATA_ROOT"):
        return False
    if sys.platform != "darwin":
        return False
    return bool(shutil.which(os.environ.get("AGENTS_RUNNER_CLAUDE") or "claude"))


def assigned(data_root, board):
    """Whether todo.md names an on-assign bucket's agent in a `[to::]`. A cheap
    look before the runner is asked, so a quiet board costs a file read."""
    names = [d["name"] for d in bucket_agents.all_buckets(board, data_root) if d["start"] == "on-assign"]
    if not names:
        return False
    try:
        with open(os.path.join(data_root, board, "todo.md"), encoding="utf-8") as fh:
            text = fh.read().lower()
    except OSError:
        return False
    return any(re.search(r"\[to::\s*%s\s*\]" % re.escape(n.lower()), text) for n in names)


def ask_pending(board):
    """The runner's answer for one board: {"run": [titles], "skipped": [[title, why]]}."""
    try:
        out = subprocess.run([sys.executable, RUN, "--pending", "--target", board], cwd=AGENT_DIR,
                             capture_output=True, text=True, timeout=PENDING_TIMEOUT)
        return json.loads(out.stdout or "{}")
    except (OSError, ValueError, subprocess.SubprocessError):
        return {}


def launch(board, data_root):
    """One run of the board's bucket agents, detached, its output in the runner's log."""
    env = dict(os.environ, **{TRIGGER_ENV: "on-assign"})
    state = os.path.join(data_root, "runner", "bucket-agent")
    os.makedirs(state, exist_ok=True)
    log = open(os.path.join(state, "runner.log"), "a", encoding="utf-8")
    return subprocess.Popen([sys.executable, RUN, "--now", "--target", board], cwd=AGENT_DIR, env=env,
                            stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True)


def tick(data_root, boards, running, seen, log=print, pending=ask_pending, start=None):
    """One pass over every board. `running` maps a board to the process this
    thread started for it, `seen` to the skip lines already logged. Returns the
    boards a run was started on."""
    started = []
    for board in boards:
        proc = running.get(board)
        if proc is not None and proc.poll() is None:
            continue
        running.pop(board, None)
        try:
            if not settings.agents_on(board, data_root) or held(lock_path(data_root, board)):
                continue
            if not assigned(data_root, board):
                seen.pop(board, None)
                continue
        except (OSError, ValueError):
            continue
        got = pending(board) or {}
        skipped = {(t, w) for t, w in got.get("skipped") or []}
        for title, why in sorted(skipped - seen.get(board, set())):
            log("bucket agents: %s: not starting %r, %s" % (board, title, why))
        seen[board] = skipped
        if got.get("run"):
            running[board] = (start or (lambda b: launch(b, data_root)))(board)
            started.append(board)
            log("bucket agents: %s: started for %s" % (board, "; ".join(got["run"])))
    STATUS["running"] = {b: getattr(p, "pid", None) for b, p in running.items()}
    return started


# The open lock file of the data root this process claimed, kept for its lifetime.
_CLAIMED = {}


def claim(data_root):
    """Take `.bucket-wake.lock` in the data root for this process's lifetime.
    True when it is now ours. False when another live process holds it, or this
    one already does, so one process never runs two threads either. The lock
    goes with the process, so a server that dies leaves nothing to clear."""
    path = os.path.join(data_root, ".bucket-wake.lock")
    if path in _CLAIMED:
        return False
    try:
        fh = open(path, "a")
    except OSError:
        return False
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        fh.close()
        return False
    _CLAIMED[path] = fh
    return True


def release(data_root):
    """Give the data root back. For the tests; a server never calls it."""
    fh = _CLAIMED.pop(os.path.join(data_root, ".bucket-wake.lock"), None)
    if fh:
        fh.close()


def start(data_root, list_boards=None, log=print):
    """Start the daemon thread that ticks every minute. Returns it, or None
    when this machine should not run agents (see enabled()) or another server
    already runs the wake on this data root (claim())."""
    if not enabled():
        return None
    if not claim(data_root):
        log("bucket agents: another board server already starts the on-assign agents on %s" % data_root)
        return None
    list_boards = list_boards or (lambda: _dataset.names(data_root))
    guard = threading.Lock()

    def loop():
        import datetime as dt
        stop = threading.Event()
        running, seen = {}, {}
        while True:
            with guard:
                try:
                    STATUS["last_tick"] = dt.datetime.now()
                    tick(data_root, list_boards(), running, seen, log)
                except Exception as err:   # a bad tick must not end the thread
                    log("bucket agents: tick failed: %r" % err)
            if stop.wait(TICK_SECONDS):
                return

    thread = threading.Thread(target=loop, name="bucket-wake", daemon=True)
    thread.start()
    return thread
