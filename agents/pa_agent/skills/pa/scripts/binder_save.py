#!/usr/bin/env python3
"""How an agent changes Binder's leads and clients, over Binder's own API.

Usage:
    binder_save.py find <text>                 # organisations whose name or slug has the text
    binder_save.py show <slug>                 # the organisation, with its contacts, as JSON
    binder_save.py create-org                  # JSON on stdin, or --json '{...}'
    binder_save.py update-org <slug>           # JSON of the fields to set
    binder_save.py add-contact <slug>          # JSON of the contact
    binder_save.py update-contact <id>         # JSON of the fields to set
    binder_save.py add-note <slug>             # JSON with a `summary`, type defaults to note

The JSON of a create or add is the record's fields as Binder's API names them
(binder/schemas.py in the Binder repo). For an update it is the fields to set,
and may be the whole record: the script fetches the record as it is, drops
every field whose value is already that, and sends only what differs together
with the `updated_at` it fetched. Nothing different means nothing is sent. A
stale `updated_at` comes back from Binder as a 409: the record as it is now is
printed on stdout, the reason on stderr, the exit is 1, and nothing is retried.
Pull the facts again, show the owner, and redo the change on that record.
Exit 0 is done, exit 2 is a refusal worded for the owner.

Two things this script cannot be made to do. It never deletes anything, and it
never starts research or summarising (the AI routes, which cost money). Every
request is checked against a short list of routes before it leaves, and
anything off the list is refused in code, so a bug or a pasted instruction
cannot reach them.

Which server:
    --url, or $BINDER_SAVE_URL, default https://binder.offdesk.io.

The token is a macOS Keychain item, read on every run with
`security find-generic-password -w` and sent as a bearer token on every
request, with `X-Binder: 1` on every write. It is never written to a file,
printed, or passed on a command line. A host other than this Mac needs https
and a token, or nothing is sent, and redirects are never followed:
    --keychain-service and --keychain-account, or
    $BINDER_SAVE_KEYCHAIN_SERVICE and $BINDER_SAVE_KEYCHAIN_ACCOUNT.

Two agents use this one script, each with a token of its own. The name Binder
shows for a change comes from the sign-in service's entry for that token, not
from anything here:
    the PA            Keychain service `binder-pa`, shown as "Tiago's PA"
    the frontend lead Keychain service `binder-fe`, shown as "Tiago's FE"
"""

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_URL = "https://binder.offdesk.io"
LOCAL_HOSTS = ("127.0.0.1", "localhost", "::1")
TIMEOUT = 30

ORG_FIELDS = ("name", "status", "website", "sector", "size", "location", "owner_email",
              "source", "value_estimate", "tags", "summary", "next_step", "next_step_due")
CONTACT_FIELDS = ("name", "role", "email", "phone", "linkedin_url", "notes", "is_primary", "relationship")

# The only routes this script will call. Anything else is refused before it is sent.
ROUTES = (
    ("GET", re.compile(r"^/api/orgs$")),
    ("GET", re.compile(r"^/api/orgs/by-slug/[a-z0-9][a-z0-9-]*$")),
    ("GET", re.compile(r"^/api/orgs/\d+/contacts$")),
    ("GET", re.compile(r"^/api/contacts/\d+$")),
    ("POST", re.compile(r"^/api/orgs$")),
    ("POST", re.compile(r"^/api/orgs/\d+/contacts$")),
    ("POST", re.compile(r"^/api/orgs/\d+/interactions$")),
    ("PATCH", re.compile(r"^/api/orgs/\d+$")),
    ("PATCH", re.compile(r"^/api/contacts/\d+$")),
)


