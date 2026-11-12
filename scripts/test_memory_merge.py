#!/usr/bin/env python3
"""Proof that scripts/memory_merge.py moves, removes and backs up what it says
and leaves the rest alone. Temp data root and temp memory folder only.
    python3 scripts/test_memory_merge.py
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "memory_merge.py")
fails = []


def check(name, ok, detail=""):
    print("  %s %s%s" % ("ok  " if ok else "FAIL", name, " - " + detail if detail and not ok else ""))
    if not ok:
        fails.append(name)


def put(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


def get(path):
    with open(path, encoding="utf-8", newline="") as fh:
        return fh.read()


def snapshot(*roots):
    out = {}
    for r in roots:
        for d, _, fs in os.walk(r):
            for f in fs:
                p = os.path.join(d, f)
                out[p] = hashlib.sha256(open(p, "rb").read()).hexdigest()
    return out


def run(root, *args):
    return subprocess.run([sys.executable, SCRIPT, "--data-root", root] + list(args),
                          capture_output=True, text=True)


TODO = "# To-do\n\n## 1. Work\n\n### To do\n\n- [ ] **A task** `id:aaaaaa`\n\n"
CTX = "## Context\n\nAna is away.\n\n### How I want messages written\n\nShort.\n"

with tempfile.TemporaryDirectory() as tmp:
    root, mem, own = (os.path.join(tmp, n) for n in ("data", "MEMORY", "OWN"))
    for d in (root, mem, own):
        os.makedirs(d)
    put(os.path.join(root, "settings.json"), json.dumps(
        {"memory_root": mem, "boards": {"solo": {"memory_root": None}, "apart": {"memory_root": own}}}))
    # moves: only in data/ (people), a section moved to context.md
    put(os.path.join(root, "moves", "todo.md"), TODO + CTX)
    put(os.path.join(root, "moves", "people.md"), "# People\n")
    # same in both, and only in memory
    put(os.path.join(root, "same", "todo.md"), TODO)
    put(os.path.join(root, "same", "about.md"), "Studio.\n")
    put(os.path.join(mem, "bench", "same", "about.md"), "Studio.\n")
    put(os.path.join(mem, "bench", "same", "people.md"), "# Mem people\n")
    # different in both, and a section that differs from context.md
    put(os.path.join(root, "differ", "todo.md"), TODO + CTX)
    put(os.path.join(root, "differ", "about.md"), "Data version\n")
    put(os.path.join(mem, "bench", "differ", "about.md"), "Memory version\n")
    put(os.path.join(mem, "bench", "differ", "context.md"), "Something else\n")
    # a section equal to context.md, with a hidden board
    put(os.path.join(root, "_hidden", "todo.md"), CTX + "\n## 1. Work\n\n### To do\n")
    put(os.path.join(mem, "bench", "_hidden", "context.md"), "Ana is away.\n\n### How I want messages written\n\nShort.\n")
    # null memory, own memory with a board profile
    put(os.path.join(root, "solo", "todo.md"), TODO + CTX)
    put(os.path.join(root, "solo", "people.md"), "# Solo\n")
    put(os.path.join(root, "apart", "todo.md"), TODO)
    put(os.path.join(root, "apart", "profile.md"), "# Own profile\n")
    # hidden boards: no folder by default, and one that already has a folder
    put(os.path.join(root, "_demo", "todo.md"), TODO + CTX)
    put(os.path.join(root, "_demo", "people.md"), "# Demo\n")
    put(os.path.join(root, "_kept", "todo.md"), TODO)
    put(os.path.join(root, "_kept", "people.md"), "# Kept\n")
    os.makedirs(os.path.join(mem, "bench", "_kept"))
    # an empty Context section
    put(os.path.join(root, "empty", "todo.md"), TODO + "## Context\n\n")
    # global profile
    put(os.path.join(root, "profile.md"), "# Profile\n")
    put(os.path.join(mem, "me", "profile.md"), "# Profile\n")

    print("dry run")
    before = snapshot(tmp)
    r = run(root)
    check("exits 0", r.returncode == 0, r.stderr)
    check("changes nothing", snapshot(tmp) == before)
    out = r.stdout
    for want in ("only in data/ -> would move", "only in memory -> nothing to do",
                 "same in both -> would remove data/ copy", "different in both -> needs a decision",
                 "no memory folder, skipped", "would move to context.md and remove from todo.md",
                 "same as context.md -> would remove from todo.md", "-Memory version", "+Data version"):
        check("says: " + want, want in out, out)
    check("finds the hidden board", "_hidden" in out)
    check("a hidden board with no memory folder is skipped", re.search(r"_demo\n  no memory folder, skipped", out) is not None, out)
    check("an empty Context section is left alone", "empty -> left alone" in out, out)
    r = run(root, "--apply")
    check("--apply alone is refused", r.returncode != 0 and "Stop the board" in r.stdout and snapshot(tmp) == before)

    print("apply")
    r = run(root, "--apply", "--yes")
    check("exits 0", r.returncode == 0, r.stdout + r.stderr)
    backups = os.path.join(root, "backups")
    dirs = os.listdir(backups) if os.path.isdir(backups) else []
    check("one backup folder, named in the output", len(dirs) == 1 and dirs[0] in r.stdout, str(dirs))
    bk = os.path.join(backups, dirs[0]) if dirs else ""
    check("backup holds the original people.md", get(os.path.join(bk, "moves", "people.md")) == "# People\n")
    check("and the original todo.md", get(os.path.join(bk, "moves", "todo.md")) == TODO + CTX)
    check("and the same-in-both copy", get(os.path.join(bk, "same", "about.md")) == "Studio.\n")
    check("but nothing for a board it left", not os.path.exists(os.path.join(bk, "differ", "about.md"))
          and not os.path.exists(os.path.join(bk, "solo")))
    check("people.md moved", get(os.path.join(mem, "bench", "moves", "people.md")) == "# People\n"
          and not os.path.exists(os.path.join(root, "moves", "people.md")))
    check("context.md written from the section",
          get(os.path.join(mem, "bench", "moves", "context.md")) == CTX.split("\n", 2)[2].strip() + "\n")
    check("todo.md loses only the section", get(os.path.join(root, "moves", "todo.md")) == TODO.rstrip("\n") + "\n"
          or get(os.path.join(root, "moves", "todo.md")) == TODO.rstrip("\n"), repr(get(os.path.join(root, "moves", "todo.md"))))
    check("same-in-both data/ copy removed", not os.path.exists(os.path.join(root, "same", "about.md"))
          and get(os.path.join(mem, "bench", "same", "about.md")) == "Studio.\n")
    check("only-in-memory file untouched", get(os.path.join(mem, "bench", "same", "people.md")) == "# Mem people\n")
    check("different about.md untouched in both places",
          get(os.path.join(root, "differ", "about.md")) == "Data version\n"
          and get(os.path.join(mem, "bench", "differ", "about.md")) == "Memory version\n")
    check("differing section left in todo.md", get(os.path.join(root, "differ", "todo.md")) == TODO + CTX)
    check("and listed at the end", "Left for you" in r.stdout and "differ" in r.stdout.split("Left for you")[1])
    check("a section equal to context.md is removed, the next heading kept",
          get(os.path.join(root, "_hidden", "todo.md")) == "\n## 1. Work\n\n### To do\n"
          or get(os.path.join(root, "_hidden", "todo.md")) == "## 1. Work\n\n### To do\n",
          repr(get(os.path.join(root, "_hidden", "todo.md"))))
    check("null-memory board untouched", get(os.path.join(root, "solo", "people.md")) == "# Solo\n"
          and get(os.path.join(root, "solo", "todo.md")) == TODO + CTX)
    check("hidden board with no folder untouched", get(os.path.join(root, "_demo", "people.md")) == "# Demo\n"
          and get(os.path.join(root, "_demo", "todo.md")) == TODO + CTX
          and not os.path.exists(os.path.join(mem, "bench", "_demo")))
    check("hidden board with a folder already there is merged",
          get(os.path.join(mem, "bench", "_kept", "people.md")) == "# Kept\n")
    check("empty section: todo.md kept, no context.md", get(os.path.join(root, "empty", "todo.md")) == TODO + "## Context\n\n"
          and not os.path.exists(os.path.join(mem, "bench", "empty", "context.md")))
    check("global profile, same in both, removed from data/", not os.path.exists(os.path.join(root, "profile.md")))
    check("a board's own profile moved to its memory folder",
          get(os.path.join(own, "me", "profile.md")) == "# Own profile\n"
          and not os.path.exists(os.path.join(root, "apart", "profile.md")))
    r = run(root)
    check("a second dry run finds nothing left to move",
          "would move" not in r.stdout and "would remove" not in r.stdout, r.stdout)

print("\n%s" % ("all passed" if not fails else "%d FAILED: %s" % (len(fails), ", ".join(fails))))
sys.exit(1 if fails else 0)
