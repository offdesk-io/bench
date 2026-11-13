#!/usr/bin/env python3
"""Where each agent run on a sub-task stands, for the card's status line.

An agent never writes todo.md, so the board cannot learn from the list whether
its agent has started on a task, failed on it or finished it. The tick
queue says only "finished". This file says the rest, one record per sub-task,
in `data/<dataset>/agent-runs.json` beside the plans:

    {"version": 1, "subs": {
      "aa0001": {"sub": "aa0001", "task": "ab12cd", "title": "Write the brief",
                 "agent": "Personal family agent", "state": "done", "at": "2026-09-27T02:05:11",
                 "started": "2026-09-27T02:03:40", "label": "planned",
                 "summary": "...", "plan": "ab12cd-write-the-brief.md"}}}

`state` is one of:

- `running`   started and not yet landed. One left standing for hours is a run
              that died without saying so, and the board reads it as failed.
- `done`      landed. `label` is the agent's own word for it (planned, needs a
              decision, done, built).
- `failed`    errored or gave up. `error` holds its output, which the board
              shows as the log.
- `queued`    the owner asked for a retry from the board. `retry` holds when, and the
              agents fold it into the item's fingerprint, so a run the shared
              runner had set aside is tried again.

Work on an Implement sub-task also leaves `output`: what it produced, for the activity
feed on the sub-task's panel.

    {"files": ["brief.md"], "project": "write-the-brief",
     "drafts": [{"name": "note-to-sam.draft.md", "text": "..."}],
     "branch": {"repo": "/path", "name": "implement/2026-09-27", "commit": "abc1234",
                "commits": 1, "summary": "..."},
     "figma": "https://www.figma.com/design/..."}

The agents write it; the board only reads it, except for two requests of the owner's
through kanban/server.py: retry, and clear (taking the task back). Every write
is under a lock, read-modify-write of the one record, so the bucket agents,
the `do` skill and the board never overwrite each other's rows.

    python3 core/agent_runs.py output aa0003 --by "Personal family agent" --file brief.md --project write-the-brief
"""

import argparse
import datetime as dt
import json
import os
import sys

import dataset as _dataset
from platform_calls import Locked as _Locked

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_ROOT = os.environ.get("TODOS_DATA_ROOT") or os.path.join(ROOT, "data")

STATES = ("running", "done", "failed", "queued")
# The most of an error's output kept on the record. Enough for the tail of a
# traceback or a CLI's complaint, not a whole transcript.
MAX_ERROR = 6000
MAX_DRAFT = 6000


def current_dataset():
    return _dataset.current(DATA_ROOT)


def runs_path(dataset=None):
    return os.path.join(DATA_ROOT, dataset or current_dataset(), "agent-runs.json")


def _now(now=None):
    return (now or dt.datetime.now()).replace(microsecond=0).isoformat()



def read(path=None):
    """Every record, by sub-task id. Missing or hand-broken is empty."""
    try:
        with open(path or runs_path(), encoding="utf-8") as fh:
            got = json.load(fh)
    except (OSError, ValueError):
        return {}
    subs = got.get("subs") if isinstance(got, dict) else None
    return {k: v for k, v in subs.items() if isinstance(v, dict)} if isinstance(subs, dict) else {}


def get(sub, path=None):
    return read(path).get(str(sub or "").strip().lower())


def _write(path, subs):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as fh:
        json.dump({"version": 1, "subs": subs}, fh, indent=2, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, path)


def _update(sub, path, fn):
    """Read the file, change one record with fn(record) -> record or None, write it."""
    sub = str(sub or "").strip().lower()
    if not sub:
        return None
    path = path or runs_path()
    with _Locked(path):
        subs = read(path)
        rec = fn(dict(subs.get(sub) or {}, sub=sub))
        if rec is None:
            subs.pop(sub, None)
        else:
            subs[sub] = rec
        _write(path, subs)
    return rec


# Kept across runs: the retry stamp (the agents fingerprint on it, and a stamp
# that vanished would read as a change) and how many times it has failed.
_KEEP = ("retry", "fails")


def start(sub, task, title, agent, path=None, now=None):
    def fn(rec):
        kept = {k: rec[k] for k in _KEEP if k in rec}
        return dict(kept, sub=rec["sub"], task=str(task or ""), title=str(title or ""),
                    agent=agent, state="running", started=_now(now), at=_now(now))
    return _update(sub, path, fn)


def finish(sub, label="", summary="", path=None, now=None, **extra):
    """Landed. `extra` carries `plan` for a plan and `output` for the work."""
    def fn(rec):
        rec.update(state="done", at=_now(now), label=label, summary=summary)
        rec.pop("error", None)
        rec["fails"] = 0
        rec.update({k: v for k, v in extra.items() if v})
        return rec
    return _update(sub, path, fn)


