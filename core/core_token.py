#!/usr/bin/env python3
"""The Offdesk core's tokens, checked with Bench's own code.

The core signs a short-lived token for every tool call, and Bench's tools for
the core (mcp/, bench_mcp) pass it on as `Authorization: Bearer`. Only the
routes under /core/ in kanban/server.py read it; everywhere else the header is
ignored, so the board's own sign-in is exactly what it was.

The format is the core's: base64url (no padding) of compact JSON
`{"sub", "agent", "exp"}`, a dot, and base64url of the HMAC-SHA256 of that
first part. Bench holds the core's key as BENCH_CORE_TOKEN_KEY (64 hex
characters, the same as the core's CORE_TOKEN_KEY); unset, every token is
refused. `exp` is seconds since 1970, and a token is good up to and including
that second. Binder checks the same tokens with the same rule, and the test
vectors in core/test_core_token.py are the core's own.

Who a token names, as the core sends it:

    sub ana@example.com, agent pa            the PA, acting for Ana
    sub ana@example.com, agent routine:r1    one of Ana's routines, as Ana
    sub ana@example.com, agent helper        Ana's own agent, as Ana
    sub agent:digest,    agent digest        an agent of the team

A person sees the boards access.json lets them see, as a signed-in visitor
would, with the teams they last signed in with (the token carries none). An
agent of the team sees only boards whose access.json lists it under `agents`.
What a request asks for is recorded as `by`: the person when the PA acts,
`agent:<name>` for an agent of the team, and `<email> via <agent>` otherwise
(`ana@example.com via routine:r1`), the way Binder records it.
"""

import base64
import binascii
import hashlib
import hmac
import json
import re
import time

import board_access

ENV = "BENCH_CORE_TOKEN_KEY"
AGENT_PREFIX = "agent:"
# The core's agent names, and how access.json lists them.
AGENT_NAME_RE = re.compile(r"^[a-z][a-z0-9-]{0,63}$")


class TokenError(Exception):
    pass


def _b64(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def key_from(env):
    """The key out of the environment, b"" when unset. Raises ValueError for a
    value that is not 64 hex characters, which the server turns into a
    refusal to start."""
    raw = (env.get(ENV) or "").strip()
    if not raw:
        return b""
    try:
        key = bytes.fromhex(raw)
    except ValueError:
        key = b""
    if len(key) != 32:
        raise ValueError("%s must be 64 hex characters, the same as the core's CORE_TOKEN_KEY" % ENV)
    return key


def verify(key, token, now=None):
    """The token's claims, or TokenError saying why not."""
    if not key:
        raise TokenError("no key: %s is not set" % ENV)
    try:
        body, sig = str(token).split(".")
    except ValueError:
        raise TokenError("malformed") from None
    good = _b64(hmac.new(key, body.encode("utf-8", "replace"), hashlib.sha256).digest())
    if not hmac.compare_digest(sig.encode("utf-8", "replace"), good.encode()):
        raise TokenError("bad signature")
    try:
        claims = json.loads(_unb64(body))
        exp = int(claims["exp"])
        sub = claims["sub"]
    except (ValueError, KeyError, TypeError, binascii.Error):
        raise TokenError("malformed") from None
    if not isinstance(sub, str) or not sub.strip():
        raise TokenError("malformed")
    if exp < int(now if now is not None else time.time()):
        raise TokenError("expired")
    return claims


def identity(claims):
    """{person, agent, via, by} for a token's claims, or None when `sub` is
    neither a person's email nor `agent:<name>`."""
    sub = str(claims.get("sub") or "").strip()
    via = claims.get("agent") if isinstance(claims.get("agent"), str) else ""
    via = via.strip()
    if sub.startswith(AGENT_PREFIX):
        name = sub[len(AGENT_PREFIX):]
        if not AGENT_NAME_RE.match(name):
            return None
        return {"person": "", "agent": name, "via": via, "by": AGENT_PREFIX + name}
    person = board_access.email(sub)
    if not person:
        return None
    if not via or via == "pa":
        by = person
    else:
        by = "%s via %s" % (person, via if ":" in via else AGENT_PREFIX + via)
    return {"person": person, "agent": "", "via": via, "by": by}


def can_see(data_root, access, who):
    """Whether this identity may see a board with this access record."""
    if not access or not who:
        return False
    if who.get("agent"):
        return who["agent"] in (access.get("agents") or [])
    teams = board_access.read_user(data_root, who["person"]).get("teams") or []
    return board_access.can_see(access, {"email": who["person"], "teams": board_access.teams(teams)})
