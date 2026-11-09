#!/usr/bin/env python3
"""The project routes and the one check behind them.

    python3 kanban/test_project_folders.py

No browser and no running board. Like test_bucket_brief.py it starts a
`Handler` of its own on an ephemeral port with `dataset_dir()` and
`current_dataset()` pointed at a temporary folder, so nothing under `data/` is
read or written. `subprocess.Popen` is replaced with a recorder, so the
open-folder route is tested for what it would open without opening Finder.

What it holds to:

  * a bare name resolves under data/projects/ and nowhere else;
  * `..`, a symlink out, an unapproved absolute path and a missing folder are
    each refused, by /project.json and /project/open alike;
  * an approved folder resolves, and so does a folder inside it;
  * Start a project makes the folder and a CLAUDE.md project_about() reads back,
    refuses a duplicate, and never touches todo.md;
  * every write route refuses a request that is not from the board;
  * with the list's own projects folder set (`projects_roots`), a bare name
    resolves there first and under data/projects/ after, new folders are
    made there and served from there, and another list's folder is never
    looked in.
"""

import http.server
import json
import os
import shutil
import sys
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "kanban"))

import server  # noqa: E402
import project_folders  # noqa: E402

PASS = []
FAIL = []
OPENED = []
# What platform_calls.open_path runs here: `open` on a Mac, `xdg-open` on
# Linux, os.startfile on Windows, which is faked below like Popen.
OPENER = {"darwin": "open", "win32": "startfile"}.get(sys.platform, "xdg-open")


def ok(label, cond, detail=""):
    (PASS if cond else FAIL).append(label if cond else
                                    (label + (" — " + detail if detail else "")))


def request(base, method, path, body=None, headers=None):
    req = urllib.request.Request(base + path, method=method,
                                 data=body.encode("utf-8") if body else None,
                                 headers=headers or {})
    try:
        with urllib.request.urlopen(req) as res:
            return res.status, res.read().decode("utf-8")
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode("utf-8")


BOARD = {"Content-Type": "application/json", "X-Board": "1"}


def get_project(base, ref):
    return request(base, "GET", "/project.json?name=" + urllib.parse.quote(ref, safe=""))


def open_project(base, ref, headers=BOARD):
    return request(base, "POST", "/project/open", json.dumps({"name": ref}), headers)


class FakePopen:
    def __init__(self, args, **kw):
        OPENED.append(args)