def fail(sub, why, error="", path=None, now=None, notify_path=None, task=None, title=None, agent=None):
    """Failed. Also asks the companion for a banner, for failures only, when
    `notify_path` names the dataset's notify queue. Pressing it opens the
    sub-task, which is where Read the log, Retry and Take it back are."""
    def fn(rec):
        if task and not rec.get("task"):
            rec["task"] = task
        if title and not rec.get("title"):
            rec["title"] = title
        if agent and not rec.get("agent"):
            rec["agent"] = agent
        rec.update(state="failed", at=_now(now), why=str(why or "")[:400],
                   error=str(error or why or "")[-MAX_ERROR:], fails=int(rec.get("fails") or 0) + 1)
        return rec
    rec = _update(sub, path, fn)
    if rec and notify_path:
        _banner(rec, notify_path)
    return rec


def _banner(rec, notify_path):
    sys.path.insert(0, os.path.join(ROOT, "companion"))
    try:
        import notify  # noqa: E402
    except ImportError:
        return
    title = rec.get("title") or "a task"
    body = "Failed on %s" % (title if len(title) < 70 else title[:69].rstrip() + "…")
    if rec.get("why"):
        body += ": %s" % rec["why"][:200]
    notify.queue(rec.get("agent") or "Agent", body, task=rec["sub"], path=notify_path)


def clear(sub, path=None):
    """Forget a sub-task's run: taken back, or finished with."""
    return _update(sub, path, lambda rec: None)


def retry(sub, path=None, now=None):
    """The owner asked for it to be tried again. Only a failed run can be retried."""
    def fn(rec):
        if rec.get("state") not in ("failed", "running"):
            return rec
        rec.update(state="queued", retry=_now(now), at=_now(now))
        return rec
    return _update(sub, path, fn)


def retry_stamp(sub, path=None):
    """The part of an item's fingerprint that a retry changes. '' with no retry."""
    rec = get(sub, path) or {}
    return rec.get("retry") or ""


def set_output(sub, output, by="", path=None, now=None):
    """What the work on a sub-task produced, merged into what is already there."""
    def fn(rec):
        got = dict(rec.get("output") or {})
        for k, v in (output or {}).items():
            if not v:
                continue
            if isinstance(v, list) and isinstance(got.get(k), list):
                got[k] = got[k] + [x for x in v if x not in got[k]]
            else:
                got[k] = v
        rec["output"] = got
        if by and not rec.get("agent"):
            rec["agent"] = by
        rec.setdefault("state", "done")
        rec.setdefault("at", _now(now))
        return rec
    return _update(sub, path, fn)


def read_drafts(folder, names):
    """The `.draft.md` files among `names`, with their text, for the feed to show inline."""
    out = []
    for name in names or []:
        if not str(name).endswith(".draft.md"):
            continue
        try:
            with open(os.path.join(folder, name), encoding="utf-8") as fh:
                out.append({"name": name, "text": fh.read()[:MAX_DRAFT]})
        except OSError:
            continue
    return out


def main(argv):
    ap = argparse.ArgumentParser(description="Record what an agent produced on a sub-task.")
    ap.add_argument("action", choices=["output", "show"])
    ap.add_argument("sub", nargs="?", default="", help="the six-character id on the sub-task's line")
    ap.add_argument("--by", default="", help="the agent the sub-task is assigned to")
    ap.add_argument("--project", default="", help="the project folder the files are in")
    ap.add_argument("--file", action="append", default=[], help="a file written, relative to the project folder")
    ap.add_argument("--branch", default="", help="a git branch the work is on")
    ap.add_argument("--repo", default="")
    ap.add_argument("--commit", default="")
    ap.add_argument("--commits", type=int, default=0)
    ap.add_argument("--summary", default="")
    ap.add_argument("--figma", default="", help="a Figma file or branch link")
    ap.add_argument("--dataset")
    args = ap.parse_args(argv)
    path = runs_path(args.dataset)
    if args.action == "show":
        print(json.dumps(get(args.sub, path) if args.sub else read(path), indent=2))
        return 0
    if not args.sub:
        ap.error("output needs the sub-task's id")
    out = {"files": args.file, "project": args.project, "figma": args.figma}
    if args.project and args.file:
        from project_folders import locate  # noqa: E402
        folder = args.project if os.path.isabs(args.project) else locate(
            args.project, os.path.dirname(path))
        out["drafts"] = read_drafts(folder, args.file)
    if args.branch:
        out["branch"] = {"name": args.branch, "repo": args.repo, "commit": args.commit,
                         "commits": args.commits, "summary": args.summary}
    set_output(args.sub, out, by=args.by, path=path)
    print("recorded the output of %s" % args.sub)
    return 0


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    raise SystemExit(main(sys.argv[1:]))
