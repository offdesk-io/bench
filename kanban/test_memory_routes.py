#!/usr/bin/env python3
"""The routes behind the Memory page: a board's about text, its people and one
read that gathers what the page shows.

    python3 kanban/test_memory_routes.py

No browser and no running board. One half starts a `Handler` of its own with
`dataset_dir()` and `current_dataset()` pointed at a temporary folder, the way
test_bucket_brief.py does. The other starts kanban/server.py signed in
(BENCH_AUTH=header) over a throwaway data root. Nothing under the real data/
is read or written.

What it holds to:

  * /about.json and PUT /about round-trip a board's company text, and a board
    with no about.md reads as empty text rather than an error;
  * PUT /people rewrites only the people table of an existing people.md and
    keeps its headings, prose and other tables, and creates the file when it
    is not there; the extra columns come back on /people.json;
  * /memory.json carries about, people, every bucket with its brief, and the
    profile, in one reply;
  * with a memory folder in settings.json, about and people are read from
    the data/ copy until the memory folder has its own, and every save lands
    in the memory folder and leaves the data/ copy as it was;
  * a write that is not from the board is refused, and a person who cannot see
    a board gets the refusal the other per-board routes give.
"""

import json
import os
import shutil
import sys
import tempfile
import threading
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HERE = os.path.join(ROOT, "kanban")
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "core"))

import server  # noqa: E402
from test_board_access import Server, seed, access, TIAGO, JEROME, BOARD  # noqa: E402

PASS = []
FAIL = []


def ok(label, cond, detail=""):
    (PASS if cond else FAIL).append(label if cond else
                                    (label + (" — " + detail if detail else "")))


def request(base, method, path, body=None, headers=None):
    req = urllib.request.Request(base + path, method=method,
                                 data=json.dumps(body).encode("utf-8") if body is not None else None,
                                 headers=headers or {})
    try:
        with urllib.request.urlopen(req) as res:
            return res.status, json.loads(res.read().decode("utf-8") or "null")
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8")
        try:
            return err.code, json.loads(raw)
        except ValueError:
            return err.code, raw


FROM_BOARD = {"Content-Type": "application/json", "X-Board": "1"}

PEOPLE_MD = """# People

Who is who on this list.

| Name | Role | Team | Reports to | Pronouns |
| --- | --- | --- | --- | --- |
| **Ana** | Lead Designer | Web | Anu | she |
| Anu | Manager | Web | | |

Some prose between the tables.

## Often confused

| Name | Not to be confused with |
| --- | --- |
| Dave | David |

The end.
"""

LIST = ("# To-do\n\n## 1. People\n\n### To do\n\n- [ ] A task\n\n## 2. Money\n\n### To do\n\n"
        "## Context\n\nNotes.\n")


