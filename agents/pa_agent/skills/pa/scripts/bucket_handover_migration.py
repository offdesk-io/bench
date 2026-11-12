#!/usr/bin/env python3
"""Which old handovers move to a bucket's agent, and how. Read-only.

    python3 bucket_handover_migration.py <list>

Before bucket agents, a task was handed to the Plan agent or the Implement
agent. Now each bucket has its own agent (core/bucket_agents.py), and a
handover's Plan and Implement sub-tasks carry that agent's name in `[to::]`.
This prints the change that moves each old handover over, and writes nothing:
the PA applies the changes to todo.md when the owner says yes.

For every open task with `[to:: Plan agent]` or `[to:: Implement agent]` on it
or on one of its sub-tasks, the task's bucket gives the stream, the way the
board maps a heading to a stream (README first, then the heading's own slug),
and the stream gives the bucket's agent. Then:

- plan-first bucket: each old tag becomes the bucket agent's name.
- free-rein bucket: the same, and an open Plan plus Review the plan pair, both
  unticked, is dropped, since the agent does the work without a plan.
- bucket not ready, or no such bucket: nothing moves, and the line says why.
  A bucket that is not ready is offered pa-bucket-setup.

One block per task:

    MOVE  <title> (id) in <stream>, <agent name>, <mode>
          <old line>
       -> <new line>
          <old line>
       -> drop
    SKIP  <title> (id): <reason>
"""

import os
import re
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[5]
sys.path.insert(0, str(_ROOT / "core"))
sys.path.insert(0, str(_ROOT / "agents" / "plan-agent"))
import bucket_agents  # noqa: E402
import settings  # noqa: E402
import todo  # noqa: E402
import plan  # noqa: E402

LEGACY = todo.AGENT_NAMES
TO_TAG = re.compile(r"\[\s*to\s*::\s*([^\]]*?)\s*\]")


def _legacy(to):
    return todo.agent_of(to) in LEGACY


def _retag(line, name):
    return TO_TAG.sub("[to:: %s]" % name, line, count=1)


def _streams(dataset, root):
    readme = os.path.join(bucket_agents.buckets_dir(dataset, root), "README.md")
    return plan.stream_map(readme)


def migrate(dataset, root=None):
    """[{task, id, stream, agent, mode, status, reason, changes}] for each open
    task still handed to an old agent. `changes` is [(old line, new line or
    None for a drop)]. status is `move` or `skip`."""
    root = root or settings.data_root()
    bucket_agents.bucket_names(dataset, root)  # refuses a list that is not one
    with open(os.path.join(root, dataset, "todo.md"), encoding="utf-8") as fh:
        text = fh.read()
    mapping = _streams(dataset, root)
    known = set(bucket_agents.bucket_names(dataset, root))
    out = []
    for task in todo.parse_doc(text):
        if task.done:
            continue
        body = task.body
        subs = []
        for i, line in enumerate(body):
            m = todo.SUB_RE.match(line)
            if m:
                step = todo.parse_task(["- [%s] %s" % (m.group(2), m.group(3))])
                subs.append((i, line, step))
        legacy_subs = [s for s in subs if _legacy(s[2].to)]
        if not legacy_subs and not _legacy(task.to):
            continue
        key = plan.bucket_slug(task.bucket)
        stream = mapping.get(key, key)
        item = {"task": task.title, "id": task.stable_id, "stream": stream, "agent": "",
                "mode": "", "status": "skip", "reason": "", "changes": []}
        out.append(item)
        if not stream or stream not in known:
            item["reason"] = "no bucket: %r has no folder under buckets/" % (stream or task.bucket)
            continue
        b = bucket_agents.load(dataset, stream, root)
        item["agent"], item["mode"] = b["name"], b["mode"] or ""
        if not b["ready"]:
            item["reason"] = ("bucket %s is not ready (missing: %s), offer pa-bucket-setup"
                              % (stream, ", ".join(b["missing"])))
            continue
        drop = set()
        if b["mode"] == "free-rein":
            by_slug = {s[2].slug: s for s in subs}
            p, r = by_slug.get("%s-plan" % task.stable_id), by_slug.get("%s-plan-review" % task.stable_id)
            if p and r and not p[2].done and not r[2].done and _legacy(p[2].to):
                drop = {p[0], r[0]}
        if _legacy(task.to):
            line = task.raw
            item["changes"].append((line.strip(), _retag(line, b["name"]).strip()))
        for i, line, step in subs:
            if i in drop:
                item["changes"].append((line.strip(), None))
            elif _legacy(step.to):
                item["changes"].append((line.strip(), _retag(line, b["name"]).strip()))
        item["status"] = "move"
    return out


def render(items, dataset):
    if not items:
        return "%s: no open task is handed to the Plan agent or the Implement agent. Nothing writes." % dataset
    lines = []
    for it in items:
        head = "%s (%s)" % (it["task"], it["id"] or "no id")
        if it["status"] == "skip":
            lines.append("SKIP  %s: %s" % (head, it["reason"]))
            continue
        lines.append("MOVE  %s in %s, %s, %s" % (head, it["stream"], it["agent"], it["mode"]))
        for old, new in it["changes"]:
            lines.append("      %s" % old)
            lines.append("   -> %s" % ("drop" if new is None else new))
    moves = sum(1 for it in items if it["status"] == "move")
    lines.append("%d to move, %d skipped. Nothing was written." % (moves, len(items) - moves))
    return "\n".join(lines)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1 or argv[0].startswith("-"):
        print("usage: python3 bucket_handover_migration.py <list>", file=sys.stderr)
        return 2
    try:
        items = migrate(argv[0])
    except (ValueError, OSError) as err:
        print(err, file=sys.stderr)
        return 2
    print(render(items, argv[0]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
