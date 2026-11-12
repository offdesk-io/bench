#!/usr/bin/env python3
"""Proof that check_todo.py's slug check sees done-archive.md.

Archiving (kanban/js/25-archiving.js) runs on its own now, hourly, so a task
that has been ticked off for more than ARCHIVE_DAYS quietly leaves todo.md.
Before archived_slugs() existed in check_todo.py, its slug left with it, and
check_slugs() had no way to tell an archived task's #slug from a typo — every
blocked-by: pointing at work that had simply finished and aged out read as a
dangling reference. See IMPROVEMENTS.md, "check_todo.py has no archive
reader."

    python3 test_check_todo.py

No JavaScript counterpart: there is no board-side equivalent of this script
to keep in step with, the same reason core/test_reports.py stands alone.
"""

import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import check_todo  # noqa: E402

FAILED = []


def check(name, got, want):
    ok = got == want
    print(("  ok  " if ok else " FAIL ") + " " + name)
    if not ok:
        FAILED.append("%s\n    got  %r\n    want %r" % (name, got, want))


TODO = """# To-do

## 1. Design System

### To do

- [ ] **Ship the button variant** [impact:: high] [effort:: M] `blocked-by:gate` `#ship`
- [ ] **Waits on a real typo** [impact:: high] [effort:: S] `blocked-by:nosuchslug`
"""

# Same shape archive_done() (kanban/server.py) actually writes: a dated
# "## Archived" section, then one "### Bucket · Tier" heading per group,
# each carrying ordinary finished task lines.
ARCHIVE = """# Finished and archived

Tasks lifted out of todo.md once they had been ticked off for more than a
month. Newest section last. Nothing here is ever deleted.

## Archived 2026-09-01

### Design System · Done

- [x] **Ship the audit gate** [impact:: high] [effort:: M] `done:2026-07-01` `#gate`
"""


def _write(tmp, path_bits, text):
    path = os.path.join(tmp, *path_bits)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
    return path


def test_blocked_by_an_archived_slug_is_not_dangling():
    tmp = tempfile.mkdtemp(prefix="check-todo-archive-")
    try:
        todo_path = _write(tmp, ("todo.md",), TODO)
        _write(tmp, ("backups", "done-archive.md"), ARCHIVE)

        archived = check_todo.archived_slugs(todo_path)
        check("the archived task's slug is read", archived, {"gate"})

        lines = TODO.splitlines()
        tasks = check_todo.parse_tasks(lines)
        findings = check_todo.check_slugs(tasks, archived)
        fixes = [f for f in findings if f.severity == "FIX"]

        check("no FIX for the slug that resolves in the archive",
              any("#gate" in str(f) for f in fixes), False)
        check("a slug that really doesn't exist anywhere is still caught",
              any("nosuchslug" in str(f) for f in fixes), True)
        check("exactly one dangling reference remains",
              len(fixes), 1)
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


def test_missing_archive_reads_as_empty_not_an_error():
    tmp = tempfile.mkdtemp(prefix="check-todo-noarchive-")
    try:
        todo_path = _write(tmp, ("todo.md",), TODO)
        # No backups/done-archive.md written at all — a brand new dataset,
        # or one that has never had anything age out yet.
        archived = check_todo.archived_slugs(todo_path)
        check("no archive on disk is an empty set, not a crash", archived, set())

        lines = TODO.splitlines()
        tasks = check_todo.parse_tasks(lines)
        findings = check_todo.check_slugs(tasks, archived)
        fixes = [f for f in findings if f.severity == "FIX"]
        check("both dangling references are caught with no archive to check",
              sorted(str(f).split("`")[1] for f in fixes if "`" in str(f)),
              sorted(["#gate", "#nosuchslug"]))
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


REUSED = """# To-do

## 1. Design System

### To do

- [ ] **Reuses an already-archived slug** [impact:: high] [effort:: M] `#gate`
"""


def test_a_live_slug_reusing_an_archived_one_is_flagged():
    tmp = tempfile.mkdtemp(prefix="check-todo-collide-")
    try:
        todo_path = _write(tmp, ("todo.md",), REUSED)
        _write(tmp, ("backups", "done-archive.md"), ARCHIVE)

        archived = check_todo.archived_slugs(todo_path)
        lines = REUSED.splitlines()
        tasks = check_todo.parse_tasks(lines)
        findings = check_todo.check_slugs(tasks, archived)
        check("a live slug already used in the archive is a CHECK, not silent",
              any("also carried by a task already in done-archive.md" in str(f)
                  for f in findings),
              True)
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


