"""What the shared board's chats have cost, and the daily limits on them.

`data/agents/chat-spend.json` holds `{"YYYY-MM-DD": {email: dollars}}`,
kept for 31 days. The limits sit in the agents' fences file beside the Plan
agent's budgets: `chat_daily_budget` (all chats on the server, dollars a day),
`chat_person_budget` (each person, dollars a day) and `chat_auto_apply_max`
(how many cards a PA reply may change before it waits for the person, see
pa_check.py). A limit that is missing or not a number is no limit.

Every add takes an exclusive lock on a file beside the ledger, so two runs
ending together cannot overwrite each other's costs.
"""

import datetime
import fcntl
import json
import os

KEEP_DAYS = 31
AUTO_APPLY_MAX = 3


def _read(path):
    try:
        with open(path, encoding="utf-8") as fh:
            got = json.load(fh)
    except (OSError, ValueError):
        return {}
    return got if isinstance(got, dict) else {}


def _number(raw, key):
    v = raw.get(key)
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v < 0:
        return None
    return float(v)


def limits(fences_path):
    raw = _read(fences_path)
    most = _number(raw, "chat_auto_apply_max")
    return {"daily": _number(raw, "chat_daily_budget"),
            "person": _number(raw, "chat_person_budget"),
            "auto_apply_max": AUTO_APPLY_MAX if most is None else int(most)}


def today():
    return datetime.date.today().isoformat()


def spent(path, email, day=None):
    """(everyone's total, this person's) for the day, in dollars."""
    row = _read(path).get(day or today()) or {}
    nums = {k: float(v) for k, v in row.items()
            if isinstance(v, (int, float)) and not isinstance(v, bool)}
    return round(sum(nums.values()), 6), round(nums.get(email, 0.0), 6)


def refusal(spend_path, fences_path, email, day=None):
    """Why a new chat may not start now, or None."""
    lim = limits(fences_path)
    total, mine = spent(spend_path, email, day)
    if lim["daily"] is not None and total >= lim["daily"]:
        return "today's chat budget on this board server is used up ($%.2f of $%.2f)" % (total, lim["daily"])
    if lim["person"] is not None and mine >= lim["person"]:
        return "your chat budget for today is used up ($%.2f of $%.2f)" % (mine, lim["person"])
    return None


def add(path, email, usd, day=None):
    """Adds one run's cost to the day. A run with no cost adds nothing."""
    if isinstance(usd, bool) or not isinstance(usd, (int, float)) or usd <= 0:
        return
    day = day or today()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            ledger = _read(path)
            cutoff = (datetime.date.fromisoformat(day) - datetime.timedelta(days=KEEP_DAYS)).isoformat()
            for old in [k for k in ledger if k < cutoff]:
                del ledger[old]
            row = ledger.setdefault(day, {})
            row[email] = round(float(row.get(email, 0) or 0) + float(usd), 6)
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(ledger, fh, indent=1, sort_keys=True)
            os.replace(tmp, path)
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
