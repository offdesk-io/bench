#!/usr/bin/env python3
"""binder_save.py against a fake Binder on a free local port. No network, no real token.

    python3 agents/pa_agent/skills/pa/scripts/test_binder_save.py

The fake keeps one organisation and one contact (made-up, @example.com),
answers the routes the script uses, and records every request it gets. A fake
`security` on PATH stands in for the Keychain, so a token goes out as a bearer
token without a real one existing. What it holds to:

  * an update sends only the fields that differ, with the updated_at it read;
  * nothing differing sends nothing;
  * a 409 prints the current record, exits 1, and is not retried;
  * every write carries X-Binder: 1 and the bearer token, a read carries the token;
  * delete, research and summarise are refused in code, before any request;
  * a remote host over http is refused before the Keychain or the network is touched.
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
SCRIPT = os.path.join(HERE, "binder_save.py")
sys.path.insert(0, HERE)
import binder_save  # noqa: E402

PASS = []
FAIL = []
TOKEN = "fake-token-for-tests"

ORG = {"id": 7, "slug": "acme-ltd", "name": "Acme Ltd", "kind": "lead", "status": "new",
       "website": "acme.example.com", "sector": None, "size": None, "location": None,
       "owner_email": "ana@example.com", "source": None, "value_estimate": None, "tags": ["a"],
       "summary": None, "next_step": None, "next_step_due": None, "last_contact": None,
       "created_at": "2026-11-01T10:00:00.000000+00:00", "updated_at": "2026-11-02T10:00:00.000000+00:00",
       "updated_by": "ana@example.com"}
CONTACT = {"id": 3, "org_id": 7, "name": "Sam Example", "role": "CTO", "email": "sam@example.com",
           "phone": None, "linkedin_url": None, "notes": None, "is_primary": True, "relationship": None,
           "updated_at": "2026-11-02T11:00:00.000000+00:00", "updated_by": "ana@example.com"}


def ok(label, cond, detail=""):
    (PASS if cond else FAIL).append(label if cond else (label + (" - " + detail if detail else "")))


class Fake:
    """A Binder that records requests. `stale` makes every PATCH a 409."""

    def __init__(self):
        self.seen = []
        self.stale = False
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def send(self, status, body):
                raw = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def handle_any(self):
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n)) if n else None
                path = self.path.split("?")[0]
                outer.seen.append((self.command, path, body, dict(self.headers)))
                if self.command == "GET":
                    if path == "/api/orgs":
                        return self.send(200, [ORG, dict(ORG, id=8, slug="globex", name="Globex")])
                    if path == "/api/orgs/by-slug/acme-ltd":
                        return self.send(200, ORG)
                    if path == "/api/orgs/7/contacts":
                        return self.send(200, [CONTACT])
                    if path == "/api/contacts/3":
                        return self.send(200, CONTACT)
                    return self.send(404, {"detail": "Not found"})
                if self.command == "PATCH":
                    if outer.stale:
                        return self.send(409, {"detail": "Changed since you loaded it", "current": ORG})
                    return self.send(200, dict(ORG, **body))
                if path == "/api/orgs/7/interactions":
                    return self.send(201, {"id": 1, "type": body["type"]})
                if path == "/api/orgs/7/contacts":
                    return self.send(201, dict(CONTACT, **body))
                return self.send(201, dict(ORG, **body, slug="new-org"))

            do_GET = do_POST = do_PATCH = do_DELETE = handle_any

        self.httpd = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:%d" % self.httpd.server_port
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def stop(self):
        self.httpd.shutdown()


def run(args, url, env, stdin=""):
    e = dict(os.environ, **env)
    for k in ("BINDER_SAVE_URL", "BINDER_SAVE_KEYCHAIN_SERVICE", "BINDER_SAVE_KEYCHAIN_ACCOUNT"):
        e.pop(k, None)
    got = subprocess.run([sys.executable, SCRIPT] + args + ["--url", url, "--keychain-service", "binder-test",
                         "--keychain-account", "offdesk"], input=stdin, capture_output=True, text=True,
                         env=e, timeout=60)
    return got.returncode, got.stdout.strip(), got.stderr.strip()


def main():
    root = tempfile.mkdtemp(prefix="binder-save-test-")
    fake = Fake()
    try:
        bindir = os.path.join(root, "bin")
        os.makedirs(bindir)
        sec = os.path.join(bindir, "security")
        with open(sec, "w") as fh:
            fh.write("#!/bin/sh\necho %s\n" % TOKEN)
        os.chmod(sec, os.stat(sec).st_mode | stat.S_IEXEC)
        env = {"PATH": bindir + os.pathsep + os.environ["PATH"]}
        auth = "Bearer " + TOKEN

        # --- reads ---------------------------------------------------------------
        code, out, err = run(["find", "glob"], fake.url, env)
        ok("find matches a name or slug", code == 0 and out.startswith("globex\tGlobex") and "acme" not in out, out + err)
        ok("a read carries the token and no X-Binder",
           fake.seen[-1][3].get("Authorization") == auth and "X-Binder" not in fake.seen[-1][3])
        code, out, _ = run(["show", "acme-ltd"], fake.url, env)
        shown = json.loads(out) if code == 0 else {}
        ok("show gives the org with its contacts", shown.get("org", {}).get("slug") == "acme-ltd"
           and shown.get("contacts", [{}])[0].get("id") == 3, out)

        # --- updates: changed fields only ------------------------------------------
        fake.seen.clear()
        full = dict(ORG, sector="Software", tags=["a"], next_step="Call Sam")
        for k in ("id", "slug", "kind", "last_contact", "created_at", "updated_at", "updated_by"):
            full.pop(k)
        code, out, err = run(["update-org", "acme-ltd", "--json", json.dumps(full)], fake.url, env)
        patches = [s for s in fake.seen if s[0] == "PATCH"]
        ok("update-org sends only what differs, plus updated_at",
           code == 0 and len(patches) == 1 and patches[0][2] == {
               "sector": "Software", "next_step": "Call Sam", "updated_at": ORG["updated_at"]},
           "%d %s %s" % (code, out, err))
        ok("a write carries X-Binder and the token", patches and patches[0][3].get("X-Binder") == "1"
           and patches[0][3].get("Authorization") == auth)
        fake.seen.clear()
        code, out, _ = run(["update-org", "acme-ltd", "--json", json.dumps({"name": "Acme Ltd", "tags": ["a"]})],
                           fake.url, env)
        ok("nothing differing sends nothing", code == 0 and not [s for s in fake.seen if s[0] == "PATCH"], out)
        code, _, err = run(["update-org", "acme-ltd", "--json", '{"slug": "other"}'], fake.url, env)
        ok("a field that cannot be edited is refused", code == 2 and "slug" in err, err)
        fake.seen.clear()
        code, out, err = run(["update-contact", "3", "--json", json.dumps({"role": "CEO", "email": "sam@example.com"})],
                             fake.url, env)
        patches = [s for s in fake.seen if s[0] == "PATCH"]
        ok("update-contact sends only the changed field with updated_at",
           code == 0 and patches and patches[0][1] == "/api/contacts/3"
           and patches[0][2] == {"role": "CEO", "updated_at": CONTACT["updated_at"]}, "%d %s %s" % (code, out, err))

        # --- 409 --------------------------------------------------------------------
        fake.stale = True
        fake.seen.clear()
        code, out, err = run(["update-org", "acme-ltd", "--json", '{"sector": "Retail"}'], fake.url, env)
        ok("a 409 exits 1 and prints the current record", code == 1 and json.loads(out).get("slug") == "acme-ltd"
           and "changed" in err, "%d %s %s" % (code, out, err))
        ok("a 409 is not retried", len([s for s in fake.seen if s[0] == "PATCH"]) == 1)
        fake.stale = False

        # --- creates ----------------------------------------------------------------
        fake.seen.clear()
        code, out, _ = run(["create-org"], fake.url, env, stdin='{"name": "New Co"}')
        ok("create-org reads stdin and posts", code == 0 and fake.seen[-1][:2] == ("POST", "/api/orgs")
           and fake.seen[-1][3].get("X-Binder") == "1", out)
        code, out, _ = run(["add-contact", "acme-ltd", "--json", '{"name": "Kim Example"}'], fake.url, env)
        ok("add-contact posts to the org's contacts", code == 0 and fake.seen[-1][1] == "/api/orgs/7/contacts", out)
        code, out, _ = run(["add-note", "acme-ltd", "--json", '{"summary": "Spoke on the phone"}'], fake.url, env)
        ok("add-note posts an interaction of type note",
           code == 0 and fake.seen[-1][1] == "/api/orgs/7/interactions" and fake.seen[-1][2].get("type") == "note", out)

        # --- never delete, research or summarise -----------------------------------
        fake.seen.clear()
        for word in ("delete", "research", "summarise"):
            code, _, err = run([word, "acme-ltd"], fake.url, env)
            ok("the %s command is refused" % word, code == 2 and "never" in err, err)
        ok("and nothing was sent for them", not fake.seen)
        probes = (("DELETE", "/api/orgs/7"), ("DELETE", "/api/contacts/3"), ("DELETE", "/api/interactions/1"),
                  ("POST", "/api/orgs/7/research"), ("POST", "/api/contacts/3/research"),
                  ("GET", "/api/research/1"), ("POST", "/api/summarise"), ("POST", "/api/whatever"))
        refused = 0
        for method, path in probes:
            try:
                binder_save.check_route(method, path)
            except binder_save.Refused:
                refused += 1
        ok("the route guard refuses every delete, research and summarise route", refused == len(probes))
        os.environ["PATH"] = env["PATH"]
        client = binder_save.Binder(fake.url, "binder-test", "offdesk")
        try:
            client.ask("DELETE", "/api/orgs/7")
            gone = False
        except binder_save.Refused:
            gone = True
        ok("a DELETE through the client never reaches the server", gone and not fake.seen)

        # --- a remote that is not https ---------------------------------------------
        code, _, err = run(["find", "x"], "http://binder.example.com", env)
        ok("a remote host over http is refused", code == 2 and "https" in err, err)
        got = subprocess.run([sys.executable, SCRIPT, "find", "x", "--url", "https://binder.example.com"],
                             capture_output=True, text=True, env=dict(os.environ, **env), timeout=60)
        ok("a remote host with no Keychain item is refused", got.returncode == 2 and "token" in got.stderr, got.stderr)
    finally:
        fake.stop()
        shutil.rmtree(root, ignore_errors=True)
    for label in PASS:
        print("ok    " + label)
    for label in FAIL:
        print("FAIL  " + label)
    print("\n%d passed, %d failed" % (len(PASS), len(FAIL)))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
