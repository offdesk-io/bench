# Chats and the PA on the server, on the offdesk API key

Date: 2026-11-04. Step 1 of 3: this step is chats and the PA. Step 2 is the Plan agent on a systemd timer, and step 3 is the Implement agent. Each gets its own design.

## Why

The board already has a PA. The focus prompt and the chat windows (`kanban/js/10-reference-sections.js`, `10a-focus-prompt.js`) send `/pa …`, and the board applies the `pa-changes` block in the reply itself. Each card also has its own chats. All of it is answered by `ai_chat_engine`, which runs the `claude` CLI.

None of it works on the server, for two reasons:

- `ai_chat_for()` (`kanban/server.py`) returns nothing whenever sign-in is on. A chat ran as whoever started the server, and that login was its owner's own.
- The server has no `claude` CLI.

offdesk now has its own Anthropic API account. A chat run on that key belongs to nobody's personal login, which removes the first reason. This step makes chats and the PA work on the server board, read-only, for everyone who can see the board.

## Decisions

- **Runtime:** the Claude Code CLI on the server, authenticated by `ANTHROPIC_API_KEY`. The engine, chat windows, transcripts, `/pa` skill and `pa-changes` flow are all unchanged.
- **Read-only.** On the server, a chat never writes files. The list changes only through `pa-changes` blocks, which the asker's tab applies and saves through the normal route, with the If-Match check.
- **Shared per board.** Everyone who can see a board sees its chats, on cards and with the PA, because there is one `sessions.json` per board, as today.

## 1. Key and runtime on the server

- **The CLI.** `claude` is installed with npm, globally, pinned to an exact version. The deploy never changes it, so an upgrade is a deliberate step.
- **The key file.** The key lives in `/etc/bench/anthropic.env`, owned by root with mode 600, holding one line, `ANTHROPIC_API_KEY=…`.
- **The service.** `bench.service` gets `EnvironmentFile=/etc/bench/anthropic.env`. systemd reads the file as root before dropping to the `bench` user, so the key exists only in the server process's environment and the `bench` user cannot read the file.
- **Who handles the key.** The owner types the key into the setup script, which reads it without echoing. It is never printed, logged or committed.
- **Spend.** The ceiling is a monthly spend limit on the offdesk workspace, set in the Anthropic console.
- **The skills.** `~bench/.claude/skills/` holds links to `agents/pa_agent/skills/*` in the checkout, the same arrangement as on the Mac. A deploy updates what they point to.

## 2. When chat runs while signed in

When sign-in is on (`AUTH`), `ai_chat_for()` builds an engine only if `ANTHROPIC_API_KEY` is set in the environment. That way a personal Claude login can never serve other people. Without the key, a signed-in board behaves as it does today: no chat.

When signed in, every run is Ask mode:

- The server refuses `mode=write` with 403.
- The "Can write" switch never shows. The `claude.json` `work` flag is ignored when signed in.

When sign-in is off, which is the Mac, everything stays as it is.

## 3. What a chat on the server can touch

A run is Ask mode, as today, so `--permission-mode dontAsk` applies and Bash, Edit, Write, NotebookEdit and Task are denied. `dontAsk` also refuses anything outside the working directory, the checkout root, which includes `/proc/self/environ` (where the key is) and the `bench` user's home.

When signed in, the server adds these to the engine's `ask_denies`:

- **Every entry in `data/` except the chat's own board**, as `Read(//<data root>/<entry>/**)` for a folder and `Read(//<data root>/<entry>)` for a file. That covers other boards, `data/users/` (everyone's profiles and current board), `data/agents/` and `settings.json`. Claude Code applies Read rules to Grep and Glob as well. The list is rebuilt from a fresh listing of `data/` every time `ai_chat_for()` returns the board's engine, so a board created after the engine was built is denied too.
- **`WebFetch` and `WebSearch`**, so nothing on the board can be sent anywhere.

`ai_chat_engine` already takes `ask_denies` for each engine, so it needs no change.

## 4. The PA on a shared board

The PA's instructions speak of "the owner", but on a shared board the person asking can be any of its people. When signed in, the server adds one line to each prompt it passes to `run`: `(Asked by <name> on the shared board "<board>".)`. `<name>` is the signed-in person's name from the sign-in headers. The PA answers that person.

The PA cannot read the asker's own profile in `data/users/`. That needs an allow rule for that one file, which means an engine change, so it is left for later.

## 5. Testing

- **`kanban/test_server_chat.py` (new)** covers:
  - Signed in without a key: `ai_chat_for()` gives no engine.
  - Signed in with a key: an engine whose denials name every `data/` entry except the board's own, plus `WebFetch` and `WebSearch`.
  - A board added later shows up in the denials.
  - `mode=write` is refused, and the "asked by" line is prepended.
  - Signed out: unchanged.
- **`kanban/test_server_chat_live.py` (new)** runs the real `claude` with those denials against a throwaway data root. It checks that reading another board, `data/users/` or `/proc/self/environ` is refused, and that reading the board's own `todo.md` works. It needs a key and the CLI, so it skips without them and is not in CI.
- The existing board suites and Python suites must still pass on the PR.

## 6. Rollout

1. **The PR** holds the `server.py` change, both tests and `scripts/setup-server-chat.sh`. The script runs from the Mac over the root ssh used for deploys, and:
   - installs the pinned `claude`;
   - writes `/etc/bench/anthropic.env` from a key read without echo;
   - adds `EnvironmentFile=` through a drop-in, `/etc/systemd/system/bench.service.d/anthropic.conf`;
   - links the skills.

   It does not restart the service. Tiago reviews, and the merge deploys the code, which restarts the service anyway.
2. **Setup.** The owner runs `scripts/setup-server-chat.sh` once. Running it again is safe.
3. **Check.** Ask the PA something on `work`, check that a `pa-changes` block applies, and open a card chat.

## Not in this step

- **The Plan agent on the server (step 2):** a systemd timer in place of the Mac's launchd wake, and the daily ceiling in `fences.json` set for the API account.
- **The Implement agent on the server (step 3),** and write mode for chats, which needs the same fencing.
- **The asker's own profile in the PA's context.**
