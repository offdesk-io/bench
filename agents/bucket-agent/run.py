#!/usr/bin/env python3
"""The bucket agents' entry point. A run is the shared runner's
(PACKAGES/agents-engine/RUNNER.md); this puts it on the path and hands it
hooks.py. `python3 run.py --help` lists the runner's commands. One more is
this agent's own, for core/bucket_wake.py:

    python3 run.py --pending --target <list>   what an on-assign run would do now, as JSON
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(HERE)), "core"))
import bench_root  # noqa: E402
sys.path.insert(0, os.path.join(bench_root.packages(), "agents-engine", "python"))
sys.path.insert(0, HERE)

import hooks  # noqa: E402
from agents_engine.runner import main  # noqa: E402
from agents_engine.runner.core import Agent  # noqa: E402


def pending(argv):
    target = argv[argv.index("--target") + 1] if "--target" in argv[:-1] else None
    agent = Agent(hooks, HERE)
    got = hooks.pending(agent)
    print(json.dumps(got.get(target, {}) if target else got))
    return 0


if __name__ == "__main__":
    if "--pending" in sys.argv[1:]:
        sys.exit(pending(sys.argv[1:]))
    sys.exit(main(hooks, HERE))
