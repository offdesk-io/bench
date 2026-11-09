"""Chats on the shared board: the signed-in counterpart of ChatEndpoints.

Same method names and return shapes as ai_chat_engine's http_glue.ChatEndpoints,
so kanban/server.py's chat routes call either one. What it adds, from
docs/superpowers/specs/2026-11-04-server-chat-api-design.md:

  * every run is Ask mode (write and work are refused with 403);
  * the prompt opens with who asked and on which board (§4);
  * a PA chat is filed under a key of its asker's own, board-pa-<hash>, and
    only they see it or read it back; card chats stay shared (§4);
  * a chat over the day's limits is refused with 429, and every run's cost,
    the check's included, is added to the ledger (§5, chat_spend.py);
  * a PA reply with changes gets a verdict (§6, pa_check.py), sent as one
    more stream line and kept for /claude/pa-check.json.

Imported by server.py only once ai_chat_engine is on sys.path.
"""

import hashlib
import json
import os
import re
import threading

import chat_spend
import pa_check
from engine import MAX_PROMPT, MAX_TITLE, OWNER_KEY, SESSION_ID, RunLimitError, transcript_read

PA_KEY = "board-pa"
# Added to the engine's ASK_DENIES, never instead of it.
EXTRA_DENIES = ["WebFetch", "WebSearch"]
KEEP_VERDICTS = 200
# claude -p runs a prompt as a slash command only when it starts with one.
COMMAND = re.compile(r"^(/[\w:-]+)(?=\s|$)\s*")
MAX_NAME = 60


def normal_email(email):
    return str(email or "").strip().lower()


def person_key(email):
    return PA_KEY + "-" + hashlib.sha256(normal_email(email).encode("utf-8")).hexdigest()[:12]


def asked_by(name, board):
    name = " ".join(re.sub(r'["()]', "", str(name or "")).split())[:MAX_NAME].strip() or "someone"
    return '(Asked by %s on the shared board "%s".)' % (name, board)


def with_asker(line, words):
    """The asked-by line in front of the words, or just after the command
    when the words start with one, so "/pa ..." still runs the PA."""
    m = COMMAND.match(words)
    if not m:
        return line + "\n\n" + words
    rest = words[m.end():]
    return m.group(1) + " " + line + ("\n\n" + rest if rest else "")


def _within(path, folder):
    return path == folder or path.startswith(folder.rstrip(os.sep) + os.sep)


def read_allows(root, data_root, board_dir, homes):
    """Read rules for what a run may read outside its board's folder: the PA's
    instructions, and any project folder the board keeps elsewhere. A folder
    broad enough to hold the board, the data root or the checkout, or one
    inside the data root (another board's), is left out with a warning."""
    board = os.path.realpath(board_dir)
    data = os.path.realpath(data_root)
    checkout = os.path.realpath(root)
    broad = {os.path.realpath(os.sep), os.path.realpath(os.path.expanduser("~"))}
    folders = [os.path.realpath(os.path.join(checkout, "agents", "pa_agent"))]
    for home in homes:
        real = os.path.realpath(home)
        if _within(real, board) or real in folders:
            continue
        if real in broad or _within(board, real) or _within(data, real) or _within(checkout, real) \
                or _within(real, data):
            print("shared chat: chats on %s may not read %s, it is too broad or inside the data"
                  % (os.path.basename(board), real))
            continue
        folders.append(real)
    # `//` makes a permission-rule path absolute.
    return ["Read(/%s/**)" % f.rstrip("/") for f in folders]