def in_process(root):
    tmp = os.path.join(root, "memory-test")
    os.makedirs(tmp)
    with open(os.path.join(tmp, "todo.md"), "w", encoding="utf-8") as fh:
        fh.write(LIST)
    server.dataset_dir = lambda name=None: tmp
    server.current_dataset = lambda: "memory-test"
    server.planning_agent_plan.paths.DATA_ROOT = root
    os.environ["PLANNING_DATASET"] = "memory-test"
    # The list's memory files are looked up under the data root, which is
    # `root` here, so the real data/ and its settings.json are never read.
    server.DATA_ROOT = root
    os.makedirs(os.path.join(tmp, "buckets", "people"))
    with open(os.path.join(tmp, "buckets", "people", "people.md"), "w", encoding="utf-8") as fh:
        fh.write("# People brief\n")
    httpd = server.BoardHTTPServer(("127.0.0.1", 0), server.Handler)
    base = "http://127.0.0.1:%d" % httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        # --- about ------------------------------------------------------------
        code, got = request(base, "GET", "/about.json")
        ok("a board with no about.md reads as empty text", code == 200 and got["text"] == "" and got["exists"] is False,
           "%s %s" % (code, got))
        code, got = request(base, "PUT", "/about", {"text": "A studio of four.\n\nWe build things."}, FROM_BOARD)
        ok("the about text can be saved", code == 200 and got.get("ok") is True, "%s %s" % (code, got))
        code, got = request(base, "GET", "/about.json")
        ok("and reads back whole", got["text"] == "A studio of four.\n\nWe build things." and got["exists"] is True)
        ok("in about.md beside the list", os.path.isfile(os.path.join(tmp, "about.md")))
        ok("with no temp file left", not os.path.exists(os.path.join(tmp, "about.md.tmp")))
        code, _ = request(base, "PUT", "/about", {"text": "x"}, {"Content-Type": "application/json"})
        ok("an about write not from the board is refused", code == 403, "got %s" % code)
        code, _ = request(base, "PUT", "/about", {"nope": 1}, FROM_BOARD)
        ok("an about write with no text is refused", code == 400, "got %s" % code)

        # --- people: no file yet -----------------------------------------------
        code, got = request(base, "GET", "/people.json")
        ok("no people.md reads as nobody", code == 200 and got == {"people": []}, "%s %s" % (code, got))
        rows = [{"name": "Ana", "role": "Lead Designer", "team": "Web", "reports_to": "Anu", "notes": "she/her"},
                {"name": "Anu", "role": "Manager", "team": "Web", "reports_to": "", "notes": ""}]
        code, got = request(base, "PUT", "/people", {"people": rows}, FROM_BOARD)
        ok("people.md is created when it is missing", code == 200 and os.path.isfile(os.path.join(tmp, "people.md")),
           "%s %s" % (code, got))
        with open(os.path.join(tmp, "people.md"), encoding="utf-8") as fh:
            made = fh.read()
        ok("with a header and the table", made.startswith("# People\n\n| Name | Role | Team | Reports to | Notes |"), made)
        code, got = request(base, "GET", "/people.json")
        ok("the extra columns come back", got["people"] == rows, str(got))

        # --- people: an existing file ------------------------------------------
        with open(os.path.join(tmp, "people.md"), "w", encoding="utf-8") as fh:
            fh.write(PEOPLE_MD)
        code, got = request(base, "GET", "/people.json")
        ana = got["people"][0]
        ok("name and role still come back", ana["name"] == "Ana" and ana["role"] == "Lead Designer", str(ana))
        ok("with team and reports_to read from the header", ana["team"] == "Web" and ana["reports_to"] == "Anu", str(ana))
        ok("the confusable-names table is not read as people", [p["name"] for p in got["people"]] == ["Ana", "Anu"])
        rows = [{"name": "Ana", "role": "Principal Designer", "team": "Web", "reports_to": "Anu", "notes": "on leave"},
                {"name": "Anu", "role": "Manager", "team": "Web", "reports_to": "", "notes": ""},
                {"name": "Bo", "role": "Engineer", "team": "Dev", "reports_to": "Anu", "notes": ""}]
        code, got = request(base, "PUT", "/people", {"people": rows}, FROM_BOARD)
        ok("the people table can be rewritten", code == 200 and [p["name"] for p in got["people"]] == ["Ana", "Anu", "Bo"],
           "%s %s" % (code, got))
        with open(os.path.join(tmp, "people.md"), encoding="utf-8") as fh:
            after = fh.read()
        ok("the heading, prose and other table are untouched",
           after.startswith("# People\n\nWho is who on this list.\n\n| Name | Role | Team | Reports to | Pronouns | Notes |")
           and "\nSome prose between the tables.\n\n## Often confused\n\n| Name | Not to be confused with |\n"
               "| --- | --- |\n| Dave | David |\n\nThe end.\n" in after, after)
        ok("a column the file already had is kept", "| she |" in after and "**Ana**" in after, after)
        ok("a changed role is written", "Principal Designer" in after and "| Lead Designer |" not in after)
        ok("a new person is added", "| Bo | Engineer | Dev | Anu |" in after, after)
        code, _ = request(base, "PUT", "/people", {"people": [{"name": "A"}, {"name": "A"}]}, FROM_BOARD)
        ok("a person listed twice is refused", code == 400, "got %s" % code)
        code, _ = request(base, "PUT", "/people", {"people": [{"name": " "}]}, FROM_BOARD)
        ok("a person with no name is refused", code == 400, "got %s" % code)
        code, _ = request(base, "PUT", "/people", {"people": rows}, {"Content-Type": "application/json"})
        ok("a people write not from the board is refused", code == 403, "got %s" % code)
        code, got = request(base, "PUT", "/people", {"people": [{"name": "Pipe | Man", "role": "a\nb"}]}, FROM_BOARD)
        ok("a pipe or line break in a cell cannot split the row",
           code == 200 and got["people"][0]["name"] == "Pipe / Man" and got["people"][0]["role"] == "a b", str(got))

        # --- two people tables: refused, nothing written --------------------------
        split = PEOPLE_MD + "\n| Name | Role |\n| --- | --- |\n| Zed | Intern |\n"
        with open(os.path.join(tmp, "people.md"), "w", encoding="utf-8") as fh:
            fh.write(split)
        code, got = request(base, "PUT", "/people", {"people": rows}, FROM_BOARD)
        ok("a file with two people tables is refused with 409",
           code == 409 and got.get("error") == "people.md has more than one people table; tidy it by hand first",
           "%s %s" % (code, got))
        with open(os.path.join(tmp, "people.md"), encoding="utf-8") as fh:
            ok("and nothing is written", fh.read() == split)

        # --- a linked file is written through ------------------------------------
        real = os.path.join(root, "memory-folder")
        os.makedirs(real)
        target = os.path.join(real, "people.md")
        with open(target, "w", encoding="utf-8") as fh:
            fh.write(PEOPLE_MD)
        link = os.path.join(tmp, "people.md")
        os.remove(link)
        os.symlink(target, link)
        code, got = request(base, "PUT", "/people", {"people": rows}, FROM_BOARD)
        ok("a linked people.md saves", code == 200, "%s %s" % (code, got))
        ok("the link is still a link", os.path.islink(link))
        with open(target, encoding="utf-8") as fh:
            ok("and the file it points at holds the save", "| Bo | Engineer | Dev | Anu |" in fh.read())
        ok("with no temp file left in either folder",
           not [f for d in (tmp, real) for f in os.listdir(d) if f.endswith(".tmp")])
        os.remove(link)
        with open(link, "w", encoding="utf-8") as fh:
            fh.write("# People\n")
        with open(os.path.join(tmp, "about.md"), "w", encoding="utf-8") as fh:
            fh.write("A studio of four.\n\nWe build things.")

        # --- context -----------------------------------------------------------
        code, got = request(base, "GET", "/context.json")
        ok("a board with no context.md reads as empty text", code == 200 and got["text"] == "" and got["exists"] is False,
           "%s %s" % (code, got))
        code, got = request(base, "PUT", "/context", {"text": "Ana is away.\n"}, FROM_BOARD)
        ok("the context can be saved", code == 200 and got.get("ok") is True, "%s %s" % (code, got))
        code, got = request(base, "GET", "/context.json")
        ok("and reads back", got["text"] == "Ana is away.\n" and got["exists"] is True, str(got))
        ok("in context.md beside the list", os.path.isfile(os.path.join(tmp, "context.md")))
        code, _ = request(base, "PUT", "/context", {"text": "x"}, {"Content-Type": "application/json"})
        ok("a context write not from the board is refused", code == 403, "got %s" % code)
        code, _ = request(base, "PUT", "/context", {"nope": 1}, FROM_BOARD)
        ok("a context write with no text is refused", code == 400, "got %s" % code)
        code, got = request(base, "GET", "/memory.json")
        ok("memory.json carries it", got["context"] == {"text": "Ana is away.\n", "exists": True}, str(got.get("context")))
        os.remove(os.path.join(tmp, "context.md"))

        # --- memory.json --------------------------------------------------------
        code, got = request(base, "GET", "/memory.json")
        ok("memory.json answers", code == 200, "%s %s" % (code, got))
        ok("it names the board", got["board"] == "memory-test")
        ok("and carries the about text", got["about"] == {"text": "A studio of four.\n\nWe build things.", "exists": True})
        ok("and the people", got["people"] == [], str(got["people"]))
        ok("and every bucket in file order", [b["name"] for b in got["buckets"]] == ["People", "Money"], str(got["buckets"]))
        people_b = got["buckets"][0]
        ok("a bucket carries heading, slug and brief text",
           people_b["heading"] == "1. People" and people_b["slug"] == "people" and people_b["text"] == "# People brief\n"
           and people_b["exists"] is True, str(people_b))
        ok("a bucket with no brief has empty text", got["buckets"][1]["text"] == "" and got["buckets"][1]["exists"] is False)
        ok("and the profile with its sections", set(got["profile"]) >= {"name", "about", "sections", "hints"}, str(list(got["profile"])))
        ok("todo.md's Context is not in it", "Notes." not in json.dumps(got))
        with open(os.path.join(tmp, "todo.md"), encoding="utf-8") as fh:
            ok("and todo.md is untouched", fh.read() == LIST)

        # --- with a memory folder ---------------------------------------------
        memory = os.path.join(root, "MEMORY")
        os.makedirs(memory)
        with open(os.path.join(root, "settings.json"), "w", encoding="utf-8") as fh:
            json.dump({"memory_root": memory}, fh)
        there = os.path.join(memory, "bench", "memory-test")
        with open(os.path.join(tmp, "people.md"), "w", encoding="utf-8") as fh:
            fh.write(PEOPLE_MD)
        code, got = request(base, "GET", "/about.json")
        ok("with a memory folder and no copy in it, about reads the list's own",
           code == 200 and got["text"] == "A studio of four.\n\nWe build things.", "%s %s" % (code, got))
        code, got = request(base, "GET", "/people.json")
        ok("and so do people", [p["name"] for p in got["people"]] == ["Ana", "Anu"], str(got))
        code, got = request(base, "PUT", "/about", {"text": "Moved."}, FROM_BOARD)
        ok("an about save with a memory folder answers", code == 200, "%s %s" % (code, got))
        with open(os.path.join(there, "about.md"), encoding="utf-8") as fh:
            ok("and lands in the memory folder", fh.read() == "Moved.")
        with open(os.path.join(tmp, "about.md"), encoding="utf-8") as fh:
            ok("leaving the list's own copy as it was", fh.read() == "A studio of four.\n\nWe build things.")
        code, got = request(base, "GET", "/about.json")
        ok("the memory folder's copy is read from then on", got["text"] == "Moved.", str(got))
        code, got = request(base, "PUT", "/people", {"people": rows}, FROM_BOARD)
        ok("a people save with a memory folder answers", code == 200 and [p["name"] for p in got["people"]] == ["Ana", "Anu", "Bo"],
           "%s %s" % (code, got))
        with open(os.path.join(there, "people.md"), encoding="utf-8") as fh:
            moved = fh.read()
        ok("lands in the memory folder, keeping the rest of the file it was read from",
           "| Bo | Engineer | Dev | Anu |" in moved and "## Often confused" in moved, moved)
        with open(os.path.join(tmp, "people.md"), encoding="utf-8") as fh:
            ok("and the list's own people.md is not written", fh.read() == PEOPLE_MD)
        code, got = request(base, "GET", "/memory.json")
        ok("memory.json reads both from the memory folder",
           got["about"]["text"] == "Moved." and [p["name"] for p in got["people"]] == ["Ana", "Anu", "Bo"], str(got))
        code, got = request(base, "PUT", "/context", {"text": "Moved context."}, FROM_BOARD)
        ok("a context save with a memory folder answers", code == 200, "%s %s" % (code, got))
        with open(os.path.join(there, "context.md"), encoding="utf-8") as fh:
            ok("and lands in the memory folder", fh.read() == "Moved context.")
        ok("leaving the list's own folder without one", not os.path.exists(os.path.join(tmp, "context.md")))
        code, got = request(base, "GET", "/context.json")
        ok("the memory folder's copy is read from then on", got["text"] == "Moved context.", str(got))
        os.remove(os.path.join(root, "settings.json"))
    finally:
        httpd.shutdown()
        httpd.server_close()


