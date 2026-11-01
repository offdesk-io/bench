#!/usr/bin/env python3
"""Ask for a desktop banner. A shim: the queue belongs to the notifier.

Since 31 Oct 2026 the queue and the script that appends to it live in the
notifier's own folder beside this checkout (bench_root.notify_home(),
~/Code/notify on the owner's Mac), with a poster of its own that drains it
whether or not the board is running. This file stays so that every caller
that reaches it by path, inside Bench and out, keeps working with the same
arguments:

    python3 companion/notify.py "Plan agent" "3 plans written, 2 skipped"
    python3 companion/notify.py --view plans "Plan agent" "3 plans waiting"
    python3 companion/notify.py --task ds-audit "Due today" "The audit is owed"
    python3 companion/notify.py --dataset _test "Title" "Body"

    sys.path.insert(0, ".../companion"); import notify
    notify.queue("Plan agent", "3 plans written", view="plans")

What it adds is Bench's: no dataset means the board on screen
(data/.current), and the queue for a board is the one the board drains,
core/notify_due.queue_file(). That is the notifier's queue for the board when
the notifier is there, and data/<board>/notify-queue.json when it is not (a
checkout without it) or when the data root is a throwaway one ($TODOS_DATA_ROOT,
the test runner's). The append itself is the notifier's notify.queue(), and
without the notifier it is the copy below, which writes the same line under
the same lock.

`task` and `view` say where the banner goes when it is pressed: a card's id or
`#slug`, and one of the board's tabs. The rules for posting (08:30 to 20:00 but
for the `content` board, three a minute, one post per line) are the drainers',
documented in the notifier's README and in core/notify_due.py. It is for things
worth a banner, not for progress: a run that wrote three plans is one line at
the end, not one line a plan.
"""

import contextlib
import datetime as dt
import importlib.util
import json
import os
import sys

try:
    import fcntl
except ImportError:          # no flock off a Unix; appends then rely on os.replace alone
    fcntl = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "core"))
import notify_due  # noqa: E402

MAX_QUEUED = 20
_home = {}


def data_root():
    return os.environ.get("TODOS_DATA_ROOT") or os.path.join(ROOT, "data")


def queue_path(dataset=None):
    if not dataset:
        import dataset as _dataset
        dataset = _dataset.current(data_root())
    return notify_due.queue_file(data_root(), dataset)


def notifier():
    """The notifier's notify module, or None when there is no notifier folder.
    Loaded by path under its own name, since this file is called notify too."""
    path = os.path.join(notify_due.bench_root.notify_home(), "notify.py")
    if path not in _home:
        mod = None
        if os.path.isfile(path):
            try:
                spec = importlib.util.spec_from_file_location("notifier_notify", path)
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)
            except Exception:   # a broken notifier must not stop the line
                mod = None
        _home[path] = mod
    return _home[path]


@contextlib.contextmanager
def queue_lock(path):
    """The notifier's lock on `notify-queue.lock` beside the queue, which the
    board's drain and the poster take too. Never raises."""
    fh = None
    if fcntl is not None:
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            fh = open(os.path.splitext(path)[0] + ".lock", "a")
            fcntl.flock(fh, fcntl.LOCK_EX)
        except OSError:
            if fh:
                fh.close()
            fh = None
    try:
        yield
    finally:
        if fh:
            fcntl.flock(fh, fcntl.LOCK_UN)
            fh.close()


def _append(title, body, task, view, path):
    """The append, for a checkout with no notifier beside it."""
    with queue_lock(path):
        try:
            with open(path, encoding="utf-8") as fh:
                items = json.load(fh)
            if not isinstance(items, list):
                items = []
        except (OSError, ValueError):
            items = []
        entry = {"title": str(title)[:120], "body": str(body)[:400],
                 "queued": dt.datetime.now().isoformat(timespec="seconds")}
        if task:
            entry["task"] = str(task)[:200]
        if view:
            entry["view"] = str(view)[:40]
        items = (items + [entry])[-MAX_QUEUED:]
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8", newline="") as fh:
                json.dump(items, fh, indent=2)
            os.replace(tmp, path)
        except OSError:
            return None
    return path


def queue(title, body, dataset=None, task=None, view=None, path=None):
    """Append one line. Returns the path, or None if it could not be written.

    `path` names the queue file outright, for a caller that already resolves
    it (paths.notify_queue_path() in the agents, under $TODOS_DATA_ROOT).
    Never raises."""
    try:
        path = path or queue_path(dataset)
    except Exception:
        return None
    mod = notifier()
    if mod is not None:
        return mod.queue(title, body, task=task, view=view, path=path)
    return _append(title, body, task, view, path)


def main(argv):
    opts = {"--dataset": None, "--task": None, "--view": None}
    while len(argv) > 1 and argv[0] in opts:
        opts[argv[0]], argv = argv[1], argv[2:]
    if len(argv) < 2:
        print(__doc__.strip().splitlines()[0], file=sys.stderr)
        print('usage: notify.py [--dataset NAME] [--task KEY] [--view NAME] '
              '"Title" "Body"', file=sys.stderr)
        return 2
    path = queue(argv[0], argv[1], opts["--dataset"],
                 task=opts["--task"], view=opts["--view"])
    if not path:
        print("could not write the queue", file=sys.stderr)
        return 1
    print("queued: posted within a minute in the 08:30 to 20:00 window, "
          "by the notifier's poster or the board, whichever is running")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
