#!/usr/bin/env bash
# Install the pipeline's deploy command on the server and let one key run it.
# Run from the Mac. Run it again after changing deploy-on-server.sh or
# deploy-forced-command.sh, since the server runs its installed copies, never
# the checkout's.
#
#   DEPLOY_HOST=<ssh host> scripts/install-deploy-key.sh <public-key-file>
#
# Copies both scripts to /usr/local/lib/bench-deploy/ (root-owned, 755), and
# replaces any earlier deploy-key line in root's authorized_keys with:
#   restrict,command="/usr/local/lib/bench-deploy/deploy-forced-command.sh" <key>

set -euo pipefail
HOST="${DEPLOY_HOST:?set DEPLOY_HOST to the ssh host of the server}"
PUB="${1:?usage: DEPLOY_HOST=<host> scripts/install-deploy-key.sh <public-key-file>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR=/usr/local/lib/bench-deploy

KEY="$(tr -d '\n' < "$PUB")"
[[ "$KEY" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ [A-Za-z0-9@._-]+)?$ ]] \
  || { echo "Expected one ssh-ed25519 public key in $PUB" >&2; exit 2; }

for f in deploy-on-server.sh deploy-forced-command.sh; do
  ssh "$HOST" "install -d -o root -g root -m 755 $DIR && cat > $DIR/.$f.new && install -o root -g root -m 755 $DIR/.$f.new $DIR/$f && rm $DIR/.$f.new" < "$HERE/$f"
  echo "installed $DIR/$f"
done

printf 'restrict,command="%s/deploy-forced-command.sh" %s\n' "$DIR" "$KEY" | ssh "$HOST" '
  set -euo pipefail
  f=/root/.ssh/authorized_keys
  install -d -m 700 /root/.ssh; touch "$f"; chmod 600 "$f"
  { grep -v "bench-deploy/deploy-forced-command.sh" "$f" || true; cat; } > "$f.new"
  chmod 600 "$f.new"; mv "$f.new" "$f"
  grep -c "bench-deploy/deploy-forced-command.sh" "$f" | sed "s/^/deploy-key lines: /"'
