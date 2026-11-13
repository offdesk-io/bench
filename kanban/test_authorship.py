#!/usr/bin/env python3
"""Who wrote each task, who last changed it, and the list's activity log.

    python3 kanban/test_authorship.py

No browser. It starts kanban/server.py itself on free ports (never 8765 or
8766) over a throwaway data root, signed in with BENCH_AUTH=header on a board
two people share, and once as the Mac board. The real data/ is never read or
written.

What it holds to:

  * signed in, a task someone adds is created by the email nginx sent, and a
    task or sub-task someone changes is last edited by it;
  * a tab cannot say either: what it sends for created-by or edited-by is put
    back to what the file says, on a task it changed or one it did not;
  * every save's changes land in data/<board>/activity.jsonl, one line per
    task, with who, their name and what changed, and /activity.json reads them
    back newest first with a name for each email;
  * on the Mac nobody signs in: no tag is written, a file without them comes
    back byte for byte, and the log names the owner from the profile;
  * a sub-task an agent asked to tick (core/tick_queue.py), applied by the
    board and saved by whoever's tab drained it, goes under the agent: the
    card is edited by `demo-tasks-agent` and the log says Demo tasks agent,
    while anything else in the same save stays the saver's; a request the
    board refuses credits nobody;
  * an edit written straight to todo.md, the way the pa skill writes, is
    logged under `pa` the next time the server reads the list and, signed in,
    stamped on the cards it changed; held while pa-working.json says pa is
    mid-edit; and on the Mac logged with no tag written.
"""

import json
import os
import shutil
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "core"))
from test_board_access import Server, seed, access, as_json, write, TIAGO, JEROME  # noqa: E402
import tick_queue  # noqa: E402

PASS = []
FAIL = []


def ok(label, cond, detail=""):
    (PASS if cond else FAIL).append(label if cond else
                                    (label + (" — " + detail if detail else "")))


LIST = """# To-do

## 1. Tasks

### To do

- [ ] **Write the brief** [due:: 2026-10-30] `created-by:tiagopedras+claude@gmail.com` `id:aaaaaa`
- [ ] **Book the venue** `id:bbbbbb`
  - [ ] Call the venue `id:s00001`
  - [ ] Send the deposit `id:s00002`

### Done

"""


def line_of(text, needle):
    return next((l for l in text.split("\n") if needle in l), "")


