#!/usr/bin/env python3
"""Who a task on a shared board can be given to.

    python3 kanban/test_board_people.py

No browser. It starts kanban/server.py itself on free ports (never 8765 or
8766) over a throwaway data root, signed in with BENCH_AUTH=header and once
as the Mac board. The real data/ is never read or written.

What it holds to:

  * /board-people.json lists the board's people and nobody else: its owner,
    its named people, and everyone who has signed in as a member of one of its
    teams, but not someone signed in only to another team;
  * each comes with the name they first signed in with, kept when a later
    sign-in sends another, and "" for someone who has never signed in; a
    name is kept and served without bidi or control characters;
  * someone outside the board cannot list them, and the Mac board has no
    such list;
  * an agent's request on behalf of a person is never credited as an agent's;
  * signed in, a bare name in [to:: ] on a line a save adds or changes becomes
    the one board person it means, by name, first name or the part of the
    address before the @ (or a +); a name meaning nobody or two people
    refuses the save, naming the line and the candidates; an agent, an email
    and an untouched line are left alone, and the Mac board keeps names.
"""

import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "core"))
from test_board_access import Server, seed, access, as_json, TIAGO, JEROME  # noqa: E402
import tick_queue  # noqa: E402

PASS = []
FAIL = []


def ok(label, cond, detail=""):
    (PASS if cond else FAIL).append(label if cond else
                                    (label + (" — " + detail if detail else "")))


# Ana's name arrives with a right-to-left override, a mark, an isolate and a
# bell in it, percent-encoded the way nginx passes it on.
ANA = {"X-Offdesk-Email": "ana@example.com",
       "X-Offdesk-Name": "%E2%80%AEAna%E2%80%8F%20%E2%81%A6Silva%07", "X-Offdesk-Teams": "offdesk"}
BOB = {"X-Offdesk-Email": "bob@example.com", "X-Offdesk-Name": "Bob", "X-Offdesk-Teams": "elsewhere"}
NOBODY = {"X-Offdesk-Email": "nobody@example.com", "X-Offdesk-Name": "Nobody"}
LIST = """# To-do

## 1. Tasks

### To do

- [ ] **Give it to Jerome** [to:: jerome@example.com] `id:aaaaaa`
  - [ ] His step [to:: jerome@example.com] `id:s00001`

### Done

"""


def signed_in(root):
    data = os.path.join(root, "signed-in")
    seed(data, "offdesk", LIST)
    access(data, "offdesk", TIAGO["X-Offdesk-Email"], people=[JEROME["X-Offdesk-Email"], "carla@example.com"],
           teams=["offdesk"])
    seed(data, "elsewhere")
    access(data, "elsewhere", BOB["X-Offdesk-Email"], teams=["elsewhere"])
    srv = Server(data, "header")
    ok("server starts", srv.wait())
    try:
        # Everyone signs in once, which is how the server learns names and teams.
        for who in (TIAGO, JEROME, ANA, BOB, NOBODY):
            srv.ask("GET", "/whoami", who)
        # A later sign-in under another name does not rename anybody.
        srv.ask("GET", "/whoami", dict(JEROME, **{"X-Offdesk-Name": "Somebody%20Else"}))

        code, body, _ = srv.ask("GET", "/board-people.json", JEROME)
        got = (as_json(body) or {}).get("people")
        ok("the board's people are listed", code == 200, "%d %s" % (code, body[:200]))
        emails = [p["email"] for p in got or []]
        ok("owner, named people, then signed-in team members",
           emails == ["tiagopedras+claude@gmail.com", "jerome@example.com", "carla@example.com", "ana@example.com"],
           repr(emails))
        ok("nobody from another team", "bob@example.com" not in emails)
        names = {p["email"]: p["name"] for p in got or []}
        ok("each with the name they first signed in with",
           names.get("jerome@example.com") == "Jérôme" and names.get("ana@example.com") == "Ana Silva", repr(names))
        ok("and no name for someone who never signed in", names.get("carla@example.com") == "", repr(names))
        ok("a name is stored without bidi or control characters",
           names.get("ana@example.com") == "Ana Silva", repr(names.get("ana@example.com")))
        code, body, _ = srv.ask("GET", "/whoami", ANA)
        ok("and /whoami says it the same", (as_json(body) or {}).get("name") == "Ana Silva", body)
        import board_access
        ok("clean_name drops every override, isolate and mark, and reads controls as spaces",
           board_access.clean_name("\u202aA\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u200e\u200fna\tSilva\u0000")
           == "Ana Silva")

        code, body, _ = srv.ask("GET", "/board-people.json", BOB)
        bobs = [p["email"] for p in (as_json(body) or {}).get("people") or []]
        ok("Bob's board lists Bob's people", bobs == ["bob@example.com"], repr(bobs))
        code, body, _ = srv.ask("GET", "/board-people.json", NOBODY)
        ok("someone outside every board cannot list anybody", code == 404, "%d %s" % (code, body[:200]))

        # An agent's tick on behalf of a person: credits nobody.
        folder = os.path.join(data, "offdesk")
        entry = tick_queue.append("s00001", "jerome@example.com", path=os.path.join(folder, "tick-queue.json"))
        srv.ask("POST", "/tick-queue.json", dict(JEROME, **{"X-Board": "1", "Content-Type": "application/json"}),
                {"done": [entry["id"]]})
        with open(os.path.join(folder, "todo.md"), encoding="utf-8") as fh:
            base = fh.read()
        code, body, _ = srv.ask("PUT", "/data/todo.md", dict(TIAGO, **{"Content-Type": "application/json"}),
                                {"text": base.replace("- [ ] His step", "- [x] His step"), "base": base})
        with open(os.path.join(folder, "todo.md"), encoding="utf-8") as fh:
            step = next(l for l in fh.read().split("\n") if "His step" in l)
        ok("a request in a person's name is never an agent's",
           "`edited-by:tiagopedras+claude@gmail.com`" in step, step)

        assignees(srv, folder)
    finally:
        srv.stop()


