"""The server as the core starts it: `python -m bench_mcp` on stdio."""

import sys

import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

pytestmark = pytest.mark.anyio


async def test_it_starts_on_stdio_and_lists_its_tools():
    params = StdioServerParameters(command=sys.executable, args=["-m", "bench_mcp"],
                                   env={"BENCH_URL": "http://127.0.0.1:9"})
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = (await session.list_tools()).tools
            assert {t.name for t in tools} == {"boards", "tasks", "task", "add", "tick"}
            r = await session.call_tool("boards", {}, meta={"offdesk/token": "a.b"})
            assert r.is_error and "Bench did not answer" in r.content[0].text
