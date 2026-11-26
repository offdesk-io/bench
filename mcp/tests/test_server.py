"""Every tool against Bench's own server, through an in-process MCP client."""

import json
import os

import pytest
from mcp import Client

from conftest import TODO, meta, token

pytestmark = pytest.mark.anyio

READS = {"boards", "tasks", "task"}
WRITES = {"add", "tick"}


async def call(server, name, args, sub="ana@example.com", **kw):
    async with Client(server) as c:
        return await c.call_tool(name, args, meta=meta(sub, **kw) if sub else None)


def text(result):
    return "\n".join(c.text for c in result.content)


def queue(board, name):
    path = os.path.join(board, name)
    return json.load(open(path)) if os.path.exists(path) else []


async def test_the_tools_and_their_annotations(server):
    async with Client(server) as c:
        tools = {t.name: t for t in (await c.list_tools()).tools}
    assert set(tools) == READS | WRITES
    for name in READS:
        assert tools[name].annotations.read_only_hint is True
    for name in WRITES:
        a = tools[name].annotations
        assert a.read_only_hint is False and a.destructive_hint is False
    for t in tools.values():
        assert t.description and t.input_schema["type"] == "object"


async def test_the_token_is_passed_through_with_x_board(server, seen, board):
    tok = token("ana@example.com", "routine:r1")
    async with Client(server) as c:
        r = await c.call_tool("boards", {}, meta={"offdesk/token": tok})
    assert not r.is_error
    assert seen and all(req.headers["authorization"] == "Bearer " + tok for req in seen)
    assert all(req.headers["x-board"] == "1" for req in seen)


async def test_no_token_is_refused_before_bench_is_called(server, seen, board):
    r = await call(server, "boards", {}, sub=None)
    assert r.is_error and "token" in text(r)
    assert seen == []


async def test_a_token_bench_refuses_comes_back_as_an_error(server, board):
    r = await call(server, "boards", {}, key=b"x" * 32)
    assert r.is_error and "Bench refused" in text(r) and "signature" in text(r)


async def test_boards(server, board):
    r = await call(server, "boards", {})
    out = text(r)
    assert not r.is_error
    assert "work" in out and "Work (Backlog, To do, Doing, Reviewing, Done)" in out and "Home (To do)" in out
    nothing = await call(server, "boards", {}, sub="rui@example.com")
    assert not nothing.is_error and "No boards" in text(nothing)


async def test_an_agent_of_the_team_sees_only_boards_that_list_it(server, board):
    assert "work" in text(await call(server, "boards", {}, sub="agent:digest", agent="digest"))
    assert "No boards" in text(await call(server, "boards", {}, sub="agent:other", agent="other"))


async def test_tasks(server, board):
    r = await call(server, "tasks", {"board": "work"})
    out = text(r)
    assert not r.is_error
    assert out.splitlines()[0].startswith("4 open tasks on work")
    assert ("- aaaaaa Send the deck: Work, Doing; due 2026-12-01; impact high, effort S; sub-tasks 2 open, 1 done; "
            "links binder:org/acme-studio, calls:call/x-1") in out
    assert "Shipped" not in out
    by_column = text(await call(server, "tasks", {"board": "work", "column": "To do"}))
    assert "Order badges" in by_column and "Fix the shelf" in by_column and "Send the deck" not in by_column
    by_bucket = text(await call(server, "tasks", {"board": "work", "bucket": "Home"}))
    assert "Fix the shelf" in by_bucket and "Order badges" not in by_bucket
    due = text(await call(server, "tasks", {"board": "work", "due_by": "2026-12-01"}))
    assert due.index("Order badges") < due.index("Send the deck") and "Fix the shelf" not in due
    done = text(await call(server, "tasks", {"board": "work", "column": "Done", "done": True}))
    assert "Shipped" in done
    none = await call(server, "tasks", {"board": "work", "bucket": "Home", "column": "Doing"})
    assert not none.is_error and "No open tasks" in text(none)


