#!/usr/bin/env bash
# Runs scripts/install.sh against a throwaway HOME and a throwaway clone.
# Nothing here touches the real ~/.claude or the real data/.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home"
mkdir -p "$HOME"
git clone --quiet --local "$HERE" "$TMP/bench"
# Test the script as it is on disk, committed or not.
cp "$HERE/scripts/install.sh" "$TMP/bench/scripts/install.sh"

FAILS=0
check() { # description, command...
  local what="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "ok   $what"; else echo "FAIL $what"; FAILS=$((FAILS + 1)); fi
}

mkdir -p "$TMP/bench/data"
echo "my own profile" > "$TMP/bench/data/profile.md"
INSTALL=(bash "$TMP/bench/scripts/install.sh" --no-wake --no-pip)

"${INSTALL[@]}" > "$TMP/run1.txt"
check "pa skill linked" test -L "$HOME/.claude/skills/pa"
check "pa skill resolves" test -f "$HOME/.claude/skills/pa/SKILL.md"
check "do skill linked" test -L "$HOME/.claude/skills/do"
check "do skill resolves" test -f "$HOME/.claude/skills/do/SKILL.md"
check "pa-agent linked" test -L "$HOME/.claude/agents/pa-agent.md"
check "settings.json created" test -f "$TMP/bench/data/settings.json"
check "existing profile.md untouched" grep -qx "my own profile" "$TMP/bench/data/profile.md"
check "BENCH_ROOT line printed" grep -q "export BENCH_ROOT=" "$TMP/run1.txt"

echo "keep me" > "$TMP/bench/data/settings.json"
"${INSTALL[@]}" > "$TMP/run2.txt"
check "second run changes no links" bash -c '! grep -q "^Linked\|^Created" "$1"' _ "$TMP/run2.txt"
check "second run keeps edited settings.json" grep -qx "keep me" "$TMP/bench/data/settings.json"

rm "$HOME/.claude/skills/pa-board"; mkdir "$HOME/.claude/skills/pa-board"
"${INSTALL[@]}" > "$TMP/run3.txt"
check "real folder skipped and said so" grep -q "^Skipped .*pa-board" "$TMP/run3.txt"
check "real folder still a folder" bash -c '[ ! -L "$1" ]' _ "$HOME/.claude/skills/pa-board"

# The wake step, with a stand-in engine and --dry-run, so launchd is never asked.
mkdir -p "$TMP/PACKAGES/agents-engine/python/agents_engine"
echo 'if argv[0] == "install": root, fences = flag("--root"), flag("--fences")' > "$TMP/PACKAGES/agents-engine/python/agents_engine/wake.py"
bash "$TMP/bench/scripts/install.sh" --yes --dry-run --no-pip > "$TMP/run4.txt"
check "wake installed for this checkout only" grep -q "agents_engine.wake install --root $TMP/bench " "$TMP/run4.txt"
check "with the checkout's own fences file" grep -q -- "--fences $TMP/bench/data/agents/fences.json\$" "$TMP/run4.txt"
check "dry run makes no data/agents" bash -c '[ ! -e "$1" ]' _ "$TMP/bench/data/agents"
# The real engine beside this repo, when it is there: its dry-run plist carries the file.
REAL="$HERE/../PACKAGES/agents-engine/python"
if grep -q '"--fences"' "$REAL/agents_engine/wake.py" 2>/dev/null; then
  PYTHONPATH="$REAL" python3 -m agents_engine.wake install --root "$TMP/bench" \
    --fences "$TMP/bench/data/agents/fences.json" --dry-run > "$TMP/job.plist"
  check "dry-run plist sets AGENTS_FENCES" python3 -c 'import plistlib,sys; j=plistlib.load(open(sys.argv[1],"rb")); assert j["EnvironmentVariables"]["AGENTS_FENCES"]==sys.argv[2]; assert j["ProgramArguments"][-2:]==["--root",sys.argv[3]]' "$TMP/job.plist" "$TMP/bench/data/agents/fences.json" "$TMP/bench"
fi
check "dry run writes no LaunchAgents" bash -c '[ ! -e "$1/Library/LaunchAgents" ]' _ "$HOME"

[ "$FAILS" = 0 ] && echo "All install checks passed." || { echo "$FAILS failed."; exit 1; }