HANDOVER = """# To-do

## 1. Design System

### Doing

- [ ] **Handed over** [to:: Plan agent] `id:ab12cd`
  - [ ] Plan [to:: Plan agent] `#ab12cd-plan` `id:aa0001`
- [ ] **Tagged by hand** [to:: Plan agent] `id:ef34gh`
- [ ] **Tagged for the Implement agent** [to:: Implement agent] `id:ij56kl`
- [ ] **Tagged with no id** [to:: Plan agent]
- [x] **Tagged and done** [to:: Plan agent] `id:mn78op`
- [ ] **Bucket agent, no handover** [to:: Work and career tenon agent] `id:qr90st`
- [ ] **Bucket agent, handed over** [to:: Work and career tenon agent] `id:uv12wx`
  - [ ] Implement [to:: Work and career tenon agent] `#uv12wx-implement` `id:bb0001`
- [ ] **Bucket agent, no id** [to:: Work and career tenon agent]
"""


def test_a_tag_with_no_handover_says_the_plan_agent_will_hand_it_over():
    found = check_todo.check_handover_hygiene(HANDOVER.splitlines(), HANDOVER)
    got = sorted((f.line_no, f.severity) for f in found)
    check("each tag with no handover is a CHECK on its own line, and nothing else",
          got, [(9, "CHECK"), (10, "CHECK"), (11, "CHECK"), (13, "CHECK"), (16, "CHECK")])
    text = {f.line_no: f.message for f in found}
    check("a tag with an id says the Plan agent will ask for the handover",
          "The Plan agent asks the board to hand it over" in text.get(9, ""), True)
    check("naming the sub-task the Implement agent's handover makes",
          "`ij56kl-implement`" in text.get(10, ""), True)
    check("a tag with no id says the board gives it one first",
          "The board gives it an id" in text.get(11, ""), True)
    check("a bucket agent with no handover points at pa-bucket-setup",
          "pa-bucket-setup" in text.get(13, ""), True)
    check("a bucket agent already handed over is left alone", 14 in text, False)
    check("a bucket agent tag with no id says the board gives it one",
          "The board gives it an id" in text.get(16, ""), True)


def test_the_calendar_is_the_checked_lists():
    """A list with no memory folder of its own reads its own profile's
    holidays, never the owner's; an inheriting list keeps the owner's."""
    import datetime as dt
    import json
    import shutil
    tmp = tempfile.mkdtemp(prefix="check-todo-cal-")
    saved = os.environ.get("TODOS_DATA_ROOT")
    os.environ["TODOS_DATA_ROOT"] = tmp
    try:
        for name in ("work", "demo"):
            os.makedirs(os.path.join(tmp, name))
            open(os.path.join(tmp, name, "todo.md"), "w").close()
        with open(os.path.join(tmp, "profile.md"), "w", encoding="utf-8") as fh:
            fh.write("# PA profile\n\n## About\n\n- Holidays: UK\n")
        with open(os.path.join(tmp, "demo", "profile.md"), "w", encoding="utf-8") as fh:
            fh.write("# PA profile\n\n## About\n\n- Holidays: PT\n")
        with open(os.path.join(tmp, "settings.json"), "w", encoding="utf-8") as fh:
            json.dump({"boards": {"demo": {"memory_root": None}}}, fh)
        portugal_day, bank_holiday = dt.date(2026, 6, 10), dt.date(2026, 8, 31)
        check_todo.use_board(os.path.join(tmp, "work", "todo.md"))
        check("an inheriting list keeps the owner's calendar",
              (bool(check_todo.working_day_problem(portugal_day)), bool(check_todo.working_day_problem(bank_holiday))),
              (False, True))
        check_todo.use_board(os.path.join(tmp, "demo", "todo.md"))
        check("a list kept apart reads its own profile's calendar",
              (bool(check_todo.working_day_problem(portugal_day)), bool(check_todo.working_day_problem(bank_holiday))),
              (True, False))
    finally:
        check_todo.REGIONS = None
        if saved is None:
            os.environ.pop("TODOS_DATA_ROOT", None)
        else:
            os.environ["TODOS_DATA_ROOT"] = saved
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    test_the_calendar_is_the_checked_lists()
    test_a_tag_with_no_handover_says_the_plan_agent_will_hand_it_over()
    test_blocked_by_an_archived_slug_is_not_dangling()
    test_missing_archive_reads_as_empty_not_an_error()
    test_a_live_slug_reusing_an_archived_one_is_flagged()
    print()
    if FAILED:
        for f in FAILED:
            print("FAIL " + f)
        print("%d failed" % len(FAILED))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