def main():
    tmp = os.path.realpath(tempfile.mkdtemp(prefix="projects-test-"))
    ds = os.path.join(tmp, "ds")
    outside = os.path.join(tmp, "outside")
    mine = os.path.join(tmp, "my-work")
    mine_old = os.path.join(tmp, "my-work-old")
    for d in (os.path.join(ds, "projects", "alpha"), outside,
              os.path.join(mine, "client-a"), mine_old):
        os.makedirs(d)
    todo = os.path.join(ds, "todo.md")
    with open(todo, "w", encoding="utf-8") as fh:
        fh.write("# To-do\n")
    before = os.stat(todo).st_mtime_ns
    # A symlink sitting inside data/projects/ that leads out of it.
    os.symlink(outside, os.path.join(ds, "projects", "escape"))

    server.dataset_dir = lambda name=None: ds
    server.current_dataset = lambda: "projects-test"
    server.subprocess.Popen = FakePopen
    server.platform_calls.os.startfile = lambda path: OPENED.append(["startfile", path])

    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    base = "http://127.0.0.1:%d" % httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    try:
        # --- the default place -----------------------------------------------
        code, body = get_project(base, "alpha")
        ok("a bare name under data/projects/ answers 200", code == 200, "got %d" % code)
        ok("and is served from /data/projects/", json.loads(body).get("url") == "/data/projects/alpha/")

        # --- traversal ---------------------------------------------------------
        for ref in ("../todo.md", "..", ".", "alpha/../../ds", "a\\b"):
            code, _ = get_project(base, ref)
            ok("a name with a hop or separator is refused: %r" % ref, code == 400, "got %d" % code)
        code, _ = get_project(base, os.path.join(ds, "projects", "alpha", "..", "..", ".."))
        ok("an absolute path climbing out with .. is refused", code == 403, "got %d" % code)
        code, _ = get_project(base, os.path.join(ds, "projects"))
        ok("data/projects/ itself is not a project", code == 403, "got %d" % code)

        # --- symlink escape ----------------------------------------------------
        code, _ = get_project(base, "escape")
        ok("a symlink out of data/projects/ is refused by name", code == 403, "got %d" % code)
        code, _ = get_project(base, os.path.join(ds, "projects", "escape"))
        ok("and by path", code == 403, "got %d" % code)

        # --- one folder inside a project (the drawer's in-place folder rows) ----
        alpha = os.path.join(ds, "projects", "alpha")
        os.makedirs(os.path.join(alpha, "sources", "deep"))
        with open(os.path.join(alpha, "sources", "2026-11-05-0900-note.md"), "w") as fh:
            fh.write("x")
        os.symlink(outside, os.path.join(alpha, "leak"))
        code, body = request(base, "GET", "/project.json?name=alpha&sub=sources")
        got = json.loads(body) if code == 200 else {}
        ok("a sub-folder lists its own entries", code == 200 and
           [e["name"] for e in got.get("entries", [])] == ["deep", "2026-11-05-0900-note.md"], body[:200])
        code, body = request(base, "GET", "/project.json?name=alpha&sub=sources%2Fdeep")
        ok("one level at a time, and a nested one works", code == 200 and json.loads(body)["entries"] == [], body[:200])
        for bad in ("../", "..", "sources/../..", "sources/../../..", "/etc", ".hidden", "sources//deep", "a\\b"):
            code, _ = request(base, "GET", "/project.json?name=alpha&sub=" + urllib.parse.quote(bad, safe=""))
            ok("a sub-folder path outside the project is refused: %r" % bad, code == 400, "got %d" % code)
        code, _ = request(base, "GET", "/project.json?name=alpha&sub=leak")
        ok("a symlink out of the project is refused as a sub-folder", code == 403, "got %d" % code)
        code, _ = request(base, "GET", "/project.json?name=alpha&sub=missing")
        ok("a missing sub-folder is 404", code == 404, "got %d" % code)
        code, _ = request(base, "GET", "/project.json?name=alpha&sub=sources%2F2026-11-05-0900-note.md")
        ok("a file is not a sub-folder", code == 404, "got %d" % code)

        # --- unapproved absolute path -----------------------------------------
        code, _ = get_project(base, outside)
        ok("an unapproved absolute path is refused", code == 403, "got %d" % code)
        code, _ = open_project(base, outside)
        ok("and the open route refuses it too", code == 403, "got %d" % code)
        ok("without running anything", OPENED == [], repr(OPENED))

        # --- non-existent folder -----------------------------------------------
        code, _ = get_project(base, "nobody-made-this")
        ok("a missing folder under data/projects/ is 404", code == 404, "got %d" % code)

        # --- approving a folder -------------------------------------------------
        code, _ = request(base, "POST", "/project-folders", json.dumps({"path": mine}),
                          {"Content-Type": "application/json"})
        ok("approving is refused when not from the board", code == 403, "got %d" % code)
        code, _ = request(base, "POST", "/project-folders",
                          json.dumps({"path": "relative/path"}), BOARD)
        ok("a relative path cannot be approved", code == 400, "got %d" % code)
        code, _ = request(base, "POST", "/project-folders", json.dumps({"path": "/"}), BOARD)
        ok("the filesystem root cannot be approved", code == 400, "got %d" % code)
        code, _ = request(base, "POST", "/project-folders",
                          json.dumps({"path": os.path.join(tmp, "not-there")}), BOARD)
        ok("a folder that does not exist cannot be approved", code == 404, "got %d" % code)
        code, body = request(base, "POST", "/project-folders", json.dumps({"path": mine}), BOARD)
        ok("an existing folder is approved", code == 200, "got %d %s" % (code, body))
        code, body = request(base, "GET", "/project-folders.json")
        ok("and listed back", json.loads(body)["folders"] == [mine], body)

        code, body = get_project(base, mine)
        ok("an approved folder resolves", code == 200, "got %d" % code)
        got = json.loads(body)
        ok("with no url, since it is not served", got.get("url") is None and got.get("external"), body[:200])
        code, _ = get_project(base, os.path.join(mine, "client-a"))
        ok("so does a folder inside it", code == 200, "got %d" % code)
        code, _ = get_project(base, mine_old)
        ok("a sibling sharing its prefix does not", code == 403, "got %d" % code)
        code, _ = get_project(base, os.path.join(mine, "missing"))
        ok("a missing folder inside an approved one is 404", code == 404, "got %d" % code)
        os.symlink(outside, os.path.join(mine, "sneaky"))
        code, _ = get_project(base, os.path.join(mine, "sneaky"))
        ok("a symlink out of an approved folder is refused", code == 403, "got %d" % code)

        code, body = request(base, "GET", "/projects.json")
        names = [p["name"] for p in json.loads(body)["projects"]]
        ok("the listing walks the approved folders too", mine in names and "alpha" in names, repr(names))
        ok("and leaves the escaping symlink out", "escape" not in names, repr(names))

        # --- opening ------------------------------------------------------------
        code, _ = open_project(base, "alpha", {"Content-Type": "application/json"})
        ok("opening is refused when not from the board", code == 403, "got %d" % code)
        code, _ = open_project(base, "alpha")
        ok("opening a default project answers 200", code == 200, "got %d" % code)
        code, _ = open_project(base, os.path.join(mine, "client-a"))
        ok("opening an approved one answers 200", code == 200, "got %d" % code)
        ok("and opens the real paths",
           OPENED == [[OPENER, os.path.join(ds, "projects", "alpha")],
                      [OPENER, os.path.join(mine, "client-a")]], repr(OPENED))
        code, _ = open_project(base, "../..")
        ok("opening with a hop is refused", code == 400, "got %d" % code)

        # --- starting a project -------------------------------------------------
        code, _ = request(base, "POST", "/project/start",
                          json.dumps({"title": "New thing"}), {"Content-Type": "application/json"})
        ok("starting is refused when not from the board", code == 403, "got %d" % code)
        code, body = request(base, "POST", "/project/start",
                             json.dumps({"title": "Plan the Q4 roadmap!", "name": ""}), BOARD)
        got = json.loads(body)
        ok("starting a project answers 200", code == 200, "got %d %s" % (code, body))
        ok("with the title slugified", got.get("name") == "plan-the-q4-roadmap", body)
        ok("and the note to write", got.get("note") == "data/projects/plan-the-q4-roadmap", body)
        made = os.path.join(ds, "projects", "plan-the-q4-roadmap")
        about = server.project_about(made)
        ok("its CLAUDE.md reads back as the title", about["title"] == "Plan the Q4 roadmap!", repr(about))
        ok("with a lead paragraph", about["blurb"].startswith("Started from the board"), repr(about))
        ok("and an Opened date", bool(about["opened"]), repr(about))
        code, _ = request(base, "POST", "/project/start",
                          json.dumps({"title": "Plan the Q4 roadmap"}), BOARD)
        ok("starting the same one twice is refused", code == 409, "got %d" % code)
        code, body = request(base, "POST", "/project/start",
                             json.dumps({"name": "../../evil", "title": "x"}), BOARD)
        ok("a name with hops is slugified flat", json.loads(body).get("name") == "evil", body)
        ok("inside data/projects/", os.path.isdir(os.path.join(ds, "projects", "evil")))
        code, _ = request(base, "POST", "/project/start", json.dumps({"name": "!!!"}), BOARD)
        ok("a name with nothing usable is refused", code == 400, "got %d" % code)
        ok("todo.md was never written", os.stat(todo).st_mtime_ns == before)

        # --- the list's projects folder -----------------------------------------
        shared = os.path.join(tmp, "PROJECTS")
        for d in (os.path.join(shared, "beta"), os.path.join(shared, "alpha"),
                  os.path.join(ds, "projects", "gamma")):
            os.makedirs(d)
        with open(os.path.join(shared, "beta", "CLAUDE.md"), "w", encoding="utf-8") as fh:
            fh.write("# Beta\n\nThe shared one.\n")
        settings_file = os.path.join(tmp, "settings.json")

        def use_settings(data):
            with open(settings_file, "w", encoding="utf-8") as fh:
                json.dump(data, fh)

        code, _ = get_project(base, "beta")
        ok("unset, a folder in the projects folder is not found", code == 404, "got %d" % code)
        theirs = os.path.join(tmp, "THEIRS")
        os.makedirs(os.path.join(theirs, "delta"))
        use_settings({"projects_roots": {"ds": shared, "other": theirs}})
        code, body = get_project(base, "beta")
        ok("set, a bare name resolves in the projects folder", code == 200, "got %d %s" % (code, body))
        ok("still served at /data/projects/", json.loads(body).get("url") == "/data/projects/beta/", body[:200])
        code, body = request(base, "GET", "/data/projects/beta/CLAUDE.md")
        ok("and its files are served from there", code == 200 and "The shared one" in body, "got %d" % code)
        code, body = request(base, "GET", "/data/projects/beta/../../settings.json")
        ok("a hop in the served path does not climb out", "projects_roots" not in body, "got %d" % code)
        code, _ = get_project(base, "delta")
        ok("another list's projects folder is not looked in", code == 404, "got %d" % code)
        code, _ = get_project(base, "gamma")
        ok("a name only under data/projects/ falls back there", code == 200, "got %d" % code)
        code, _ = open_project(base, "alpha")
        ok("a name in both opens the projects folder's",
           OPENED[-1] == [OPENER, os.path.join(shared, "alpha")], repr(OPENED[-1:]))
        code, _ = get_project(base, os.path.join(shared, "beta"))
        ok("its absolute path needs no approval", code == 200, "got %d" % code)
        code, _ = get_project(base, shared)
        ok("the projects folder itself is not a project", code == 403, "got %d" % code)
        os.symlink(outside, os.path.join(shared, "leak"))
        code, _ = get_project(base, "leak")
        ok("a symlink out of the projects folder is refused", code == 403, "got %d" % code)
        code, body = request(base, "GET", "/projects.json")
        names = [p["name"] for p in json.loads(body)["projects"]]
        ok("the listing walks both, each name once",
           names.count("alpha") == 1 and "beta" in names and "gamma" in names
           and "leak" not in names and "delta" not in names, repr(names))
        code, body = request(base, "POST", "/project/start", json.dumps({"title": "Shared idea"}), BOARD)
        ok("a new project is made in the projects folder",
           code == 200 and os.path.isdir(os.path.join(shared, "shared-idea"))
           and not os.path.exists(os.path.join(ds, "projects", "shared-idea")), body)
        ok("with the same note as before", json.loads(body).get("note") == "data/projects/shared-idea", body)
        code, _ = request(base, "POST", "/project/start", json.dumps({"title": "Gamma"}), BOARD)
        ok("a name already under data/projects/ is refused, not shadowed", code == 409, "got %d" % code)
        ok("the chat may write in both", server.project_homes() == [shared, os.path.join(ds, "projects")],
           repr(server.project_homes()))

        use_settings({"projects_roots": {"other": shared}})
        code, _ = get_project(base, "beta")
        ok("a list with no projects folder never looks in another's", code == 404, "got %d" % code)
        code, _ = request(base, "GET", "/data/projects/beta/CLAUDE.md")
        ok("nor serves from there", code == 404, "got %d" % code)
        code, body = request(base, "POST", "/project/start", json.dumps({"title": "Frozen one"}), BOARD)
        ok("and makes its new projects under data/projects/",
           os.path.isdir(os.path.join(ds, "projects", "frozen-one"))
           and not os.path.exists(os.path.join(shared, "frozen-one")), body)
        os.remove(settings_file)
        ok("todo.md was still never written", os.stat(todo).st_mtime_ns == before)

        # --- the note, as the agents read it -----------------------------------
        ok("note_ref reads the default shape",
           project_folders.note_ref(["  - Project: `data/projects/atlas2027`. More."]) == "atlas2027")
        ok("note_ref reads a path in a code span",
           project_folders.note_ref(["  - Project: `/home/x/My Work/a`. Notes."]) == "/home/x/My Work/a")
        ok("note_ref reads a bare path",
           project_folders.note_ref(["  - Project: /home/x/work/a."]) == "/home/x/work/a")
        ok("note_ref finds nothing on a task with no note",
           project_folders.note_ref(["  - Waiting on: HR"]) == "")
    finally:
        httpd.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)

    print("\n%d passed" % len(PASS))
    for f in FAIL:
        print("  FAIL  " + f)
    if FAIL:
        print("\n%d failed\n" % len(FAIL))
        sys.exit(1)
    print("")


if __name__ == "__main__":
    main()
