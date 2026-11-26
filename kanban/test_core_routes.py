#!/usr/bin/env python3
"""The routes the Offdesk core's tools use, under /offdesk/, with the core's token.

    python3 kanban/test_core_routes.py

No browser. It starts kanban/server.py as a process on free ports (never 8765
or 8766) over a throwaway data root, signed in (BENCH_AUTH=header) and on the
Mac (BENCH_AUTH unset), with BENCH_CORE_TOKEN_KEY set and without, and talks
to it the way bench_mcp does: `Authorization: Bearer <token>` and `X-Board: 1`.
The real data/ and data/.current are never read or written.

What it holds to:

  * /offdesk/ answers only with a good token: none, a bad one, an expired one and
    any token while the key is unset are 401, and sign-in headers never stand
    in for one there; a bad key refuses to start;
  * everywhere else the Authorization header changes nothing;
  * a person sees the boards access.json lets them see (named, or through the
    teams they last signed in with), an agent of the team only boards that
    list it under `agents`, and a board outside that is a 404 like one that
    does not exist;
  * a board's tasks, by column, bucket or due date, and one task's detail with
    its sub-tasks and references, the lead read as binder:org/<slug>;
  * an add is queued in add-queue.json with who asked (a routine as
    `<email> via routine:<id>`), checked first (bucket, column, title, date,
    refs), and never writes todo.md;
  * a tick is queued in tick-queue.json, only for a sub-task assigned to
    whoever the token acts for, and never writes todo.md;
  * the board's own drain routes for the add queue read and clear it.
"""

import base64
import hashlib
import hmac
import json
import os
import shutil
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "core"))
from test_board_access import Server, as_json, seed  # noqa: E402
import board_access  # noqa: E402

PASS, FAIL = [], []
KEY = bytes(range(32))
# This checkout's server, whatever BENCH_ROOT the shell running the suite names.
HERE_ROOT = {"BENCH_ROOT": os.path.dirname(HERE)}
BOARD = {"X-Board": "1", "Content-Type": "application/json"}
TODO = """# To-do

## 1. Work

### Done

### Reviewing

### Doing

- [ ] **Send the deck** [impact:: high] [effort:: S] [due:: 2026-12-01] [lead:: acme-studio] [ref:: calls:call/x-1] `id:aaaaaa`
  - Background in the shared folder.
  - [ ] Draft it [to:: ana@example.com] `id:s00001`
  - [ ] Check it [to:: rui@example.com] `id:s00002`
  - [x] Book the room [to:: ana@example.com] `done:2026-11-20` `id:s00003`
  - [ ] Ask the digest [to:: agent:digest] `id:s00004`
  - [ ] Nobody's step `id:s00005`

### To do

- [ ] **Order badges** [due:: 2026-11-28] `id:bbbbbb`

### Backlog

- [ ] **Someday** `id:cccccc`

---

## 2. Home

### To do

- [ ] **Fix the shelf** [due:: 2026-12-20] `id:dddddd`
"""


def ok(label, cond, detail=""):
    print("  %s %s%s" % ("ok  " if cond else "FAIL", label, "" if cond else "  — %s" % detail))
    (PASS if cond else FAIL).append(label)


