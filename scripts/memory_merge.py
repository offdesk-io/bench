#!/usr/bin/env python3
"""Move what a board keeps in data/ into its memory folder.

    python3 scripts/memory_merge.py [--data-root DIR]            # report, change nothing
    python3 scripts/memory_merge.py [--data-root DIR] --apply --yes

For every board under the data root (a folder holding a todo.md, hidden _ ones
included) whose memory folder exists, it compares people.md, about.md and
context.md in data/<board>/ with <memory>/bench/<board>/, the `## Context`
section still inside todo.md with context.md, and the profiles with the
`me/profile.md` they would be read from instead. Each pair is one of four
things: only in data/ (moved), only in memory (nothing to do), the same in both
(the data/ copy is removed), or different (left alone, listed for the owner).

--apply copies every data/ file it is about to change into
data/backups/memory-merge-<UTC time>/, keeping its path, before it touches
anything. Stop the board first: a tab open on the list autosaves todo.md, and
that save would put the Context section back. Stdlib plus Bench's own
core/settings.py, which says where each board's memory folder is.
"""
import argparse
import datetime
import difflib
import os
import re
import shutil
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "core"))
import settings  # noqa: E402

FILES = ("people", "about", "context")
CONTEXT_RE = re.compile(r"^##\s+context\s*$", re.I)
NEXT_RE = re.compile(r"^##\s")


def read(path):
    try:
        with open(path, encoding="utf-8", newline="") as fh:
            return fh.read()
    except OSError:
        return None


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)
    os.replace(tmp, path)


def context_span(lines):
    """(at, end) of the `## Context` section in a todo.md's lines, else None.
    The body runs to the next `## ` heading, so `### ` subsections stay in."""
    for at, line in enumerate(lines):
        if CONTEXT_RE.match(line.rstrip("\r\n")):
            end = len(lines)
            for i in range(at + 1, len(lines)):
                if NEXT_RE.match(lines[i]):
                    end = i
                    break
            return at, end
    return None


def without_section(text):
    lines = text.splitlines(keepends=True)
    at, end = context_span(lines)
    if end >= len(lines):
        while at > 0 and lines[at - 1].strip() == "":
            at -= 1
    return "".join(lines[:at] + lines[end:])


def section_text(text):
    lines = text.splitlines(keepends=True)
    span = context_span(lines)
    if not span:
        return None
    return "".join(lines[span[0] + 1:span[1]]).strip()


def boards_in(root):
    out = []
    for name in sorted(os.listdir(root)):
        if name.startswith("."):
            continue
        if os.path.isfile(os.path.join(root, name, "todo.md")):
            out.append(name)
    return out


def short_diff(a, b, la, lb, limit=14):
    lines = list(difflib.unified_diff(a.splitlines(), b.splitlines(), la, lb, lineterm="", n=1))
    more = len(lines) - limit
    return lines[:limit] + (["... %d more lines" % more] if more > 0 else [])


def plan_pair(label, src, dst, rel_src):
    """One data/ file against its memory twin. A step is a dict with `do`:
    move, remove, keep (nothing to do) or decide."""
    a, b = read(src), read(dst)
    if a is None and b is None:
        return None
    if b is None:
        return {"label": label, "do": "move", "src": src, "dst": dst, "rel": rel_src,
                "say": "only in data/ -> would move"}
    if a is None:
        return {"label": label, "do": "keep", "say": "only in memory -> nothing to do"}
    if a == b:
        return {"label": label, "do": "remove", "src": src, "rel": rel_src,
                "say": "same in both -> would remove data/ copy"}
    return {"label": label, "do": "decide", "say": "different in both -> needs a decision",
            "diff": short_diff(b, a, "memory", "data")}


