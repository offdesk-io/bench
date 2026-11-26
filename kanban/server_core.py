"""The routes the Offdesk core's tools call, under /offdesk/, for kanban/server.py.

bench_mcp (mcp/) calls these on loopback with the core's signed token as
`Authorization: Bearer`, checked by core/core_token.py. They are the only
routes that read the token: kanban/server.py sends every /offdesk/ request here
before its own sign-in check, and no other route looks at the header, so the
board's own sign-in is unchanged.

    GET  /offdesk/boards.json                          the boards the token's identity may see
    GET  /offdesk/tasks.json?board=&column=&bucket=&due_by=&done=
    GET  /offdesk/task.json?board=&id=                 one task, its notes and sub-tasks
    POST /offdesk/add   {board, title, bucket?, column?, due?, refs?}
    POST /offdesk/tick  {board, sub}

Reads parse the board's todo.md with core/todo.py. Writes never touch it: an
add goes into the board's add-queue.json (core/add_queue.py) and a tick into
its tick-queue.json (core/tick_queue.py), and the board applies both when it
next loads, through its own edit path. Both are checked here first, so what is
queued is what the board can apply: a tick only for a sub-task assigned to
whoever the token acts for (`[to::]` the person's email, or `agent:<name>`), or
for one with no `[to::]` (the owner's own) when the board's owner asks through
the PA (`owner: true` on the entry), an
add only into To do, Backlog or another column the bucket has that is not
Doing, Reviewing or Done (CONVENTIONS.md: nothing goes there on the owner's
behalf).

A board the identity may not see answers exactly as one that does not exist.
"""

import os
import re

import add_queue
import board_access
import core_token
import tick_queue
import todo

# Columns nothing but the owner moves a task into (CONVENTIONS.md, States).
OWNER_ONLY = ("Doing", "Reviewing", "Done")
# Columns the board makes when a bucket lacks them (ensureTier()).
ALWAYS = ("To do", "Backlog")
NO_BOARD = "no such board that you can see; bench.boards lists them"
MAX_TITLE = 200
MAX_REFS = 10
MAX_NOTES = 40
STEP_ID_RE = re.compile(r"^[a-z0-9]{6}$")
ADD_KEYS = {"board", "title", "bucket", "column", "due", "refs"}


class Refused(Exception):
    def __init__(self, code, message):
        Exception.__init__(self, message)
        self.code = code


def identify(headers, key, now=None):
    """The token's identity, or (status, body) to refuse with."""
    raw = headers.get("Authorization") or ""
    if not raw.startswith("Bearer "):
        return None, (401, {"error": "the Offdesk core's token is needed here"})
    try:
        claims = core_token.verify(key, raw[len("Bearer "):].strip(), now=now)
    except core_token.TokenError as e:
        return None, (401, {"error": "token refused: %s" % e})
    who = core_token.identity(claims)
    if who is None:
        return None, (401, {"error": "token refused: it names nobody Bench knows"})
    return who, None


