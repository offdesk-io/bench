"""Checks for core/add_queue.py, the queue new tasks from the Offdesk core wait in.

    python3 core/test_add_queue.py

A throwaway folder only; nothing under data/ is read or written.
"""

import datetime as dt
import json
import os
import shutil
import sys
import tempfile
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import add_queue  # noqa: E402

FAILED = []


def ok(label, cond, detail=""):
    print("  %s %s%s" % ("ok  " if cond else "FAIL", label, "" if cond else "  (%s)" % detail))
    if not cond:
        FAILED.append(label)


def main():
    tmp = tempfile.mkdtemp(prefix="add-queue-test-")
    try:
        path = os.path.join(tmp, "work", "add-queue.json")
        ok("no file is an empty queue", add_queue.read(path) == [])
        now = dt.datetime(2026, 11, 26, 9, 30, 5, 123)
        e = add_queue.append({"title": "Send the deck", "column": "To do", "bucket": "Work", "due": "2026-12-01",
                              "refs": ["binder:org/acme-ltd"]}, by="ana@example.com via routine:r1",
                             taken={"aaaaaa"}, path=path, now=now)
        ok("an entry has its id, who and when", len(e["id"]) == 6 and e["by"] == "ana@example.com via routine:r1"
           and e["at"] == "2026-11-26T09:30:05", e)
        ok("and what was asked for", e["title"] == "Send the deck" and e["column"] == "To do"
           and e["bucket"] == "Work" and e["due"] == "2026-12-01" and e["refs"] == ["binder:org/acme-ltd"], e)
        ok("the id is the new task's, never one already taken", e["id"] != "aaaaaa")
        e2 = add_queue.append({"title": "Two", "column": "Backlog", "bucket": "Work"}, by="agent:digest",
                              taken=set(), path=path)
        ok("a second entry gets an id of its own", e2["id"] != e["id"])
        ok("with no due and no refs", e2["due"] == "" and e2["refs"] == [], e2)
        got = add_queue.read(path)
        ok("both wait, oldest first", [x["id"] for x in got] == [e["id"], e2["id"]], got)

        ok("a refused entry stays, with its reason",
           add_queue.refuse({e2["id"]: "no column Backlog in Work"}, path) == 1)
        got = add_queue.read(path)
        ok("and says why", got[1].get("refused") == "no column Backlog in Work", got)
        ok("waiting() leaves refused entries out", [x["id"] for x in add_queue.waiting(path)] == [e["id"]])
        ok("refusing an id that is not there changes nothing", add_queue.refuse({"zzzzzz": "x"}, path) == 0)

        ok("removing takes out only those ids", add_queue.remove([e["id"]], path) == 1)
        ok("and leaves the rest", [x["id"] for x in add_queue.read(path)] == [e2["id"]])
        ok("removing it again is nothing", add_queue.remove([e["id"]], path) == 0)

        with open(path, "w") as fh:
            fh.write("not json")
        ok("a broken file reads as empty", add_queue.read(path) == [])
        with open(path, "w") as fh:
            json.dump([{"id": "abcdef"}, 5, "x"], fh)
        ok("only objects are entries", add_queue.read(path) == [{"id": "abcdef"}])

        os.remove(path)
        threads = [threading.Thread(target=add_queue.append, args=({"title": "T%d" % i, "column": "To do",
                                                                     "bucket": "Work"}, "ana@example.com"),
                                    kwargs={"taken": set(), "path": path}) for i in range(20)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(10)
        got = add_queue.read(path)
        ok("twenty appends at once all land, under the lock", len(got) == 20 and len({x["id"] for x in got}) == 20,
           len(got))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if FAILED:
        print("%d failed" % len(FAILED))
        sys.exit(1)
    print("all checks passed")


if __name__ == "__main__":
    main()
