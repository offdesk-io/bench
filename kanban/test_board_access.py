#!/usr/bin/env python3
"""Signed-in Bench: who is asking, and what the shared board leaves out.

    python3 kanban/test_board_access.py

No browser. It starts kanban/server.py itself, as a process, on free ports
(never 8765 or 8766) over a throwaway data root, once with BENCH_AUTH=header
and once without, and talks to it the way nginx would: three headers saying
who is signed in. The real data/ and data/.current are never read or written.

What it holds to:

  * signed in, a request without an email is refused, on every method;
  * /whoami says who nginx said, with the name decoded from percent-encoded UTF-8;
  * the parts that only work on the owner's Mac are refused, and so is a
    POST that a form on another site could send;
  * a person sees only the boards their access.json lets them, and every
    board route answers for their board and never for one outside it: a read
    never carries another board's content, a write never lands in it, and a
    board named outright is a 404;
  * which board is on screen is per person, and data/.current is left alone;
  * a new board is personal or shared, and only its owner changes that;
  * scripts/set-board-access.py opens a board made before sign-in;
  * each person's profile is their own, data/users/<hash>.profile.md, read
    from the shared data/profile.md until they save one, and never anybody
    else's, with the parts naming a server path left out;
  * BENCH_AUTH unset is the Mac board exactly as before, access.json or not,
    and an unknown value refuses to start.
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(ROOT, "kanban", "server.py")
sys.path.insert(0, os.path.join(ROOT, "core"))
import board_access  # noqa: E402

PASS = []
FAIL = []

TIAGO = {"X-Offdesk-Email": "tiagopedras+claude@gmail.com",
         "X-Offdesk-Name": "Tiago%20Pedras", "X-Offdesk-Teams": "offdesk"}
JEROME = {"X-Offdesk-Email": "jerome@example.com",
          "X-Offdesk-Name": "J%C3%A9r%C3%B4me", "X-Offdesk-Teams": "offdesk,other"}
OUTSIDER = {"X-Offdesk-Email": "nobody@example.com", "X-Offdesk-Name": "Nobody"}
BOARD = {"X-Board": "1", "Content-Type": "application/json"}
SECRET = "SECRET-OF-TIAGO"

# Every route that reads a board, as the board asks for it.
BOARD_GETS = ("/data/todo.md", "/data/views.md", "/data/people.md", "/chat-viewed.json",
              "/people.json", "/attach-queue.json", "/tick-queue.json", "/pa-working.json",
              "/history.json?task=ab12cd", "/agent-runs.json", "/briefings.json",
              "/bucket-colors.json", "/bucket-themes.json", "/column-names.json",
              "/bucket-brief.json?bucket=1.%20Tasks", "/agents-planners.json?buckets=1.%20Tasks",
              "/reports.json", "/data/reports/secret.md", "/projects.json",
              "/project.json?name=secret", "/data/projects/secret/CLAUDE.md",
              "/project-folders.json", "/plans.json", "/data/plans/secret.md",
              "/planning-agent.json", "/backups.json", "/data/backups/todo-backup-secret.md",
              "/data/backups/done-archive.md", "/dataset/access.json", "/settings.json")
# Every route that writes one, with a body each would accept.
BOARD_POSTS = (("/chat-viewed", {"version": 1, "viewed": {}}),
               ("/bucket/scaffold", {"name": "Tasks"}),
               ("/bucket-colors", {"Tasks": "x"}), ("/bucket-themes", {"Tasks": ["x"]}),
               ("/column-names", {"To do": "x"}), ("/attach-queue.json", []),
               ("/agent-runs", {"action": "clear", "sub": "ab12cd"}),
               ("/tick-queue.json", {"done": []}), ("/project/start", {"name": "x"}),
               ("/agenda-history", {"text": "x"}), ("/archive", {"text": "x"}),
               ("/dataset/access", {"teams": [], "people": []}))


def ok(label, cond, detail=""):
    (PASS if cond else FAIL).append(label if cond else
                                    (label + (" — " + detail if detail else "")))


def free_port():
    while True:
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        if port not in (8765, 8766):
            return port


def seed(data_root, name, text="# To-do\n\n## 1. Tasks\n\n### To do\n\n- [ ] A task\n"):
    os.makedirs(os.path.join(data_root, name, "backups"), exist_ok=True)
    with open(os.path.join(data_root, name, "todo.md"), "w", encoding="utf-8") as fh:
        fh.write(text)


class Server:
    """kanban/server.py in a process of its own, over `data_root`."""

    def __init__(self, data_root, auth, env=None):
        self.port = free_port()
        self.base = "http://127.0.0.1:%d" % self.port
        extra = dict(env or {})
        env = dict(os.environ, TODOS_DATA_ROOT=data_root, TODOS_PORT=str(self.port),
                   TODOS_NO_BROWSER="1")
        env.pop("BENCH_AUTH", None)
        # A key in the shell that runs the suites would turn the signed-in
        # board's chat on; only a test that means to sets one.
        env.pop("ANTHROPIC_API_KEY", None)
        env.update(extra)
        if auth is not None:
            env["BENCH_AUTH"] = auth
        self.proc = subprocess.Popen([sys.executable, SERVER], env=env, cwd=ROOT,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

    def wait(self):
        for _ in range(100):
            if self.proc.poll() is not None:
                return False
            try:
                socket.create_connection(("127.0.0.1", self.port), timeout=0.2).close()
                return True
            except OSError:
                time.sleep(0.1)
        return False

    def stop(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            self.proc.wait(timeout=5)
        out = self.proc.stdout.read().decode("utf-8", "replace")
        self.proc.stdout.close()
        return out

    def ask(self, method, path, headers=None, body=None):
        data = body if isinstance(body, bytes) else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(self.base + path, method=method, data=data,
                                     headers=headers or {})
        try:
            with urllib.request.urlopen(req) as res:
                return res.status, res.read().decode("utf-8"), res.headers
        except urllib.error.HTTPError as err:
            return err.code, err.read().decode("utf-8"), err.headers
        except (urllib.error.URLError, ConnectionError) as err:
            # The server dropped the connection rather than answer.
            return 0, str(err), {}


def as_json(text):
    try:
        return json.loads(text)
    except ValueError:
        return None


def signed_in_checks(root):
    data = os.path.join(root, "signed-in")
    seed(data, "offdesk")
    srv = Server(data, "header")
    ok("signed-in server starts", srv.wait())
    try:
        # --- nobody signed in ---------------------------------------------------
        for method, path in (("GET", "/kanban/index.html"), ("GET", "/data/todo.md"),
                             ("HEAD", "/data/todo.md"), ("GET", "/datasets.json"),
                             ("GET", "/whoami"), ("POST", "/datasets"),
                             ("PUT", "/data/todo.md")):
            code, body, _ = srv.ask(method, path, headers=dict(BOARD) if method != "GET" else None,
                                    body={} if method in ("POST", "PUT") else None)
            ok("no email: %s %s is 401" % (method, path), code == 401, "got %d" % code)
        code, _, _ = srv.ask("GET", "/whoami", {"X-Offdesk-Email": "not an address"})
        ok("an email that is not one is 401", code == 401, "got %d" % code)

        # --- who is signed in ---------------------------------------------------
        code, body, _ = srv.ask("GET", "/whoami", JEROME)
        who = as_json(body) or {}
        ok("/whoami answers", code == 200, "got %d" % code)
        ok("/whoami has the email", who.get("email") == "jerome@example.com", body)
        ok("/whoami decodes the name", who.get("name") == "Jérôme", body)
        ok("/whoami has the teams", who.get("teams") == ["offdesk", "other"], body)
        code, body, _ = srv.ask("GET", "/owner.js", JEROME)
        ok("owner.js names whoever is signed in", "J\\u00e9r\\u00f4me" in body, body)
        code, body, _ = srv.ask("GET", "/profile-basics.json", JEROME)
        ok("no profile setup for a visitor", (as_json(body) or {}).get("needs_setup") is False, body)

        # --- the Mac-only parts ---------------------------------------------------
        for method, path in (("GET", "/schedule.json"), ("GET", "/usage.json"),
                             ("GET", "/agents-api/state.json"), ("POST", "/agents-api/run"),
                             ("POST", "/project/open"), ("POST", "/project-folders"),
                             ("POST", "/planning_agent/run"), ("GET", "/claude.json"),
                             ("POST", "/claude"), ("GET", "/ai-chat/ai-chat.js")):
            code, _, _ = srv.ask(method, path, dict(TIAGO, **BOARD),
                                 body={} if method == "POST" else None)
            ok("signed in: %s %s is refused" % (method, path), code == 404, "got %d" % code)
        code, _, _ = srv.ask("PUT", "/settings.json", dict(TIAGO, **BOARD), body={"name": "x"})
        ok("signed in: PUT /settings.json is refused", code == 403, "got %d" % code)

        # A form on another site can POST with the cookie but not with X-Board.
        code, _, _ = srv.ask("POST", "/archive", dict(TIAGO, **{"Content-Type": "text/plain"}),
                             body=b'{"text": "x"}')
        ok("signed in: a POST without X-Board is refused", code == 403, "got %d" % code)
    finally:
        srv.stop()


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def access(data, board, owner, people=(), teams=()):
    write(os.path.join(data, board, "access.json"),
          json.dumps({"owner": owner, "people": list(people), "teams": list(teams)}))


def seed_boards(data):
    """Five boards: shared with the team, Tiago's own, Jerome's own, one from
    before sign-in, and one whose access.json does not parse."""
    seed(data, "offdesk")
    access(data, "offdesk", "tiagopedras+claude@gmail.com", teams=["offdesk"])
    seed(data, "tiago-own", "# To-do\n\n## 1. Tasks\n\n### To do\n\n- [ ] %s\n" % SECRET)
    access(data, "tiago-own", "tiagopedras+claude@gmail.com")
    t = os.path.join(data, "tiago-own")
    for rel in ("views.md", "people.md", "reports/secret.md", "plans/secret.md",
                "projects/secret/CLAUDE.md", "backups/todo-backup-secret.md",
                "backups/done-archive.md", "history.jsonl"):
        write(os.path.join(t, rel), "# %s\n\n| Name | Role |\n| --- | --- |\n| %s | x |\n" % (SECRET, SECRET))
    for rel in ("chat-viewed.json", "bucket-colors.json", "bucket-themes.json",
                "column-names.json", "briefings.json", "pa-working.json"):
        write(os.path.join(t, rel), json.dumps({SECRET: SECRET}))
    for rel in ("attach-queue.json", "tick-queue.json"):
        write(os.path.join(t, rel), json.dumps([{"id": SECRET, "sub": SECRET}]))
    write(os.path.join(t, "buckets", "tasks", "tasks.md"), SECRET)
    seed(data, "jerome-own")
    access(data, "jerome-own", "jerome@example.com")
    seed(data, "legacy")
    seed(data, "broken")
    write(os.path.join(data, "broken", "access.json"), "{not json")
    write(os.path.join(data, ".current"), "legacy")
    roots = {"tiago-own": os.path.join(data, "..", "proj-tiago"), "offdesk": os.path.join(data, "..", "proj-offdesk")}
    for folder in roots.values():
        os.makedirs(folder, exist_ok=True)
    write(os.path.join(data, "settings.json"), json.dumps({"projects_roots": roots}))


def snapshot(folder):
    out = {}
    for base, _, files in os.walk(folder):
        for f in files:
            full = os.path.join(base, f)
            with open(full, "rb") as fh:
                out[os.path.relpath(full, folder)] = fh.read()
    return out


def boards(srv, who):
    code, body, _ = srv.ask("GET", "/datasets.json", who)
    return (as_json(body) or {}).get("datasets") if code == 200 else code


def access_checks(root):
    data = os.path.join(root, "access")
    seed_boards(data)
    srv = Server(data, "header")
    ok("access server starts", srv.wait())
    try:
        # --- who sees what ------------------------------------------------------
        ok("Tiago sees the team board and his own", boards(srv, TIAGO) == ["offdesk", "tiago-own"],
           str(boards(srv, TIAGO)))
        ok("Jerome sees his own and the team board", boards(srv, JEROME) == ["jerome-own", "offdesk"],
           str(boards(srv, JEROME)))
        ok("someone in no team with no board sees none", boards(srv, OUTSIDER) == [],
           str(boards(srv, OUTSIDER)))

        # --- the board on screen is each person's own ---------------------------
        code, _, _ = srv.ask("POST", "/dataset/select", dict(TIAGO, **BOARD), {"name": "tiago-own"})
        ok("Tiago switches to his own board", code == 200, "got %d" % code)
        code, _, _ = srv.ask("POST", "/dataset/select", dict(JEROME, **BOARD), {"name": "tiago-own"})
        ok("Jerome cannot switch to Tiago's board: 404", code == 404, "got %d" % code)
        code, _, _ = srv.ask("POST", "/dataset/select", dict(JEROME, **BOARD), {"name": "jerome-own"})
        code, body, _ = srv.ask("GET", "/datasets.json", TIAGO)
        ok("Jerome switching leaves Tiago's board on screen",
           (as_json(body) or {}).get("current") == "tiago-own", body)
        with open(os.path.join(data, ".current")) as fh:
            ok("data/.current is left alone", fh.read() == "legacy")
        jerome_file = board_access.user_path(data, "jerome@example.com")
        ok("each person's board is kept in data/users/, under a hash of the address",
           os.path.isfile(jerome_file) and os.path.basename(jerome_file) != "jerome@example.com.json"
           and json.load(open(jerome_file)).get("email") == "jerome@example.com")

        # A hand-edited pointer at a board outside his access falls back.
        write(jerome_file, json.dumps({"email": "jerome@example.com", "current": "tiago-own"}))
        code, body, _ = srv.ask("GET", "/datasets.json", JEROME)
        ok("a pointer at a board outside access falls back to one he sees",
           (as_json(body) or {}).get("current") in ("jerome-own", "offdesk"), body)
        # A file naming someone else is not his, whatever its name.
        write(jerome_file, json.dumps({"email": "someone@example.com", "current": "offdesk"}))
        ok("a pointer file for another address is ignored",
           board_access.read_current(data, "jerome@example.com") == "")
        write(jerome_file, json.dumps({"email": "jerome@example.com", "current": "jerome-own"}))

        # --- every read is Jerome's board, never Tiago's ------------------------
        leaks = []
        for path in BOARD_GETS:
            code, body, _ = srv.ask("GET", path, JEROME)
            if SECRET in body:
                leaks.append("%s (%d)" % (path, code))
        ok("no read for Jerome carries Tiago's board", not leaks, ", ".join(leaks))

        # Paths that only become /data/<board>/ once cleaned, and data/ itself.
        # A symlink inside Jerome's board, at Tiago's board and at a file in it.
        os.symlink(os.path.join(data, "tiago-own"), os.path.join(data, "jerome-own", "sneak"))
        os.symlink(os.path.join(data, "tiago-own", "todo.md"), os.path.join(data, "jerome-own", "sneak.md"))
        users = os.path.relpath(jerome_file, data)
        for path in ("/kanban/../data/tiago-own/todo.md", "/%64ata/tiago-own/todo.md",
                     "//data/tiago-own/todo.md", "/data/../data/tiago-own/todo.md",
                     "/kanban/%2e%2e/data/tiago-own/todo.md", "/data/../" + users,
                     "/kanban/../data/settings.json", "/kanban/../data/" + users,
                     "/data/tiago-own/todo.md",
                     "/data/%252e%252e/tiago-own/todo.md", "/data/%252E%252e/tiago-own/todo.md",
                     "/data/%2E%2e/tiago-own/todo.md", "/data/%2e%2e%2ftiago-own%2ftodo.md",
                     "/data/%252e%252e%252ftiago-own%252ftodo.md", "/data/..%5ctiago-own%5ctodo.md",
                     "/data/%252e%252e/" + users, "/data/%252e%252e/settings.json",
                     "/data/todo.md%00.html", "/data/sneak/todo.md", "/data/sneak.md",
                     "/data/sneak/", "/data/./todo.md", "/data/.board.lock"):
            for method in ("GET", "HEAD"):
                code, body, _ = srv.ask(method, path, JEROME)
                ok("path trick %s %s is not served" % (method, path),
                   code != 200 and SECRET not in body, "got %d" % code)

        # What the shared board serves from outside /data/, and nothing else.
        for path in ("/kanban/index.html", "/kanban/js/boot.js", "/kanban/board.css",
                     "/core/todo.js", "/kanban/demo.md"):
            code, _, _ = srv.ask("GET", path, JEROME)
            ok("signed in: %s is served" % path, code == 200, "got %d" % code)
        for path in ("/kanban/server.py", "/README.md", "/core/settings.py", "/.git",
                     "/.git/HEAD", "/kanban/", "/kanban/js/", "/core/", "/kanban/ui/index.ts",
                     "/scripts/set-board-access.py", "/kanban/js/../server.py"):
            code, _, _ = srv.ask("GET", path, JEROME)
            ok("signed in: %s is refused" % path, code == 404, "got %d" % code)
        req = urllib.request.Request(srv.base + "/", headers=JEROME)
        opener = urllib.request.build_opener(type("NoRedirect", (urllib.request.HTTPRedirectHandler,),
                                                  {"redirect_request": lambda *a, **k: None}))
        try:
            code, where = opener.open(req).status, ""
        except urllib.error.HTTPError as err:
            code, where = err.code, err.headers.get("Location")
        ok("signed in: / goes to the board", code == 302 and where == "/kanban/index.html", "%s %s" % (code, where))

        # Names, not paths on the server.
        code, body, _ = srv.ask("GET", "/settings.json", JEROME)
        got = as_json(body) or {}
        ok("settings name no server folder", "memory_root" not in got
           and all("/" not in v for v in (got.get("projects_roots") or {}).values()), body)
        code, body, _ = srv.ask("GET", "/bucket-brief.json?bucket=1.%20Tasks", JEROME)
        ok("a brief's path is inside the list", (as_json(body) or {}).get("path") == "buckets/tasks/tasks.md", body)
        code, body, _ = srv.ask("POST", "/bucket/scaffold", dict(JEROME, **BOARD), {"name": "Tasks"})
        ok("a scaffolded brief is named inside the list",
           (as_json(body) or {}).get("brief") == "buckets/tasks/tasks.md", body)
        code, body, _ = srv.ask("GET", "/streams.json", JEROME)
        paths = [st.get("path", "") for st in (as_json(body) or {}).get("streams", [])]
        ok("streams name a folder, not a path", all("/" not in p for p in paths), str(paths))
        code, body, _ = srv.ask("GET", "/agents-status.json", JEROME)
        ok("signed in, no agent can run", (as_json(body) or {}).get("ready") is False, body)

        # --- every write lands on Jerome's board, never Tiago's -------------------
        before = snapshot(os.path.join(data, "tiago-own"))
        for path, body in BOARD_POSTS:
            srv.ask("POST", path, dict(JEROME, **BOARD), body)
        srv.ask("PUT", "/bucket-brief", dict(JEROME, **BOARD), {"bucket": "1. Tasks", "text": "mine"})
        code, _, hdrs = srv.ask("GET", "/data/todo.md", JEROME)
        code, _, _ = srv.ask("PUT", "/data/todo.md",
                             dict(JEROME, **{"Content-Type": "text/markdown",
                                             "If-Unmodified-Since": hdrs.get("Last-Modified"),
                                             "If-Match": hdrs.get("X-Todo-Hash")}),
                             "# To-do\n\n## 1. Tasks\n\n### To do\n\n- [ ] Jerome's\n".encode())
        ok("Jerome's save lands", code == 200, "got %d" % code)
        with open(os.path.join(data, "jerome-own", "todo.md")) as fh:
            ok("on his own board", "Jerome's" in fh.read())
        ok("no write by Jerome touched Tiago's board", snapshot(os.path.join(data, "tiago-own")) == before)

        code, _, _ = srv.ask("POST", "/dataset/access", dict(JEROME, **BOARD),
                             {"name": "tiago-own", "people": ["jerome@example.com"]})
        ok("Jerome cannot share Tiago's board: 404", code == 404, "got %d" % code)

        # --- someone with no board at all ---------------------------------------
        wrong = []
        for path in BOARD_GETS:
            code, body, _ = srv.ask("GET", path, OUTSIDER)
            if path != "/settings.json" and code != 404:
                wrong.append("GET %s %d" % (path, code))
            if SECRET in body:
                wrong.append("GET %s leaked" % path)
        for path, body in BOARD_POSTS:
            code, _, _ = srv.ask("POST", path, dict(OUTSIDER, **BOARD), body)
            if code != 404:
                wrong.append("POST %s %d" % (path, code))
        code, _, _ = srv.ask("PUT", "/data/todo.md", dict(OUTSIDER, **{"If-Unmodified-Since": "x"}),
                             b"# To-do\n\n## 1. x\n")
        if code != 404:
            wrong.append("PUT /data/todo.md %d" % code)
        ok("with no board, every board route is a 404", not wrong, ", ".join(wrong))
        ok("and nothing was written for them", not os.path.exists(os.path.join(data, ".no-list")))
        code, body, _ = srv.ask("GET", "/settings.json", JEROME)
        roots = (as_json(body) or {}).get("projects_roots") or {}
        ok("settings name no board outside access", "tiago-own" not in roots and "offdesk" in roots, body)

        # --- making a board -------------------------------------------------------
        code, _, _ = srv.ask("POST", "/datasets", dict(JEROME, **BOARD), {"name": "J Notes"})
        ok("Jerome makes a personal board", code == 200, "got %d" % code)
        got = json.load(open(os.path.join(data, "j-notes", "access.json")))
        ok("personal: only its owner", got == {"owner": "jerome@example.com", "people": [], "teams": []}, str(got))
        ok("Tiago does not see it", "j-notes" not in boards(srv, TIAGO))
        code, _, _ = srv.ask("POST", "/datasets", dict(JEROME, **BOARD),
                             {"name": "J Team", "sharing": {"kind": "shared", "teams": ["offdesk"]}})
        ok("Jerome makes a board shared with his team", code == 200, "got %d" % code)
        ok("Tiago sees it", "j-team" in boards(srv, TIAGO))
        code, _, _ = srv.ask("POST", "/datasets", dict(JEROME, **BOARD),
                             {"name": "J People", "sharing": {"kind": "shared", "people": ["Tiagopedras+claude@gmail.com"]}})
        ok("a board shared with a named person", code == 200 and "j-people" in boards(srv, TIAGO), "got %d" % code)
        for name, sharing, want in (("Elsewhere", {"kind": "shared", "teams": ["secret-team"]}, 400),
                                    ("Nobody", {"kind": "shared"}, 400),
                                    ("Odd", {"kind": "everyone"}, 400),
                                    ("users", None, 400),
                                    ("tiago-own", None, 409)):
            code, _, _ = srv.ask("POST", "/datasets", dict(JEROME, **BOARD),
                                 {"name": name, "sharing": sharing} if sharing else {"name": name})
            ok("refused: %s" % name, code == want, "got %d" % code)
        ok("a refused board makes no folder",
           not any(os.path.exists(os.path.join(data, n)) for n in ("elsewhere", "nobody", "odd")))
        ok("Tiago's board is untouched by the name clash",
           json.load(open(os.path.join(data, "tiago-own", "access.json")))["owner"] == "tiagopedras+claude@gmail.com")

        # --- changing who sees a board -------------------------------------------
        srv.ask("POST", "/dataset/select", dict(JEROME, **BOARD), {"name": "offdesk"})
        code, body, _ = srv.ask("GET", "/dataset/access.json", JEROME)
        ok("Jerome reads the team board's sharing, not as owner",
           code == 200 and (as_json(body) or {}).get("mine") is False, body)
        code, _, _ = srv.ask("POST", "/dataset/access", dict(JEROME, **BOARD), {"teams": [], "people": []})
        ok("only the owner changes sharing: 403", code == 403, "got %d" % code)
        code, body, _ = srv.ask("POST", "/dataset/access", dict(TIAGO, **BOARD),
                                {"name": "tiago-own", "people": ["jerome@example.com"]})
        ok("Tiago shares his board with Jerome", code == 200, body)
        ok("Jerome now sees it", "tiago-own" in boards(srv, JEROME))
        code, _, _ = srv.ask("POST", "/dataset/access", dict(TIAGO, **BOARD),
                             {"name": "tiago-own", "teams": ["other"]})
        ok("the owner cannot share with a team he is not in", code == 400, "got %d" % code)
        srv.ask("POST", "/dataset/access", dict(TIAGO, **BOARD), {"name": "tiago-own"})
        ok("and makes it personal again", "tiago-own" not in boards(srv, JEROME))

        # --- a board from before sign-in ------------------------------------------
        ok("a board with no access.json is seen by nobody",
           "legacy" not in boards(srv, TIAGO) and "legacy" not in boards(srv, JEROME))
        ok("nor is one whose access.json does not parse", "broken" not in boards(srv, TIAGO))
        env = dict(os.environ, TODOS_DATA_ROOT=data)
        script = os.path.join(ROOT, "scripts", "set-board-access.py")
        run = lambda *a: subprocess.run([sys.executable, script] + list(a), env=env,
                                        capture_output=True, text=True)
        ok("the script wants an owner the first time", run("legacy", "--team", "offdesk").returncode == 2)
        ok("the script refuses a board that is not there", run("nothere", "--owner", "a@b.io").returncode == 2)
        r = run("legacy", "--owner", "tiagopedras+claude@gmail.com", "--team", "offdesk")
        ok("the script sets a board's access", r.returncode == 0, r.stderr)
        ok("and Jerome sees it through his team", "legacy" in boards(srv, JEROME))
        r = run("legacy", "--person", "x@example.com")
        got = json.load(open(os.path.join(data, "legacy", "access.json")))
        ok("a later run keeps the owner and adds", got["owner"] == "tiagopedras+claude@gmail.com"
           and got["teams"] == ["offdesk"] and got["people"] == ["x@example.com"], str(got))
    finally:
        srv.stop()

    # --- the same folder on the Mac board ---------------------------------------
    srv = Server(data, None)
    ok("Mac server over the same boards starts", srv.wait())
    try:
        got = boards(srv, None)
        ok("Mac: every board is visible, access.json or not",
           all(n in got for n in ("broken", "jerome-own", "legacy", "offdesk", "tiago-own")), str(got))
        code, body, _ = srv.ask("GET", "/datasets.json")
        ok("Mac: data/.current is the board on screen", (as_json(body) or {}).get("current") == "legacy", body)
        code, _, _ = srv.ask("POST", "/datasets", BOARD, {"name": "Mac List"})
        ok("Mac: a new board has no access.json",
           code == 200 and not os.path.exists(os.path.join(data, "mac-list", "access.json")), "got %d" % code)
        with open(os.path.join(data, ".current")) as fh:
            ok("Mac: making it moves data/.current", fh.read() == "mac-list")
        code, _, _ = srv.ask("GET", "/dataset/access.json")
        ok("Mac: /dataset/access.json is 404", code == 404, "got %d" % code)
        code, _, _ = srv.ask("GET", "/kanban/../data/settings.json")
        ok("Mac: data/ is still not served outside /data/", code == 404, "got %d" % code)
        os.symlink(os.path.join(data, "tiago-own"), os.path.join(data, "mac-list", "sneak"))
        for path in ("/data/%252e%252e/tiago-own/todo.md", "/data/%252e%252e/settings.json",
                     "/.git/HEAD", "/.git", "/data/sneak/todo.md"):
            code, body, _ = srv.ask("GET", path)
            ok("Mac: %s is refused" % path, code == 404 and SECRET not in body, "got %d" % code)
        for path in ("/README.md", "/kanban/server.py", "/kanban/", "/data/todo.md"):
            code, _, _ = srv.ask("GET", path)
            ok("Mac: %s is served as before" % path, code == 200, "got %d" % code)
    finally:
        srv.stop()


def mac_checks(root):
    data = os.path.join(root, "mac")
    seed(data, "personal")
    srv = Server(data, None)
    ok("Mac server starts", srv.wait())
    try:
        code, body, _ = srv.ask("GET", "/data/todo.md")
        ok("Mac: the list reads with no headers", code == 200 and "A task" in body, "got %d" % code)
        code, _, _ = srv.ask("GET", "/whoami")
        ok("Mac: /whoami is 404", code == 404, "got %d" % code)
        code, body, _ = srv.ask("GET", "/datasets.json")
        ok("Mac: /datasets.json lists the board", (as_json(body) or {}).get("datasets") == ["personal"], body)
        code, _, _ = srv.ask("GET", "/schedule.json")
        ok("Mac: /schedule.json still answers", code == 200, "got %d" % code)
        code, _, _ = srv.ask("POST", "/archive", {"Content-Type": "text/plain"}, body=b'{"text": "x"}')
        ok("Mac: /archive still takes a POST without X-Board", code == 200, "got %d" % code)
    finally:
        srv.stop()


def profile_checks(root):
    data = os.path.join(root, "profiles")
    seed(data, "offdesk")
    access(data, "offdesk", "tiagopedras+claude@gmail.com", teams=["offdesk"])
    shared = os.path.join(data, "profile.md")
    write(shared, "# PA profile\n\n## About\n\n- Name: Tiago/Jerome\n- Country: GB\n\n"
                  "## Writing\n\n- Spelling: British English\n")
    shared_before = open(shared, encoding="utf-8").read()
    jerome_file = board_access.profile_path(data, JEROME["X-Offdesk-Email"])
    tiago_file = board_access.profile_path(data, TIAGO["X-Offdesk-Email"])
    srv = Server(data, "header")
    ok("profile server starts", srv.wait())
    try:
        code, body, _ = srv.ask("GET", "/profile-basics.json", JEROME)
        got = as_json(body) or {}
        ok("profile: before saving, the name is the sign-in's", code == 200 and got.get("name") == "Jérôme", body)
        ok("profile: before saving, the rest is the shared profile", got.get("country") == "GB"
           and got.get("sections", {}).get("writing") == "- Spelling: British English", body)
        ok("profile: signed in, no path is offered", "facts_file" not in got.get("about", {"facts_file": 1})
           and "setup" not in got.get("sections", {"setup": 1}) and "setup" not in got.get("hints", {"setup": 1}), body)
        ok("profile: signed in, nothing to set up", got.get("needs_setup") is False, body)

        code, body, _ = srv.ask("PUT", "/profile-basics.json", dict(JEROME, **BOARD), body={
            "name": "Jerome", "country": "PT", "region": "",
            "about": {"addressing": "Salut Jerome"},
            "sections": {"writing": "- Spelling: French", "habits": "- Deferring: builds straight away"}})
        got = as_json(body) or {}
        ok("profile: a person saves their own", code == 200 and got.get("name") == "Jerome"
           and got.get("country") == "PT", "%d %s" % (code, body))
        ok("profile: it lands beside their user record", os.path.isfile(jerome_file))
        text = open(jerome_file, encoding="utf-8").read() if os.path.isfile(jerome_file) else ""
        ok("profile: in the - Key: value format", "- Name: Jerome" in text and "- Country: PT" in text
           and "- How to address them: Salut Jerome" in text and "- Spelling: French" in text, text)
        ok("profile: the shared profile is untouched",
           open(shared, encoding="utf-8").read() == shared_before)

        code, body, _ = srv.ask("GET", "/profile-basics.json", JEROME)
        got = as_json(body) or {}
        ok("profile: reading it back gives their own", got.get("name") == "Jerome"
           and got.get("about", {}).get("addressing") == "Salut Jerome"
           and got.get("sections", {}).get("habits") == "- Deferring: builds straight away", body)
        code, body, _ = srv.ask("GET", "/holiday-countries.json", JEROME)
        ok("profile: the regions offered follow their own country", "PT" in (as_json(body) or {}).get("regions", {"PT": 1})
           or (as_json(body) or {}).get("regions") == {}, body)

        code, body, _ = srv.ask("GET", "/profile-basics.json", TIAGO)
        got = as_json(body) or {}
        ok("profile: somebody else never sees it", got.get("name") == urllib.parse.unquote(TIAGO["X-Offdesk-Name"])
           and got.get("country") == "GB" and got.get("sections", {}).get("writing") == "- Spelling: British English", body)
        ok("profile: and has no file of their own yet", not os.path.exists(tiago_file))

        for bad in ({"about": {"facts_file": "/etc/passwd"}}, {"sections": {"setup": "- Bench repo: /"}}):
            code, body, _ = srv.ask("PUT", "/profile-basics.json", dict(TIAGO, **BOARD), body=dict(bad, name="Tiago"))
            ok("profile: signed in, a path is refused: %s" % list(bad.values())[0], code == 400, "got %d" % code)
        code, _, _ = srv.ask("PUT", "/profile-basics.json", dict(TIAGO, **BOARD),
                             body={"name": "Tiago", "sections": {"writing": "## About\n- Name: X"}})
        ok("profile: a heading that would split the file is refused", code == 400, "got %d" % code)
        code, _, _ = srv.ask("PUT", "/profile-basics.json", dict(TIAGO, **{"Content-Type": "application/json"}),
                             body={"name": "Tiago"})
        ok("profile: a PUT without X-Board is refused", code == 403, "got %d" % code)
        ok("profile: the refused saves wrote nothing", not os.path.exists(tiago_file))

        pa = {"X-Offdesk-Email": "pa-tiago@offdesk.invalid", "X-Offdesk-Name": "PA", "X-Offdesk-Board": "offdesk"}
        for method in ("GET", "PUT"):
            code, _, _ = srv.ask(method, "/profile-basics.json", dict(pa, **BOARD),
                                 body={"name": "x"} if method == "PUT" else None)
            ok("profile: a request held to one board cannot %s a profile" % method, code == 403, "got %d" % code)
    finally:
        srv.stop()

    # The Mac: nobody signed in, and the profile is data/profile.md as ever.
    srv = Server(data, None)
    ok("profile: Mac server starts", srv.wait())
    try:
        code, body, _ = srv.ask("GET", "/profile-basics.json")
        got = as_json(body) or {}
        ok("profile: Mac reads the shared profile, paths and all", got.get("name") == "Tiago/Jerome"
           and "facts_file" in got.get("about", {}) and "setup" in got.get("sections", {}), body)
        code, body, _ = srv.ask("PUT", "/profile-basics.json", BOARD, body={
            "name": "Tiago", "about": {"facts_file": "~/facts.md"}, "sections": {"setup": "- Bench repo: ~/bench"}})
        ok("profile: Mac saves the shared profile", code == 200, "%d %s" % (code, body))
        text = open(shared, encoding="utf-8").read()
        ok("profile: Mac wrote data/profile.md", "- Name: Tiago" in text and "- Facts file: ~/facts.md" in text
           and "- Bench repo: ~/bench" in text, text)
        ok("profile: Mac left the person's file alone",
           "- Name: Jerome" in open(jerome_file, encoding="utf-8").read())
    finally:
        srv.stop()


def translate_checks(root):
    """The data/ guard itself, in-process, where the data root is the served
    tree's own data/ as it is on a real install. Over a scratch root the
    server's base class would never find a board under ROOT/data/ anyway."""
    sys.path.insert(0, os.path.join(ROOT, "kanban"))
    import server
    tree = os.path.join(root, "tree")
    data = os.path.join(tree, "data")
    seed(data, "mine")
    seed(data, "theirs")
    write(os.path.join(data, ".current"), "mine")
    server.DATA_ROOT = server.DEFAULT_DATA_ROOT = data
    server.CURRENT_FILE = os.path.join(data, ".current")
    server.SCRATCH = False
    h = server.Handler.__new__(server.Handler)
    h.directory = tree
    for path in ("//data/theirs/todo.md", "/./data/theirs/todo.md", "/data/../data/theirs/todo.md",
                 "/kanban/../data/theirs/todo.md", "//data/.current"):
        real = os.path.realpath(h.translate_path(path))
        ok("translate_path keeps %s out of other boards" % path,
           not real.startswith(os.path.realpath(os.path.join(data, "theirs"))) and not real.endswith(".current"), real)
    ok("translate_path still serves the board on screen",
       h.translate_path("/data/todo.md") == os.path.join(data, "mine", "todo.md"))
    ok("and the page", h.translate_path("/kanban/index.html") == os.path.join(server.ROOT, "kanban", "index.html"))


def refusal_checks(root):
    srv = Server(os.path.join(root, "typo"), "headers")
    started = srv.wait()
    out = srv.stop()
    ok("an unknown BENCH_AUTH refuses to start", not started and "BENCH_AUTH" in out, out[-300:])


def main():
    root = tempfile.mkdtemp(prefix="board-access-test-")
    try:
        signed_in_checks(root)
        access_checks(root)
        mac_checks(root)
        profile_checks(root)
        translate_checks(root)
        refusal_checks(root)
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
