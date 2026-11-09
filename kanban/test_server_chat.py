#!/usr/bin/env python3
"""Chats on the signed-in board, end to end, with a stand-in claude.

    python3 kanban/test_server_chat.py

Starts kanban/server.py signed in over a throwaway data root, with a fake
ANTHROPIC_API_KEY and a stand-in `claude` first on PATH that logs how it was
started and answers from files the test writes. Nothing real is run.
"""
import json
import os
import shutil
import socket
import stat
import struct
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_board_access import (BOARD, FAIL, JEROME, PASS, TIAGO, Server, access,  # noqa: E402
                               as_json, seed)
from test_board_access import ok as _ok  # noqa: E402


def ok(label, cond, detail=""):
    _ok(label, bool(cond), detail if isinstance(detail, str) else repr(detail))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "core"))
import bench_root  # noqa: E402
sys.path.insert(0, os.path.join(bench_root.packages(), "ai_chat_engine"))
import server_chat  # noqa: E402
F = "`" * 3

STUB = r'''#!/usr/bin/env python3
import json, os, sys, time, uuid
here = os.environ["STUB_DIR"]
args = sys.argv[1:]
with open(os.path.join(here, "log.jsonl"), "a") as fh:
    fh.write(json.dumps({"argv": args, "cwd": os.getcwd()}) + "\n")
def say(row):
    # Compact, as the real CLI writes stream-json: the engine finds the init
    # and result lines by substring.
    print(json.dumps(row, separators=(",", ":")), flush=True)
def read(name, default=""):
    try:
        return open(os.path.join(here, name)).read()
    except OSError:
        return default
if args[args.index("--output-format") + 1] == "json":
    if os.path.exists(os.path.join(here, "check-raw")):
        print(read("check-raw"))
        sys.exit(0)
    say({"type": "result", "result": read("check", "yes"), "total_cost_usd": 0.001})
    sys.exit(0)
sid = args[args.index("--resume") + 1] if "--resume" in args else str(uuid.uuid4())
reply = read("reply", "Hello.")
say({"type": "system", "subtype": "init", "session_id": sid})
if os.path.exists(os.path.join(here, "slow")):
    time.sleep(1.5)
say({"type": "assistant", "message": {"id": "m1", "content": [{"type": "text", "text": reply}]}})
say({"type": "result", "subtype": "success", "result": reply, "session_id": sid, "total_cost_usd": 0.05})
'''


def stub(root):
    d = os.path.join(root, "stub")
    os.makedirs(d)
    path = os.path.join(d, "claude")
    with open(path, "w") as fh:
        fh.write(STUB)
    os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC)
    return d


def runs(d):
    try:
        with open(os.path.join(d, "log.jsonl")) as fh:
            return [json.loads(l) for l in fh if l.strip()]
    except OSError:
        return []


def lines(body):
    return [as_json(l) or {} for l in body.split("\n") if l.strip()]


def allow_checks(root):
    """read_allows() on its own: an outside folder is readable, anything
    broad enough to hold the board, the data root or the checkout is not."""
    data = os.path.realpath(os.path.join(root, "data"))
    board = os.path.join(data, "offdesk")
    outside = os.path.realpath(os.path.join(root, "outside-projects"))
    os.makedirs(outside, exist_ok=True)
    pa = "Read(/%s/**)" % os.path.realpath(os.path.join(ROOT, "agents", "pa_agent"))

    def allows(home):
        return server_chat.read_allows(ROOT, data, board, [home])
    got = allows(outside)
    ok("an outside project folder may be read", got == [pa, "Read(/%s/**)" % outside], got)
    got = allows(os.path.join(board, "projects"))
    ok("the board's own projects folder needs no rule", got == [pa], got)
    for label, home in (("the checkout", ROOT), ("the data root", data),
                        ("an ancestor of the board", root), ("/", "/"),
                        ("the home folder", os.path.expanduser("~")),
                        ("another board's folder", os.path.join(data, "other", "projects"))):
        got = allows(home)
        ok("%s may not be read" % label, got == [pa], got)