async def test_tasks_errors_are_plain(server, board):
    r = await call(server, "tasks", {"board": "work", "column": "Later"})
    assert r.is_error and "no column called Later" in text(r) and "To do" in text(r)
    r = await call(server, "tasks", {"board": "elsewhere"})
    assert r.is_error and "no such board" in text(r)
    r = await call(server, "tasks", {"board": "work", "due_by": "soon"})
    assert r.is_error and "due_by is not valid" in text(r)
    r = await call(server, "tasks", {"board": "work", "colour": "red"})
    assert r.is_error and "Unknown argument colour" in text(r)
    r = await call(server, "tasks", {})
    assert r.is_error and "Missing board" in text(r)


async def test_task(server, board):
    r = await call(server, "task", {"board": "work", "id": "aaaaaa"})
    out = text(r)
    assert not r.is_error
    assert out.splitlines()[0] == "Send the deck (aaaaaa), on work: Work, Doing"
    assert "Due: 2026-12-01" in out and "Links: binder:org/acme-studio, calls:call/x-1" in out
    assert "- Background in the shared folder." in out
    assert "- [ ] s00001 Draft it, for ana@example.com" in out
    assert "- [x] s00003 Book the room, for ana@example.com" in out
    missing = await call(server, "task", {"board": "work", "id": "zzzzzz"})
    assert missing.is_error and "no task with id zzzzzz" in text(missing)


async def test_add_is_queued_and_todo_is_not_written(server, board):
    r = await call(server, "add", {"board": "work", "title": "Call Acme back", "bucket": "Work", "column": "Backlog",
                                   "due": "2026-12-03", "refs": ["binder:org/acme-studio"]},
                   agent="routine:r1")
    out = text(r)
    assert not r.is_error
    (entry,) = queue(board, "add-queue.json")
    assert out == ('Queued "Call Acme back" for Work, Backlog on work (id %s). It appears on the board when the '
                   'board next loads.' % entry["id"])
    assert entry["by"] == "ana@example.com via routine:r1" and entry["refs"] == ["binder:org/acme-studio"]
    assert open(os.path.join(board, "todo.md")).read() == TODO


async def test_add_refusals_are_plain(server, board):
    r = await call(server, "add", {"board": "work", "title": "x", "bucket": "Work", "column": "Doing"})
    assert r.is_error and "column is not valid (one of To do, Backlog)" in text(r)
    r = await call(server, "add", {"board": "work", "title": "x"})
    assert r.is_error and "say which bucket" in text(r)
    r = await call(server, "add", {"board": "work", "title": "x", "bucket": "Work", "refs": ["acme"]})
    assert r.is_error and "refs is not valid" in text(r)
    assert queue(board, "add-queue.json") == []


async def test_tick_only_what_is_assigned_to_whoever_the_core_acts_for(server, board):
    r = await call(server, "tick", {"board": "work", "sub": "s00001"}, agent="routine:r1")
    assert not r.is_error
    assert text(r) == ('Queued a tick of s00001 on "Send the deck". It is applied when the board next loads.')
    (entry,) = queue(board, "tick-queue.json")
    assert entry["as"] == "ana@example.com" and entry["by"] == "ana@example.com via routine:r1"
    r = await call(server, "tick", {"board": "work", "sub": "s00002"})
    assert r.is_error and "assigned to rui@example.com" in text(r)
    r = await call(server, "tick", {"board": "work", "sub": "s00003"})
    assert r.is_error and "already ticked" in text(r)
    r = await call(server, "tick", {"board": "work", "sub": "toolong1"})
    assert r.is_error and "sub is not valid" in text(r)
    assert len(queue(board, "tick-queue.json")) == 1
    assert open(os.path.join(board, "todo.md")).read() == TODO


async def test_bench_down_is_a_plain_error():
    import httpx
    from bench_mcp.server import make_server
    server = make_server(httpx.AsyncClient(base_url="http://127.0.0.1:9", timeout=2))
    r = await call(server, "boards", {})
    assert r.is_error and text(r) == "Bench did not answer. Try again later."
