#!/usr/bin/env python3
"""Who is signed in, and which boards they may see, when Bench is shared.

Off by default. `$BENCH_AUTH` unset or empty is the Mac board as it has always
been: nobody signs in, every board is visible, and `data/.current` says which
one is on screen. `BENCH_AUTH=header` is the server behind nginx. nginx asks
the sign-in service who the visitor is and passes the answer on in three
headers, and kanban/server.py refuses any request that arrives without one.
Any other value refuses to start, so a typo cannot leave a public board open.

    X-Offdesk-Email   the person's address, the identity everything keys on
    X-Offdesk-Name    their name, percent-encoded UTF-8
    X-Offdesk-Teams   the team ids they belong to, comma separated

Team membership comes from that header and from nowhere else. The list of
who is in which team is the sign-in service's (teams.json in
offdesk-server), so Bench keeps no copy that could disagree with it.

Each board says who may see it in `data/<board>/access.json`:

    {"owner": "a@example.com", "people": ["b@example.com"], "teams": ["offdesk"]}

Written by the server when a board is made or its sharing changes, and by
scripts/set-board-access.py for a board that existed before sign-in did.
With sign-in on, a board without the file, or with one that does not parse, is
visible to nobody: a board is opened up on purpose, never by accident. With it
off the file is not read at all.

Which board each person has on screen is theirs alone, in `data/users/`, one
file per person named from a hash of their address, so one person switching
boards does not switch anybody else's. Their PA profile sits beside it as
`<hash>.profile.md` (profile_path(), read through core/owner_profile.py). The same file remembers the name they
first signed in with and the teams they last signed in with, which is how a
board's people are known: its owner and named people from access.json, and
everyone who has signed in as a member of one of its teams (board_people()).
Somebody in a board's team who has never signed in is not offered, because
Bench has never been told they exist.

The PA reaches a shared board as an identity of its own, through
agents/pa_agent/skills/pa/scripts/pa_save.py. The sign-in service checks its
token, which is good for one board, and nginx passes a fourth header:

    X-Offdesk-Board   the one board this request is held to

kanban/server.py then serves that board whatever the identity's current board
is, and refuses anything but reading and saving its list (pinned_board()).
The header narrows and never widens: the identity still has to be able to see
the board. Its teams header is empty, so that means being named in the board's
`people`. A board from before sign-in has no access.json and is visible to
nobody, the PA identity included, so scripts/set-board-access.py gives it one
before the identity is added:

    scripts/set-board-access.py offdesk --owner tiagopedras+claude@gmail.com --team offdesk
    scripts/set-board-access.py offdesk --person pa-tiago@offdesk.invalid
"""

import hashlib
import json
import os
import re
import tempfile
import unicodedata

FILE = "access.json"
USERS = "users"
# Folders under data/ that are not boards and must never become one: a board
# called `users` would hold everyone's choice of board, and `agents` holds the
# agents engine's budgets.
RESERVED = (USERS, "agents")

EMAIL_RE = re.compile(r"^[^@\s,]+@[^@\s,]+\.[^@\s,]+$")
TEAM_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def mode():
    """"header" when Bench is signed in to through nginx, None when it is not.

    Raises ValueError for anything else, which the server turns into a refusal
    to start."""
    raw = (os.environ.get("BENCH_AUTH") or "").strip()
    if not raw:
        return None
    if raw == "header":
        return "header"
    raise ValueError("BENCH_AUTH=%s is not a mode Bench knows; use header, or unset it" % raw)


def email(raw):
    """An address as compared everywhere here, or None when it is not one."""
    s = str(raw or "").strip().lower()
    if len(s) > 254 or not EMAIL_RE.match(s):
        return None
    return s


def clean_name(raw):
    """A person's name as it may be stored or shown: control characters
    (category Cc, tabs and newlines among them) read as spaces, format
    characters (Cf, which holds every bidirectional override and isolate,
    U+202A to U+202E and U+2066 to U+2069, and the marks U+200E and U+200F)
    dropped, so a name cannot reorder or hide the text around it. Then
    whitespace collapsed and the whole cut to 200 characters."""
    out = []
    for c in str(raw or ""):
        cat = unicodedata.category(c)
        if cat == "Cc":
            out.append(" ")
        elif cat != "Cf":
            out.append(c)
    return " ".join("".join(out).split())[:200]


def teams(raw):
    """Team ids out of a comma list, or out of a list, cleaned and deduplicated."""
    parts = raw.split(",") if isinstance(raw, str) else (raw or [])
    out = []
    for p in parts:
        t = str(p).strip().lower()
        if TEAM_RE.match(t) and t not in out:
            out.append(t)
    return out


def path(board_dir):
    return os.path.join(board_dir, FILE)


def read(board_dir):
    """The board's access as {owner, people, teams}, or None when it has none.

    A file that does not parse, or names no owner, counts as none."""
    try:
        with open(path(board_dir), encoding="utf-8") as fh:
            raw = json.load(fh)
    except (OSError, ValueError):
        return None
    if not isinstance(raw, dict) or not email(raw.get("owner")):
        return None
    people = raw.get("people") if isinstance(raw.get("people"), list) else []
    return {
        "owner": email(raw.get("owner")),
        "people": [e for e in (email(p) for p in people) if e],
        "teams": teams(raw.get("teams") if isinstance(raw.get("teams"), list) else []),
    }


