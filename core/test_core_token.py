"""Checks for core/core_token.py: the Offdesk core's tokens, checked with Bench's own code.

    python3 core/test_core_token.py

The two vectors were made by the core's Tokens with KEY, for 1000 seconds
after 1970 and a life of 300. The same two are in Binder's and the core's
tests, so the three verifiers cannot drift apart.
"""

import base64
import hashlib
import hmac
import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import board_access  # noqa: E402
import core_token  # noqa: E402

FAILED = []

KEY_HEX = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
KEY = bytes.fromhex(KEY_HEX)
PERSON = ("eyJzdWIiOiJhbmFAZXhhbXBsZS5jb20iLCJhZ2VudCI6InBhIiwiZXhwIjoxMzAwfQ"
          ".-gGkCXnslvXniIar1FnH85x4hhOFFTzJUFf9iETjr0A")
AGENT = ("eyJzdWIiOiJhZ2VudDpkaWdlc3QiLCJhZ2VudCI6ImRpZ2VzdCIsImV4cCI6MTMwMH0"
         ".Ay0_EI211cPjiL81Dz4LJlJo1csOrgMeMjWfwG9ZlVw")
# A PA turn on the web also names the teams of its sign-in, an optional claim; the vector above stays good.
PERSON_TEAMS = ("eyJzdWIiOiJhbmFAZXhhbXBsZS5jb20iLCJhZ2VudCI6InBhIiwiZXhwIjoxMzAwLCJ0ZWFtcyI6WyJvZmZkZXNrIl19"
                ".qoOGLP7X9KLqeFNhrCsvfJLTLbOqguQEKS5CFIonzf0")


def ok(label, cond, detail=""):
    print("  %s %s%s" % ("ok  " if cond else "FAIL", label, "" if cond else "  (%s)" % detail))
    if not cond:
        FAILED.append(label)