def plan(root):
    """[(heading, [step, ...])] for every board, and the global profile."""
    out = []
    memory = settings.memory_root(root)
    if memory:
        steps = [plan_pair("profile.md", os.path.join(root, "profile.md"),
                           os.path.join(memory, "me", "profile.md"), "profile.md")]
        out.append(("the owner's profile", [s for s in steps if s]))
    for board in boards_in(root):
        folder = settings.board_memory_root(board, root)
        if not folder:
            out.append((board, [{"label": "", "do": "skip",
                                 "say": "no memory folder, skipped"}]))
            continue
        base = os.path.join(folder, "bench", board)
        steps = []
        for name in FILES:
            s = plan_pair(name + ".md", os.path.join(root, board, name + ".md"),
                          os.path.join(base, name + ".md"), os.path.join(board, name + ".md"))
            if s:
                steps.append(s)
        if not settings.inherits_memory(board, root):
            s = plan_pair("profile.md", os.path.join(root, board, "profile.md"),
                          os.path.join(folder, "me", "profile.md"), os.path.join(board, "profile.md"))
            if s:
                steps.append(s)
        todo_path = os.path.join(root, board, "todo.md")
        body = section_text(read(todo_path) or "")
        if body is not None:
            there = read(os.path.join(base, "context.md"))
            if there is None:
                there = read(os.path.join(root, board, "context.md"))  # about to move
            label = "## Context in todo.md"
            rel = os.path.join(board, "todo.md")
            if there is None:
                steps.append({"label": label, "do": "section", "todo": todo_path, "rel": rel,
                              "dst": os.path.join(base, "context.md"), "body": body,
                              "say": "only in todo.md -> would move to context.md and remove from todo.md"})
            elif there.strip() == body:
                steps.append({"label": label, "do": "section", "todo": todo_path, "rel": rel,
                              "dst": None, "body": body,
                              "say": "same as context.md -> would remove from todo.md"})
            else:
                steps.append({"label": label, "do": "decide",
                              "say": "different from context.md -> needs a decision",
                              "diff": short_diff(there.strip(), body, "context.md", "todo.md")})
        out.append((board, steps))
    return out


def report(groups, apply):
    for heading, steps in groups:
        print("\n%s" % heading)
        for s in steps:
            print("  %s%s" % (s["label"] + ": " if s["label"] else "", s["say"]))
            for line in s.get("diff", []):
                print("      " + line)


def backup(root, groups, stamp):
    dest = os.path.join(root, "backups", "memory-merge-" + stamp)
    seen = set()
    for _, steps in groups:
        for s in steps:
            rel = s.get("rel")
            if s["do"] in ("move", "remove", "section") and rel and rel not in seen:
                seen.add(rel)
                src = os.path.join(root, rel)
                os.makedirs(os.path.dirname(os.path.join(dest, rel)), exist_ok=True)
                shutil.copy2(src, os.path.join(dest, rel))
    return dest, len(seen)


def apply_steps(groups):
    for _, steps in groups:
        for s in steps:
            if s["do"] == "move":
                os.makedirs(os.path.dirname(s["dst"]), exist_ok=True)
                shutil.copy2(s["src"], s["dst"])
                os.remove(s["src"])
            elif s["do"] == "remove":
                os.remove(s["src"])
            elif s["do"] == "section":
                if s["dst"]:
                    write(s["dst"], s["body"] + "\n")
                write(s["todo"], without_section(read(s["todo"])))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--data-root", help="default: Bench's data folder (TODOS_DATA_ROOT or <bench>/data)")
    ap.add_argument("--apply", action="store_true", help="make the changes, after backing up")
    ap.add_argument("--yes", action="store_true", help="confirm --apply, with the board stopped")
    args = ap.parse_args(argv)
    root = os.path.abspath(args.data_root or settings.data_root())
    if not os.path.isdir(root):
        print("No data folder at %s" % root)
        return 2
    if args.apply and not args.yes:
        print("Stop the board first: an open tab autosaves todo.md and would put the Context\n"
              "section back. Then run again with --apply --yes.")
        return 2
    groups = plan(root)
    report(groups, args.apply)
    steps = [s for _, g in groups for s in g]
    if not args.apply:
        print("\nDry run: nothing changed. Add --apply --yes, with the board stopped, to make these moves.")
        return 0
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dest, n = backup(root, groups, stamp)
    apply_steps(groups)
    print("\nDone. %d file(s) backed up to %s" % (n, dest))
    left = [(h, s) for h, g in groups for s in g if s["do"] == "decide"]
    if left:
        print("\nLeft for you, different in both:")
        for h, s in left:
            print("  %s: %s" % (h, s["label"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
