#!/usr/bin/env python3
"""The shared board's chat spend and its daily limits.

    python3 kanban/test_chat_spend.py
"""
import json
import multiprocessing
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import chat_spend  # noqa: E402

failed = 0


def ok(name, cond, detail=""):
    global failed
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else "  " + str(detail)))
    failed += not cond


def add_many(path, email, n):
    for _ in range(n):
        chat_spend.add(path, email, 0.01, day="2026-11-09")


def main():
    root = tempfile.mkdtemp()
    spend = os.path.join(root, "agents", "chat-spend.json")
    fences = os.path.join(root, "agents", "fences.json")

    ok("nothing spent on a fresh server", chat_spend.spent(spend, "a@example.com") == (0.0, 0.0))
    ok("no limits without a fences file",
       chat_spend.limits(fences) == {"daily": None, "person": None, "auto_apply_max": 3})
    ok("and nothing refused", chat_spend.refusal(spend, fences, "a@example.com") is None)

    chat_spend.add(spend, "a@example.com", 0.25, day="2026-11-09")
    chat_spend.add(spend, "b@example.com", 0.5, day="2026-11-09")
    chat_spend.add(spend, "a@example.com", 0.25, day="2026-11-09")
    ok("costs add up by person and day",
       chat_spend.spent(spend, "a@example.com", day="2026-11-09") == (1.0, 0.5))
    ok("another day starts at nothing",
       chat_spend.spent(spend, "a@example.com", day="2026-11-10") == (0.0, 0.0))
    chat_spend.add(spend, "a@example.com", 0, day="2026-11-09")
    chat_spend.add(spend, "a@example.com", None, day="2026-11-09")
    ok("a run with no cost changes nothing",
       chat_spend.spent(spend, "a@example.com", day="2026-11-09") == (1.0, 0.5))

    os.makedirs(os.path.dirname(fences), exist_ok=True)
    with open(fences, "w") as fh:
        json.dump({"daily_budget": 9, "chat_daily_budget": 2, "chat_person_budget": 0.5,
                   "chat_auto_apply_max": 5}, fh)
    ok("the limits are read from fences.json",
       chat_spend.limits(fences) == {"daily": 2.0, "person": 0.5, "auto_apply_max": 5})
    why = chat_spend.refusal(spend, fences, "a@example.com", day="2026-11-09")
    ok("a person at their limit is refused", why and "your chat budget" in why, why)
    ok("another person is not",
       chat_spend.refusal(spend, fences, "c@example.com", day="2026-11-09") is None)
    chat_spend.add(spend, "c@example.com", 1.0, day="2026-11-09")
    why = chat_spend.refusal(spend, fences, "d@example.com", day="2026-11-09")
    ok("everyone is refused once the board's day is used up", why and "today's chat budget" in why, why)

    with open(fences, "w") as fh:
        json.dump({"chat_daily_budget": "lots", "chat_person_budget": -1, "chat_auto_apply_max": True}, fh)
    ok("a limit that is not a number is no limit",
       chat_spend.limits(fences) == {"daily": None, "person": None, "auto_apply_max": 3})

    # Two processes adding at once: every cost counts.
    race = os.path.join(root, "race", "chat-spend.json")
    procs = [multiprocessing.Process(target=add_many, args=(race, "a@example.com", 50)) for _ in range(2)]
    [p.start() for p in procs]
    [p.join() for p in procs]
    total, _ = chat_spend.spent(race, "a@example.com", day="2026-11-09")
    ok("two runs ending at once both count", abs(total - 1.0) < 1e-6, total)

    print("\n%d failed" % failed if failed else "\nall checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
