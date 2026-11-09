#!/usr/bin/env bash
# One-off setup for chats on the shared board, run from the Mac. Safe to run
# again. See docs/superpowers/specs/2026-11-04-server-chat-api-design.md, §1.
#
#   scripts/setup-server-chat.sh            # asks for the API key, without echo
#   DEPLOY_HOST=root@host scripts/setup-server-chat.sh
#   DATA_DIR=/path/to/data scripts/setup-server-chat.sh   # default $CHECKOUT/data
#
# It installs the claude CLI at CLAUDE_VERSION, writes the key to
# /etc/bench/anthropic.env (root, 600), adds it to bench.service through a
# drop-in, and links the PA skills into the bench user's ~/.claude/skills.
# It also moves any old card-chat index, <data>/<board>/sessions.json, to
# <data>/agents/old-sessions/<board>.json, where a chat run cannot read it.
# It does not restart the service: restart it when ready, or let the next
# deploy do it. The key is never printed, logged or written on this Mac.
set -euo pipefail

HOST="${DEPLOY_HOST:-root@167.235.25.240}"
CLAUDE_VERSION="2.1.319"
CHECKOUT=/opt/agency/bench
DATA_DIR="${DATA_DIR:-$CHECKOUT/data}"

read -rsp "offdesk Anthropic API key (not shown): " KEY; echo
case "$KEY" in sk-ant-*) ;; *) echo "that does not look like an Anthropic API key" >&2; exit 1 ;; esac

# The key goes over ssh's stdin, never on a command line.
printf 'ANTHROPIC_API_KEY=%s\n' "$KEY" | ssh "$HOST" \
  'umask 077 && mkdir -p /etc/bench && cat > /etc/bench/anthropic.env && chown root:root /etc/bench/anthropic.env && chmod 600 /etc/bench/anthropic.env'
unset KEY
echo "key written to /etc/bench/anthropic.env"

ssh "$HOST" CLAUDE_VERSION="$CLAUDE_VERSION" CHECKOUT="$CHECKOUT" DATA_DIR="$DATA_DIR" bash -s <<'REMOTE'
set -euo pipefail
have="$(claude --version 2>/dev/null | awk '{print $1}' || true)"
if [ "$have" != "$CLAUDE_VERSION" ]; then
  npm install -g "@anthropic-ai/claude-code@$CLAUDE_VERSION"
fi
echo "claude $(claude --version)"

mkdir -p /etc/systemd/system/bench.service.d
cat > /etc/systemd/system/bench.service.d/anthropic.conf <<'EOF'
[Service]
EnvironmentFile=/etc/bench/anthropic.env
EOF
systemctl daemon-reload
echo "drop-in at /etc/systemd/system/bench.service.d/anthropic.conf"

home="$(getent passwd bench | cut -d: -f6)"
install -d -o bench -g bench "$home/.claude" "$home/.claude/skills"
for skill in "$CHECKOUT"/agents/pa_agent/skills/*/; do
  name="$(basename "$skill")"
  ln -sfn "${skill%/}" "$home/.claude/skills/$name"
done
chown -h bench:bench "$home"/.claude/skills/*
# The old card-chat index sat in each board's folder, which a chat run can
# read. The server no longer uses it: park it beside the new sessions files.
old="$DATA_DIR/agents/old-sessions"
for f in "$DATA_DIR"/*/sessions.json; do
  [ -f "$f" ] || continue
  board="$(basename "$(dirname "$f")")"
  [ "$board" = agents ] && continue
  if [ ! -d "$old" ]; then
    if [ ! -d "$DATA_DIR/agents" ]; then
      mkdir -p "$DATA_DIR/agents"
      chown --reference="$DATA_DIR" "$DATA_DIR/agents"
    fi
    mkdir -p "$old"
    chown --reference="$DATA_DIR/agents" "$old"
  fi
  target="$old/$board.json"
  [ -e "$target" ] && target="$old/$board.$(date +%Y%m%d-%H%M%S).json"
  mv -n "$f" "$target"
  echo "moved $f to $target"
done

echo "skills linked: $(ls "$home/.claude/skills" | tr '\n' ' ')"
echo "not restarted: run 'systemctl restart bench' when ready"
REMOTE
