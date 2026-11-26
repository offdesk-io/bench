"""Bench's tools for the Offdesk core, over MCP on stdio.

Each call carries the core's signed token in its request meta (`offdesk/token`). The token goes to Bench as
`Authorization: Bearer`, on the routes under /offdesk/ in kanban/server.py, so Bench itself decides who is
asking and which boards they see (core/core_token.py); a call without one is refused here before Bench is
reached. Every request carries `X-Board: 1`, which Bench asks of a POST. Answers are short plain text for the
model, never Bench's JSON in full; Bench's errors come back as tool errors with its own message.

Bench never lets anything but the board write todo.md, so `add` and `tick` are queued (add-queue.json,
tick-queue.json) and applied when the board next loads; the tools say so.

BENCH_URL is Bench's address (default http://127.0.0.1:8765, on the same machine as the core)."""

import os
import re
from typing import Any, Awaitable, Callable, Dict, List

import anyio
import httpx
import mcp.types as types
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server

DEFAULT_URL = "http://127.0.0.1:8765"
MAX_ROWS = 50       # tasks in a list
MAX_NOTES = 20      # note lines shown with a task
MAX_TEXT = 200      # characters of a note

READ = types.ToolAnnotations(read_only_hint=True)
WRITE = types.ToolAnnotations(read_only_hint=False, destructive_hint=False)
DATE = {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$", "description": "A date, YYYY-MM-DD."}
BOARD = {"type": "string", "minLength": 1, "description": "The board's name, as bench.boards lists it."}
REF = {"type": "string", "pattern": r"^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*/[^\s\]]+$",
       "description": "A record in another module, <module>:<kind>/<id>, e.g. binder:org/acme-ltd."}


class Failed(Exception):
    """A plain sentence for the model."""


UNREADABLE = "Bench gave an answer this tool could not read. Try again later."


def _obj(props: Dict[str, Any], required: List[str]) -> Dict[str, Any]:
    return {"type": "object", "properties": props, "required": required, "additionalProperties": False}


TOOLS = [
    types.Tool(name="boards", annotations=READ, input_schema=_obj({}, []),
               description="The Bench boards you may see, each with its buckets and their columns."),
    types.Tool(name="tasks", annotations=READ, input_schema=_obj({
        "board": BOARD,
        "column": {"type": "string", "minLength": 1, "description": "Only this column (To do, Doing, ...)."},
        "bucket": {"type": "string", "minLength": 1, "description": "Only this bucket."},
        "due_by": dict(DATE, description="Only tasks due on or before this date, soonest first."),
        "done": {"type": "boolean", "description": "Include ticked tasks too (default false)."}}, ["board"]),
        description="A board's open tasks: by column or bucket, or what is due by a date. Gives each task's id, "
                    "where it sits, its dates, scores, sub-task counts and links to other modules."),
    types.Tool(name="task", annotations=READ, input_schema=_obj({
        "board": BOARD,
        "id": {"type": "string", "pattern": r"^[a-z0-9]{6}$", "description": "The task's id, as bench.tasks shows it."}},
        ["board", "id"]),
        description="One task: where it sits, its dates, who it is with, its notes, its links, and its sub-tasks "
                    "with their ids (bench.tick takes one)."),
    types.Tool(name="add", annotations=WRITE, input_schema=_obj({
        "board": BOARD,
        "title": {"type": "string", "minLength": 1, "maxLength": 200, "description": "The task, in plain words."},
        "bucket": {"type": "string", "minLength": 1, "description": "Which bucket; needed when the board has more "
                                                                    "than one."},
        "column": {"type": "string", "enum": ["To do", "Backlog"],
                   "description": "To do if it is next up, Backlog if not (default To do). Only the owner puts a "
                                  "task in Doing or Reviewing."},
        "due": DATE,
        "refs": {"type": "array", "items": REF, "maxItems": 10,
                 "description": "Records in other modules this task is about."}}, ["board", "title"]),
        description="Ask Bench to add a task to a board. It is queued and appears when the board next loads."),
    types.Tool(name="tick", annotations=WRITE, input_schema=_obj({
        "board": BOARD,
        "sub": {"type": "string", "pattern": r"^[a-z0-9]{6}$",
                "description": "The sub-task's id, as bench.task shows it."}}, ["board", "sub"]),
        description="Ask Bench to tick a sub-task assigned to the person you act for (or to you, an agent), or one "
                    "assigned to nobody when you are the board owner's PA. It is queued and applied when the board "
                    "next loads."),
]


def _cut(text: Any, n: int = MAX_TEXT) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= n else text[: n - 1] + "…"


class Bench:
    """Bench's /offdesk/ routes, called with one call's token."""

    def __init__(self, http: httpx.AsyncClient, token: str):
        self.http, self.token = http, token

    async def request(self, method: str, path: str, **kw) -> Any:
        headers = {"Authorization": "Bearer " + self.token, "X-Board": "1"}
        try:
            r = await self.http.request(method, path, headers=headers, **kw)
        except httpx.HTTPError:
            raise Failed("Bench did not answer. Try again later.") from None
        try:
            body = r.json()
        except ValueError:
            body = None
        if r.status_code < 400:
            if not isinstance(body, dict):
                raise Failed(UNREADABLE)
            return body
        detail = body.get("error") if isinstance(body, dict) else None
        detail = _cut(detail, 240) if isinstance(detail, str) else ""
        if r.status_code == 401:
            raise Failed("Bench refused the call: %s" % (detail or "not signed in"))
        raise Failed(detail or "Bench answered %d" % r.status_code)


def _where(t: Dict[str, Any]) -> str:
    return "%s, %s" % (t["bucket"], t["column"])


def _line(t: Dict[str, Any]) -> str:
    bits = [_where(t)]
    if t.get("due"):
        bits.append("due %s" % t["due"])
    if t.get("start"):
        bits.append("starts %s" % t["start"])
    scores = ", ".join(x for x in ("impact %s" % t["impact"] if t.get("impact") else "",
                                   "effort %s" % t["effort"] if t.get("effort") else "") if x)
    if scores:
        bits.append(scores)
    if t.get("to"):
        bits.append("with %s" % t["to"])
    if t.get("urgent"):
        bits.append("urgent")
    if t.get("done"):
        bits.append("done")
    open_, done = (t.get("subtasks") or [0, 0])[:2]
    if open_ or done:
        bits.append("sub-tasks %d open, %d done" % (open_, done))
    if t.get("blocked_by"):
        bits.append("blocked by %s" % ", ".join(t["blocked_by"]))
    if t.get("refs"):
        bits.append("links %s" % ", ".join(t["refs"]))
    return "- %s %s: %s" % (t.get("id") or "(no id)", _cut(t["title"], 120), "; ".join(bits))


async def boards(b: Bench, args: Dict[str, Any]) -> str:
    got = (await b.request("GET", "/offdesk/boards.json"))["boards"]
    if not got:
        return "No boards you can see in Bench."
    lines = ["Boards you can see (%d):" % len(got)]
    for board in got:
        buckets = "; ".join("%s (%s)" % (x["name"], ", ".join(x["columns"])) for x in board["buckets"])
        lines.append("- %s: %s" % (board["name"], buckets or "no buckets yet"))
    return "\n".join(lines)


async def tasks(b: Bench, args: Dict[str, Any]) -> str:
    params = {k: args[k] for k in ("board", "column", "bucket", "due_by") if args.get(k)}
    if args.get("done"):
        params["done"] = "1"
    got = (await b.request("GET", "/offdesk/tasks.json", params=params))["tasks"]
    which = [s for s in ("in %s" % args["bucket"] if args.get("bucket") else "",
                         "in %s" % args["column"] if args.get("column") else "",
                         "due by %s" % args["due_by"] if args.get("due_by") else "") if s]
    what = "tasks" if args.get("done") else "open tasks"
    if not got:
        return "No %s on %s%s." % (what, args["board"], " " + " ".join(which) if which else "")
    lines = ["%d %s on %s%s:" % (len(got), what, args["board"], " " + " ".join(which) if which else "")]
    lines += [_line(t) for t in got[:MAX_ROWS]]
    if len(got) > MAX_ROWS:
        lines.append("… and %d more, not shown; narrow it by column, bucket or due_by." % (len(got) - MAX_ROWS))
    return "\n".join(lines)


async def task(b: Bench, args: Dict[str, Any]) -> str:
    t = await b.request("GET", "/offdesk/task.json", params={"board": args["board"], "id": args["id"]})
    lines = ["%s (%s), on %s: %s" % (t["title"], t["id"], args["board"], _where(t))]
    for label, key in (("Due", "due"), ("Starts", "start"), ("Impact", "impact"), ("Effort", "effort"),
                       ("With", "to"), ("Done on", "done_on"), ("Cancelled", "cancelled"), ("Archived", "archived")):
        if t.get(key):
            lines.append("%s: %s" % (label, t[key]))
    if t.get("blocked_by"):
        lines.append("Blocked by: %s" % ", ".join(t["blocked_by"]))
    if t.get("refs"):
        lines.append("Links: %s" % ", ".join(t["refs"]))
    if t.get("notes"):
        lines.append("Notes:")
        lines += ["- %s" % _cut(n) for n in t["notes"][:MAX_NOTES]]
    subs = t.get("subtasks") or []
    if subs:
        lines.append("Sub-tasks:")
        for s in subs[:MAX_ROWS]:
            bits = [x for x in ("for %s" % s["to"] if s.get("to") else "", "due %s" % s["due"] if s.get("due") else "",
                                "being worked on" if s.get("doing") else "") if x]
            lines.append("- [%s] %s %s%s" % ("x" if s.get("done") else " ", s.get("id") or "(no id)",
                                            _cut(s["title"], 120), ", " + ", ".join(bits) if bits else ""))
    else:
        lines.append("No sub-tasks.")
    return "\n".join(lines)


async def add(b: Bench, args: Dict[str, Any]) -> str:
    body = {k: args[k] for k in ("board", "title", "bucket", "column", "due", "refs") if args.get(k) is not None}
    got = await b.request("POST", "/offdesk/add", json=body)
    return ('Queued "%s" for %s, %s on %s (id %s). It appears on the board when the board next loads.'
            % (_cut(args["title"], 120), got["bucket"], got["column"], args["board"], got["id"]))


async def tick(b: Bench, args: Dict[str, Any]) -> str:
    got = await b.request("POST", "/offdesk/tick", json={"board": args["board"], "sub": args["sub"]})
    return 'Queued a tick of %s on "%s". It is applied when the board next loads.' % (got["sub"], _cut(got["task"], 120))


HANDLERS: Dict[str, Callable[[Bench, Dict[str, Any]], Awaitable[str]]] = {
    "boards": boards, "tasks": tasks, "task": task, "add": add, "tick": tick,
}


def _fits(value: Any, schema: Dict[str, Any]) -> bool:
    """The few JSON Schema rules these tools use: type, enum, pattern, minLength, maxLength, items, maxItems."""
    kind = schema.get("type")
    ok = {"string": lambda v: isinstance(v, str), "boolean": lambda v: isinstance(v, bool),
          "array": lambda v: isinstance(v, list)}
    if kind and not ok[kind](value):
        return False
    if isinstance(value, str):
        if "enum" in schema and value not in schema["enum"]:
            return False
        if "pattern" in schema and not re.match(schema["pattern"], value):
            return False
        if len(value.strip()) < schema.get("minLength", 0) or len(value) > schema.get("maxLength", 10 ** 6):
            return False
    if isinstance(value, list):
        if len(value) > schema.get("maxItems", 10 ** 6):
            return False
        if "items" in schema:
            return all(_fits(v, schema["items"]) for v in value)
    return True


def _check(name: str, args: Dict[str, Any]) -> None:
    schema = next(t for t in TOOLS if t.name == name).input_schema
    missing = [k for k in schema["required"] if k not in args]
    if missing:
        raise Failed("Missing %s." % ", ".join(missing))
    extra = [k for k in args if k not in schema["properties"]]
    if extra:
        raise Failed("Unknown argument %s." % ", ".join(extra))
    for key, value in args.items():
        prop = schema["properties"][key]
        if not _fits(value, prop):
            allowed = " (one of %s)" % ", ".join(prop["enum"]) if "enum" in prop else ""
            raise Failed("%s is not valid%s; see the tool's schema." % (key, allowed))


def _result(text: str, error: bool = False) -> types.CallToolResult:
    return types.CallToolResult(content=[types.TextContent(type="text", text=text)], is_error=error)


def make_server(http: httpx.AsyncClient) -> Server:
    async def list_tools(ctx, params) -> types.ListToolsResult:
        return types.ListToolsResult(tools=TOOLS)

    async def call_tool(ctx, params: types.CallToolRequestParams) -> types.CallToolResult:
        name, args = params.name, dict(params.arguments or {})
        if name not in HANDLERS:
            return _result("No tool %r in Bench." % name, error=True)
        token = (ctx.meta or {}).get("offdesk/token")
        if not isinstance(token, str) or not token:
            return _result("No Offdesk token on this call: Bench acts only for the person the core names.",
                           error=True)
        try:
            _check(name, args)
            return _result(await HANDLERS[name](Bench(http, token), args))
        except Failed as e:
            return _result(str(e), error=True)
        except (KeyError, TypeError, ValueError, AttributeError, IndexError):
            # Bench answered with a shape this tool does not expect: a short sentence, never the exception.
            return _result(UNREADABLE, error=True)

    return Server("bench", on_list_tools=list_tools, on_call_tool=call_tool)


async def _serve() -> None:
    url = os.environ.get("BENCH_URL", DEFAULT_URL).rstrip("/")
    async with httpx.AsyncClient(base_url=url, timeout=30) as http:
        server = make_server(http)
        async with stdio_server() as (read, write):
            await server.run(read, write, server.create_initialization_options())


def main() -> None:
    anyio.run(_serve)