def assignees(srv, folder):
    """A task handed over by name, as the PA writes it, on the signed-in board."""
    path = os.path.join(folder, "todo.md")
    board = dict(JEROME, **{"X-Board": "1", "Content-Type": "application/json"})

    def disk():
        with open(path, encoding="utf-8") as fh:
            return fh.read()

    def save(*lines):
        base = disk()
        text = base.replace("### Done\n", "\n".join(lines) + "\n\n### Done\n")
        code, body, _ = srv.ask("PUT", "/data/todo.md", board, {"text": text, "base": base})
        return code, as_json(body) or {}

    def line(title):
        return next((l for l in disk().split("\n") if title in l), "")

    code, got = save("- [ ] **Named Jerome** [to:: Jerome] `id:nm0001`",
                     "  - [ ] A step for him [to:: jérôme] `id:nm0002`",
                     "- [ ] **Named Tiago** [to:: Tiago] `id:nm0003`",
                     "- [ ] **By address** [to:: carla] `id:nm0004`",
                     "- [ ] **By the part before the +** [to:: TiagoPedras] `id:nm0005`",
                     "- [ ] **For the agent** [to:: Plan agent] `id:nm0006`",
                     "- [ ] **Already an email** [to:: jerome@example.com] `id:nm0007`")
    ok("a save with names in it lands", code == 200, "%d %r" % (code, got))
    ok("a name becomes the board person's email, accents or not",
       "[to:: jerome@example.com]" in line("Named Jerome"), line("Named Jerome"))
    ok("a sub-task's too, written with the accents", "[to:: jerome@example.com]" in line("A step for him"),
       line("A step for him"))
    ok("the owner's own name resolves, by first name", "[to:: tiagopedras+claude@gmail.com]" in line("Named Tiago"),
       line("Named Tiago"))
    ok("someone who never signed in is found by their address",
       "[to:: carla@example.com]" in line("By address"), line("By address"))
    ok("and by the part of it before a +", "[to:: tiagopedras+claude@gmail.com]" in line("before the +"),
       line("before the +"))
    ok("an agent keeps its name", "[to:: Plan agent]" in line("For the agent"), line("For the agent"))
    ok("an email stays as it was", "[to:: jerome@example.com]" in line("Already an email"))
    ok("and the reply carries what was written, so the tab catches up",
       "[to:: jerome@example.com]" in (got.get("text") or ""), repr(got)[:200])

    # A name nobody on the board answers to refuses the whole save, by line.
    before = disk()
    code, got = save("- [ ] **For a stranger** [to:: Zed] `id:nm0010`",
                     "- [ ] **For Jerome too** [to:: Jerome] `id:nm0011`")
    ok("a name matching nobody refuses the save", code == 422, "%d %r" % (code, got))
    stranger = (got.get("assignees") or [{}])[0]
    ok("naming the line and the name", stranger.get("name") == "Zed" and "For a stranger" in stranger.get("text", "")
       and stranger.get("line") == next(i + 1 for i, l in enumerate((before.replace(
           "### Done\n", "- [ ] **For a stranger** [to:: Zed] `id:nm0010`\n- [ ] **For Jerome too** [to:: Jerome] "
           "`id:nm0011`\n\n### Done\n")).split("\n")) if "For a stranger" in l), repr(got))
    ok("and says so in words", "line" in got.get("error", "") and "Zed" in got.get("error", "") and "nobody" in got.get("error", ""),
       got.get("error"))
    ok("and nothing is written", disk() == before)

    # A line nobody touched keeps whatever name it holds.
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(before.replace("### Done\n", "- [ ] **Left by hand** [to:: Zed] `id:nm0020`\n\n### Done\n"))
    code, got = save("- [ ] **Something new** `id:nm0021`")
    ok("a name on a line the save did not change is left alone", code == 200 and "[to:: Zed]" in line("Left by hand"),
       "%d %r" % (code, got))

    # Two people called Maya sign in: "Maya" could be either, so it is refused with both.
    for addr, name in (("maya@example.com", "Maya%20Rossi"), ("maya.costa@example.com", "Maya%20Costa")):
        srv.ask("GET", "/whoami", {"X-Offdesk-Email": addr, "X-Offdesk-Name": name, "X-Offdesk-Teams": "offdesk"})
    before = disk()
    code, got = save("- [ ] **For one of the Mayas** [to:: Maya] `id:nm0030`")
    two = (got.get("assignees") or [{}])[0]
    ok("a name matching two people refuses the save", code == 422, "%d %r" % (code, got))
    ok("naming both", sorted(two.get("candidates") or []) == ["maya.costa@example.com", "maya@example.com"], repr(got))
    ok("and nothing is written either", disk() == before)
    code, got = save("- [ ] **For Maya Costa** [to:: Maya Costa] `id:nm0031`")
    ok("a whole name tells them apart", code == 200 and "[to:: maya.costa@example.com]" in line("For Maya Costa"),
       "%d %r" % (code, got))

    import board_access
    import todo
    people = [{"email": "j@example.com", "name": "Jérôme Martin"}]
    ok("people_named folds accents and case", board_access.people_named(people, "  JEROME ") == ["j@example.com"])
    text, problems = todo.resolve_assignees("", "Notes mention [to:: Jerome]\n- [ ] x [to:: Jerome]",
                                            lambda n: board_access.people_named(people, n))
    ok("resolve_assignees touches task lines only",
       text == "Notes mention [to:: Jerome]\n- [ ] x [to:: j@example.com]" and not problems, repr((text, problems)))


def mac(root):
    data = os.path.join(root, "mac")
    seed(data, "tasks", LIST)
    srv = Server(data, None)
    ok("Mac server starts", srv.wait())
    try:
        code, _, _ = srv.ask("GET", "/board-people.json")
        ok("the Mac board has no list of people to give a task to", code == 404, "got %d" % code)
        path = os.path.join(data, "tasks", "todo.md")
        with open(path, encoding="utf-8") as fh:
            base = fh.read()
        text = base.replace("### Done\n", "- [ ] **Named Zed** [to:: Zed] `id:nm0100`\n\n### Done\n")
        code, _, _ = srv.ask("PUT", "/data/todo.md", {"X-Board": "1", "Content-Type": "application/json"},
                             {"text": text, "base": base})
        with open(path, encoding="utf-8") as fh:
            ok("on the Mac board a name is saved as written", code == 200 and fh.read() == text, "got %d" % code)
    finally:
        srv.stop()


def main():
    root = tempfile.mkdtemp(prefix="board-people-test-")
    try:
        signed_in(root)
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
