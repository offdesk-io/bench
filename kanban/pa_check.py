"""The second check on a PA reply's changes, on the shared board.

Anyone on a shared board can write a card, and the PA reads cards. So before
the asker's tab applies a reply's pa-changes block, the server decides whether
it applies straight away or waits for the person to accept it.

Rules first, which cost nothing. A reply waits when it changes more than
`auto_max` cards, when it changes a card the person's words do not name as
a whole word or title (the focused card counts as named), or when it adds
more than one card or a card whose title shares no word with what they typed. Then a cheap model sees the person's own
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
# Words too common to tie a new card to what the person typed.
COMMON = {"this", "that", "these", "those", "with", "from", "into", "about", "what", "when",
          "which", "there", "their", "have", "will", "would", "could", "should", "week",
          "today", "tomorrow", "please", "card", "cards", "task", "tasks", "board", "list",
          "make", "need", "next", "some", "them", "they", "your", "mine", "just", "also"}

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


def _says(words, text):
    """Whether `text` appears in `words` as a whole, not inside a longer word
    or id: "1" is not named by "card 12", nor "Book the venue" by "booking"."""
    return bool(re.search(r"(?<![\w-])" + re.escape(text) + r"(?![\w-])", words))


def _mentions(words, title):
    """Whether the words share a real word (four letters or more) with a new
    card's title: "add a card for the badges" for "Order event badges"."""
    return any(_says(words, w) for w in re.findall(r"\w{4,}", title.lower()) if w not in COMMON)


def _rules(ask, edits, focus, auto_max):
    touched = []
    for item in edits:
        r = _ref(item)
        if r and r not in touched:
            touched.append(r)
    if len(touched) > auto_max:
        return "it changes %d cards, more than %d" % (len(touched), auto_max)
    adds = [item for item in edits if item.get("kind") == "add"]
    if len(adds) > 1:
        return "it adds %d new cards, and only one is added without asking" % len(adds)
    words = ask.lower()
    named = {f.strip().lower() for f in focus if f and f.strip()}
    for item in edits:
        r = _ref(item)
        if item.get("kind") == "add":
            if not r or not _mentions(words, r):
                return 'it adds "%s", which the question does not mention' % (r or "a card")
            continue
        if not r or (r.lower() not in named and not _says(words, r.lower())):
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