def b64(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def token(sub="ana@example.com", agent="pa", exp=None, key=KEY):
    body = b64(json.dumps({"sub": sub, "agent": agent, "exp": exp or int(time.time()) + 300},
                          separators=(",", ":")).encode())
    return body + "." + b64(hmac.new(key, body.encode(), hashlib.sha256).digest())


def bearer(sub="ana@example.com", agent="pa", **kw):
    return {"Authorization": "Bearer " + token(sub, agent, **kw)}


def setup(data):
    seed(data, "work", TODO)
    seed(data, "private", "# To-do\n\n## 1. Mine\n\n### To do\n\n- [ ] **Secret** `id:eeeeee`\n")
    seed(data, "open", "# To-do\n\n## 1. Open\n\n### To do\n\n- [ ] **Shared** `id:ffffff`\n")
    board_access.write(os.path.join(data, "work"), {"owner": "owner@example.com", "people": ["ana@example.com"],
                                                    "teams": [], "agents": ["digest"]})
    board_access.write(os.path.join(data, "private"), {"owner": "owner@example.com", "people": [], "teams": []})
    board_access.write(os.path.join(data, "open"), {"owner": "owner@example.com", "people": [],
                                                    "teams": ["offdesk"]})


def read(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return None


def token_checks(srv, data):
    for name, headers in (("no token", {}), ("a bad one", bearer(key=b"x" * 32)),
                          ("an expired one", bearer(exp=int(time.time()) - 5)),
                          ("not a bearer", {"Authorization": "Basic " + token()}),
                          ("sign-in headers instead", {"X-Offdesk-Email": "ana@example.com",
                                                       "X-Offdesk-Teams": "offdesk"})):
        code, _, _ = srv.ask("GET", "/offdesk/boards.json", headers)
        ok("/offdesk/ with %s is 401" % name, code == 401, "got %d" % code)
    code, body, _ = srv.ask("GET", "/offdesk/boards.json", bearer("routine:r1"))
    ok("a sub that is neither a person nor agent:<name> is 401", code == 401, "got %d %s" % (code, body))
    code, _, _ = srv.ask("POST", "/offdesk/add", dict(bearer()), {"board": "work", "title": "x"})
    ok("a POST without X-Board is 403", code == 403, "got %d" % code)


def read_checks(srv, data):
    code, body, _ = srv.ask("GET", "/offdesk/boards.json", bearer())
    got = as_json(body) or {}
    names = [b["name"] for b in got.get("boards", [])]
    ok("Ana sees the board that names her, and no other", code == 200 and names == ["work"], body)
    work = got["boards"][0] if got.get("boards") else {}
    ok("with its buckets and their columns",
       [b["name"] for b in work.get("buckets", [])] == ["Work", "Home"]
       and "To do" in work["buckets"][0]["columns"], work)
    board_access.remember_person(data, "rui@example.com", "Rui", ["offdesk"])
    code, body, _ = srv.ask("GET", "/offdesk/boards.json", bearer("rui@example.com"))
    names = [b["name"] for b in (as_json(body) or {}).get("boards", [])]
    ok("Rui sees the team's board through the teams he last signed in with", names == ["open"], body)
    code, body, _ = srv.ask("GET", "/offdesk/boards.json", bearer("agent:digest", "digest"))
    names = [b["name"] for b in (as_json(body) or {}).get("boards", [])]
    ok("the digest agent sees only the board listing it", names == ["work"], body)
    code, body, _ = srv.ask("GET", "/offdesk/boards.json", bearer("agent:helper", "helper"))
    ok("another agent sees none", (as_json(body) or {}).get("boards") == [], body)

    code, body, _ = srv.ask("GET", "/offdesk/tasks.json?board=private", bearer())
    ok("a board outside Ana's access is a 404", code == 404, "got %d" % code)
    code, body2, _ = srv.ask("GET", "/offdesk/tasks.json?board=nothing", bearer())
    ok("the same as one that does not exist", code == 404 and as_json(body) == as_json(body2), body2)

    code, body, _ = srv.ask("GET", "/offdesk/tasks.json?board=work", bearer())
    tasks = (as_json(body) or {}).get("tasks", [])
    ok("every open task on the board", [t["id"] for t in tasks] == ["aaaaaa", "bbbbbb", "cccccc", "dddddd"], body)
    deck = tasks[0] if tasks else {}
    ok("each with its bucket, column, dates and references",
       deck.get("bucket") == "Work" and deck.get("column") == "Doing" and deck.get("due") == "2026-12-01"
       and deck.get("refs") == ["binder:org/acme-studio", "calls:call/x-1"] and deck.get("subtasks") == [4, 1],
       deck)
    code, body, _ = srv.ask("GET", "/offdesk/tasks.json?board=work&column=to%20do", bearer())
    ok("by column, any case", [t["id"] for t in (as_json(body) or {}).get("tasks", [])] == ["bbbbbb", "dddddd"], body)
    code, body, _ = srv.ask("GET", "/offdesk/tasks.json?board=work&bucket=Home", bearer())
    ok("by bucket", [t["id"] for t in (as_json(body) or {}).get("tasks", [])] == ["dddddd"], body)
    code, body, _ = srv.ask("GET", "/offdesk/tasks.json?board=work&due_by=2026-12-01", bearer())
    ok("due by a date, soonest first",
       [t["id"] for t in (as_json(body) or {}).get("tasks", [])] == ["bbbbbb", "aaaaaa"], body)
    code, body, _ = srv.ask("GET", "/offdesk/tasks.json?board=work&due_by=soon", bearer())
    ok("a due_by that is not a date is 400", code == 400, "got %d" % code)
    code, body, _ = srv.ask("GET", "/offdesk/tasks.json?board=work&column=Nowhere", bearer())
    ok("a column the board does not have is 400, naming the ones it has",
       code == 400 and "To do" in body, "%d %s" % (code, body))

    code, body, _ = srv.ask("GET", "/offdesk/task.json?board=work&id=aaaaaa", bearer())
    t = as_json(body) or {}
    ok("one task's detail", code == 200 and t.get("title") == "Send the deck" and t.get("impact") == "high", body)
    ok("its notes", t.get("notes") == ["Background in the shared folder."], t.get("notes"))
    subs = t.get("subtasks") or []
    ok("its sub-tasks with ids, who and whether done",
       [(s["id"], s["to"], s["done"]) for s in subs] == [
           ("s00001", "ana@example.com", False), ("s00002", "rui@example.com", False),
           ("s00003", "ana@example.com", True), ("s00004", "agent:digest", False), ("s00005", "", False)], subs)
    code, _, _ = srv.ask("GET", "/offdesk/task.json?board=work&id=zzzzzz", bearer())
    ok("a task that is not there is 404", code == 404, "got %d" % code)
    code, _, _ = srv.ask("GET", "/offdesk/task.json?board=private&id=eeeeee", bearer())
    ok("a task on a board outside access is 404", code == 404, "got %d" % code)


def add_checks(srv, data):
    before = read(os.path.join(data, "work", "todo.md"))
    queue = os.path.join(data, "work", "add-queue.json")
    body = {"board": "work", "title": "Call Acme back", "bucket": "work", "column": "backlog",
            "due": "2026-12-03", "refs": ["binder:org/acme-studio"]}
    code, got, _ = srv.ask("POST", "/offdesk/add", dict(bearer("ana@example.com", "routine:r1"), **BOARD), body)
    e = as_json(got) or {}
    ok("an add is queued", code == 202 and e.get("queued") is True and len(e.get("id", "")) == 6, got)
    q = json.load(open(queue))
    ok("in add-queue.json, with who asked as <email> via the routine",
       len(q) == 1 and q[0]["by"] == "ana@example.com via routine:r1" and q[0]["title"] == "Call Acme back"
       and q[0]["bucket"] == "Work" and q[0]["column"] == "Backlog" and q[0]["refs"] == ["binder:org/acme-studio"]
       and q[0]["id"] == e.get("id"), q)
    ok("todo.md is not written", read(os.path.join(data, "work", "todo.md")) == before)
    code, got, _ = srv.ask("POST", "/offdesk/add", dict(bearer("agent:digest", "digest"), **BOARD),
                           {"board": "work", "title": "From the digest", "bucket": "Home"})
    q = json.load(open(queue))
    ok("an agent of the team is recorded as agent:<name>, the column To do by default",
       code == 202 and q[-1]["by"] == "agent:digest" and q[-1]["column"] == "To do", q[-1:])
    for why, extra, code_want in (
            ("no title", {"title": " "}, 400), ("a title over two lines", {"title": "a\nb"}, 400),
            ("a title carrying a tag", {"title": "x [due:: 2026-01-01]"}, 400),
            ("a title with a backtick", {"title": "x `urgent`"}, 400),
            ("a bucket the board does not have", {"bucket": "Nope"}, 400),
            ("no bucket on a board with two", {"bucket": None}, 400),
            ("Doing, which only the owner sets", {"column": "Doing"}, 400),
            ("Reviewing", {"column": "Reviewing"}, 400), ("Done", {"column": "Done"}, 400),
            ("a column the bucket does not have", {"column": "Later"}, 400),
            ("a due date that is not one", {"due": "2026-02-30"}, 400),
            ("a ref that is not one", {"refs": ["acme"]}, 400),
            ("a ref with an underscore in its module", {"refs": ["my_mod:org/x"]}, 400),
            ("a ref swallowing a tag", {"refs": ["binder:org/x[to::y"]}, 400),
            ("a ref with a byte-order mark", {"refs": ["binder:org/x\ufeff"]}, 400),
            ("a ref with a trailing newline", {"refs": ["binder:org/x\n"]}, 400),
            ("refs that are not a list", {"refs": "binder:org/x"}, 400),
            ("more than ten refs", {"refs": ["binder:org/x%d" % i for i in range(11)]}, 400),
            ("an unknown key", {"rank": 1}, 400),
            ("a board outside access", {"board": "private", "bucket": "Mine"}, 404)):
        payload = dict({"board": "work", "title": "Fine", "bucket": "Work"}, **extra)
        payload = {k: v for k, v in payload.items() if v is not None}
        code, got, _ = srv.ask("POST", "/offdesk/add", dict(bearer(), **BOARD), payload)
        ok("refused: %s (%d)" % (why, code_want), code == code_want, "got %d %s" % (code, got))
    ok("nothing refused was queued", len(json.load(open(queue))) == 2)
    seed(data, "solo", "# To-do\n\n## 1. Only\n\n### To do\n\n- [ ] **One** `id:gggggg`\n")
    board_access.write(os.path.join(data, "solo"), {"owner": "ana@example.com", "people": [], "teams": []})
    code, got, _ = srv.ask("POST", "/offdesk/add", dict(bearer(), **BOARD), {"board": "solo", "title": "Two"})
    ok("a board with one bucket needs none named", code == 202, "got %d %s" % (code, got))
    ids = [x["id"] for x in json.load(open(os.path.join(data, "solo", "add-queue.json")))]
    ok("and the id is not one the board already has", ids and ids[0] != "gggggg", ids)


def tick_checks(srv, data):
    before = read(os.path.join(data, "work", "todo.md"))
    queue = os.path.join(data, "work", "tick-queue.json")
    code, got, _ = srv.ask("POST", "/offdesk/tick", dict(bearer("ana@example.com", "routine:r1"), **BOARD),
                           {"board": "work", "sub": "S00001"})
    q = json.load(open(queue)) if os.path.exists(queue) else []
    ok("Ana's routine asks to tick Ana's sub-task: queued", code == 202 and (as_json(got) or {}).get("queued"), got)
    ok("in tick-queue.json, acting as Ana, recorded as via the routine",
       len(q) == 1 and q[0]["sub"] == "s00001" and q[0]["as"] == "ana@example.com"
       and q[0]["by"] == "ana@example.com via routine:r1", q)
    ok("todo.md is not written", read(os.path.join(data, "work", "todo.md")) == before)
    for why, sub, who, want in (("someone else's", "s00002", bearer(), 403),
                                ("nobody's", "s00005", bearer(), 403),
                                ("already ticked", "s00003", bearer(), 409),
                                ("not on the board", "zzzzzz", bearer(), 404),
                                ("not an id", "x", bearer(), 400),
                                ("an agent's own, by another agent", "s00004",
                                 bearer("agent:helper", "helper"), 404)):
        code, got, _ = srv.ask("POST", "/offdesk/tick", dict(who, **BOARD), {"board": "work", "sub": sub})
        ok("a tick of a sub-task %s is %d" % (why, want), code == want, "got %d %s" % (code, got))
    code, got, _ = srv.ask("POST", "/offdesk/tick", dict(bearer("agent:digest", "digest"), **BOARD),
                           {"board": "work", "sub": "s00004"})
    q = json.load(open(queue))
    ok("the digest agent ticks the step assigned to agent:digest",
       code == 202 and q[-1]["as"] == "agent:digest" and q[-1]["by"] == "agent:digest", q[-1:])
    ok("nothing refused was queued", len(q) == 2, q)
    # A sub-task with no [to::] is the board owner's: the owner may tick it, through the PA only.
    code, got, _ = srv.ask("POST", "/offdesk/tick", dict(bearer("owner@example.com", "routine:r9"), **BOARD),
                           {"board": "work", "sub": "s00005"})
    ok("the owner's routine may not tick a sub-task assigned to nobody", code == 403, "got %d %s" % (code, got))
    code, got, _ = srv.ask("POST", "/offdesk/tick", dict(bearer("owner@example.com", "helper"), **BOARD),
                           {"board": "work", "sub": "s00005"})
    ok("nor the owner's own agent", code == 403, "got %d %s" % (code, got))
    code, got, _ = srv.ask("POST", "/offdesk/tick", dict(bearer("owner@example.com", "pa"), **BOARD),
                           {"board": "work", "sub": "s00005"})
    q = json.load(open(queue))
    ok("the owner through the PA ticks a sub-task assigned to nobody, marked as the owner's",
       code == 202 and len(q) == 3 and q[-1]["as"] == "owner@example.com" and q[-1].get("owner") is True, q[-1:])
    ok("other ticks are not marked as the owner's", all("owner" not in e for e in q[:2]), q)


def board_drain_checks(srv, data):
    """The board's POST /add-queue.json: what it dealt with comes out, what it refused stays with a reason."""
    queue = os.path.join(data, "_test", "add-queue.json")
    sys.path.insert(0, os.path.join(os.path.dirname(HERE), "core"))
    import add_queue
    a = add_queue.append({"title": "One", "column": "To do", "bucket": "Tasks"}, "ana@example.com", path=queue)
    b = add_queue.append({"title": "Two", "column": "To do", "bucket": "Gone"}, "ana@example.com", path=queue)
    c = add_queue.append({"title": "Three", "column": "To do", "bucket": "Tasks"}, "ana@example.com", path=queue)
    code, got, _ = srv.ask("GET", "/add-queue.json")
    ok("the board reads what waits", [x["id"] for x in as_json(got) or []] == [a["id"], b["id"], c["id"]], got)
    code, got, _ = srv.ask("POST", "/add-queue.json", None, {"done": [a["id"]], "refused": {b["id"]: "no bucket"}})
    ok("a POST without X-Board is refused", code == 403, "got %d" % code)
    code, got, _ = srv.ask("POST", "/add-queue.json", BOARD, {"done": [a["id"]], "refused": {b["id"]: "no bucket"}})
    left = add_queue.read(queue)
    ok("what it dealt with comes out, what it refused stays with why",
       code == 200 and [x["id"] for x in left] == [b["id"], c["id"]] and left[0]["refused"] == "no bucket", left)
    code, got, _ = srv.ask("GET", "/add-queue.json")
    ok("and the board is not offered it again", [x["id"] for x in as_json(got) or []] == [c["id"]], got)
    code, got, _ = srv.ask("POST", "/add-queue.json", BOARD, {"done": "x"})
    ok("a body that is not {done, refused} is 400", code == 400, "got %d" % code)


def main():
    root = tempfile.mkdtemp(prefix="bench-core-routes-")
    try:
        data = os.path.join(root, "signed-in")
        setup(data)
        srv = Server(data, "header", dict(HERE_ROOT, BENCH_CORE_TOKEN_KEY=KEY.hex()))
        ok("signed-in server with the core's key starts", srv.wait())
        try:
            token_checks(srv, data)
            read_checks(srv, data)
            add_checks(srv, data)
            tick_checks(srv, data)
            code, _, _ = srv.ask("GET", "/datasets.json", bearer())
            ok("outside /offdesk/ a token is not a sign-in", code == 401, "got %d" % code)
            code, body, _ = srv.ask("GET", "/datasets.json", dict(bearer(key=b"x" * 32), **{
                "X-Offdesk-Email": "ana@example.com"}))
            ok("and a bad one beside sign-in headers changes nothing", code == 200, "got %d" % code)
        finally:
            srv.stop()

        mac = os.path.join(root, "mac")
        setup(mac)
        seed(mac, "_test", "# To-do\n\n## 1. Tasks\n\n### To do\n\n- [ ] A task\n")
        with open(os.path.join(mac, ".current"), "w") as fh:
            fh.write("_test")
        srv = Server(mac, None, dict(HERE_ROOT, BENCH_CORE_TOKEN_KEY=KEY.hex(), TODOS_SHOW_HIDDEN="1"))
        ok("the Mac board with the core's key starts", srv.wait())
        try:
            code, body, _ = srv.ask("GET", "/offdesk/boards.json", bearer())
            names = [b["name"] for b in (as_json(body) or {}).get("boards", [])]
            ok("on the Mac a token still sees only what access.json allows", names == ["work"], body)
            board_drain_checks(srv, mac)
        finally:
            srv.stop()

        nokey = os.path.join(root, "nokey")
        setup(nokey)
        srv = Server(nokey, "header", HERE_ROOT)
        ok("a server without the key starts", srv.wait())
        try:
            code, _, _ = srv.ask("GET", "/offdesk/boards.json", bearer())
            ok("without the key every token is 401", code == 401, "got %d" % code)
        finally:
            srv.stop()

        srv = Server(nokey, "header", dict(HERE_ROOT, BENCH_CORE_TOKEN_KEY="zz" * 32))
        started = srv.wait()
        out = srv.stop()
        ok("a bad key refuses to start, naming it", not started and "BENCH_CORE_TOKEN_KEY" in out, out[-300:])
    finally:
        shutil.rmtree(root, ignore_errors=True)
    print("%d passed" % len(PASS))
    if FAIL:
        print("%d failed" % len(FAIL))
        sys.exit(1)


if __name__ == "__main__":
    main()
