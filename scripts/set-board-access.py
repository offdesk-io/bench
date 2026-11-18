#!/usr/bin/env python3
"""Say who may see a board, for a board made before sign-in was on.

    scripts/set-board-access.py offdesk --owner tiagopedras+bench@example.com --team offdesk
    scripts/set-board-access.py offdesk --person someone@example.com
    scripts/set-board-access.py offdesk            # print what it has now

With BENCH_AUTH=header a board without data/<board>/access.json is visible to
nobody, so each board already on a server needs this once. After that its
owner changes the sharing from the board's Settings. `--owner` is needed the
first time; later runs keep the owner and add the teams and people given, or
replace them with `--replace`.

Reads $TODOS_DATA_ROOT like the server, else the checkout's data/. Writes the
file only; nothing needs restarting, since the server reads it on every request.
"""

import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "core"))
import board_access  # noqa: E402


def main(argv=None):
    ap = argparse.ArgumentParser(description="Set who may see a Bench board.")
    ap.add_argument("board", help="the board's folder name under data/")
    ap.add_argument("--owner", help="the owner's email; needed when the board has no access.json")
    ap.add_argument("--team", action="append", default=[], help="a team id that may see it (repeatable)")
    ap.add_argument("--person", action="append", default=[], help="an email that may see it (repeatable)")
    ap.add_argument("--replace", action="store_true", help="replace the teams and people rather than add to them")
    args = ap.parse_args(argv)

    data_root = os.environ.get("TODOS_DATA_ROOT") or os.path.join(ROOT, "data")
    board_dir = os.path.join(data_root, args.board)
    if args.board.startswith((".", "_")) or os.sep in args.board \
            or not os.path.isfile(os.path.join(board_dir, "todo.md")):
        print("There is no board called %s under %s." % (args.board, data_root), file=sys.stderr)
        return 2

    was = board_access.read(board_dir)
    if not (args.owner or args.team or args.person):
        print(json.dumps(was, indent=2) if was else "%s has no access.json: nobody sees it when signed in." % args.board)
        return 0

    owner = args.owner or (was or {}).get("owner")
    if not owner:
        print("%s has no owner yet; give one with --owner." % args.board, file=sys.stderr)
        return 2
    keep = was if was and not args.replace else {"people": [], "teams": []}
    record, err = board_access.clean(owner, keep["people"] + args.person, keep["teams"] + args.team)
    if err:
        print(err, file=sys.stderr)
        return 2
    board_access.write(board_dir, record)
    print(json.dumps(record, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