def signed_in(root):
    data = os.path.join(root, "signed-in")
    seed(data, "offdesk", LIST)
    access(data, "offdesk", TIAGO["X-Offdesk-Email"], people=[JEROME["X-Offdesk-Email"]])
    path = os.path.join(data, "offdesk", "todo.md")
    srv = Server(data, "header")
    ok("signed-in server starts", srv.wait())
    try:
        def save(who, text, base):
            code, body, _ = srv.ask("PUT", "/data/todo.md", dict(who, **{"Content-Type": "application/json"}),
                                    {"text": text, "base": base})
            return code, as_json(body) or {}

        def disk():
            with open(path, encoding="utf-8") as fh:
                return fh.read()

        # --- an edit, a new task and a new sub-task, from Jerome --------------------
        mine = (LIST.replace("[due:: 2026-10-30]", "[due:: 2026-11-02]")
                    .replace("  - [ ] Send the deposit `id:s00002`\n",
                             "  - [ ] Send the deposit `id:s00002`\n  - [ ] Confirm numbers `id:s00003`\n")
                    .replace("### Done", "- [ ] **Order badges** `id:cccccc`\n\n### Done"))
        code, got = save(JEROME, mine, LIST)
        now = disk()
        ok("a save from Jerome writes", code == 200, "%d %r" % (code, got))
        brief = line_of(now, "Write the brief")
        ok("the task he changed is last edited by him",
           "`edited-by:jerome@example.com`" in brief, brief)
        ok("and still created by who wrote it",
           "`created-by:tiagopedras+claude@gmail.com`" in brief, brief)
        ok("the tags sit in front of the id",
           brief.endswith("`created-by:tiagopedras+claude@gmail.com` `edited-by:jerome@example.com` `id:aaaaaa`"), brief)
        badges = line_of(now, "Order badges")
        ok("the task he added is created by him", "`created-by:jerome@example.com`" in badges, badges)
        ok("and has no editor yet", "edited-by" not in badges, badges)
        step = line_of(now, "Confirm numbers")
        ok("the sub-task he added is created by him", "`created-by:jerome@example.com`" in step, step)
        venue = line_of(now, "Book the venue")
        ok("a task whose sub-tasks he changed counts as edited by him",
           "`edited-by:jerome@example.com`" in venue, venue)
        ok("a sub-task he did not touch is left alone",
           line_of(now, "Call the venue") == "  - [ ] Call the venue `id:s00001`", line_of(now, "Call the venue"))
        ok("the reply carries the text written, tags and all",
           got.get("text") == now and not got.get("merged"), repr(got)[:200])

        # --- a tab cannot say who did it ------------------------------------------
        base = now
        forged = (base.replace("`created-by:tiagopedras+claude@gmail.com`", "`created-by:mallory@example.com`")
                      .replace("- [ ] Call the venue `id:s00001`",
                               "- [x] Call the venue `created-by:mallory@example.com` `id:s00001`")
                      .replace("### Done",
                               "- [ ] **Forged** `created-by:mallory@example.com` `edited-by:mallory@example.com` `id:dddddd`\n\n### Done"))
        code, got = save(JEROME, forged, base)
        now = disk()
        ok("a forged save still writes", code == 200, "%d %r" % (code, got))
        ok("created-by sent on an untouched task is put back",
           "`created-by:tiagopedras+claude@gmail.com`" in line_of(now, "Write the brief")
           and "mallory" not in line_of(now, "Write the brief"), line_of(now, "Write the brief"))
        call = line_of(now, "Call the venue")
        ok("created-by sent on a sub-task it changed is dropped, and the editor is the signer",
           "mallory" not in call and "`edited-by:jerome@example.com`" in call, call)
        new = line_of(now, "Forged")
        ok("both sent on a new task are replaced by the signer",
           "mallory" not in new and "`created-by:jerome@example.com`" in new and "edited-by" not in new, new)

        # --- the same edit from Tiago: the other name ---------------------------------
        base = now
        code, got = save(TIAGO, base.replace("**Order badges**", "**Order name badges**"), base)
        badges = line_of(disk(), "Order name badges")
        ok("the header decides the name: Tiago's edit is his",
           "`created-by:jerome@example.com` `edited-by:tiagopedras+claude@gmail.com`" in badges, badges)

        # --- the activity log -------------------------------------------------------
        log_path = os.path.join(data, "offdesk", "activity.jsonl")
        with open(log_path, encoding="utf-8") as fh:
            log = [json.loads(l) for l in fh if l.strip()]
        first = [e for e in log if e["who"] == "jerome@example.com"]
        ok("each save's changes are logged", len(log) >= 6, json.dumps(log)[:300])
        ok("with who, by email and name",
           all(e.get("name") == "Jérôme" for e in first) and first, json.dumps(first)[:300])
        ok("the edit says which fields",
           any(e["task"] == "Write the brief" and e["what"] == "edited" and e["fields"] == ["due"] for e in log),
           json.dumps(log)[:400])
        ok("an added task says so",
           any(e["task"] == "Order badges" and e["what"] == "added" and e["id"] == "cccccc" for e in log))
        ok("every entry carries when", all(e.get("at", "").endswith("+00:00") for e in log))
        code, body, _ = srv.ask("GET", "/activity.json", JEROME)
        got = as_json(body) or {}
        ok("/activity.json answers", code == 200, "%d %s" % (code, body[:200]))
        ok("newest first", (got.get("entries") or [{}])[0].get("task") == "Order name badges",
           json.dumps(got.get("entries"))[:200])
        ok("with a name for every email it has seen",
           got.get("names", {}).get("jerome@example.com") == "Jérôme"
           and got.get("names", {}).get("tiagopedras+claude@gmail.com") == "Tiago Pedras", repr(got.get("names")))
        ok("and says who is asking", got.get("me") == "jerome@example.com", repr(got.get("me")))
        code, _, _ = srv.ask("GET", "/activity.json", {"X-Offdesk-Email": "nobody@example.com"})
        ok("someone outside the board cannot read its log", code == 404, "got %d" % code)
    finally:
        srv.stop()


AGENTS = """# To-do

## 1. Tasks

### Doing

- [ ] **Ship the page** [to:: Demo tasks agent] `id:aaaaaa`
  - [ ] Implement [to:: Demo tasks agent] `id:s00001`
  - [ ] Review the work [to:: Tiago] `id:s00002`
- [ ] **Plan the launch** [to:: Demo admin agent] `id:bbbbbb`
  - [ ] Plan [to:: Demo admin agent] `id:s00003`
- [ ] **Order badges** `id:cccccc`

### Done

"""


