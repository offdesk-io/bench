#!/usr/bin/env bash
# The only thing the pipeline's deploy key can run. root's authorized_keys
# names it with `restrict,command="..."`, so whatever the client asks for
# arrives here as SSH_ORIGINAL_COMMAND and is never run as a command.
#
# It deploys one full 40-character commit id with --apply, through the
# installed copy of deploy-on-server.sh, and refuses everything else. That
# script refuses, after its fetch, a commit that is not on origin/main.
# Installed by scripts/install-deploy-key.sh, with deploy-on-server.sh beside it.

set -uo pipefail
DEPLOY_SCRIPT="${BENCH_DEPLOY_SCRIPT:-/usr/local/lib/bench-deploy/deploy-on-server.sh}"
ref="${SSH_ORIGINAL_COMMAND-}"

if ! [[ "$ref" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Refused: this key only deploys one full commit id." >&2
  exit 2
fi

exec env BENCH_DEPLOY_ONLY_ON=main bash "$DEPLOY_SCRIPT" 1 /opt/agency/bench /opt/agency/PACKAGES "$ref"
