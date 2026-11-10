#!/usr/bin/env python3
"""pa_save.py against a real board server, never the live one.

    python3 agents/pa_agent/skills/pa/scripts/test_pa_save.py

No browser. It starts kanban/server.py on free ports (never 8765 or 8766) over
a throwaway data root, through test_board_access.Server, once as the Mac board
and once signed in, and runs pa_save.py as the PA would. The real data/ is
never read or written, and the copies go to a temp folder ($PA_SAVE_DIR).

What it holds to:

  * on the Mac, with no token, the PA pulls, edits and pushes a board that is
    not the one on screen, which stays on screen, and the log says pa did it;
  * a save landing between the pull and the push is merged, not lost;
  * the same thing changed by both is a 409: the conflicts are printed,
    nothing is written, the exit is 1, and the copy and theirs.md stay;
  * a pull will not go over an edit that was never pushed, unless told to;
  * a board that does not exist, or a request held to one board asking for
    anything but its list, is refused;
  * a host that is not this Mac is refused without a token, a token is never
    sent over http to one, and when there is one it goes as a bearer token;
  * signed in, X-Offdesk-Board holds the PA identity to its board, which it
    must be named in, and the save is logged under the PA's own address.
"""

import http.server
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, *[".."] * 5))
SCRIPT = os.path.join(HERE, "pa_save.py")
sys.path.insert(0, os.path.join(ROOT, "kanban"))
from test_board_access import Server, seed, access, as_json, write, TIAGO  # noqa: E402

PASS = []
FAIL = []

LIST = """# To-do

## 1. Tasks

### To do

- [ ] **Write the brief** [impact:: high] [due:: 2026-10-30] `id:aaaaaa`
- [ ] **Book the venue** [impact:: med] `id:bbbbbb`
- [ ] **Order badges** `id:cccccc`

### Done

"""

PA = "pa-tiago@offdesk.invalid"
PA_HEADERS = {"X-Offdesk-Email": PA, "X-Offdesk-Name": "Tiago%27s%20PA", "X-Offdesk-Teams": ""}


def ok(label, cond, detail=""):
    (PASS if cond else FAIL).append(label if cond else
                                    (label + (" — " + detail if detail else "")))


