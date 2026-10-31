#!/usr/bin/env python3
"""Two saves on one list, merged by the server rather than refused.

    python3 kanban/test_merge_save.py

No browser. It starts kanban/server.py itself on free ports (never 8765 or
8766) over a throwaway data root, once as the Mac board and once signed in
with BENCH_AUTH=header and a board two people share, and saves the way the
board does: {text, base} as JSON. The real data/ is never read or written.

What it holds to:

  * a save built on the version on disk is written as sent;
  * two saves built on one version, on different tasks, both land, whichever
    arrives second, and so do the same task's different fields;
  * the same field changed apart is a 409 naming the task and field, carrying
    the file as it stands, and nothing is written; nor for a task deleted on
    one side and edited on the other;
  * the answer to a conflict saves, built on the file the 409 carried;
  * two saves sent at the same moment are taken one at a time, so neither
    is written over unseen;
  * the reply says which version it wrote, matching a read straight after;
  * a save naming the list it was read from writes, and one naming another
    list is a 409 naming the list the board is on, with nothing written;
  * a bare document (a script, a tab from before this) is still refused when
    the file moved under it, and still needs If-Unmodified-Since.
"""

import json
import os
import re
import shutil
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "core"))
from test_board_access import Server, seed, access, as_json, write, TIAGO, JEROME  # noqa: E402
import todo  # noqa: E402

PASS = []
FAIL = []


def ok(label, cond, detail=""):
    (PASS if cond else FAIL).append(label if cond else
                                    (label + (" — " + detail if detail else "")))


LIST = """# To-do

## 1. Tasks

### To do

- [ ] **Write the brief** [impact:: high] [due:: 2026-10-30] `id:aaaaaa`
- [ ] **Book the venue** [impact:: med] `id:bbbbbb`
  - [ ] Call the venue `id:s00001`
- [ ] **Order badges** `id:cccccc`

### Done

"""


# Signed in, every save also says who wrote and changed each task
# (test_authorship.py). What is merged is compared without that.
AUTHORS = re.compile(r" `(?:created-by|edited-by):[^`]*`")


def plain(text):
    return AUTHORS.sub("", text or "")


def edit(text, *pairs):
    for old, new in pairs:
        assert old in text, old
        text = text.replace(old, new)
    return text


