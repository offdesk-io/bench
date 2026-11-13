#!/usr/bin/env bash
# Sets up a fresh checkout of Bench. Safe to run again: every step checks first.
#
#   scripts/install.sh [--yes] [--no-wake] [--dry-run] [--no-pip]
#
#   --yes       accept the hourly wake without asking
#   --no-wake   skip the hourly wake
#   --dry-run   print each action and change nothing
#   --no-pip    skip the chevron install (used by test-install.sh)
set -euo pipefail

YES=0 NO_WAKE=0 DRY=0 NO_PIP=0
for arg in "$@"; do
  case "$arg" in
    --yes) YES=1 ;;
    --no-wake) NO_WAKE=1 ;;
    --dry-run) DRY=1 ;;
    --no-pip) NO_PIP=1 ;;
    -h|--help) sed -n 2,9p "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILLS="$HOME/.claude/skills"
AGENTS="$HOME/.claude/agents"

say() { echo "$*"; }
# Runs a command, or only prints it under --dry-run.
act() {
  if [ "$DRY" = 1 ]; then say "  would run: $*"; else "$@"; fi
}

# Links $1 at $2. A real file or folder already at $2 is left alone.
link() {
  local src="$1" dest="$2"
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    say "Skipped $dest: a real file or folder is already there."
  elif [ -L "$dest" ] && [ "$(readlink "$dest")" = "$src" ]; then
    say "Already linked: $dest"
  else
    act ln -sfn "$src" "$dest"
    [ "$DRY" = 1 ] || say "Linked $dest"
  fi
}

say "Step 1: checkout is $ROOT"
if [ "$ROOT" != "$(cd "$HOME/Code/bench" 2>/dev/null && pwd || echo none)" ]; then
  say "  This is not ~/Code/bench. Add this line to your shell profile:"
  say "  export BENCH_ROOT=\"$ROOT\""
fi

say "Step 2: skills into $SKILLS"
act mkdir -p "$SKILLS"
for s in "$ROOT"/agents/pa_agent/skills/* "$ROOT"/agents/bucket-agent/skills/do; do
  [ -d "$s" ] || continue
  link "$s" "$SKILLS/$(basename "$s")"
done

say "Step 3: agent definitions"
act mkdir -p "$AGENTS"
link "$ROOT/agents/pa_agent/pa-agent.md" "$AGENTS/pa-agent.md"

say "Step 4: chevron"
if [ "$NO_PIP" = 1 ]; then
  say "  Skipped (--no-pip)."
elif python3 -c 'import chevron' 2>/dev/null; then
  say "Already installed: chevron"
else
  act python3 -m pip install --user chevron
  [ "$DRY" = 1 ] || say "Installed chevron"
fi

say "Step 5: data files"
act mkdir -p "$ROOT/data"
copy_if_absent() {
  if [ -e "$2" ]; then
    say "Already there: $2"
  else
    act cp "$1" "$2"
    [ "$DRY" = 1 ] || say "Created $2"
  fi
}
copy_if_absent "$ROOT/core/settings.example.json" "$ROOT/data/settings.json"
copy_if_absent "$ROOT/agents/pa_agent/profile.example.md" "$ROOT/data/profile.md"

say "Step 6: hourly wake"
ENGINE="$ROOT/../PACKAGES/agents-engine/python"
if [ "$NO_WAKE" = 1 ]; then
  say "  Skipped (--no-wake)."
elif [ ! -d "$ENGINE/agents_engine" ]; then
  say "  agents-engine is not next to this repo. Clone it to $(dirname "$ROOT")/PACKAGES/agents-engine"
  say "  (github.com/tiagopedras/agents-engine), then run this script again."
elif ! grep -q '"--fences"' "$ENGINE/agents_engine/wake.py" 2>/dev/null; then
  say "  This agents-engine has no 'wake install --fences' yet. Skipped."
else
  ENGINE="$(cd "$ENGINE" && pwd)"
  go=0
  if [ "$YES" = 1 ]; then
    go=1
  elif [ "$DRY" = 1 ]; then
    say "  Would ask whether to install the hourly wake (default no)."
  elif [ -t 0 ]; then
    read -r -p "  Install the hourly wake for the scheduled agents? [y/N] " reply || reply=""
    case "$reply" in y|Y|yes|YES) go=1 ;; esac
  fi
  if [ "$go" = 1 ]; then
    # --root keeps the wake to the agents inside this checkout, and --fences
    # keeps the daily ceiling and spend records in its data/ (gitignored).
    # kanban/server.py points its own runs at the same file.
    act mkdir -p "$ROOT/data/agents"
    act env PYTHONPATH="$ENGINE" python3 -m agents_engine.wake install --root "$ROOT" \
      --fences "$ROOT/data/agents/fences.json"
    [ "$DRY" = 1 ] || say "Installed the hourly wake"
  elif [ "$DRY" = 0 ]; then
    say "  Skipped. Run this script with --yes to install it later."
  fi
fi

say "Done. Start the board with ./run.command, then open it."
say "Onboarding will ask for your name, holidays and models."