def read(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    except FileNotFoundError:
        return None


def edit(text, old, new):
    assert old in text, old
    return text.replace(old, new)


def run(args, url, copies, env=None):
    """(exit, stdout, stderr) for one pa_save.py run."""
    e = dict(os.environ, PA_SAVE_URL=url, PA_SAVE_DIR=copies)
    e.pop("PA_SAVE_KEYCHAIN_SERVICE", None)
    e.pop("PA_SAVE_KEYCHAIN_ACCOUNT", None)
    e.update(env or {})
    got = subprocess.run([sys.executable, SCRIPT] + args, capture_output=True, text=True, env=e, timeout=60)
    return got.returncode, got.stdout.strip(), got.stderr.strip()


def mac_checks(root):
    data = os.path.join(root, "mac")
    copies = os.path.join(root, "copies")
    seed(data, "personal")
    seed(data, "work", LIST)
    write(os.path.join(data, ".current"), "personal")
    todo = os.path.join(data, "work", "todo.md")
    srv = Server(data, None)
    ok("Mac server starts", srv.wait())
    try:
        # --- the board not on screen ---------------------------------------------
        code, out, err = run(["pull", "work"], srv.base, copies)
        copy = out
        ok("pull prints the copy's path", code == 0 and read(copy) == LIST, "%d %s %s" % (code, out, err))
        write(copy, edit(LIST, "[due:: 2026-10-30]", "[due:: 2026-11-02]"))
        code, out, err = run(["push", "work"], srv.base, copies)
        ok("push saves the board it named", code == 0 and "[due:: 2026-11-02]" in read(todo),
           "%d %s %s" % (code, out, err))
        ok("the board on screen stays on screen", read(os.path.join(data, ".current")) == "personal")
        ok("the board on screen is untouched", "[due::" not in read(os.path.join(data, "personal", "todo.md")))
        ok("the copy goes once saved", not os.path.exists(copy))
        log = [json.loads(line) for line in (read(os.path.join(data, "work", "activity.jsonl")) or "").splitlines()]
        ok("the log says pa made the change", log and all(e.get("who") == "pa" for e in log), repr(log))

        # --- a save in between, on another task ---------------------------------
        write(todo, LIST)
        code, copy, _ = run(["pull", "work"], srv.base, copies)
        theirs = edit(LIST, "[impact:: med]", "[impact:: low]")
        code, body, _ = srv.ask("PUT", "/data/todo.md", {"X-Offdesk-Board": "work", "Content-Type": "application/json"},
                                {"text": theirs, "base": LIST})
        ok("a tab's save lands in between", code == 200, "%d %s" % (code, body))
        write(copy, edit(LIST, "[due:: 2026-10-30]", "[due:: 2026-11-02]"))
        code, out, err = run(["push", "work"], srv.base, copies)
        ok("the push is merged with it", code == 0 and "merged" in out, "%d %s %s" % (code, out, err))
        ok("and both changes are on disk", "[due:: 2026-11-02]" in read(todo) and "[impact:: low]" in read(todo))

        # --- the same field: a 409 ------------------------------------------------
        write(todo, LIST)
        code, copy, _ = run(["pull", "work"], srv.base, copies)
        theirs = edit(LIST, "[due:: 2026-10-30]", "[due:: 2026-11-05]")
        write(todo, theirs)
        mine = edit(LIST, "[due:: 2026-10-30]", "[due:: 2026-11-02]")
        write(copy, mine)
        code, out, err = run(["push", "work"], srv.base, copies)
        ok("a conflict exits 1", code == 1, "%d %s %s" % (code, out, err))
        ok("and names the task and the field", "Write the brief: due" in err, err)
        ok("nothing is written", "[due:: 2026-11-05]" in read(todo) and "2026-11-02" not in read(todo))
        ok("the copy stays, with their version beside it",
           read(copy) == mine and "[due:: 2026-11-05]" in (read(os.path.join(os.path.dirname(copy), "theirs.md")) or ""))

        # --- an unsaved copy ------------------------------------------------------
        code, out, err = run(["pull", "work"], srv.base, copies)
        ok("a pull will not go over an unsaved edit", code == 2 and "never saved" in err and read(copy) == mine,
           "%d %s %s" % (code, out, err))
        code, out, err = run(["pull", "work", "--discard"], srv.base, copies)
        ok("unless told to", code == 0 and "[due:: 2026-11-05]" in read(copy), "%d %s %s" % (code, out, err))
        code, out, _ = run(["push", "work"], srv.base, copies)
        ok("an untouched copy saves nothing", code == 0 and "nothing" in out, out)
        run(["drop", "work"], srv.base, copies)

        # --- refusals ------------------------------------------------------------
        code, _, err = run(["pull", "nope"], srv.base, copies)
        ok("a board that does not exist is refused", code == 2 and "nope" in err, err)
        for method, path in (("POST", "/dataset/select"), ("GET", "/settings.json"), ("GET", "/datasets.json"),
                             ("GET", "/data/views.md"), ("PUT", "/settings.json")):
            code, _, _ = srv.ask(method, path, {"X-Offdesk-Board": "work", "Content-Type": "application/json"},
                                 {"name": "work"} if method != "GET" else None)
            ok("held to one board, %s %s is refused" % (method, path), code == 403, "got %d" % code)
        code, _, hdrs = srv.ask("GET", "/data/todo.md")
        ok("a tab's read is still the board on screen", code == 200 and hdrs.get("X-Bench-Board") == "personal",
           "%d %s" % (code, hdrs.get("X-Bench-Board")))
    finally:
        srv.stop()


def host_checks(root):
    copies = os.path.join(root, "copies-host")
    code, _, err = run(["pull", "work"], "https://bench.example.com", copies)
    ok("another host without a token is refused", code == 2 and "needs a token" in err, err)
    code, _, err = run(["pull", "work", "--keychain-service", "s", "--keychain-account", "a"],
                       "http://bench.example.com", copies)
    ok("a token never goes over http", code == 2 and "https" in err, err)

    # A stand-in `security` on PATH and a stand-in server on this Mac, to see
    # the token go out as it should.
    bin_dir = os.path.join(root, "bin")
    os.makedirs(bin_dir)
    fake = os.path.join(bin_dir, "security")
    write(fake, "#!/bin/sh\n[ \"$3\" = svc ] && [ \"$5\" = acct ] && echo tok-123 && exit 0\nexit 44\n")
    os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)
    seen = {}

    class Stub(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            seen["auth"] = self.headers.get("Authorization")
            seen["board"] = self.headers.get("X-Offdesk-Board")
            body = LIST.encode()
            self.send_response(200)
            self.send_header("X-Bench-Board", "work")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    class NoLookup(http.server.HTTPServer):
        # HTTPServer.server_bind() looks the host name up in DNS, which can
        # hang on a machine with a slow resolver (a CI runner).
        def server_bind(self):
            import socketserver
            socketserver.TCPServer.server_bind(self)
            self.server_name, self.server_port = self.server_address[:2]

    stub = NoLookup(("127.0.0.1", 0), Stub)
    threading.Thread(target=stub.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:%d" % stub.server_address[1]
    env = {"PATH": bin_dir + os.pathsep + os.environ.get("PATH", "")}
    try:
        code, out, err = run(["pull", "work"], url, copies,
                             dict(env, PA_SAVE_KEYCHAIN_SERVICE="svc", PA_SAVE_KEYCHAIN_ACCOUNT="acct"))
        ok("the Keychain token goes as a bearer token", code == 0 and seen.get("auth") == "Bearer tok-123",
           "%d %s %r" % (code, err, seen))
        ok("with the board named", seen.get("board") == "work", repr(seen))
        ok("and is printed nowhere", "tok-123" not in out + err)
        code, _, err = run(["pull", "work", "--discard", "--keychain-service", "svc", "--keychain-account", "other"],
                           url, copies, env)
        ok("a missing Keychain item is refused", code == 2 and "no Keychain item" in err, err)
    finally:
        stub.shutdown()


def signed_in_checks(root):
    data = os.path.join(root, "signed-in")
    seed(data, "offdesk", LIST)
    seed(data, "tiago-own")
    seed(data, "old-board")
    access(data, "offdesk", TIAGO["X-Offdesk-Email"], people=[PA], teams=["offdesk"])
    access(data, "tiago-own", TIAGO["X-Offdesk-Email"], people=[PA])
    srv = Server(data, "header")
    ok("signed-in server starts", srv.wait())
    pin = lambda board: dict(PA_HEADERS, **{"X-Offdesk-Board": board, "Content-Type": "application/json"})  # noqa: E731
    try:
        code, body, hdrs = srv.ask("GET", "/data/todo.md", pin("offdesk"))
        ok("the PA reads the board it is held to", code == 200 and hdrs.get("X-Bench-Board") == "offdesk",
           "%d %s" % (code, hdrs.get("X-Bench-Board")))
        code, _, hdrs = srv.ask("GET", "/data/todo.md", pin("tiago-own"))
        ok("and only that one, whatever its current board", hdrs.get("X-Bench-Board") == "tiago-own")
        code, _, _ = srv.ask("GET", "/data/todo.md", pin("old-board"))
        ok("a board with no access.json is a 404, PA included", code == 404, "got %d" % code)
        mine = edit(LIST, "[impact:: med]", "[impact:: low]")
        code, body, _ = srv.ask("PUT", "/data/todo.md", pin("offdesk"), {"text": mine, "base": LIST})
        got = as_json(body) or {}
        ok("its save lands in that board", code == 200 and got.get("board") == "offdesk"
           and "[impact:: low]" in read(os.path.join(data, "offdesk", "todo.md")), "%d %s" % (code, body))
        log = [json.loads(line) for line in read(os.path.join(data, "offdesk", "activity.jsonl")).splitlines()]
        ok("logged under the PA's own address", log and log[-1].get("who") == PA, repr(log[-1:]))
        code, _, _ = srv.ask("POST", "/dataset/select", dict(pin("offdesk"), **{"X-Board": "1"}), {"name": "tiago-own"})
        ok("held to a board, it cannot switch", code == 403, "got %d" % code)
        code, body, _ = srv.ask("GET", "/whoami", pin("offdesk"))
        ok("it can ask who it is", code == 200 and (as_json(body) or {}).get("email") == PA, body)
    finally:
        srv.stop()


def main():
    root = tempfile.mkdtemp(prefix="pa-save-test-")
    try:
        mac_checks(root)
        host_checks(root)
        signed_in_checks(root)
    finally:
        shutil.rmtree(root, ignore_errors=True)
    for label in PASS:
        print("ok    " + label)
    for label in FAIL:
        print("FAIL  " + label)
    print("\n%d passed, %d failed" % (len(PASS), len(FAIL)))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
