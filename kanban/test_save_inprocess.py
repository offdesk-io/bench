#!/usr/bin/env python3
"""The save path's edges that need the server in this process to reach.

    python3 kanban/test_save_inprocess.py

kanban/server.py runs in a thread here, over a temp folder, with the list it
saves to and the person asking set by hand. That is how the cases below are
reached at all: a board with no todo.md is never offered by the routes, and
a lock is only visible from inside. The real data/ is never read or written.

What it holds to:

  * the first save to a list with no todo.md yet cannot carry forged authors:
    every task is created by whoever signed in;
  * the board's drain of agent requests holds the save lock while it reads
    the queue, credits the agents and takes the requests out, so no save can
    land between the version it credits from and the removal;
  * an outside writer is never written over: a file still being written (a
    slow, non-atomic write with a pause in it) is left alone until it has
    settled, and a write landing between the server's read and its stamp is
    not replaced by the stamp.
"""

import http.server
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRATCH = tempfile.mkdtemp(prefix="save-inprocess-test-")
os.environ["TODOS_DATA_ROOT"] = os.path.join(SCRATCH, "data")
os.makedirs(os.environ["TODOS_DATA_ROOT"])
sys.path.insert(0, os.path.join(ROOT, "kanban"))
import server  # noqa: E402

PASS = []
FAIL = []


def ok(label, cond, detail=""):
    (PASS if cond else FAIL).append(label if cond else
                                    (label + (" — " + detail if detail else "")))


JEROME = {"email": "jerome@example.com", "name": "Jérôme", "teams": []}


SIGNED = {"X-Offdesk-Email": JEROME["email"], "X-Offdesk-Name": "J%C3%A9r%C3%B4me"}


def put(base, body):
    req = urllib.request.Request(base + "/data/todo.md", method="PUT", data=json.dumps(body).encode(),
                                 headers=dict(SIGNED, **{"Content-Type": "application/json"}))
    try:
        with urllib.request.urlopen(req) as res:
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b"{}")


def first_save(base, folder):
    """A list folder with no todo.md, and a first save carrying forged tags."""
    path = os.path.join(folder, "todo.md")
    forged = ("# To-do\n\n## 1. Tasks\n\n### To do\n\n"
              "- [ ] **Claimed** `created-by:mallory@example.com` `edited-by:mallory@example.com` `id:aaaaaa`\n"
              "  - [ ] A step `created-by:mallory@example.com` `id:s00001`\n")
    code, got = put(base, {"text": forged, "base": ""})
    ok("a first save to a list with no file writes", code == 200 and os.path.exists(path), "%d %r" % (code, got))
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    ok("no forged author survives it", "mallory" not in text, text)
    ok("the task is created by whoever signed in",
       "**Claimed** `created-by:jerome@example.com` `id:aaaaaa`" in text, text)
    ok("and so is its sub-task", "A step `created-by:jerome@example.com` `id:s00001`" in text, text)


def tick_lock(base, folder):
    """The drain's POST, with tick_queue watched from inside: every queue
    operation must run with the save lock held by the thread doing it."""
    import tick_queue
    seen = []
    real_read, real_remove = tick_queue.read, tick_queue.remove

    def read(path=None):
        seen.append(("read", server._save_lock._is_owned()))
        return real_read(path)

    def remove(ids, path=None):
        seen.append(("remove", server._save_lock._is_owned()))
        return real_remove(ids, path)

    server.tick_queue_path = lambda name=None: os.path.join(folder, "tick-queue.json")
    entry = tick_queue.append("s00001", "Implement agent", path=server.tick_queue_path())
    tick_queue.read, tick_queue.remove = read, remove
    try:
        req = urllib.request.Request(base + "/tick-queue.json", method="POST",
                                     data=json.dumps({"done": [entry["id"]]}).encode(),
                                     headers=dict(SIGNED, **{"Content-Type": "application/json", "X-Board": "1"}))
        with urllib.request.urlopen(req) as res:
            got = json.loads(res.read())
    finally:
        tick_queue.read, tick_queue.remove = real_read, real_remove
    ok("the drain removed the request", got.get("removed") == 1, repr(got))
    ok("it read the queue and removed from it", seen[:1] == [("read", True)] and ("remove", True) in seen,
       repr(seen))
    ok("both under the save lock", seen and all(held for _, held in seen), repr(seen))


LIST = ("# To-do\n\n## 1. Tasks\n\n### To do\n\n"
        "- [ ] **One** `id:aaaaaa`\n- [ ] **Two** `id:bbbbbb`\n")


def outside_writers(folder):
    """notice_outside_edit() against writers that do not take the lock."""
    path = os.path.join(folder, "todo.md")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(LIST)
    server.remember("fresh", LIST)
    for f in ("activity.jsonl", "pa-working.json"):
        if os.path.exists(os.path.join(folder, f)):
            os.remove(os.path.join(folder, f))

    # A slow writer: half the new file, a pause longer than the read, the rest.
    new = LIST.replace("**One**", "**One, renamed**") + "- [ ] **Three, added at the end** `id:cccccc`\n"
    half = len(new) // 2
    started = threading.Event()

    def slow():
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(new[:half])
            fh.flush()
            started.set()
            time.sleep(0.6)
            fh.write(new[half:])

    writer = threading.Thread(target=slow)
    writer.start()
    started.wait()
    server.notice_outside_edit("fresh")
    writer.join()
    with open(path, encoding="utf-8") as fh:
        ok("a write still in progress is not written over", fh.read() == new)
    ok("nor logged half-done", not os.path.exists(os.path.join(folder, "activity.jsonl")))
    time.sleep(server.OUTSIDE_QUIET_S + 0.1)
    server.notice_outside_edit("fresh")
    with open(path, encoding="utf-8") as fh:
        now = fh.read()
    ok("once it has settled it is stamped, whole",
       "**One, renamed** `edited-by:pa` `id:aaaaaa`" in now and "Three, added at the end** `created-by:pa`" in now, now)

    # A write landing between the read and the stamp.
    server.remember("fresh", now)
    edited = now.replace("**Two**", "**Two, edited**")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(edited)
    time.sleep(server.OUTSIDE_QUIET_S + 0.1)
    late = edited.replace("**Two, edited**", "**Two, edited again**")
    real = server.todo.stamp_authors

    def stamp_while_written(*a, **k):
        got = real(*a, **k)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(late)
        return got

    server.todo.stamp_authors = stamp_while_written
    try:
        server.notice_outside_edit("fresh")
    finally:
        server.todo.stamp_authors = real
    with open(path, encoding="utf-8") as fh:
        ok("a write landing mid-stamp is not replaced by the stamp", fh.read() == late)


def main():
    folder = os.path.join(os.environ["TODOS_DATA_ROOT"], "fresh")
    os.makedirs(folder)
    server.dataset_dir = lambda name=None: folder
    server.current_dataset = lambda: "fresh"
    server.requester = lambda: JEROME
    server.AUTH = "header"
    httpd = server.BoardHTTPServer(("127.0.0.1", 0), server.Handler)
    base = "http://127.0.0.1:%d" % httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        first_save(base, folder)
        tick_lock(base, folder)
        outside_writers(folder)
    finally:
        httpd.shutdown()
        shutil.rmtree(SCRATCH, ignore_errors=True)

    print("\n%d passed" % len(PASS))
    for f in FAIL:
        print("  FAIL  " + f)
    if FAIL:
        print("\n%d failed\n" % len(FAIL))
        sys.exit(1)
    print("")


if __name__ == "__main__":
    main()