# An outside edit is only taken once the file has been left alone this long
# (OUTSIDE_QUIET_S in kanban/server.py), so a read waits it out.
QUIET = 1.2


def log_of(folder):
    try:
        with open(os.path.join(folder, "activity.jsonl"), encoding="utf-8") as fh:
            return [json.loads(l) for l in fh if l.strip()]
    except OSError:
        return []


def agents_and_outside(root):
    data = os.path.join(root, "agents")
    seed(data, "offdesk", AGENTS)
    access(data, "offdesk", TIAGO["X-Offdesk-Email"], people=[JEROME["X-Offdesk-Email"]])
    folder = os.path.join(data, "offdesk")
    path = os.path.join(folder, "todo.md")
    queue = os.path.join(folder, "tick-queue.json")
    srv = Server(data, "header")
    ok("agents server starts", srv.wait())
    try:
        def disk():
            with open(path, encoding="utf-8") as fh:
                return fh.read()

        def save(text, base):
            code, body, _ = srv.ask("PUT", "/data/todo.md", dict(JEROME, **{"Content-Type": "application/json"}),
                                    {"text": text, "base": base})
            return code, as_json(body) or {}

        # --- the agent's tick ------------------------------------------------------
        good = tick_queue.append("s00001", "Demo tasks agent", path=queue)
        bad = tick_queue.append("s00003", "Demo tasks agent", path=queue)   # not its sub-task
        # Two more the board refuses: a handover for a card whose [to::] names
        # no agent, and a move off the content list.
        hand = tick_queue.append_handover("cccccc", "Demo admin agent", "Demo admin agent", path=queue)
        move = tick_queue.append_move("bbbbbb", "Reviewing", "Content strategist agent", path=queue)
        code, body, _ = srv.ask("POST", "/tick-queue.json", dict(JEROME, **{"X-Board": "1",
                                "Content-Type": "application/json"}),
                                {"done": [good["id"], bad["id"], hand["id"], move["id"]]})
        ok("the board's drain answers", code == 200 and (as_json(body) or {}).get("removed") == 4, body)
        # What Jerome's tab saves: the tick it applied, the card moved on, and
        # an edit of his own on another card, all in one save.
        base = disk()
        mine = (base.replace("- [ ] Implement [to:: Demo tasks agent]", "- [x] Implement [to:: Demo tasks agent] `done:2026-10-23`")
                    .replace("**Order badges**", "**Order name badges**")
                    .replace("**Plan the launch**", "**Plan the launch now**"))
        code, got = save(mine, base)
        now = disk()
        ok("the save with the tick writes", code == 200, "%d %r" % (code, got))
        step = line_of(now, "Implement [to::")
        ok("the ticked sub-task is edited by the agent", "`edited-by:demo-tasks-agent`" in step, step)
        card = line_of(now, "Ship the page")
        ok("and so is its card", "`edited-by:demo-tasks-agent`" in card, card)
        own = line_of(now, "Order name badges")
        ok("the saver's own edit in the same save stays theirs", "`edited-by:jerome@example.com`" in own, own)
        refused = line_of(now, "Plan the launch now")
        ok("a request the board refused credits nobody", "`edited-by:jerome@example.com`" in refused, refused)
        ok("a handover for a card not handed to that agent credits nobody",
           "`edited-by:jerome@example.com`" in own and "demo-admin-agent" not in own, own)
        ok("nor does a move off the content list",
           "content-strategist-agent" not in refused and "`edited-by:jerome@example.com`" in refused, refused)
        log = log_of(folder)
        ship = [e for e in log if e["task"] == "Ship the page"]
        ok("the log has the tick under the agent",
           ship and ship[-1]["who"] == "demo-tasks-agent" and ship[-1]["name"] == "Demo tasks agent", json.dumps(log))
        ok("and the saver's edit under the saver",
           any(e["task"] == "Order name badges" and e["who"] == "jerome@example.com" for e in log))
        code, body, _ = srv.ask("GET", "/activity.json", JEROME)
        ok("/activity.json names the agent",
           (as_json(body) or {}).get("names", {}).get("demo-tasks-agent") == "Demo tasks agent", body[:300])

        # --- an edit written straight to the file ---------------------------------
        srv.ask("HEAD", "/data/todo.md", JEROME)          # the server has seen this version
        write(os.path.join(folder, "pa-working.json"), json.dumps({"tasks": ["Order name badges"]}))
        write(path, disk().replace("**Order name badges**", "**Order name badges for the launch**"))
        time.sleep(QUIET)
        srv.ask("HEAD", "/data/todo.md", JEROME)
        ok("held while pa says it is mid-edit",
           not any(e["who"] == "pa" for e in log_of(folder)) and "edited-by:pa" not in disk())
        os.remove(os.path.join(folder, "pa-working.json"))
        code, body, _ = srv.ask("GET", "/data/todo.md", JEROME)
        out = [e for e in log_of(folder) if e["who"] == "pa"]
        ok("once it is done, the next read logs the edit under pa",
           out and out[-1]["task"] == "Order name badges for the launch" and out[-1]["fields"] == ["title"],
           json.dumps(out))
        line = line_of(disk(), "Order name badges for the launch")
        ok("signed in, the card it changed is stamped as pa's", "`edited-by:pa`" in line, line)
        ok("and the read serves the stamped list", "`edited-by:pa`" in line_of(body, "for the launch"))
        before = len(log_of(folder))
        srv.ask("HEAD", "/data/todo.md", JEROME)
        ok("an edit is logged once", len(log_of(folder)) == before)
        # A tab's save on top of it merges, and its own change is still its own.
        base = disk()
        code, _ = save(base.replace("**Ship the page**", "**Ship the landing page**"), base)
        ok("a save after an outside edit is the saver's",
           "`edited-by:jerome@example.com`" in line_of(disk(), "Ship the landing page"))
        write(path, disk().replace("**Ship the landing page**", "**Ship it**"))
        code, got = save(base.replace("**Plan the launch now**", "**Plan it**"), base)
        log = log_of(folder)
        ok("an outside edit found by a save is logged under pa, before the save",
           [e["who"] for e in log[-2:]] == ["pa", "jerome@example.com"]
           and log[-2]["task"] == "Ship it", json.dumps(log[-2:]))
    finally:
        srv.stop()


