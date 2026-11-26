#!/usr/bin/env python3
"""What the server serves under /data/ can never run as a page of Bench's site.

    python3 kanban/test_data_headers.py

No browser. It starts kanban/server.py itself on free ports over a throwaway
data root, with a project folder holding one file of each kind a drawer upload
could put there. Under /data/ every answer carries Content-Security-Policy:
sandbox and X-Content-Type-Options: nosniff, and everything but plain text,
Markdown and an image other than SVG is a download (Content-Disposition:
attachment). On os.offdesk.io, where Bench shares the core's origin, a page
uploaded to a project could otherwise script the core. The list itself, a
report and a backup still read as they did.
"""

import os
import shutil
import sys
import tempfile

from test_board_access import Server, seed

PASS = []
FAIL = []

FILES = {
    "page.html": (b"<script>alert(1)</script>", True),
    "page.htm": (b"<script>alert(1)</script>", True),
    "drawing.svg": (b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', True),
    "data.json": (b'{"a": 1}', True),
    "script.js": (b"alert(1)", True),
    "no-extension": (b"<script>alert(1)</script>", True),
    "notes.md": (b"# Notes\n", False),
    "notes.txt": (b"Notes\n", False),
    "picture.png": (b"\x89PNG\r\n\x1a\n", False),
    "photo.jpg": (b"\xff\xd8\xff", False),
}


def ok(label, cond, detail=""):
    (PASS if cond else FAIL).append(label if cond else
                                    (label + (" — " + detail if detail else "")))


def ask(srv, method, path):
    """(status, body as text, headers), the body decoded leniently: some files here are images."""
    import http.client
    conn = http.client.HTTPConnection("127.0.0.1", srv.port, timeout=10)
    try:
        conn.request(method, path)
        res = conn.getresponse()
        return res.status, res.read().decode("utf-8", "replace"), res.headers
    finally:
        conn.close()


def headers_checks(root):
    data = os.path.join(root, "data")
    seed(data, "_test")
    with open(os.path.join(data, ".current"), "w") as fh:
        fh.write("_test")
    for sub in ("projects/p", "reports", "backups"):
        os.makedirs(os.path.join(data, "_test", sub), exist_ok=True)
    for name, (body, _) in FILES.items():
        with open(os.path.join(data, "_test", "projects", "p", name), "wb") as fh:
            fh.write(body)
    with open(os.path.join(data, "_test", "reports", "r.md"), "w") as fh:
        fh.write("---\ntitle: R\n---\n\nA report.\n")
    with open(os.path.join(data, "_test", "backups", "todo-backup-x.md"), "w") as fh:
        fh.write("# To-do\n")
    srv = Server(data, None, env={"TODOS_SHOW_HIDDEN": "1"})
    ok("the server starts", srv.wait())
    try:
        for name, (body, download) in FILES.items():
            code, text, h = ask(srv, "GET", "/data/projects/p/" + name)
            ok("%s is served" % name, code == 200, "got %d" % code)
            ok("%s is sandboxed" % name, h.get("Content-Security-Policy") == "sandbox", str(h.get("Content-Security-Policy")))
            ok("%s is not sniffed" % name, h.get("X-Content-Type-Options") == "nosniff")
            disp = h.get("Content-Disposition") or ""
            if download:
                ok("%s is a download" % name, disp.startswith("attachment"), disp)
            else:
                ok("%s opens in the tab" % name, disp == "", disp)
        code, _, h = ask(srv, "HEAD", "/data/projects/p/page.html")
        ok("a HEAD carries the same headers", code == 200 and h.get("Content-Security-Policy") == "sandbox"
           and (h.get("Content-Disposition") or "").startswith("attachment"))

        code, text, h = ask(srv, "GET", "/data/todo.md")
        ok("the list reads as it did", code == 200 and "A task" in text and h.get("X-Todo-Hash"), "got %d" % code)
        ok("the list is sandboxed and not a download", h.get("Content-Security-Policy") == "sandbox"
           and not h.get("Content-Disposition"))
        for path in ("/data/reports/r.md", "/data/backups/todo-backup-x.md"):
            code, text, h = ask(srv, "GET", path)
            ok("%s reads as it did" % path, code == 200 and text and not h.get("Content-Disposition"), "got %d" % code)

        code, _, h = ask(srv, "GET", "/kanban/index.html")
        ok("the page itself is not sandboxed", code == 200 and not h.get("Content-Security-Policy")
           and not h.get("Content-Disposition"))
        code, _, h = ask(srv, "GET", "/owner.js")
        ok("nor is what it loads", code == 200 and not h.get("Content-Security-Policy"))
    finally:
        srv.stop()


def main():
    os.environ.pop("BENCH_BASE", None)
    root = tempfile.mkdtemp(prefix="data-headers-test-")
    try:
        headers_checks(root)
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