class Refused(Exception):
    """Something this script will not do, worded for the owner to pass on."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    # Signed out, nginx answers with a redirect to the sign-in page, and
    # following it would hand back a page of HTML with a 200.
    def redirect_request(self, *a, **kw):
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def keychain_token(service, account):
    try:
        got = subprocess.run(["security", "find-generic-password", "-s", service, "-a", account, "-w"],
                             capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired) as err:
        raise Refused("could not read the Keychain: %s" % err)
    token = got.stdout.strip()
    if got.returncode != 0 or not token:
        raise Refused("no Keychain item for service %s, account %s" % (service, account))
    return token


def check_route(method, path):
    """Refuses anything but the routes above, with the reason in plain words."""
    method = method.upper()
    if method == "DELETE":
        raise Refused("this script never deletes anything")
    if re.search(r"/(research|summarise)(/|$)", path):
        raise Refused("this script never starts research or summarising")
    if not any(m == method and rx.fullmatch(path) for m, rx in ROUTES):
        raise Refused("%s %s is not a route this script uses" % (method, path))


class Binder:
    def __init__(self, url, service, account):
        self.url = url.rstrip("/")
        parts = urllib.parse.urlsplit(self.url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise Refused("%s is not a server address" % url)
        local = parts.hostname in LOCAL_HOSTS
        self.token = None
        if service or account:
            if not (service and account):
                raise Refused("the Keychain item needs both a service and an account")
            if not local and parts.scheme != "https":
                raise Refused("a token only goes to %s over https" % parts.hostname)
            self.token = keychain_token(service, account)
        elif not local:
            raise Refused("%s is not this Mac, so it needs a token from the Keychain" % parts.hostname)

    def ask(self, method, path, body=None, query=None):
        """(status, parsed JSON or None) for one request."""
        check_route(method, path)
        headers = {"Accept": "application/json"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        data = None
        if method != "GET":
            headers["X-Binder"] = "1"
            data = json.dumps(body if body is not None else {}, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        url = self.url + path + ("?" + urllib.parse.urlencode(query) if query else "")
        req = urllib.request.Request(url, method=method, data=data, headers=headers)
        try:
            with _opener.open(req, timeout=TIMEOUT) as res:
                status, raw = res.status, res.read()
        except urllib.error.HTTPError as err:
            status, raw = err.code, err.read()
        except (urllib.error.URLError, OSError) as err:
            raise Refused("could not reach %s: %s" % (self.url, getattr(err, "reason", err)))
        try:
            return status, json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return status, None

    def ok(self, method, path, body=None, query=None):
        """The parsed answer of a request that has to succeed, else Refused."""
        status, got = self.ask(method, path, body, query)
        if 200 <= status < 300 and got is not None:
            return got
        raise Refused(refusal(status, got))


def refusal(status, got):
    if status in (301, 302, 303, 307, 308):
        return "%d, sent to sign in: the token was refused or has expired" % status
    if status == 401:
        return "401, not signed in: the token was refused or has expired"
    if isinstance(got, dict) and got.get("detail"):
        return "%d, %s" % (status, got["detail"])
    return "%d from the server" % status


def read_json(args):
    text = args.json if args.json is not None else sys.stdin.read()
    try:
        got = json.loads(text)
    except ValueError as err:
        raise Refused("the JSON would not parse: %s" % err)
    if not isinstance(got, dict):
        raise Refused("the JSON must be one object")
    return got


def show(value):
    print(json.dumps(value, indent=2, ensure_ascii=False))


def org_by_slug(b, slug):
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", slug):
        raise Refused("%s is not a slug" % slug)
    return b.ok("GET", "/api/orgs/by-slug/" + slug)


def changed(current, wanted, allowed, what):
    """The fields of `wanted` that differ from `current`, refusing any not editable."""
    bad = sorted(k for k in wanted if k not in allowed)
    if bad:
        raise Refused("%s cannot be changed here: %s" % (", ".join(bad), what))
    return dict((k, v) for k, v in wanted.items() if current.get(k) != v)


def patch(b, path, current, fields):
    """PATCH only `fields` with the updated_at of `current`. 0 saved, 1 stale."""
    if not fields:
        print("nothing differs, nothing saved")
        return 0
    status, got = b.ask("PATCH", path, dict(fields, updated_at=current["updated_at"]))
    if status == 409:
        print("not saved: somebody changed this record since it was read. Its current state is on stdout.",
              file=sys.stderr)
        if isinstance(got, dict) and got.get("current") is not None:
            show(got["current"])
        return 1
    if 200 <= status < 300 and got is not None:
        print("saved %s: %s" % (path, ", ".join(sorted(fields))))
        return 0
    raise Refused("not saved: " + refusal(status, got))


def cmd_find(b, args):
    needle = args.text.strip().lower()
    if not needle:
        raise Refused("find needs some text")
    rows = [o for o in b.ok("GET", "/api/orgs", query={"sort": "name"})
            if needle in o["name"].lower() or needle in o["slug"].lower()]
    for o in rows:
        print("\t".join([o["slug"], o["name"], o["kind"], o["status"], o.get("owner_email") or "-"]))
    if not rows:
        print("no organisation matches %s" % args.text)
    return 0


def cmd_show(b, args):
    org = org_by_slug(b, args.slug)
    show({"org": org, "contacts": b.ok("GET", "/api/orgs/%d/contacts" % org["id"])})
    return 0


def cmd_create_org(b, args):
    org = b.ok("POST", "/api/orgs", read_json(args))
    print("created %s" % org["slug"])
    show(org)
    return 0


def cmd_update_org(b, args):
    org = org_by_slug(b, args.slug)
    fields = changed(org, read_json(args), ORG_FIELDS, "an organisation's slug, kind and stamps are not editable")
    return patch(b, "/api/orgs/%d" % org["id"], org, fields)


def cmd_add_contact(b, args):
    org = org_by_slug(b, args.slug)
    contact = b.ok("POST", "/api/orgs/%d/contacts" % org["id"], read_json(args))
    print("added contact %s to %s" % (contact["id"], org["slug"]))
    show(contact)
    return 0


def cmd_update_contact(b, args):
    path = "/api/contacts/%d" % args.id
    contact = b.ok("GET", path)
    fields = changed(contact, read_json(args), CONTACT_FIELDS, "a contact's organisation and stamps are not editable")
    return patch(b, path, contact, fields)


def cmd_add_note(b, args):
    org = org_by_slug(b, args.slug)
    body = read_json(args)
    body.setdefault("type", "note")
    # Binder keeps notes as interactions: the timeline's call, email, meeting and note entries.
    note = b.ok("POST", "/api/orgs/%d/interactions" % org["id"], body)
    print("added %s %s to %s" % (note["type"], note["id"], org["slug"]))
    return 0


COMMANDS = (
    ("find", cmd_find, "text", None),
    ("show", cmd_show, "slug", None),
    ("create-org", cmd_create_org, None, True),
    ("update-org", cmd_update_org, "slug", True),
    ("add-contact", cmd_add_contact, "slug", True),
    ("update-contact", cmd_update_contact, "id", True),
    ("add-note", cmd_add_note, "slug", True),
)

# What an agent might try, answered with the reason rather than "invalid choice".
NEVER = {"delete": "this script never deletes anything",
         "research": "this script never starts research or summarising",
         "summarise": "this script never starts research or summarising"}


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name, fn, arg, writes in COMMANDS:
        p = sub.add_parser(name)
        if arg == "id":
            p.add_argument("id", type=int)
        elif arg:
            p.add_argument(arg)
        if writes:
            p.add_argument("--json", help="the fields as one JSON object; read from stdin when left out")
        p.add_argument("--url", default=os.environ.get("BINDER_SAVE_URL") or DEFAULT_URL)
        p.add_argument("--keychain-service", default=os.environ.get("BINDER_SAVE_KEYCHAIN_SERVICE") or "")
        p.add_argument("--keychain-account", default=os.environ.get("BINDER_SAVE_KEYCHAIN_ACCOUNT") or "")
        p.set_defaults(func=fn)
    if argv and argv[0] in NEVER:
        print("binder_save: %s" % NEVER[argv[0]], file=sys.stderr)
        return 2
    args = ap.parse_args(argv)
    try:
        return args.func(Binder(args.url, args.keychain_service, args.keychain_account), args)
    except Refused as err:
        print("binder_save: %s" % err, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