def asker_checks():
    line = server_chat.asked_by('  Ann  "the (boss)"\n Smith ', "b")
    ok("the asker's name loses quotes, brackets and runs of space",
       line == '(Asked by Ann the boss Smith on the shared board "b".)', line)
    ok("  is capped", len(server_chat.asked_by("x" * 200, "b")) == len(server_chat.asked_by("", "b")) - 7 + 60)
    ok("  and is someone when nothing is left", "Asked by someone " in server_chat.asked_by('"()"', "b"))
    got = server_chat.with_asker("(A)", "/pa")
    ok("a bare command keeps its place", got == "/pa (A)", got)
    got = server_chat.with_asker("(A)", "/plugin:cmd do it")
    ok("a namespaced command keeps its place", got == "/plugin:cmd (A)\n\ndo it", got)
    got = server_chat.with_asker("(A)", "a / b")
    ok("words with no command get the line in front", got == "(A)\n\na / b", got)
    got = server_chat.with_asker("(A)", "/Users/x/notes.md is wrong")
    ok("a path is not a command", got == "(A)\n\n/Users/x/notes.md is wrong", got)


def pa_runs_until_init(srv, who, payload):
    """POST /claude, read until the init line, then hang up: the tab closed."""
    body = json.dumps(payload).encode()
    head = dict(who, **BOARD)
    req = "POST /claude HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: %d\r\n" % len(body)
    req += "".join("%s: %s\r\n" % kv for kv in head.items()) + "\r\n"
    s = socket.create_connection(("127.0.0.1", srv.port), timeout=10)
    s.sendall(req.encode() + body)
    got = b""
    while b'"subtype":"init"' not in got or not got.endswith(b"\n"):
        chunk = s.recv(4096)
        if not chunk:
            break
        got += chunk
    # Reset rather than close, so the server's next write fails at once.
    s.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
    s.close()
    for line in got.decode("utf-8", "replace").split("\n"):
        row = as_json(line.strip()) or {}
        if row.get("subtype") == "init":
            return row.get("session_id")
    return None


