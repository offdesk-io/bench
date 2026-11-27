#!/usr/bin/env python3
"""Bench under a path of a bigger site: BENCH_BASE.

    python3 kanban/test_base_path.py

No browser (kanban/test_base_path.mjs is the board's half). It starts
kanban/server.py itself on free ports over a throwaway data root and asks it
the way nginx does on os.offdesk.io, which serves Bench under /bench/ and
removes the prefix before the request gets here: the paths asked for are the
server's own, and only what the server hands the browser carries the base.

What it holds to:

  * set, the page's every script, stylesheet and icon is under the base, and
    the one address that is not Bench's, the sign-in's /auth/logout, is left
    as it is; /owner.js tells the board its base; the root sends a browser to
    the page under the base, signed in or not;
  * unset, the page is served exactly as the file on disk, /owner.js says the
    base is empty, and the root is what it was (a 302 signed in, a listing
    on the Mac);
  * a base that is not one lower-case path segment refuses to start.
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile

from test_board_access import ROOT, Server, seed

PASS = []
FAIL = []
SIGNED_IN = {"X-Offdesk-Email": "dev@offdesk.local", "X-Offdesk-Name": "Dev"}
ADDRESS = re.compile(r'\s(?:href|src|action)="(/[^"]*)"')


def ok(label, cond, detail=""):
    (PASS if cond else FAIL).append(label if cond else
                                    (label + (" — " + detail if detail else "")))


def page_on_disk():
    with open(os.path.join(ROOT, "kanban", "index.html"), encoding="utf-8") as fh:
        return fh.read()


def under_base_checks(root):
    data = os.path.join(root, "based")
    seed(data, "_test")
    with open(os.path.join(data, ".current"), "w") as fh:
        fh.write("_test")
    os.makedirs(os.path.join(data, "_test", "projects", "p"))
    srv = Server(data, None, env={"BENCH_BASE": "/bench", "TODOS_SHOW_HIDDEN": "1"})
    ok("a server with BENCH_BASE=/bench starts", srv.wait())
    try:
        code, page, headers = srv.ask("GET", "/kanban/index.html")
        ok("the page is served", code == 200, "got %d" % code)
        ok("as html", (headers.get("Content-Type") or "").startswith("text/html"), str(headers.get("Content-Type")))
        found = ADDRESS.findall(page)
        ok("the page names absolute addresses", len(found) >= 8, str(found))
        outside = [a for a in found if not a.startswith("/bench/") and not a.startswith("/auth/")]
        ok("every absolute address on the page is under /bench/", not outside, str(outside))
        ok("the sign-out form still posts to the sign-in's own /auth/logout",
           'action="/auth/logout"' in page)
        for want in ('src="/bench/owner.js"', 'src="/bench/core/todo.js"', 'src="/bench/ai-chat/ai-chat.js"',
                     'href="/bench/kanban/board.css"', 'href="/bench/kanban/dist/tenon.css"',
                     'href="/bench/kanban/brand/favicon.svg"'):
            ok("the page loads %s" % want, want in page)
        ok("the board's own scripts stay relative to the page", 'src="js/boot.js"' in page
           and 'src="dist/board-ui.js"' in page)
        ok("and nothing else on the page changes",
           page.replace("/bench/", "/") == page_on_disk().replace("/bench/", "/"))
        code, page_dir, _ = srv.ask("GET", "/kanban/")
        ok("/kanban/ is the same page", code == 200 and page_dir == page, "got %d" % code)

        code, owner, _ = srv.ask("GET", "/owner.js")
        ok("/owner.js tells the board its base", code == 200 and 'window.BENCH_BASE = "/bench";' in owner, owner)

        status, location = redirect(srv, "/")
        ok("the root sends the browser to the page under the base",
           status == 302 and location == "/bench/kanban/index.html", "%s %s" % (status, location))

        status, location = redirect(srv, "/data/projects/p")
        ok("a folder without its slash is sent to it under the base",
           status == 301 and location == "/bench/data/projects/p/", "%s %s" % (status, location))
        status, location = redirect(srv, "/kanban")
        ok("and so is the page's own folder", status == 301 and location == "/bench/kanban/", "%s %s" % (status, location))

        code, todo, _ = srv.ask("GET", "/data/todo.md")
        ok("the board's routes answer at their own paths, as nginx hands them on",
           code == 200 and "A task" in todo, "got %d" % code)
    finally:
        srv.stop()

    data = os.path.join(root, "based-signed-in")
    seed(data, "_test")
    srv = Server(data, "header", env={"BENCH_BASE": "/bench", "TODOS_SHOW_HIDDEN": "1"})
    ok("signed in, a server with BENCH_BASE=/bench starts", srv.wait())
    try:
        status, location = redirect(srv, "/", SIGNED_IN)
        ok("signed in, the root sends the browser to the page under the base",
           status == 302 and location == "/bench/kanban/index.html", "%s %s" % (status, location))
        code, page, _ = srv.ask("GET", "/kanban/index.html", SIGNED_IN)
        outside = [a for a in ADDRESS.findall(page) if not a.startswith(("/bench/", "/auth/"))]
        ok("signed in, the page's addresses are under the base", code == 200 and not outside, str(outside))
        code, _, _ = srv.ask("GET", "/kanban/", SIGNED_IN)
        ok("signed in, /kanban/ is still refused, as every folder is", code == 404, "got %d" % code)
        code, owner, _ = srv.ask("GET", "/owner.js", SIGNED_IN)
        ok("signed in, /owner.js tells the board its base", 'window.BENCH_BASE = "/bench";' in owner, owner)
        code, _, _ = srv.ask("GET", "/kanban/index.html")
        ok("and the page still needs a sign-in", code == 401, "got %d" % code)
    finally:
        srv.stop()


def unset_checks(root):
    data = os.path.join(root, "root")
    seed(data, "_test")
    with open(os.path.join(data, ".current"), "w") as fh:
        fh.write("_test")
    os.makedirs(os.path.join(data, "_test", "projects", "p"))
    srv = Server(data, None, env={"TODOS_SHOW_HIDDEN": "1"})
    ok("a server without BENCH_BASE starts", srv.wait())
    try:
        code, page, _ = srv.ask("GET", "/kanban/index.html")
        ok("unset, the page is the file on disk, byte for byte", code == 200 and page == page_on_disk())
        code, owner, _ = srv.ask("GET", "/owner.js")
        ok("unset, /owner.js says the base is empty", 'window.BENCH_BASE = "";' in owner, owner)
        status, _ = redirect(srv, "/")
        ok("unset, the root on the Mac is the folder listing it always was", status == 200, str(status))
        status, location = redirect(srv, "/data/projects/p")
        ok("unset, a folder without its slash is sent to it as before",
           status == 301 and location == "/data/projects/p/", "%s %s" % (status, location))
    finally:
        srv.stop()

    data = os.path.join(root, "root-signed-in")
    seed(data, "_test")
    srv = Server(data, "header")
    ok("signed in without BENCH_BASE starts", srv.wait())
    try:
        status, location = redirect(srv, "/", SIGNED_IN)
        ok("unset and signed in, the root is the 302 to /kanban/index.html it was",
           status == 302 and location == "/kanban/index.html", "%s %s" % (status, location))
    finally:
        srv.stop()


def refusal_checks(root):
    for bad in ("bench", "/bench/", "/Bench", "/a/b", "/../x", "/bench x"):
        srv = Server(os.path.join(root, "bad"), None, env={"BENCH_BASE": bad})
        try:
            out = srv.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            out = None
        text = srv.stop()
        ok("BENCH_BASE=%r refuses to start" % bad, out == 2 and "BENCH_BASE" in text, "%s %s" % (out, text[-200:]))


def redirect(srv, path, headers=None):
    """(status, Location) of one request, without following a redirect."""
    import http.client
    conn = http.client.HTTPConnection("127.0.0.1", srv.port, timeout=10)
    try:
        conn.request("GET", path, headers=headers or {})
        res = conn.getresponse()
        res.read()
        return res.status, res.getheader("Location")
    finally:
        conn.close()


def main():
    # Unset means unset: a BENCH_BASE in the shell would reach every server here.
    os.environ.pop("BENCH_BASE", None)
    root = tempfile.mkdtemp(prefix="base-path-test-")
    try:
        under_base_checks(root)
        unset_checks(root)
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
