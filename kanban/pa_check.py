"""The second check on a PA reply's changes, on the shared board.

Anyone on a shared board can write a card, and the PA reads cards. So before
the asker's tab applies a reply's pa-changes block, the server decides whether
it applies straight away or waits for the person to accept it.

Two rules first, which cost nothing: a reply changing more than
`auto_max` cards, or changing a card the person's words do not name (the
focused card counts as named), waits. Then a cheap model sees the person's own
words and the proposed changes, never any card text, and answers whether the
person asked for them. Anything but a plain yes waits, and so does a failed
check. See docs/superpowers/specs/2026-11-04-server-chat-api-design.md, §6.
"""

import json
import re
import shutil
import subprocess
import tempfile

BLOCK = re.compile(r"```pa-changes[^\n]*\n([\s\S]*?)```")
ACTION_KINDS = ("open", "view", "filter")
NO_TOOLS = ["Bash", "Edit", "Write", "NotebookEdit", "Task", "Read", "Grep", "Glob",
            "WebFetch", "WebSearch"]
MODEL = "haiku"

PROMPT = """You check changes that an assistant proposes to make to a to-do board.
You see only what the person typed and the proposed changes, nothing from the board.
Decide whether the person asked for these changes: every change must follow from their words.
Reply with one line only: "yes", or "no: <short reason>".

What the person typed:
<<<
{ask}
>>>

The proposed changes, as JSON:
<<<
{changes}
>>>"""


def changes_in(text):
    """The last pa-changes block's list: [] when there is none, None when it
    cannot be read. The same reading as paChangesFromReply() in the board."""
    bodies = BLOCK.findall(str(text or ""))
    if not bodies:
        return []
    try:
        data = json.loads(bodies[-1])
    except ValueError:
        return None
    if isinstance(data, dict) and isinstance(data.get("changes"), list):
        data = data["changes"]
    return data if isinstance(data, list) else None


def _edits(items):
    return [i for i in items if isinstance(i, dict) and str(i.get("kind") or "") not in ACTION_KINDS]


def _ref(item):
    return str(item.get("task") or item.get("step") or item.get("title") or "").strip()


def _rules(ask, edits, focus, auto_max):
    touched = []
    for item in edits:
        r = _ref(item)
        if r and r not in touched:
            touched.append(r)
    if len(touched) > auto_max:
        return "it changes %d cards, more than %d" % (len(touched), auto_max)
    words = ask.lower()
    named = {f.strip().lower() for f in focus if f and f.strip()}
    for item in edits:
        if item.get("kind") == "add":
            continue
        r = _ref(item)
        if not r or (r.lower() not in named and r.lower() not in words):
            return 'it changes "%s", which the question does not name' % (r or "a card")
    return None


def ask_model(prompt, binary, timeout=60):
    """(first line of the answer, cost) from one claude run with no tools,
    in an empty folder. Raises on any failure."""
    cwd = tempfile.mkdtemp(prefix="pa-check-")
    try:
        done = subprocess.run(
            [binary, "-p", prompt, "--model", MODEL, "--output-format", "json",
             "--permission-mode", "dontAsk", "--disallowedTools"] + NO_TOOLS,
            cwd=cwd, stdin=subprocess.DEVNULL, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=timeout)
        got = json.loads(done.stdout)
        if not isinstance(got, dict):
            raise ValueError("the check did not answer with a JSON object")
        cost = got.get("total_cost_usd") or 0
        if isinstance(cost, bool) or not isinstance(cost, (int, float)):
            raise ValueError("the check's cost was not a number")
        return str(got.get("result") or ""), float(cost)
    finally:
        shutil.rmtree(cwd, ignore_errors=True)


def verdict(ask, items, focus, auto_max, run):
    """{"hold": bool, "why": str, "cost": float}. `run(prompt)` returns
    (answer, cost); the server passes ask_model, a test passes a fake."""
    ask = str(ask or "")
    if items is None:
        return {"hold": True, "why": "the pa-changes block could not be read", "cost": 0.0}
    edits = _edits(items)
    if not edits:
        return {"hold": False, "why": "", "cost": 0.0}
    if not ask.strip():
        return {"hold": True, "why": "the question was not sent with the run", "cost": 0.0}
    why = _rules(ask, edits, list(focus or []), auto_max)
    if why:
        return {"hold": True, "why": why, "cost": 0.0}
    try:
        answer, cost = run(PROMPT.format(ask=ask, changes=json.dumps(edits, ensure_ascii=False, indent=1)))
    except (OSError, ValueError, subprocess.SubprocessError):
        return {"hold": True, "why": "the check could not run", "cost": 0.0}
    first = (answer.strip().splitlines() or [""])[0].strip()
    if first.lower().rstrip(".") == "yes":
        return {"hold": False, "why": "", "cost": cost}
    reason = re.sub(r"^no\s*[:,-]?\s*", "", first, flags=re.I) or "the check did not confirm it"
    return {"hold": True, "why": reason, "cost": cost}
