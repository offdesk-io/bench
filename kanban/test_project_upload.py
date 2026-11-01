#!/usr/bin/env python3
"""The file upload route behind the drawer's Add file button.

    python3 kanban/test_project_upload.py

No browser and no running board. Like test_project_folders.py it starts a
`Handler` of its own on an ephemeral port with `dataset_dir()` and
`current_dataset()` pointed at a temporary folder, so nothing under `data/` is
touched.

What it holds to:

  * a file posted to /project/upload lands in the project folder, byte for byte,
    and in a sub-folder when `sub` names one;
  * a second file with the same name is saved as "name (2).ext", then "(3)", and
    the first is never overwritten;
  * a name with a hop, a separator, a null or other control character or a leading dot is refused, and so
    is a sub-folder that climbs out;
  * a request without X-Board is refused;
  * a body declared over 25 MB is a 413 and nothing is written;
  * signed in (AUTH), a person who is not on the board's access.json gets 403
    and the owner and the people on it get through;
  * no temporary file is left behind, and todo.md is never written.
"""

import http.server
import json
import os
import shutil
import socket
import sys
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "kanban"))

import server  # noqa: E402
import board_access  # noqa: E402

PASS = []
FAIL = []
BOARD = {"X-Board": "1"}


def ok(label, cond, detail=""):
    (PASS if cond else FAIL).append(label if cond else
                                    (label + (" — " + detail if detail else "")))


def upload(base, name, file, data=b"hello", sub="", headers=BOARD):
    url = "/project/upload?name=%s&file=%s" % (urllib.parse.quote(name, safe=""),
                                               urllib.parse.quote(file, safe=""))
    if sub:
        url += "&sub=" + urllib.parse.quote(sub, safe="")
    req = urllib.request.Request(base + url, method="POST", data=data, headers=headers)
    try:
        with urllib.request.urlopen(req) as res:
            return res.status, json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read().decode("utf-8") or "{}")


def raw_status(port, head):
    """Sends only headers, so a declared size can be refused without sending it."""
    with socket.create_connection(("127.0.0.1", port), timeout=5) as sock:
        sock.sendall(head.encode("ascii"))
        return int(sock.recv(4096).split(b" ", 2)[1])


def read(path):
    with open(path, "rb") as fh:
        return fh.read()