def _read(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return None


def buckets_of(text):
    """[{name, columns}] in file order, each bucket's columns as the board draws
    them (the file holds them the other way round, Done first)."""
    out = []
    in_buckets = False
    for line in re.sub(r"\r\n?", "\n", text or "").split("\n"):
        bm = todo.BUCKET_RE.match(line)
        if bm:
            out.append({"name": bm.group(2).strip(), "columns": []})
            in_buckets = True
            continue
        if in_buckets and line.startswith("## "):
            break
        tm = todo.TIER_RE.match(line)
        if tm and out:
            name = todo.column_name(tm.group(1))
            if name not in out[-1]["columns"]:
                out[-1]["columns"].append(name)
    for b in out:
        b["columns"].reverse()
    return out


class Boards:
    """The boards on disk, as one identity may see them."""

    def __init__(self, data_root, names, who):
        self.data_root, self.names, self.who = data_root, names, who

    def visible(self):
        return [n for n in self.names
                if core_token.can_see(self.data_root, board_access.read(os.path.join(self.data_root, n)), self.who)]

    def open(self, name):
        name = str(name or "")
        if name not in self.names or name not in self.visible():
            raise Refused(404, NO_BOARD)
        text = _read(os.path.join(self.data_root, name, "todo.md"))
        if text is None:
            raise Refused(404, NO_BOARD)
        return os.path.join(self.data_root, name), text


def _steps(task):
    return [s["task"] for s in todo.split_body(task)[1]]


def _summary(t):
    steps = _steps(t)
    done = sum(1 for s in steps if s.done)
    return {"id": t.stable_id, "title": t.title, "bucket": t.bucket, "column": t.column, "done": t.done,
            "due": t.due, "start": t.start, "impact": t.impact, "effort": t.effort, "to": t.to,
            "urgent": t.urgent, "week": t.week, "refs": todo.refs_of(t), "blocked_by": t.blocked_by,
            "subtasks": [len(steps) - done, done]}


def _detail(t):
    notes, steps = todo.split_body(t)
    out = _summary(t)
    out["notes"] = [n.strip()[2:].strip() if n.strip().startswith("- ") else n.strip()
                    for n in notes if n.strip()][:MAX_NOTES]
    out["cancelled"], out["archived"], out["done_on"] = t.cancelled, t.archived, t.done_on
    out["subtasks"] = [{"id": s["task"].stable_id, "title": s["task"].title, "done": s["task"].done,
                        "to": s["task"].to, "due": s["task"].due, "doing": s["task"].doing,
                        "refs": list(s["task"].refs)} for s in steps]
    return out


def _date(value, what):
    value = str(value or "").strip()
    if not value:
        return ""
    if not todo.parse_date(value):
        raise Refused(400, "%s must be a date, YYYY-MM-DD" % what)
    return value


def _one_of(value, names, what):
    """The name in `names` that `value` is, whatever its case."""
    want = str(value or "").strip().lower()
    for n in names:
        if n.lower() == want:
            return n
    raise Refused(400, "no %s called %s; there is %s" % (what, str(value)[:60], ", ".join(names) or "none"))


def boards(ctx):
    out = []
    for name in ctx.visible():
        text = _read(os.path.join(ctx.data_root, name, "todo.md")) or ""
        out.append({"name": name, "buckets": buckets_of(text)})
    return 200, {"boards": out}


def tasks(ctx, query):
    _, text = ctx.open(query.get("board"))
    bks = buckets_of(text)
    got = todo.parse_doc(text)
    if query.get("bucket"):
        b = _one_of(query["bucket"], [x["name"] for x in bks], "bucket")
        got = [t for t in got if t.bucket == b]
    if query.get("column"):
        cols = []
        for x in bks:
            cols += [c for c in x["columns"] if c not in cols]
        c = _one_of(query["column"], cols, "column")
        got = [t for t in got if t.column == c]
    if str(query.get("done") or "") not in ("1", "true"):
        got = [t for t in got if not t.done]
    by = _date(query.get("due_by"), "due_by")
    if by:
        got = sorted((t for t in got if t.due and todo.parse_date(t.due) and t.due <= by), key=lambda t: t.due)
    return 200, {"board": query.get("board"), "tasks": [_summary(t) for t in got]}


def task(ctx, query):
    _, text = ctx.open(query.get("board"))
    want = str(query.get("id") or "").strip().lower()
    for t in todo.parse_doc(text):
        if want and t.stable_id == want:
            return 200, dict(_detail(t), board=query.get("board"))
    raise Refused(404, "no task with id %s on that board" % want[:20])


def _acting_for(who):
    """The person a request acts for, or `agent:<name>` for an agent of the team."""
    return who["person"] or core_token.AGENT_PREFIX + who["agent"]


def _owner_through_pa(who, folder):
    """Whether the request is the board's owner's, through the PA (never a routine or an agent)."""
    access = board_access.read(folder)
    return bool(access and who["person"] and who["person"] == access["owner"] and who["via"] == "pa")


def _taken(text):
    ids = set()
    for t in todo.parse_doc(text):
        if t.stable_id:
            ids.add(t.stable_id)
        for s in _steps(t):
            if s.stable_id:
                ids.add(s.stable_id)
    return ids


def add(ctx, body):
    if not isinstance(body, dict):
        raise Refused(400, "expected {board, title, bucket, column, due, refs}")
    extra = sorted(set(body) - ADD_KEYS)
    if extra:
        raise Refused(400, "unknown %s" % ", ".join(extra))
    folder, text = ctx.open(body.get("board"))
    title = body.get("title")
    if not isinstance(title, str) or not title.strip():
        raise Refused(400, "a task needs a title")
    title = " ".join(title.split()) if "\n" not in title and "\r" not in title else None
    if title is None:
        raise Refused(400, "a title is one line")
    if len(title) > MAX_TITLE or "`" in title or "::" in title or title.startswith("*"):
        raise Refused(400, "a title is plain words, up to %d characters, with no tags in it" % MAX_TITLE)
    bks = buckets_of(text)
    if body.get("bucket"):
        bucket = _one_of(body["bucket"], [b["name"] for b in bks], "bucket")
    elif len(bks) == 1:
        bucket = bks[0]["name"]
    else:
        raise Refused(400, "say which bucket: %s" % ", ".join(b["name"] for b in bks))
    have = next(b["columns"] for b in bks if b["name"] == bucket)
    column = _one_of(body.get("column") or "To do", have + [c for c in ALWAYS if c not in have], "column")
    if column in OWNER_ONLY:
        raise Refused(400, "a new task goes to To do or Backlog; only the owner puts one in %s" % column)
    due = _date(body.get("due"), "due")
    refs = body.get("refs") if body.get("refs") is not None else []
    if not isinstance(refs, list) or len(refs) > MAX_REFS:
        raise Refused(400, "refs is a list of at most %d references" % MAX_REFS)
    for r in refs:
        if not isinstance(r, str) or not todo.read_ref(r):
            raise Refused(400, "%s is not a reference, <module>:<kind>/<id>" % str(r)[:60])
    try:
        entry = add_queue.append({"title": title, "bucket": bucket, "column": column, "due": due,
                                  "refs": [r.strip(" \t") for r in refs]}, ctx.who["by"], taken=_taken(text),
                                  path=add_queue.path_for(folder), acting_for=_acting_for(ctx.who))
    except add_queue.QueueFull as e:
        raise Refused(429, "%s; ask again once the board has been opened" % e)
    return 202, {"queued": True, "id": entry["id"], "board": body.get("board"), "bucket": bucket,
                 "column": column}


def tick(ctx, body):
    if not isinstance(body, dict):
        raise Refused(400, "expected {board, sub}")
    folder, text = ctx.open(body.get("board"))
    sub = str(body.get("sub") or "").strip().lower()
    if not STEP_ID_RE.match(sub):
        raise Refused(400, "sub is the six-character id on the sub-task's line")
    me = _acting_for(ctx.who)
    for t in todo.parse_doc(text):
        for s in _steps(t):
            if s.stable_id != sub:
                continue
            if s.done:
                raise Refused(409, "that sub-task is already ticked")
            to = (s.to or "").strip().lower()
            # No [to::] is the board owner's own, which the owner may tick through the PA, and nothing else may.
            owners = not to and _owner_through_pa(ctx.who, folder)
            if to != me and not owners:
                raise Refused(403, "only the one a sub-task is assigned to may tick it; it is %s"
                              % ("assigned to %s" % s.to.strip() if to else
                                 "the board owner's, who may tick it through the PA"))
            entry = tick_queue.append(sub, ctx.who["by"], path=os.path.join(folder, "tick-queue.json"),
                                      assignee=me, owner=owners)
            return 202, {"queued": True, "id": entry["id"], "sub": sub, "task": t.title}
    raise Refused(404, "no sub-task with id %s on that board" % sub)


GETS = {"/offdesk/boards.json": lambda ctx, q, b: boards(ctx), "/offdesk/tasks.json": lambda ctx, q, b: tasks(ctx, q),
        "/offdesk/task.json": lambda ctx, q, b: task(ctx, q)}
POSTS = {"/offdesk/add": lambda ctx, q, b: add(ctx, b), "/offdesk/tick": lambda ctx, q, b: tick(ctx, b)}


def handle(method, route, query, body, who, data_root, names):
    """(status, payload) for one /offdesk/ request from an identity already checked."""
    table = GETS if method in ("GET", "HEAD") else POSTS if method == "POST" else {}
    fn = table.get(route)
    if fn is None:
        return 404, {"error": "no route %s" % route}
    try:
        return fn(Boards(data_root, names, who), query, body)
    except Refused as e:
        return e.code, {"error": str(e)}

