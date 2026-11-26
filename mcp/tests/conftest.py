"""Bench's own server (kanban/server.py), on a free port over a throwaway data root, behind the MCP server,
which is driven by an in-process MCP client. Tokens are made here with the core's algorithm (nothing is
imported from the core). The owner's data/ is never read: the server is given its own TODOS_DATA_ROOT and its
BENCH_ROOT is this checkout."""

import base64
import hashlib
import hmac
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time

import httpx
import pytest

from bench_mcp.server import make_server

KEY = bytes(range(32))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SERVER = os.path.join(REPO, "kanban", "server.py")
TODO = """# To-do

## 1. Work

### Done

- [x] **Shipped** `done:2026-11-20` `id:dn0001`

### Reviewing

### Doing

- [ ] **Send the deck** [impact:: high] [effort:: S] [due:: 2026-12-01] [lead:: acme-studio] [ref:: calls:call/x-1] `id:aaaaaa`
  - Background in the shared folder.
  - [ ] Draft it [to:: ana@example.com] `id:s00001`
  - [ ] Check it [to:: rui@example.com] `id:s00002`
  - [x] Book the room [to:: ana@example.com] `done:2026-11-20` `id:s00003`

### To do

- [ ] **Order badges** [due:: 2026-11-28] `id:bbbbbb`

### Backlog

- [ ] **Someday** `id:cccccc`

---

## 2. Home

### To do

- [ ] **Fix the shelf** [due:: 2026-12-20] `id:dddddd`
"""


def b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def token(sub: str = "ana@example.com", agent: str = "pa", exp=None, key: bytes = KEY) -> str:
    body = b64(json.dumps({"sub": sub, "agent": agent, "exp": exp or int(time.time()) + 300},
                          separators=(",", ":")).encode())
    return body + "." + b64(hmac.new(key, body.encode(), hashlib.sha256).digest())


def meta(sub: str = "ana@example.com", **kw):
    return {"offdesk/token": token(sub, **kw)}


def _free_port() -> int:
    while True:
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        if port not in (8765, 8766):
            return port


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(scope="session")
def bench():
    """{url, data}: Bench signed in (BENCH_AUTH=header) with the core's key, over its own data root."""
    root = tempfile.mkdtemp(prefix="bench-mcp-test-")
    data = os.path.join(root, "data")
    os.makedirs(data)
    port = _free_port()
    env = {k: v for k, v in os.environ.items() if not k.startswith(("BENCH_", "TODOS_", "ANTHROPIC_"))}
    env.update(TODOS_DATA_ROOT=data, TODOS_PORT=str(port), TODOS_NO_BROWSER="1", BENCH_AUTH="header",
               BENCH_ROOT=REPO, BENCH_CORE_TOKEN_KEY=KEY.hex(), BENCH_NOTIFY="0")
    python = os.environ.get("BENCH_PYTHON") or shutil.which("python3", path="/usr/bin:/bin") or sys.executable
    proc = subprocess.Popen([python, "-u", SERVER], env=env, cwd=REPO, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT)
    for _ in range(100):
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
            break
        except OSError:
            if proc.poll() is not None:
                break
            time.sleep(0.1)
    else:
        proc.terminate()
    if proc.poll() is not None:
        out = proc.stdout.read().decode("utf-8", "replace")
        shutil.rmtree(root, ignore_errors=True)
        pytest.fail("Bench did not start:\n" + out)
    try:
        yield {"url": "http://127.0.0.1:%d" % port, "data": data}
    finally:
        proc.terminate()
        proc.wait(timeout=5)
        proc.stdout.close()
        shutil.rmtree(root, ignore_errors=True)


@pytest.fixture
def board(bench):
    """The `work` board, fresh for each test, that Ana and the digest agent may see."""
    folder = os.path.join(bench["data"], "work")
    shutil.rmtree(folder, ignore_errors=True)
    os.makedirs(os.path.join(folder, "backups"))
    with open(os.path.join(folder, "todo.md"), "w", encoding="utf-8") as fh:
        fh.write(TODO)
    with open(os.path.join(folder, "access.json"), "w", encoding="utf-8") as fh:
        json.dump({"owner": "owner@example.com", "people": ["ana@example.com"], "teams": [],
                   "agents": ["digest"]}, fh)
    return folder


@pytest.fixture
def seen():
    """Every request the MCP server made to Bench."""
    return []


@pytest.fixture
def server(bench, seen):
    async def record(request):
        seen.append(request)

    http = httpx.AsyncClient(base_url=bench["url"], event_hooks={"request": [record]}, timeout=10)
    return make_server(http)