def mac(root):
    data = os.path.join(root, "mac")
    plain = LIST.replace(" `created-by:tiagopedras+claude@gmail.com`", "")
    seed(data, "tasks", plain)
    write(os.path.join(data, "profile.md"), "# Profile\n\n## About\n\n- Name: Tiago\n")
    path = os.path.join(data, "tasks", "todo.md")
    srv = Server(data, None)
    ok("Mac server starts", srv.wait())
    try:
        mine = plain.replace("[due:: 2026-10-30]", "[due:: 2026-11-02]")
        code, body, _ = srv.ask("PUT", "/data/todo.md", {"Content-Type": "application/json"},
                                {"text": mine, "base": plain})
        got = as_json(body) or {}
        with open(path, encoding="utf-8") as fh:
            ok("on the Mac the file is written as sent, no tags", fh.read() == mine)
        ok("and the reply carries no text", code == 200 and "text" not in got, repr(got))
        with open(os.path.join(data, "tasks", "activity.jsonl"), encoding="utf-8") as fh:
            log = [json.loads(l) for l in fh if l.strip()]
        ok("the log still has the change, under the owner's name",
           log and log[-1]["who"] == "" and log[-1]["name"] == "Tiago" and log[-1]["fields"] == ["due"],
           json.dumps(log))
        code, body, _ = srv.ask("GET", "/activity.json")
        ok("/activity.json answers on the Mac with nobody asking",
           code == 200 and (as_json(body) or {}).get("me") == "", body[:200])

        # An edit written straight to the file, on the Mac: logged, no tag.
        outside = mine.replace("**Book the venue**", "**Book a venue**")
        write(path, outside)
        time.sleep(QUIET)
        srv.ask("HEAD", "/data/todo.md")
        with open(path, encoding="utf-8") as fh:
            ok("on the Mac an outside edit writes no tag", fh.read() == outside)
        with open(os.path.join(data, "tasks", "activity.jsonl"), encoding="utf-8") as fh:
            log = [json.loads(l) for l in fh if l.strip()]
        ok("and is logged under pa",
           log[-1]["who"] == "pa" and log[-1]["task"] == "Book a venue", json.dumps(log[-1]))
    finally:
        srv.stop()


def main():
    root = tempfile.mkdtemp(prefix="authorship-test-")
    try:
        signed_in(root)
        agents_and_outside(root)
        mac(root)
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