def main():
    tmp = os.path.realpath(tempfile.mkdtemp(prefix="upload-test-"))
    root = os.path.join(tmp, "data")
    ds = os.path.join(root, "up-test")
    alpha = os.path.join(ds, "projects", "alpha")
    os.makedirs(os.path.join(alpha, "sources"))
    outside = os.path.join(tmp, "outside")
    os.makedirs(outside)
    todo = os.path.join(ds, "todo.md")
    with open(todo, "w", encoding="utf-8") as fh:
        fh.write("# To-do\n")
    before = os.stat(todo).st_mtime_ns
    with open(os.path.join(ds, "access.json"), "w", encoding="utf-8") as fh:
        json.dump({"owner": "owner@example.com", "people": ["pal@example.com"], "teams": []}, fh)

    server.DATA_ROOT = root
    server.dataset_dir = lambda name=None: ds
    server.current_dataset = lambda: "up-test"

    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    port = httpd.server_address[1]
    base = "http://127.0.0.1:%d" % port
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    try:
        # --- saving ----------------------------------------------------------
        code, got = upload(base, "alpha", "brief.pdf", b"first")
        ok("a file is saved and its name returned", code == 200 and got == {"ok": True, "name": "brief.pdf"},
           "%s %s" % (code, got))
        ok("with its bytes", read(os.path.join(alpha, "brief.pdf")) == b"first")
        code, got = upload(base, "alpha", "brief.pdf", b"second")
        ok("a clash is saved as (2)", code == 200 and got.get("name") == "brief (2).pdf", "%s %s" % (code, got))
        code, got = upload(base, "alpha", "brief.pdf", b"third")
        ok("and the next as (3)", got.get("name") == "brief (3).pdf", str(got))
        ok("the first is never overwritten", read(os.path.join(alpha, "brief.pdf")) == b"first")
        ok("each copy holds its own bytes", read(os.path.join(alpha, "brief (2).pdf")) == b"second"
           and read(os.path.join(alpha, "brief (3).pdf")) == b"third")
        code, got = upload(base, "alpha", "notes", b"")
        ok("an empty file is saved", code == 200 and os.path.getsize(os.path.join(alpha, "notes")) == 0)
        code, got = upload(base, "alpha", "deep.txt", b"in", sub="sources")
        ok("a sub-folder takes the file", code == 200 and read(os.path.join(alpha, "sources", "deep.txt")) == b"in",
           "%s %s" % (code, got))
        code, _ = upload(base, "alpha", "x.txt", sub="../..")
        ok("a sub-folder that climbs out is refused", code == 400, "got %d" % code)
        code, _ = upload(base, "alpha", "x.txt", sub="missing")
        ok("a sub-folder that is not there is a 404", code == 404, "got %d" % code)
        code, got = upload(base, "nope", "x.txt")
        ok("a project that is not there is a 404 the drawer can tell apart", code == 404 and got.get("code") == "missing",
           "%s %s" % (code, got))
        code, got = upload(base, os.path.join(tmp, "gone-folder"), "x.txt")
        ok("an absolute path that is not there is also 404 missing", code == 404 and got.get("code") == "missing", "%s %s" % (code, got))
        code, got = upload(base, outside, "x.txt")
        ok("an absolute folder that is there but not approved is a 403 unapproved", code == 403 and got.get("code") == "unapproved",
           "%s %s" % (code, got))
        ok("and nothing was written into it", os.listdir(outside) == [])
        code, _ = upload(base, "../ds", "x.txt")
        ok("a project name with a hop is refused", code == 400, "got %d" % code)

        # --- names ---------------------------------------------------------------
        for bad in ("../evil.txt", "..", "a/b.txt", "a\\b.txt", ".hidden", "", "x\0y", "a..b",
                    "tab\there", "line\nbreak", "bell\x07", "del\x7f"):
            code, _ = upload(base, "alpha", bad)
            ok("the name %r is refused" % bad, code == 400, "got %d" % code)
        ok("nothing was written outside the folder", not os.path.exists(os.path.join(ds, "evil.txt"))
           and not os.path.exists(os.path.join(alpha, ".hidden")))

        # --- from the board only --------------------------------------------------
        code, _ = upload(base, "alpha", "nohdr.txt", headers={})
        ok("a request without X-Board is refused", code == 403, "got %d" % code)
        ok("and writes nothing", not os.path.exists(os.path.join(alpha, "nohdr.txt")))

        # --- the cap ---------------------------------------------------------------
        cap = server.MAX_UPLOAD_BYTES
        ok("the cap is 25 MB", cap == 25 * 1024 * 1024)
        head = ("POST /project/upload?name=alpha&file=big.bin HTTP/1.1\r\nHost: x\r\nX-Board: 1\r\n"
                "Content-Length: %d\r\n\r\n")
        ok("a body over the cap is a 413", raw_status(port, head % (cap + 1)) == 413)
        ok("and writes nothing", not os.path.exists(os.path.join(alpha, "big.bin")))

        # --- signed in -------------------------------------------------------------
        server.AUTH = "header"
        try:
            def as_(email):
                return dict(BOARD, **{"X-Offdesk-Email": email})
            code, got = upload(base, outside, "x.txt", headers=as_("owner@example.com"))
            ok("signed in, an unapproved path is refused with no hint whether it exists", code == 403 and "code" not in got,
               "%s %s" % (code, got))
            code, got = upload(base, "alpha", "stranger.txt", headers=as_("other@example.com"))
            ok("signed in, someone not on the board gets 403", code == 403, "%s %s" % (code, got))
            ok("and nothing is written", not os.path.exists(os.path.join(alpha, "stranger.txt")))
            code, got = upload(base, "alpha", "owner.txt", headers=as_("owner@example.com"))
            ok("the owner can add a file", code == 200, "%s %s" % (code, got))
            code, got = upload(base, "alpha", "pal.txt", headers=as_("pal@example.com"))
            ok("so can a person on the board", code == 200, "%s %s" % (code, got))
        finally:
            server.AUTH = None

        # --- leftovers ---------------------------------------------------------------
        ok("no temporary file is left behind",
           not [n for d in (alpha, os.path.join(alpha, "sources")) for n in os.listdir(d) if n.startswith(".upload-")])
        ok("todo.md was never written", os.stat(todo).st_mtime_ns == before)
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