def clean(owner, people=(), team_ids=()):
    """An access record from what a form or a command sent, or (None, error)."""
    o = email(owner)
    if not o:
        return None, "the owner needs to be an email address"
    if not isinstance(people, (list, tuple)) or not isinstance(team_ids, (list, tuple)):
        return None, "people and teams need to be lists"
    out = []
    for p in people:
        e = email(p)
        if not e:
            return None, "%s is not an email address" % str(p)[:80]
        if e != o and e not in out:
            out.append(e)
    ts = []
    for t in team_ids:
        got = teams([t])
        if not got:
            return None, "%s is not a team id" % str(t)[:80]
        if got[0] not in ts:
            ts.append(got[0])
    return {"owner": o, "people": out, "teams": ts}, None


def write(board_dir, record):
    """Write access.json whole, through a temp file so a crash leaves the old one."""
    os.makedirs(board_dir, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=board_dir, prefix=".access-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump({"owner": record["owner"], "people": list(record["people"]),
                       "teams": list(record["teams"])}, fh, indent=2)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path(board_dir))
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def can_see(access, who):
    """Whether `who` ({email, teams}) may see a board with this access record."""
    if not access or not who or not who.get("email"):
        return False
    if who["email"] == access["owner"] or who["email"] in access["people"]:
        return True
    return bool(set(who.get("teams") or ()) & set(access["teams"]))


def user_path(data_root, address):
    """data/users/<hash>.json: the first 16 hex characters of the lowercased
    address's sha256, so no two addresses can be squeezed onto one file name.
    The address itself is kept inside the file."""
    digest = hashlib.sha256(address.lower().encode("utf-8")).hexdigest()[:16]
    return os.path.join(data_root, USERS, digest + ".json")


def profile_path(data_root, address):
    """data/users/<hash>.profile.md, this person's own PA profile, beside
    their record and named from the same hash. In owner_profile's
    `- Key: value` format, read and written through core/owner_profile.py."""
    return user_path(data_root, address)[:-len(".json")] + ".profile.md"


def read_user(data_root, address):
    """Everything kept for this person, or {} for nobody yet."""
    try:
        with open(user_path(data_root, address), encoding="utf-8") as fh:
            got = json.load(fh)
    except (OSError, ValueError):
        return {}
    if not isinstance(got, dict) or got.get("email") != address.lower():
        return {}
    return got


def _write_user(data_root, address, record):
    target = user_path(data_root, address)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(target), prefix=".user-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(dict(record, email=address.lower()), fh, ensure_ascii=False)
            fh.write("\n")
        os.replace(tmp, target)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def remember_person(data_root, address, name, team_ids):
    """Keeps the name this person first signed in with, and the teams they
    signed in with this time. Writes only when something changed."""
    got = read_user(data_root, address)
    want = dict(got)
    name = clean_name(name)
    if name and not got.get("name"):
        want["name"] = name
    want["teams"] = teams(team_ids)
    if want != got:
        _write_user(data_root, address, want)


def board_people(data_root, access):
    """Everyone a board can be assigned to: its owner, its named people, and
    everyone who has signed in as a member of one of its teams. Each is
    {email, name}, name "" when they have never signed in. Owner first, then
    named people as access.json lists them, then team members by email."""
    if not access:
        return []
    out, seen = [], set()

    def add(address, rec=None):
        if address and address not in seen:
            seen.add(address)
            rec = rec if rec is not None else read_user(data_root, address)
            out.append({"email": address, "name": clean_name(rec.get("name"))})

    add(access["owner"])
    for p in access["people"]:
        add(p)
    if access["teams"]:
        folder = os.path.join(data_root, USERS)
        try:
            names = sorted(os.listdir(folder))
        except OSError:
            names = []
        members = []
        for f in names:
            if not f.endswith(".json"):
                continue
            try:
                with open(os.path.join(folder, f), encoding="utf-8") as fh:
                    rec = json.load(fh)
            except (OSError, ValueError):
                continue
            address = email(rec.get("email")) if isinstance(rec, dict) else None
            if address and set(teams(rec.get("teams") or [])) & set(access["teams"]):
                members.append((address, rec))
        for address, rec in sorted(members, key=lambda m: m[0]):
            add(address, rec)
    return out


def _fold(raw):
    """A name as compared when matching: accents dropped, case folded,
    whitespace collapsed, so "Jerome" finds "Jérôme"."""
    s = unicodedata.normalize("NFKD", str(raw or ""))
    s = "".join(c for c in s if not unicodedata.combining(c))
    return " ".join(s.casefold().split())


def people_named(people, name):
    """The emails of the people in `people` (board_people()) that `name` can
    mean, in board order: their whole name, its first word, the part of their
    address before the @, or that part before a +. One email is a match; none
    or several is for the caller to refuse, since guessing would hand a task
    to the wrong person."""
    want = _fold(name)
    if not want:
        return []
    out = []
    for p in people:
        address = p.get("email") or ""
        full = _fold(p.get("name"))
        local = _fold(address.split("@")[0])
        keys = {full, full.split(" ")[0] if full else "", local, local.split("+")[0]}
        if want in keys - {""} and address not in out:
            out.append(address)
    return out


def read_current(data_root, address):
    """The board this person last had on screen, or "" for none recorded."""
    return str(read_user(data_root, address).get("current") or "")


def write_current(data_root, address, name):
    _write_user(data_root, address, dict(read_user(data_root, address), current=name))