def b64(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def make(claims, key=KEY):
    """The core's algorithm, written out here."""
    body = b64(json.dumps(claims, separators=(",", ":")).encode())
    return body + "." + b64(hmac.new(key, body.encode(), hashlib.sha256).digest())


def refused(token, now=1000, key=KEY, why=""):
    try:
        core_token.verify(key, token, now=now)
    except core_token.TokenError as e:
        return not why or why in str(e)
    return False


def check_verify():
    ok("the core's person vector verifies",
       core_token.verify(KEY, PERSON, now=1001) == {"sub": "ana@example.com", "agent": "pa", "exp": 1300})
    ok("the core's agent vector verifies, up to and including its last second",
       core_token.verify(KEY, AGENT, now=1300)["sub"] == "agent:digest")
    ok("the core's vector naming teams verifies",
       core_token.verify(KEY, PERSON_TEAMS, now=1001).get("teams") == ["offdesk"])
    ok("the algorithm written here makes the core's vector",
       make({"sub": "ana@example.com", "agent": "pa", "exp": 1300}) == PERSON)
    ok("expired is refused", refused(PERSON, now=1301, why="expired"))
    ok("another key is refused", refused(PERSON, key=b"x" * 32, why="signature"))
    body, sig = PERSON.split(".")
    forged = b64(json.dumps({"sub": "rui@example.com", "agent": "pa", "exp": 1300}).encode()) + "." + sig
    ok("a changed body is refused", refused(forged, why="signature"))
    for bad in ("", "abc", "a.b.c", "é.é"):
        ok("malformed %r is refused" % bad, refused(bad))
    for claims in ({"sub": "ana@example.com"}, [1, 2], {"sub": "", "exp": 1300}, {"exp": 1300},
                   {"sub": 5, "exp": 1300}, {"sub": "  ", "exp": 1300}):
        ok("signed with bad claims %r is refused" % (claims,), refused(make(claims), why="malformed"))
    ok("no key refuses every token", refused(PERSON, key=b"", why="no key"))


def check_key():
    ok("the key is read as hex", core_token.key_from({"BENCH_CORE_TOKEN_KEY": KEY_HEX}) == KEY)
    ok("unset is no key", core_token.key_from({}) == b"")
    for bad in ("zz" * 32, "00" * 16):
        try:
            core_token.key_from({"BENCH_CORE_TOKEN_KEY": bad})
            ok("a bad key %r refuses" % bad[:6], False)
        except ValueError as e:
            ok("a bad key %r refuses, naming the variable" % bad[:6], "BENCH_CORE_TOKEN_KEY" in str(e))


def check_identity():
    pa = core_token.identity({"sub": "Ana@Example.com", "agent": "pa"})
    ok("the PA acts as the person, recorded as them, with no teams when the token names none",
       pa == {"person": "ana@example.com", "agent": "", "via": "pa", "by": "ana@example.com", "teams": []}, pa)
    pt = core_token.identity({"sub": "ana@example.com", "agent": "pa", "teams": ["Offdesk", "bad team", 5]})
    ok("the PA's teams are the token's, cleaned", pt["teams"] == ["offdesk"], pt)
    rt = core_token.identity({"sub": "ana@example.com", "agent": "routine:r1", "teams": ["offdesk"]})
    ok("a routine carries no teams, whatever the token says", rt["teams"] == [], rt)
    ok("nor does a person's own agent",
       core_token.identity({"sub": "ana@example.com", "agent": "helper", "teams": ["offdesk"]})["teams"] == [])
    ok("teams that are not a list are none",
       core_token.identity({"sub": "ana@example.com", "agent": "pa", "teams": "offdesk"})["teams"] == [])
    r = core_token.identity({"sub": "ana@example.com", "agent": "routine:r1"})
    ok("a routine acts as its person, recorded as <email> via it",
       r["person"] == "ana@example.com" and r["by"] == "ana@example.com via routine:r1", r)
    own = core_token.identity({"sub": "ana@example.com", "agent": "helper"})
    ok("a person's own agent is recorded as <email> via agent:<name>",
       own["by"] == "ana@example.com via agent:helper", own)
    team = core_token.identity({"sub": "agent:digest", "agent": "digest"})
    ok("an agent of the team is itself, recorded as agent:<name>, with no teams",
       team == {"person": "", "agent": "digest", "via": "digest", "by": "agent:digest", "teams": []}, team)
    for sub in ("routine:r1", "agent:", "agent:Not A Name", "nobody", "a@b"):
        ok("sub %r is no identity" % sub, core_token.identity({"sub": sub, "agent": "pa"}) is None)


def check_access():
    root = tempfile.mkdtemp(prefix="core-token-test-")
    try:
        board = os.path.join(root, "work")
        os.makedirs(board)
        with open(os.path.join(board, "access.json"), "w") as fh:
            json.dump({"owner": "owner@example.com", "people": ["ana@example.com"], "teams": ["offdesk"],
                       "agents": ["Digest", "bad name", "helper"]}, fh)
        got = board_access.read(board)
        ok("access.json's agents are read, cleaned", got["agents"] == ["digest", "helper"], got)
        access = got
        ana = core_token.identity({"sub": "ana@example.com", "agent": "routine:r1"})
        rui = core_token.identity({"sub": "rui@example.com", "agent": "pa"})
        ok("a named person sees the board", core_token.can_see(root, access, ana))
        ok("someone else does not", not core_token.can_see(root, access, rui))
        board_access.remember_person(root, "rui@example.com", "Rui", ["offdesk"])
        ok("the teams a person last signed in with count for nothing", not core_token.can_see(root, access, rui))
        rui_pa = core_token.identity({"sub": "rui@example.com", "agent": "pa", "teams": ["offdesk"]})
        ok("the PA's token naming the board's team sees it", core_token.can_see(root, access, rui_pa))
        rui_routine = core_token.identity({"sub": "rui@example.com", "agent": "routine:r1", "teams": ["offdesk"]})
        ok("a routine does not, teams claim or not", not core_token.can_see(root, access, rui_routine))
        digest = core_token.identity({"sub": "agent:digest", "agent": "digest"})
        other = core_token.identity({"sub": "agent:other", "agent": "other"})
        ok("an agent the board lists sees it", core_token.can_see(root, access, digest))
        ok("an agent it does not list does not", not core_token.can_see(root, access, other))
        bare = dict(access, agents=[])
        ok("a board with no agents is seen by no agent", not core_token.can_see(root, bare, digest))
        ok("no access.json is seen by nobody", not core_token.can_see(root, None, ana))
        board_access.write(board, access)
        ok("writing access.json keeps its agents", board_access.read(board)["agents"] == ["digest", "helper"])
        board_access.write(board, dict(access, agents=[]))
        with open(os.path.join(board, "access.json")) as fh:
            ok("and leaves the key out when there are none", "agents" not in json.load(fh))
        rec, err = board_access.clean("owner@example.com", [], [], ["digest", "Digest"])
        ok("clean takes agents, deduplicated", not err and rec["agents"] == ["digest"], (rec, err))
        rec, err = board_access.clean("owner@example.com", [], [], ["not ok"])
        ok("and refuses one that is not a name", rec is None and "agent" in err, err)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def main():
    check_verify()
    check_key()
    check_identity()
    check_access()
    if FAILED:
        print("%d failed" % len(FAILED))
        sys.exit(1)
    print("all checks passed")


if __name__ == "__main__":
    main()