def signed_in(root):
    data = os.path.join(root, "signed-in")
    seed(data, "offdesk", LIST)
    access(data, "offdesk", TIAGO["X-Offdesk-Email"], teams=["offdesk"])
    seed(data, "tiago-own", LIST)
    access(data, "tiago-own", TIAGO["X-Offdesk-Email"])
    with open(os.path.join(data, "tiago-own", "about.md"), "w", encoding="utf-8") as fh:
        fh.write("SECRET-ABOUT")
    outsider = {"X-Offdesk-Email": "nobody@example.com", "X-Offdesk-Name": "Nobody"}
    srv = Server(data, "header")
    ok("the signed-in server starts", srv.wait())
    try:
        code, body, _ = srv.ask("GET", "/memory.json", dict(TIAGO))
        ok("a person who can see a board reads its memory", code == 200, "%d %s" % (code, body[:200]))
        code, body, _ = srv.ask("PUT", "/about", dict(JEROME, **BOARD), {"text": "mine"})
        ok("a team member can write the shared board's about text", code == 200, "%d %s" % (code, body[:200]))
        with open(os.path.join(data, "offdesk", "about.md"), encoding="utf-8") as fh:
            ok("into the board they are on", fh.read() == "mine")
        for method, path, body in (("GET", "/memory.json", None), ("GET", "/about.json", None),
                                   ("PUT", "/about", {"text": "x"}), ("PUT", "/people", {"people": []})):
            code, text, _ = srv.ask(method, path, dict(outsider, **BOARD), body)
            ok("%s %s is refused for someone with no board" % (method, path), code == 404 and "SECRET" not in text,
               "%d %s" % (code, text[:200]))
        # Another person sees their own board, never Tiago's: Jerome's current
        # board falls to the one he can see, so Tiago's about text does not leak.
        code, text, _ = srv.ask("GET", "/memory.json", dict(JEROME))
        ok("a board outside someone's access never shows in their memory", "SECRET-ABOUT" not in text, text[:200])
        code, text, _ = srv.ask("PUT", "/about", dict(JEROME, **{"X-Board": "1", "Content-Type": "application/json"}),
                                {"text": "overwrite"})
        with open(os.path.join(data, "tiago-own", "about.md"), encoding="utf-8") as fh:
            ok("and their write never lands on it", fh.read() == "SECRET-ABOUT")
    finally:
        srv.stop()


def main():
    root = tempfile.mkdtemp(prefix="memory-test-")
    try:
        in_process(root)
        signed_in(root)
    finally:
        shutil.rmtree(root, ignore_errors=True)
    for label in FAIL:
        print("FAIL", label)
    print("%d passed, %d failed" % (len(PASS), len(FAIL)))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