def main():
    root = tempfile.mkdtemp(prefix="server-chat-")
    allow_checks(root)
    asker_checks()
    d = stub(root)
    env = {"PATH": d + os.pathsep + os.environ.get("PATH", ""), "STUB_DIR": d}
    try:
        data = os.path.join(root, "data")
        seed(data, "offdesk")
        seed(data, "other")
        access(data, "offdesk", TIAGO["X-Offdesk-Email"], people=[JEROME["X-Offdesk-Email"]])
        access(data, "other", TIAGO["X-Offdesk-Email"])
        board = os.path.realpath(os.path.join(data, "offdesk"))
        # A claude.json asking for the checkout and for work mode, both ignored.
        with open(os.path.join(board, "claude.json"), "w") as fh:
            json.dump({"cwd": ROOT, "work": True, "timeout": 3600}, fh)

        # --- no key: no chat ------------------------------------------------------
        srv = Server(data, "header", env=env)
        ok("signed-in server without a key starts", srv.wait())
        try:
            code, _, _ = srv.ask("GET", "/claude.json", JEROME)
            ok("signed in without a key: no chat", code == 404, "got %d" % code)
        finally:
            srv.stop()

        # --- with a key ----------------------------------------------------------
        srv = Server(data, "header", env=dict(env, ANTHROPIC_API_KEY="sk-test-not-a-key"))
        ok("signed-in server with a key starts", srv.wait())
        try:
            code, body, _ = srv.ask("GET", "/claude.json", JEROME)
            st = as_json(body) or {}
            ok("signed in with a key: chat is there", code == 200 and st.get("available"), body)
            ok("  and it cannot write, whatever claude.json says", st.get("work") is False, body)
            ok("  and it sits in the board's folder", os.path.realpath(st.get("cwd", "")) == board, body)
            ok("  and claude.json cannot stretch a run past the engine's default",
               st.get("timeout") == 900, body)

            def ask(who, payload):
                return srv.ask("POST", "/claude", dict(who, **BOARD), body=payload)

            code, body, _ = ask(JEROME, {"prompt": "hi", "mode": "write", "owner": "chat-ab12cd"})
            ok("mode=write is refused", code == 403, "got %d %s" % (code, body))

            code, body, _ = srv.ask("POST", "/claude", dict(JEROME, **BOARD), body=["what is due"])
            ok("a body that is not an object is refused", code == 400, "got %d %s" % (code, body))

            code, body, _ = ask(JEROME, {"prompt": "what is due", "owner": "chat-ab12cd", "title": "Due"})
            ok("a card chat runs", code == 200, "got %d %s" % (code, body))
            card_sid = next(l["session_id"] for l in lines(body) if l.get("subtype") == "init")
            run = runs(d)[-1]
            argv = run["argv"]
            ok("  in the board's folder", os.path.realpath(run["cwd"]) == board, run["cwd"])
            prompt = argv[argv.index("-p") + 1]
            ok("  with the asked-by line first",
               prompt.startswith('(Asked by Jérôme on the shared board "offdesk".)\n\nwhat is due'), prompt)
            ok("  in dontAsk", argv[argv.index("--permission-mode") + 1] == "dontAsk")
            allows = argv[argv.index("--allowedTools") + 1:argv.index("--disallowedTools")]
            ok("  allowed to read the PA's folder and nothing else",
               allows == ["Read(/%s/**)" % os.path.realpath(os.path.join(ROOT, "agents", "pa_agent"))], allows)
            denied = argv[argv.index("--disallowedTools") + 1:]
            ok("  the engine's default denials are kept",
               all(t in denied for t in ("Bash", "Edit", "Write", "NotebookEdit", "Task")), denied)
            ok("  and the web is denied", "WebFetch" in denied and "WebSearch" in denied, denied)

            # --- PA chats are private -------------------------------------------------
            code, body, _ = ask(JEROME, {"prompt": "/pa what now", "owner": "board-pa", "title": "Now", "words": "what now"})
            ok("Jérôme's PA chat runs", code == 200, body)
            jerome_sid = next(l["session_id"] for l in lines(body) if l.get("subtype") == "init")
            prompt = runs(d)[-1]["argv"][runs(d)[-1]["argv"].index("-p") + 1]
            ok("a slash command keeps its place, the asked-by line after it",
               prompt == '/pa (Asked by Jérôme on the shared board "offdesk".)\n\nwhat now', prompt)
            code, body, _ = ask(TIAGO, {"prompt": "/pa and me", "owner": "board-pa", "title": "Me", "words": "and me"})
            tiago_sid = next(l["session_id"] for l in lines(body) if l.get("subtype") == "init")

            def chats(who):
                return (as_json(srv.ask("GET", "/claude/sessions.json", who)[1]) or {}).get("chats", {})

            mine, his = chats(JEROME), chats(TIAGO)
            ok("each sees only their own PA chats",
               [r["id"] for r in mine.get("board-pa", [])] == [jerome_sid]
               and [r["id"] for r in his.get("board-pa", [])] == [tiago_sid], (mine, his))
            ok("card chats are seen by both", "chat-ab12cd" in mine and "chat-ab12cd" in his, (mine, his))
            ok("the session store is not in the board's folder, where a run could read it",
               not os.path.exists(os.path.join(board, "sessions.json")))
            with open(os.path.join(data, "agents", "chat-sessions", "offdesk.json")) as fh:
                stored = json.load(fh)["chats"]
            ok("PA chats are stored under one key per person",
               len([k for k in stored if k.startswith("board-pa-")]) == 2 and "board-pa" not in stored, stored)
            code, body, _ = srv.ask("GET", "/claude/transcript.json?session=%s&cwd=" % tiago_sid, JEROME)
            ok("one cannot read the other's PA transcript",
               code == 404 and "no such conversation" in body, "%d %s" % (code, body))
            code, body, _ = srv.ask("GET", "/claude/transcript.json?session=%s&cwd=" % jerome_sid, JEROME)
            ok("  but reaches their own (the stand-in wrote none)",
               code == 404 and "no transcript on disk" in body, "%d %s" % (code, body))
            code, body, _ = ask(JEROME, {"prompt": "go on", "owner": "board-pa", "session": tiago_sid})
            ok("  nor carry on the other's conversation", code == 404, "%d %s" % (code, body))
            code, body, _ = ask(JEROME, {"prompt": "hi", "owner": "board-pa-0123456789ab"})
            ok("a person's PA key cannot be named outright", code == 400, "%d %s" % (code, body))
            code, body, _ = srv.ask("GET", "/claude/attachable.json", JEROME)
            ok("nothing on the server's disk is offered to attach",
               (as_json(body) or {}).get("sessions") == [], body)

            # --- the check ------------------------------------------------------------
            def reply(block):
                with open(os.path.join(d, "reply"), "w") as fh:
                    fh.write("doing: ticking\n\n" + F + "pa-changes\n" + block + "\n" + F)

            reply('[{"kind":"tick","task":"ab12cd"}]')
            with open(os.path.join(d, "check"), "w") as fh:
                fh.write("yes")
            code, body, _ = ask(JEROME, {"prompt": "/pa tick it", "owner": "board-pa", "words": "tick it",
                                         "focus": ["ab12cd", "A task"]})
            check = [l for l in lines(body) if l.get("type") == "board_pa_check"]
            ok("a PA reply with changes ends with the check's verdict",
               check and check[-1]["hold"] is False, body)
            sid = next(l["session_id"] for l in lines(body) if l.get("subtype") == "init")
            code, body, _ = srv.ask("GET", "/claude/pa-check.json?session=" + sid, JEROME)
            got = as_json(body) or {}
            ok("  and the verdict can be read back",
               code == 200 and got.get("hold") is False and got.get("items") == [{"kind": "tick", "task": "ab12cd"}], body)
            code, body, _ = srv.ask("GET", "/claude/pa-check.json?session=" + sid, TIAGO)
            ok("  by the asker only", code == 404, "%d %s" % (code, body))
            check_runs = [r for r in runs(d) if "json" in r["argv"] and "--model" in r["argv"]]
            ok("  the check ran with no tools, outside the board",
               check_runs and "Read" in check_runs[-1]["argv"][check_runs[-1]["argv"].index("--disallowedTools") + 1:]
               and not os.path.realpath(check_runs[-1]["cwd"]).startswith(board), check_runs[-1:])

            code, body, _ = ask(JEROME, {"prompt": "/pa tidy up", "owner": "board-pa", "words": "tidy up my board"})
            check = [l for l in lines(body) if l.get("type") == "board_pa_check"]
            ok("a change to a card the question does not name is held",
               check and check[-1]["hold"] is True and "ab12cd" in check[-1]["why"], body)

            with open(os.path.join(d, "check"), "w") as fh:
                fh.write("no: they asked about something else")
            code, body, _ = ask(JEROME, {"prompt": "/pa tick it", "owner": "board-pa", "words": "tick it",
                                         "focus": ["ab12cd"]})
            check = [l for l in lines(body) if l.get("type") == "board_pa_check"]
            ok("a change the check does not confirm is held",
               check and check[-1]["hold"] is True and "something else" in check[-1]["why"], body)

            # A later turn of the same conversation whose check fails must not
            # be read back as the earlier turn's yes.
            with open(os.path.join(d, "check"), "w") as fh:
                fh.write("yes")
            code, body, _ = ask(JEROME, {"prompt": "/pa tick it", "owner": "board-pa", "words": "tick it",
                                         "focus": ["ab12cd"]})
            turn_sid = next(l["session_id"] for l in lines(body) if l.get("subtype") == "init")
            got = as_json(srv.ask("GET", "/claude/pa-check.json?session=" + turn_sid, JEROME)[1]) or {}
            ok("turn one of a conversation is confirmed", got.get("hold") is False, got)
            with open(os.path.join(d, "check-raw"), "w") as fh:
                fh.write("[]")
            code, body, _ = ask(JEROME, {"prompt": "/pa tick it again", "owner": "board-pa",
                                         "session": turn_sid, "words": "tick it", "focus": ["ab12cd"]})
            got = as_json(srv.ask("GET", "/claude/pa-check.json?session=" + turn_sid, JEROME)[1]) or {}
            ok("  turn two, whose check fails, is held rather than read as turn one's yes",
               got.get("hold") is True and got.get("why") == "the check could not run", got)
            os.remove(os.path.join(d, "check-raw"))
            with open(os.path.join(d, "reply"), "w") as fh:
                fh.write("Nothing to change.")
            code, body, _ = ask(JEROME, {"prompt": "/pa and now", "owner": "board-pa",
                                         "session": turn_sid, "words": "and now"})
            code, body, _ = srv.ask("GET", "/claude/pa-check.json?session=" + turn_sid, JEROME)
            ok("  and turn three, with no changes, leaves no verdict to read", code == 404,
               "%d %s" % (code, body))
            reply('[{"kind":"tick","task":"ab12cd"}]')

            # The tab closes mid-run: the cost still lands, and the verdict is
            # kept for the tab to read after a reload.
            with open(os.path.join(board, "..", "agents", "chat-spend.json")) as fh:
                before = json.load(fh)
            before = before[sorted(before)[-1]].get("jerome@example.com", 0)
            open(os.path.join(d, "slow"), "w").close()
            gone_sid = pa_runs_until_init(srv, JEROME, {"prompt": "/pa tick it", "owner": "board-pa",
                                                        "words": "tick it", "focus": ["ab12cd"]})
            time.sleep(3)
            os.remove(os.path.join(d, "slow"))
            with open(os.path.join(board, "..", "agents", "chat-spend.json")) as fh:
                after = json.load(fh)
            after = after[sorted(after)[-1]].get("jerome@example.com", 0)
            ok("a run whose tab closed still costs what it cost",
               abs(after - before - 0.051) < 1e-6, "%r -> %r" % (before, after))
            got = as_json(srv.ask("GET", "/claude/pa-check.json?session=%s" % gone_sid, JEROME)[1]) or {}
            ok("  and its verdict is kept", got.get("hold") is False, got)

            os.remove(os.path.join(d, "reply"))   # the stand-in answers "Hello."
            code, body, _ = ask(JEROME, {"prompt": "/pa hello", "owner": "board-pa", "words": "hello"})
            ok("a reply with no changes gets no verdict",
               not [l for l in lines(body) if l.get("type") == "board_pa_check"], body)

            # --- spend ----------------------------------------------------------------
            with open(os.path.join(data, "agents", "chat-spend.json")) as fh:
                ledger = json.load(fh)
            day = sorted(ledger)[-1]
            ok("every run's cost is in the ledger, the check's included",
               abs(ledger[day].get("jerome@example.com", 0) - (0.05 * 10 + 0.001 * 4)) < 1e-6, ledger)
            leaks = []
            for here, _, names in os.walk(board):
                for name in names:
                    with open(os.path.join(here, name), encoding="utf-8", errors="replace") as fh:
                        text = fh.read()
                    if jerome_sid in text or tiago_sid in text or "board-pa-" in text:
                        leaks.append(os.path.join(here, name))
            ok("no PA conversation is named in any file under the board's folder", not leaks, leaks)
            os.makedirs(os.path.join(data, "agents"), exist_ok=True)
            with open(os.path.join(data, "agents", "fences.json"), "w") as fh:
                json.dump({"chat_person_budget": 0.3}, fh)
            code, body, _ = ask(JEROME, {"prompt": "one more", "owner": "chat-ab12cd"})
            ok("a person over their daily limit is refused", code == 429 and "your chat budget" in body,
               "%d %s" % (code, body))
            code, body, _ = ask(TIAGO, {"prompt": "one more", "owner": "chat-ab12cd"})
            ok("  another person is not", code == 200, "%d %s" % (code, body))

            # --- the PA key, on the routes that name one ----------------------------
            def post(path, payload, who=JEROME):
                return srv.ask("POST", path, dict(who, **BOARD), body=payload)
            named = server_chat.person_key("jerome@example.com")
            for route, payload in (("/claude/forget", {"owner": named, "session": jerome_sid}),
                                   ("/claude/note", {"owner": named, "session": jerome_sid, "prompt": "x"}),
                                   ("/claude/assign", {"owner": named, "session": jerome_sid,
                                                       "to": "chat-ab12cd"}),
                                   ("/claude/assign", {"owner": "chat-ab12cd", "session": card_sid,
                                                       "to": named})):
                code, body, _ = post(route, payload)
                ok("%s naming a person's PA key outright is refused" % route, code == 400,
                   "%d %s" % (code, body))
            code, body, _ = post("/claude/assign", {"owner": "chat-ab12cd", "session": card_sid,
                                                    "to": "board-pa"})
            ok("a card chat cannot be moved into the asker's private PA chats", code == 400,
               "%d %s" % (code, body))
            code, body, _ = post("/claude/note", {"owner": "board-pa", "session": jerome_sid,
                                                  "prompt": "my note"})
            with open(os.path.join(data, "agents", "chat-sessions", "offdesk.json")) as fh:
                stored = json.load(fh)["chats"]
            row = next((r for r in stored.get(named, []) if r["id"] == jerome_sid), {})
            ok("a note on board-pa lands on the asker's own key", code == 200 and row.get("prompt") == "my note",
               "%d %s %s" % (code, body, stored))
            code, body, _ = post("/claude/assign", {"owner": "board-pa", "session": jerome_sid,
                                                    "to": "chat-ab12cd"})
            mine = (as_json(srv.ask("GET", "/claude/sessions.json", JEROME)[1]) or {}).get("chats", {})
            ok("a PA chat can be moved onto a card",
               code == 200 and jerome_sid in [r["id"] for r in mine.get("chat-ab12cd", [])], "%d %s" % (code, mine))
            code, body, _ = post("/claude/forget", {"owner": "board-pa", "session": tiago_sid}, TIAGO)
            his = (as_json(srv.ask("GET", "/claude/sessions.json", TIAGO)[1]) or {}).get("chats", {})
            ok("forgetting on board-pa forgets from the asker's own key",
               code == 200 and not his.get("board-pa"), "%d %s" % (code, his))
        finally:
            srv.stop()

        # --- signed out: unchanged ---------------------------------------------------
        srv = Server(data, None, env=dict(env, ANTHROPIC_API_KEY="sk-test-not-a-key"))
        ok("Mac server starts", srv.wait())
        try:
            before = len(runs(d))
            code, body, _ = srv.ask("POST", "/claude", BOARD, body={"prompt": "hi", "owner": "chat-ab12cd"})
            run = runs(d)[before] if len(runs(d)) > before else {}
            prompt = run.get("argv", ["-p", ""])[run.get("argv", ["-p", ""]).index("-p") + 1] if run else ""
            ok("signed out, the prompt is sent as it was", code == 200 and prompt == "hi", "%d %r" % (code, prompt))
            ok("  from the checkout, as before", os.path.realpath(run.get("cwd", "")) == os.path.realpath(ROOT), run)
        finally:
            srv.stop()
    finally:
        shutil.rmtree(root, ignore_errors=True)

    print("\n%d passed" % len(PASS))
    for f in FAIL:
        print("  FAIL  " + f)
    if FAIL:
        print("%d failed" % len(FAIL))
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