class SharedChat:
    def __init__(self, engine, board, who, spend_path, fences_path, check=None):
        self.engine = engine
        self.board = board
        self.who = who
        self.spend_path = spend_path
        self.fences_path = fences_path
        self.check = check or (lambda prompt: pa_check.ask_model(prompt, self.engine.binary()))
        self.verdicts = {}
        self.lock = threading.Lock()

    def _email(self):
        return normal_email(self.who()["email"])

    def guard_ok(self, handler):
        return handler.headers.get("X-Board") == "1"

    # ---- keys ----

    def _key(self, owner):
        """The stored key for an owner the board names: the asker's own for the
        PA, the same for anything else, None for a key nobody may name."""
        owner = str(owner or "")
        if owner == PA_KEY:
            return person_key(self.who()["email"])
        if owner.startswith(PA_KEY):
            return None
        return owner

    def _visible(self):
        mine = person_key(self.who()["email"])
        out = {}
        for owner, rows in self.engine.sessions.read().items():
            if owner == mine:
                out[PA_KEY] = rows
            elif not owner.startswith(PA_KEY):
                out[owner] = rows
        return out

    def _row(self, session_id):
        for rows in self._visible().values():
            for row in rows:
                if row.get("id") == session_id:
                    return row
        return None

    # ---- GETs ----

    def status(self):
        return self.engine.status()

    def sessions(self):
        return {"chats": self._visible()}

    def transcript(self, session_id, cwd):
        if not SESSION_ID.match(session_id or ""):
            return None, {"error": "not a session id"}
        row = self._row(session_id)
        if not row:
            return None, {"error": "no such conversation on this board"}
        got = transcript_read(session_id, row.get("cwd") or "")
        if got is None:
            return None, {"error": "no transcript on disk for that session"}
        return got, None

    def attachable(self, query=None):
        return {"sessions": []}

    def pa_check(self, session_id):
        with self.lock:
            v = self.verdicts.get(session_id or "")
        if not v or v["email"] != self._email():
            return None, {"error": "no check for that conversation"}
        return {"hold": v["hold"], "why": v["why"], "items": v["items"]}, None

    # ---- POSTs ----

    def forget(self, owner, session_id):
        key = self._key(owner)
        if not key or not OWNER_KEY.match(key) or not SESSION_ID.match(session_id or ""):
            return None, {"error": "bad owner or session id"}
        return {"ok": self.engine.sessions.forget(key, session_id)}, None

    def assign(self, owner, session_id, to_owner):
        key, to = self._key(owner), self._key(to_owner)
        if not key or not to or not OWNER_KEY.match(key) or not OWNER_KEY.match(to):
            return None, {"error": "bad owner key"}
        # Into the asker's private PA chats only from there: a card's chat is
        # everyone's on the board, and hiding it would take it from them.
        if str(to_owner) == PA_KEY and str(owner) != PA_KEY:
            return None, {"error": "a card's chat cannot be made a private PA chat"}
        if not SESSION_ID.match(session_id or ""):
            return None, {"error": "not a session id"}
        return {"ok": self.engine.sessions.assign(key, session_id, to)}, None

    def note(self, owner, session_id, prompt):
        key = self._key(owner)
        if not key or not OWNER_KEY.match(key) or not SESSION_ID.match(session_id or ""):
            return None, {"error": "bad owner or session id"}
        return {"ok": self.engine.sessions.set_prompt(key, session_id, str(prompt or "")[:MAX_PROMPT])}, None

    def attach(self, owner, session_id, cwd, title):
        return None, {"error": "attaching a session is not on the shared board"}

    def stream(self, handler, payload):
        if not isinstance(payload, dict):
            return 400, {"error": "the body must be a JSON object"}
        who = self.who()
        email = normal_email(who["email"])
        mode = payload.get("mode") or "ask"
        if mode != "ask":
            return 403, {"error": "chats on the shared board only read"}
        why = chat_spend.refusal(self.spend_path, self.fences_path, email)
        if why:
            return 429, {"error": why}
        words = str(payload.get("prompt") or "").strip()
        if not words:
            return 400, {"error": "no prompt"}
        prompt = with_asker(asked_by(who["name"], self.board), words)
        if len(prompt) > MAX_PROMPT:
            return 413, {"error": "prompt too long"}
        asked_for = str(payload.get("owner") or payload.get("chat") or "")
        owner = self._key(asked_for)
        if owner is None:
            return 400, {"error": "bad owner key"}
        owner = owner if OWNER_KEY.match(owner) else ""
        session = str(payload.get("session") or "")
        session = session if SESSION_ID.match(session) else ""
        if session and not self._row(session):
            return 404, {"error": "no such conversation on this board"}
        title = str(payload.get("title") or words).strip().replace("\n", " ")[:MAX_TITLE]

        try:
            gen = self.engine.run(prompt, "ask", session, owner, title)
        except RunLimitError as err:
            return 429, {"error": str(err)}
        except PermissionError as err:
            return 403, {"error": str(err)}
        except RuntimeError as err:
            return 501, {"error": str(err)}

        # A verdict kept from an earlier turn must never answer for this one.
        self._drop(session)
        handler.send_response(200)
        handler.send_header("Content-Type", "application/x-ndjson")
        handler.end_headers()
        reply, cost, sid = "", 0.0, session
        listening = [True]

        def send(line):
            # A closed tab stops the writing, not the run: the result line and
            # its cost still have to come, and the verdict is kept for a reload.
            if not listening[0]:
                return
            try:
                handler.wfile.write((line + "\n").encode())
                handler.wfile.flush()
            except OSError:
                listening[0] = False

        try:
            for line in gen:
                if '"type":"result"' in line or '"subtype":"init"' in line:
                    try:
                        row = json.loads(line)
                    except ValueError:
                        row = {}
                    row = row if isinstance(row, dict) else {}
                    got_sid = str(row.get("session_id") or "")
                    if got_sid and got_sid != sid:
                        sid = got_sid
                        self._drop(sid)
                    if row.get("type") == "result":
                        reply = row.get("result") if isinstance(row.get("result"), str) else ""
                        got = row.get("total_cost_usd")
                        cost = float(got) if isinstance(got, (int, float)) and not isinstance(got, bool) else 0.0
                send(line)
            if asked_for == PA_KEY and sid:
                v = self._verdict(payload, reply)
                if v is not None:
                    cost += v["cost"]
                    self._keep(sid, email, v)
                    send(json.dumps({"type": "board_pa_check", "hold": v["hold"], "why": v["why"]}))
        finally:
            chat_spend.add(self.spend_path, email, cost)
            gen.close()
        return None

    def _verdict(self, payload, reply):
        items = pa_check.changes_in(reply)
        if items == []:
            return None
        try:
            focus = [str(f) for f in (payload.get("focus") or []) if isinstance(f, str)][:4]
            most = chat_spend.limits(self.fences_path)["auto_apply_max"]
            v = pa_check.verdict(str(payload.get("words") or ""), items, focus, most, self.check)
        except Exception:  # noqa: BLE001  (any failure of the check holds the changes)
            v = {"hold": True, "why": "the check could not run", "cost": 0.0}
        v["items"] = items or []
        return v

    def _drop(self, sid):
        if sid:
            with self.lock:
                self.verdicts.pop(sid, None)

    def _keep(self, sid, email, v):
        with self.lock:
            self.verdicts.pop(sid, None)
            self.verdicts[sid] = dict(v, email=email)
            while len(self.verdicts) > KEEP_VERDICTS:
                self.verdicts.pop(next(iter(self.verdicts)))