def checks(srv, path, who, label):
    """Every case, against one server. `who` is the sign-in headers, or {}."""
    board = dict(who, **{"X-Board": "1", "Content-Type": "application/json"})

    def reset():
        write(path, LIST)

    def save(text, base):
        code, body, _ = srv.ask("PUT", "/data/todo.md", board, {"text": text, "base": base})
        return code, as_json(body) or {}

    def save_on(text, base, name):
        code, body, _ = srv.ask("PUT", "/data/todo.md", board, {"text": text, "base": base, "board": name})
        return code, as_json(body) or {}

    def disk():
        with open(path, encoding="utf-8") as fh:
            return plain(fh.read())

    # --- built on the version on disk ------------------------------------------
    reset()
    mine = edit(LIST, ("[due:: 2026-10-30]", "[due:: 2026-11-02]"))
    code, got = save(mine, LIST)
    ok("%s: a save on the current version writes" % label, code == 200 and disk() == mine, "%d %r" % (code, got))
    ok("%s: and is not called merged" % label, not got.get("merged"), repr(got))
    code, _, head = srv.ask("HEAD", "/data/todo.md", who)
    ok("%s: the reply names the version written" % label,
       got.get("hash") == head.get("X-Todo-Hash") and got.get("disk") == head.get("Last-Modified"),
       "%r vs %s %s" % (got, head.get("X-Todo-Hash"), head.get("Last-Modified")))

    # --- two saves on different tasks -------------------------------------------
    reset()
    first = edit(LIST, ("**Order badges**", "**Order name badges**"))
    second = edit(LIST, ("[due:: 2026-10-30]", "[due:: 2026-11-02]"))
    save(first, LIST)
    code, got = save(second, LIST)
    both = edit(LIST, ("**Order badges**", "**Order name badges**"), ("[due:: 2026-10-30]", "[due:: 2026-11-02]"))
    ok("%s: two saves on different tasks both land" % label, code == 200 and disk() == both,
       "%d %r\n%s" % (code, got, disk()))
    ok("%s: the second is called merged, with what was written" % label,
       got.get("merged") is True and plain(got.get("text")) == both, repr(got))

    # --- the same task, different fields ---------------------------------------
    reset()
    save(edit(LIST, ("[impact:: high]", "[impact:: low]")), LIST)
    code, got = save(edit(LIST, ("[due:: 2026-10-30]", "[due:: 2026-11-02]")), LIST)
    ok("%s: the same task's different fields both land" % label,
       code == 200 and "- [ ] **Write the brief** [impact:: low] [due:: 2026-11-02] `id:aaaaaa`" in disk(),
       "%d %r" % (code, got))

    # --- the same field ----------------------------------------------------------
    reset()
    theirs = edit(LIST, ("[due:: 2026-10-30]", "[due:: 2026-11-05]"))
    save(theirs, LIST)
    mine = edit(LIST, ("[due:: 2026-10-30]", "[due:: 2026-11-02]"))
    code, got = save(mine, LIST)
    ok("%s: the same field changed apart is a 409" % label, code == 409, "%d %r" % (code, got))
    ok("%s: naming the task and the field" % label,
       got.get("conflicts") == [{"task": "Write the brief", "step": "", "field": "due"}], repr(got))
    ok("%s: carrying the file as it stands" % label, plain(got.get("current")) == theirs, repr(got)[:200])
    ok("%s: and nothing is written" % label, disk() == theirs)

    # Answered: the tab merges with its choice and saves on the file it was given.
    current = got.get("current") or ""
    answer = todo.merge_saves(LIST, mine, current, "mine")["text"]
    code, got = save(answer, current)
    ok("%s: the answer to a conflict saves" % label, code == 200 and disk() == mine, "%d %r" % (code, got))

    # --- a sub-task's field ------------------------------------------------------
    reset()
    save(edit(LIST, ("Call the venue", "Call the venue [due:: 2026-10-28]")), LIST)
    code, got = save(edit(LIST, ("Call the venue", "Call the venue [due:: 2026-10-29]")), LIST)
    ok("%s: a sub-task's same field is a conflict naming the sub-task" % label,
       code == 409 and got.get("conflicts") == [{"task": "Book the venue", "step": "Call the venue",
                                                 "field": "due"}], "%d %r" % (code, got))

    # --- deleted against edited ------------------------------------------------
    reset()
    save(edit(LIST, ("**Order badges**", "**Order name badges**")), LIST)
    code, got = save(edit(LIST, ("- [ ] **Order badges** `id:cccccc`\n", "")), LIST)
    ok("%s: deleted here, edited there is a conflict" % label,
       code == 409 and got.get("conflicts") == [{"task": "Order name badges", "step": "", "field": "deleted"}],
       "%d %r" % (code, got))
    ok("%s: and the edited task is still on disk" % label, "Order name badges" in disk())

    # --- two at once -------------------------------------------------------------
    reset()
    a = edit(LIST, ("**Order badges**", "**Order name badges**"))
    b = edit(LIST, ("[due:: 2026-10-30]", "[due:: 2026-11-02]"))
    codes = []
    threads = [threading.Thread(target=lambda t=t: codes.append(save(t, LIST)[0])) for t in (a, b)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    ok("%s: two saves at once both land" % label, codes == [200, 200] and disk() == both,
       "%r\n%s" % (codes, disk()))

    # --- the list the save names -------------------------------------------------
    name = os.path.basename(os.path.dirname(path))
    reset()
    mine = edit(LIST, ("**Order badges**", "**Order name badges**"))
    code, got = save_on(mine, LIST, name)
    ok("%s: a save naming this list writes" % label, code == 200 and disk() == mine, "%d %r" % (code, got))
    reset()
    code, got = save_on(mine, LIST, "another-list")
    ok("%s: a save naming another list is refused" % label, code == 409 and got.get("wrongBoard") is True,
       "%d %r" % (code, got))
    ok("%s: naming the list the board is on" % label, got.get("board") == name, repr(got))
    ok("%s: and nothing is written" % label, disk() == LIST)

    # --- the old contract, for a bare document --------------------------------
    reset()
    code, body, head = srv.ask("GET", "/data/todo.md", who)
    stamp, digest = head.get("Last-Modified"), head.get("X-Todo-Hash")
    write(path, edit(LIST, ("**Order badges**", "**Order name badges**")))
    bare = dict(who, **{"X-Board": "1", "Content-Type": "text/markdown; charset=utf-8",
                         "If-Unmodified-Since": stamp, "If-Match": digest})
    code, _, _ = srv.ask("PUT", "/data/todo.md", bare, LIST.encode())
    ok("%s: a bare document on a moved file is still refused" % label, code == 409, "got %d" % code)
    code, _, _ = srv.ask("PUT", "/data/todo.md", dict(who, **{"X-Board": "1"}), LIST.encode())
    ok("%s: and still needs If-Unmodified-Since" % label, code == 428, "got %d" % code)
    code, _, _ = srv.ask("PUT", "/data/todo.md", board, {"text": LIST})
    ok("%s: as does JSON with no base" % label, code == 428, "got %d" % code)


def main():
    root = tempfile.mkdtemp(prefix="merge-save-test-")
    try:
        data = os.path.join(root, "mac")
        seed(data, "tasks", LIST)
        srv = Server(data, None)
        ok("Mac server starts", srv.wait())
        try:
            checks(srv, os.path.join(data, "tasks", "todo.md"), {}, "Mac")
        finally:
            srv.stop()

        data = os.path.join(root, "signed-in")
        seed(data, "offdesk", LIST)
        access(data, "offdesk", TIAGO["X-Offdesk-Email"], people=[JEROME["X-Offdesk-Email"]])
        srv = Server(data, "header")
        ok("signed-in server starts", srv.wait())
        try:
            checks(srv, os.path.join(data, "offdesk", "todo.md"), JEROME, "signed in")
        finally:
            srv.stop()
    finally:
        shutil.rmtree(root, ignore_errors=True)

    print("\n%d passed" % len(PASS))
    for f in FAIL:
        print("  FAIL  " + f)
    if FAIL:
        print("\n%d failed\n" % len(FAIL))
        sys.exit(1)
    print("")


if __name__ == "__main__":
    main()
