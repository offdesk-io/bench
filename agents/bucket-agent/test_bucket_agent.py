#!/usr/bin/env python3
"""Checks on the bucket agents' runner, with a fake `claude` and no spend.

Which sub-tasks a bucket's agent takes and which it leaves and why, a
plan-first bucket planning and then waiting for review, a free-rein one going
straight to the work, the hours of a scheduled bucket, the on-assign wake and
its lock, and the guards: todo.md never written, no plan approved on arrival,
nothing done outside the project folder kept. Everything happens under a
scratch data root; the real lists are never read.

    python3 agents/bucket-agent/test_bucket_agent.py
"""

import datetime as dt
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile

TMP = tempfile.mkdtemp(prefix="bucket-agent-test-")
DATA = os.path.join(TMP, "data")
# Before anything imports paths.py, which reads it once.
os.environ["TODOS_DATA_ROOT"] = DATA
os.environ["PLANNING_DATASET"] = "t"
os.environ["AGENTS_FENCES"] = os.path.join(TMP, "fences.json")
os.environ["AGENTS_RUNNER_QUIET"] = "1"
os.environ["IMPLEMENT_IMPROVE_DIR"] = os.path.join(TMP, "no-improve-agent")
os.environ.pop("BUCKET_AGENT_TRIGGER", None)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "core"))
import bench_root  # noqa: E402
for _pk in (bench_root.packages(), os.path.join(os.path.expanduser("~"), "Code", "PACKAGES")):
    if os.path.isdir(os.path.join(_pk, "agents-engine", "python")):
        sys.path.insert(0, os.path.join(_pk, "agents-engine", "python"))
        os.environ.setdefault("BENCH_PACKAGES", _pk)
        break
sys.path.insert(0, HERE)

import hooks  # noqa: E402
import agent_runs  # noqa: E402
import bucket_wake  # noqa: E402
import guard  # noqa: E402
import paths  # noqa: E402
import plan_types  # noqa: E402
import plans  # noqa: E402
import tick_queue  # noqa: E402
from agents_engine.runner import core, settings as runner_settings  # noqa: E402

FAILED = []
TARGET = {"id": "t"}
DAY = dt.date.today()
NOW_HOUR = dt.datetime.now().hour
OTHER_HOUR = (NOW_HOUR + 3) % 24


def check(name, got, want):
    if got != want:
        FAILED.append("%s\n    got  %r\n    want %r" % (name, got, want))


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


SECTIONS = {
    "What this agent is for": "Drafts the weekly newsletter.",
    "The processes I run in this bucket": "**Newsletter.** Fridays, a draft in the project folder.",
    "Guidelines it follows": "GUIDELINE-MARK: British English, under 300 words.",
    "What it may touch": "MAY-MARK: the newsletter's project folder.",
    "What it must never touch": "NEVER-MARK: the mailing list. Nothing is sent.",
    "What good looks like here": "A draft I send with one edit.",
}


def definition(mode, start="on-assign", drop=None):
    text = "---\nmode: %s\nstart: %s\n---\n# Bucket\n\nOne line.\n\n" % (mode, start)
    for heading, body in SECTIONS.items():
        text += "## %s\n\n%s\n\n" % (heading, "" if heading == drop else body)
    return text


def bucket(list_, name, text):
    write(os.path.join(DATA, list_, "buckets", name, "%s.md" % name), text)


def task(tid, title, agent, kinds=("plan", "plan-review", "implement", "work-review"), done=(), plan=None,
         project=None, extra=""):
    """A task handed to `agent`, with the sub-tasks a handover lays out and those
    in `done` ticked."""
    lines = ["- [ ] **%s** [impact:: high] [effort:: M] [to:: %s] `id:%s`%s" % (title, agent, tid, extra)]
    if project:
        lines.append("  - Project: %s" % project)
    titles = {"plan": "Plan", "plan-review": "Review the plan", "implement": "Implement",
              "work-review": "Review the work"}
    before = ""
    for n, kind in enumerate(kinds):
        who = agent if kind in ("plan", "implement") else "Morgan"
        lines.append("  - [%s] %s [to:: %s] `#%s-%s`%s `id:%sp%d`" % (
            "x" if kind in done else " ", titles[kind], who, tid, kind,
            (" `blocked-by:%s-%s`" % (tid, before)) if before else "", tid[:4], n + 1))
        if kind == "plan-review" and plan:
            lines.append("    - Plan: plans/%s" % plan)
        before = kind
    return "\n".join(lines)


def doc(*tasks_):
    return "# List\n\n## 1. News\n\n### Doing\n\n" + "\n".join(tasks_) + "\n"


def set_todo(text, list_="t"):
    """Write todo.md as the board would: the file and its known copy together."""
    write(os.path.join(DATA, list_, "todo.md"), text)
    write(os.path.join(DATA, list_, ".known-todo.md"), text)


def by_title(items):
    return {i["title"]: i for i in items}


def why(item, target=TARGET):
    got = hooks.eligible(item, target)
    return got["why"] if isinstance(got, dict) else got


def reset_queue(list_="t"):
    write(os.path.join(DATA, list_, "tick-queue.json"), "[]")


FAKE = r'''#!/usr/bin/env python3
import json, os, re, sys
prompt = sys.argv[sys.argv.index("-p") + 1]
log = os.environ.get("FAKE_CLAUDE_LOG")
if log:
    with open(log, "a") as fh:
        fh.write(json.dumps({"prompt": prompt, "argv": sys.argv[1:]}) + "\n")
if os.environ.get("FAKE_WRITE_TODO"):
    with open(os.environ["FAKE_WRITE_TODO"], "a") as fh:
        fh.write("- [ ] **Written by an agent**\n")
if "--- This run: plan ---" in prompt:
    text = ("---\ntype: write-up\nsummary: Draft it from the notes.\n---\n\n## Context\n\nRead things.\n\n"
            "## Summary\n\nDraft it.\n\n## Findings\n\n- **Notes exist.** In the task.\n\n"
            "## Proposed plan\n\nClaude's steps.\n\n1. Draft it.\n\n## Needs you\n\nNothing, it is ready.\n")
else:
    m = re.search(r"Only inside this folder, and only new files:\n(.+)\n", prompt)
    if m:
        os.makedirs(m.group(1), exist_ok=True)
        with open(os.path.join(m.group(1), "newsletter.md"), "w") as fh:
            fh.write("A draft.\n")
    text = "Wrote newsletter.md.\nSUMMARY: Wrote the draft.\nOUTCOME: done\n"
print(json.dumps({"result": text, "session_id": "sess-1", "total_cost_usd": 0.01}))
'''


def fake_claude():
    path = os.path.join(TMP, "claude")
    write(path, FAKE)
    os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC)
    os.environ["AGENTS_RUNNER_CLAUDE"] = path
    os.environ["FAKE_CLAUDE_LOG"] = os.path.join(TMP, "claude-calls.jsonl")
    return os.environ["FAKE_CLAUDE_LOG"]


def calls():
    try:
        return [json.loads(l) for l in open(os.environ["FAKE_CLAUDE_LOG"], encoding="utf-8")]
    except OSError:
        return []


def agent():
    return core.Agent(hooks, HERE)


def run_board(target_id="t"):
    return core.run_target(agent(), {"id": target_id}, trigger="manual")


def set_hours(target_id, on, hours):
    err = runner_settings.save(hooks.STATE, hooks, target_id, {"on": on, "hours": hours})
    assert err is None, err


def setup():
    write(os.path.join(DATA, ".current"), "t")
    write(os.path.join(DATA, "t", "buckets", "README.md"),
          "| Heading in `todo.md` | Stream | Brief |\n| --- | --- | --- |\n"
          "| `## 1. News` | `news` | `news/news.md` |\n")
    bucket("t", "news", definition("plan-first"))
    bucket("t", "ops", definition("free-rein"))
    bucket("t", "night", definition("plan-first", "scheduled"))
    bucket("t", "half", definition("plan-first", drop="Guidelines it follows"))
    bucket("t", "t-tasks", definition("free-rein"))
    set_todo(doc())
    write(os.path.join(DATA, "u", "todo.md"), "# U\n")
    bucket("u", "news", definition("free-rein"))
    write(os.path.join(DATA, "settings.json"), json.dumps({"boards": {"u": {"agents": False}}}))
    fake_claude()


# --- names and the queue ----------------------------------------------------------


def test_names_and_queue():
    rows = {r["bucket"]: r for r in hooks.bucket_rows("t")}
    check("each bucket's agent is named [List] [bucket] agent", rows["news"]["name"], "T news agent")
    check("the list word is dropped where the bucket starts with it", rows["t-tasks"]["name"], "T tasks agent")
    set_todo(doc(
        task("aaaa01", "Plan the newsletter", "T news agent"),
        task("bbbb01", "Half-defined bucket", "T half agent"),
        task("cccc01", "Owner's review only", "T news agent", done=("plan",)),
        task("dddd01", "Old Plan agent task", "Plan agent"),
        task("eeee01", "Not until next year", "T news agent", extra=" [start:: %d-01-01]" % (DAY.year + 1)),
    ))
    items = by_title(hooks.items(TARGET))
    check("only open Plan or Implement sub-tasks of the list's bucket agents, their blocker ticked",
          sorted(items), ["Half-defined bucket", "Not until next year", "Plan the newsletter"])
    a = items["Plan the newsletter"]
    check("the item is the Plan sub-task, with its agent", (a["sub"], a["kind"], a["name"]),
          ("aaaap1", "plan", "T news agent"))
    check("a ready plan-first bucket on-assign is taken", why(a), None)
    check("a bucket that is not ready is skipped, saying what is missing",
          why(items["Half-defined bucket"]), "the T half agent is not ready: its definition is missing guidelines")
    check("a start: not yet arrived is skipped", why(items["Not until next year"]).startswith("not startable until"),
          True)


# --- plan-first: plan, then wait for review, then the work ------------------------


def test_plan_first():
    reset_queue()
    set_todo(doc(task("aaaa02", "Write the newsletter", "T news agent")))
    before = read(paths.todo_path())
    run = run_board()
    check("the plan run ran", [d["label"] for d in run["did"]], ["planned"])
    path = os.path.join(paths.plans_dir(), "write-the-newsletter-aaaa02.md")
    front = plans.read_front(path)
    check("the plan is written to data/<list>/plans/", os.path.isfile(path), True)
    check("named for the agent that wrote it", (front.get("agent"), front.get("type")), ("T news agent", "write-up"))
    q = tick_queue.read(paths.tick_queue_path())
    check("its Plan sub-task's tick is queued, as its agent",
          [(e["sub"], e["by"], e.get("plan")) for e in q], [("aaaap1", "T news agent", os.path.basename(path))])
    check("no plan type is approved on arrival: the tick carries no type", [e.get("type") for e in q], [None])
    check("todo.md is never written", read(paths.todo_path()), before)
    prompt = calls()[-1]["prompt"]
    check("the prompt carries the one tracked definition", "You are the agent for one bucket" in prompt, True)
    check("and the bucket's guidelines, may and never touch, verbatim",
          all(m in prompt for m in ("GUIDELINE-MARK", "MAY-MARK", "NEVER-MARK")), True)
    check("and names no per-bucket agent definition", "--agent" in calls()[-1]["argv"], False)

    # The board applies the tick. Until the owner ticks Review the plan, there is nothing to do.
    reset_queue()
    set_todo(doc(task("aaaa02", "Write the newsletter", "T news agent", done=("plan",),
                      plan=os.path.basename(path))))
    check("with the plan ticked and its review open, it waits for the owner", hooks.items(TARGET), [])
    n = len(calls())
    run = run_board()
    check("and a run does nothing", (run["did"], len(calls())), ([], n))
    check("nor ticks the review itself", tick_queue.read(paths.tick_queue_path()), [])

    # The owner approves: the work runs, into the project folder.
    set_todo(doc(task("aaaa02", "Write the newsletter", "T news agent", done=("plan", "plan-review"),
                      plan=os.path.basename(path))))
    items = hooks.items(TARGET)
    check("once the review is ticked, Implement is the item", [(i["kind"], i["plan_rel"]) for i in items],
          [("implement", os.path.basename(path))])
    run = run_board()
    check("the work ran", [d["label"] for d in run["did"]], ["done"])
    folder = os.path.join(DATA, "t", "projects", "write-the-newsletter")
    check("its file is in the task's project folder", os.path.isfile(os.path.join(folder, "newsletter.md")), True)
    q = tick_queue.read(paths.tick_queue_path())
    check("the Implement sub-task's tick is queued, and only that", [(e["sub"], e["by"]) for e in q],
          [("aaaap3", "T news agent")])
    check("its report is added to the plan", "## What the implementing agent did" in read(path), True)
    work_prompt = calls()[-1]["prompt"]
    check("the work prompt names the approved plan", path in work_prompt, True)
    check("and carries the bucket's never-touch section", "NEVER-MARK" in work_prompt, True)
    rec = agent_runs.get("aaaap3", path=paths.agent_runs_path())
    check("the card's run record says done, under the agent's name", (rec.get("state"), rec.get("agent")),
          ("done", "T news agent"))


def test_replan_after_send_back():
    """A replan overwrites the same file in place, History and all, and the
    prompt carries why the last one was sent back."""
    reset_queue()
    lines = task("aaaa03", "Plan again", "T news agent").split("\n")
    set_todo(doc("\n".join(lines)))
    run_board()
    path = os.path.join(paths.plans_dir(), "plan-again-aaaa03.md")
    check("revision 1", plans.read_front(path).get("revision"), "1")
    lines.insert(2, "    - feedback: too long, cut it to two steps")
    reset_queue()
    set_todo(doc("\n".join(lines)))
    run_board()
    check("a send-back replans into the same file as revision 2", plans.read_front(path).get("revision"), "2")
    told = plans.read_sections(path, ("History",))["history"]
    check("History keeps both revisions", len([l for l in told.splitlines() if l.startswith("- **")]), 2)
    check("the prompt says why it was sent back", "too long, cut it to two steps" in calls()[-1]["prompt"], True)


# --- free-rein: straight to the work ----------------------------------------------


def test_free_rein():
    reset_queue()
    set_todo(doc(task("ffff01", "Tidy the ops notes", "T ops agent", kinds=("implement", "work-review"))))
    items = hooks.items(TARGET)
    check("a free-rein handover's Implement is the item, with no plan", [(i["kind"], i["plan"]) for i in items],
          [("implement", "")])
    check("and is taken", why(items[0]), None)
    opts = hooks.options(items[0], TARGET)
    folder = os.path.realpath(os.path.join(DATA, "t", "projects", "tidy-the-ops-notes"))
    check("no Bash", "Bash" in opts["disallowed"], True)
    check("Write and Edit only on the project folder",
          [t for t in opts["tools"] if t.startswith(("Write", "Edit"))],
          ["Write(/%s/**)" % folder, "Edit(/%s/**)" % folder])
    check("no permission mode that accepts an edit anywhere", opts.get("permission_mode"), None)
    run = run_board()
    check("it goes straight to the work", [d["label"] for d in run["did"]], ["done"])
    check("the task itself is the instruction", "the task below is the instruction" in calls()[-1]["prompt"], True)
    check("its tick is queued as its agent", [(e["sub"], e["by"]) for e in tick_queue.read(paths.tick_queue_path())],
          [("ffffp1", "T ops agent")])
    n = len(calls())
    run = run_board()
    check("its tick waiting keeps it from running again", (run["did"], len(calls())), ([], n))
    # A plan sub-task on a free-rein bucket is not planned.
    reset_queue()
    set_todo(doc(task("ffff02", "Planned for ops", "T ops agent")))
    check("a free-rein bucket's agent does not plan",
          why(hooks.items(TARGET)[0]), "the T ops agent is free-rein, so it does not plan: hand the task over again")


# --- the board's switch and a scheduled bucket's hours ----------------------------


def test_board_off():
    set_todo(doc(task("uuuu01", "On the quiet board", "U news agent", kinds=("implement", "work-review"))), "u")
    target = {"id": "u"}
    items = hooks.items(target)
    check("a board with its agents off still lists the work", len(items), 1)
    check("and skips it, saying why", why(items[0], target), hooks.OFF)
    n = len(calls())
    run = run_board("u")
    check("a run on it does nothing", (run["did"], len(calls())), ([], n))
    check("the card says so", len(hooks.problems(target)), 1)
    check("another board is not touched", hooks.problems(TARGET), [])


def test_scheduled():
    reset_queue()
    set_todo(doc(task("ssss01", "Night work", "T night agent")))
    item = hooks.items(TARGET)[0]
    set_hours("t", False, [NOW_HOUR])
    check("a scheduled bucket on a board switched off is skipped",
          why(item), "the T night agent starts only in this board's scheduled hours, and none are set")
    set_hours("t", True, [OTHER_HOUR])
    check("outside the board's hours it is skipped",
          why(item), "the T night agent starts only in this board's scheduled hours, and %02d:00 is not one"
          % NOW_HOUR)
    n = len(calls())
    run_board()
    check("and nothing runs", len(calls()), n)
    rows = {r["bucket"]: r for r in hooks.bucket_rows("t")}
    check("the card gives a scheduled bucket the board's hours, and on-assign none",
          (rows["night"]["hours"], rows["news"]["hours"]), ([OTHER_HOUR], None))
    set_hours("t", True, [NOW_HOUR])
    check("inside them it is taken", why(item), None)
    set_hours("t", False, [])


# --- the guards --------------------------------------------------------------------


def test_todo_guard():
    reset_queue()
    set_todo(doc(task("gggg01", "Guarded", "T ops agent", kinds=("implement", "work-review"))))
    os.environ["FAKE_WRITE_TODO"] = paths.todo_path()
    try:
        run = run_board()
    finally:
        del os.environ["FAKE_WRITE_TODO"]
    got = run["did"][0]
    check("an agent writing todo.md fails the run", (got["outcome"], got["label"]), ("failed", "refused"))
    check("and the run stops", run["stopped"], "todo.md changed during the run")
    folder = os.path.join(DATA, "t", "projects", "guarded")
    check("its work is put aside", os.path.exists(os.path.join(folder, "newsletter.md")), False)
    check("and nothing is ticked", tick_queue.read(paths.tick_queue_path()), [])

    since = dt.datetime.now().astimezone() - dt.timedelta(seconds=1)
    before = plans.file_hash(paths.todo_path())
    set_todo(read(paths.todo_path()) + "- [ ] **The owner, at the board**\n")
    check("a save by the board while it runs is not the agent's", plans.todo_moved(before, since), None)
    with open(paths.activity_path(), "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"at": dt.datetime.now(dt.timezone.utc).isoformat(), "who": "pa", "name": "pa"}) + "\n")
    check("a write outside the board, already accounted for by the server, is",
          plans.todo_moved(before, since), "todo.md was written outside the board during the run")


def test_figma_and_plan_checks():
    for name, kind, needs in (("fig.md", "figma", "no"), ("ask.md", "write-up", "yes")):
        write(os.path.join(paths.plans_dir(), name),
              "---\ntitle: x\nneeds_you: %s\ntype: %s\nsummary: S.\n---\n\nBody.\n" % (needs, kind))
    done = ("plan", "plan-review")
    set_todo(doc(task("hhhh01", "A Figma plan", "T news agent", done=done, plan="fig.md"),
                 task("hhhh02", "Asks first", "T news agent", done=done, plan="ask.md"),
                 task("hhhh03", "Plan gone", "T news agent", done=done, plan="gone.md"),
                 task("hhhh04", "Folder nobody approved", "T news agent", done=done, plan="fig.md",
                      project="/nowhere/approved"),
                 task("hhhh05", "Work review given to the agent", "T ops agent", kinds=("implement", "work-review"),
                      done=("implement",)).replace("Review the work [to:: Morgan]",
                                                   "Review the work [to:: T ops agent]")))
    items = by_title(hooks.items(TARGET))
    check("Figma is refused unattended", why(items["A Figma plan"]), hooks.FIGMA_REFUSAL)
    check("a folded plan is not carried out", why(items["Asks first"]), "its plan asks you something first")
    check("a missing plan file is said", "is missing" in why(items["Plan gone"]), True)
    check("a review is never an item, whoever it is assigned to", "Work review given to the agent" in items, False)
    check("no plan type is pre-approved any more", hasattr(plan_types, "PRE_APPROVED"), False)
    check("a type off the list is other", plan_types.read("report"), "other")


def test_guard():
    folder = os.path.join(TMP, "guarded-folder")
    write(os.path.join(folder, "brief.md"), "his brief\n")
    write(os.path.join(folder, "old.md"), "keep me\n")
    watch = os.path.join(DATA, "t")
    state = guard.before(folder, watch=watch)
    write(os.path.join(folder, "brief.md"), "overwritten\n")
    os.remove(os.path.join(folder, "old.md"))
    write(os.path.join(folder, "new.md"), "new\n")
    write(os.path.join(watch, "stray.md"), "outside\n")
    write(os.path.join(watch, "activity.jsonl"), "{}\n")
    write(os.path.join(watch, ".known-todo.md"), "board\n")
    report = guard.after(state, DAY)
    check("a new file in the folder stays", report["added"], ["new.md"])
    check("a file written over is put back", read(os.path.join(folder, "brief.md")), "his brief\n")
    check("a removed file is put back", read(os.path.join(folder, "old.md")), "keep me\n")
    check("a new file outside is moved aside", (report["outside_new"], os.path.exists(os.path.join(watch, "stray.md"))),
          (["stray.md"], False))
    check("what the board writes while it is used is not the agent's", report["outside_changed"], [])
    check("then v2 beside the original", os.path.basename(guard.next_version(os.path.join(folder, "brief.md"))),
          "brief-v2.md")


def test_handovers():
    reset_queue()
    set_todo(doc("- [ ] **Tagged by hand** [to:: T news agent] `id:kkkk01`",
                 "- [ ] **Tagged to a person** [to:: Morgan] `id:kkkk02`"))
    run_board()
    q = tick_queue.read(paths.tick_queue_path())
    check("a task tagged to a bucket's agent with no handover is asked for, as that agent",
          [(e.get("handover"), e.get("to"), e.get("by")) for e in q], [("kkkk01", "T news agent", "T news agent")])
    run_board()
    check("and asked for once", len(tick_queue.read(paths.tick_queue_path())), 1)


# --- the on-assign wake ----------------------------------------------------------


class Proc(object):
    def __init__(self):
        self.done = False

    def poll(self):
        return 0 if self.done else None


def test_wake():
    reset_queue()
    set_todo(doc(task("wwww01", "Start me now", "T ops agent", kinds=("implement", "work-review"))))
    set_todo(doc(task("wwww02", "Quiet board", "U news agent", kinds=("implement", "work-review"))), "u")
    got = hooks.pending(agent())
    check("pending says what an on-assign run would take", got["t"]["run"], ["Start me now"])
    out = subprocess.run([sys.executable, os.path.join(HERE, "run.py"), "--pending", "--target", "t"],
                         capture_output=True, text=True, env=dict(os.environ))
    check("and run.py --pending answers it as JSON for one board", json.loads(out.stdout or "{}").get("run"),
          ["Start me now"])

    started, logged = [], []
    proc = Proc()

    def start(board):
        started.append(board)
        return proc

    running, seen = {}, {}
    pending = lambda b: hooks.pending(agent())[b]  # noqa: E731
    bucket_wake.tick(DATA, ["t", "u"], running, seen, logged.append, pending=pending, start=start)
    check("the wake starts a run on a board whose on-assign bucket holds work", started, ["t"])
    check("and not on a board whose agents are off", "u" in started, False)
    bucket_wake.tick(DATA, ["t", "u"], running, seen, logged.append, pending=pending, start=start)
    check("one run at a time per board: no second while the first is going", started, ["t"])
    proc.done = True
    lock = bucket_wake.lock_path(DATA, "t")
    os.makedirs(lock, exist_ok=True)
    write(os.path.join(lock, "pid"), str(os.getpid()))
    bucket_wake.tick(DATA, ["t"], running, seen, logged.append, pending=pending, start=start)
    check("nor while the runner's own lock is held by a live run", started, ["t"])
    shutil.rmtree(lock)
    check("the runner takes the same lock", hooks.lock_path("t"), lock)
    bucket_wake.tick(DATA, ["t"], running, seen, logged.append, pending=pending, start=start)
    check("once it is free, the next tick starts again", started, ["t", "t"])

    set_todo(doc(task("wwww03", "Not ready yet", "T half agent", kinds=("implement", "work-review"))))
    running, seen, logged[:] = {}, {}, []
    bucket_wake.tick(DATA, ["t"], running, seen, logged.append, pending=pending, start=start)
    check("work for a bucket that is not ready starts nothing", started, ["t", "t"])
    check("and logs why, once", len([l for l in logged if "not ready" in l]), 1)
    bucket_wake.tick(DATA, ["t"], running, seen, logged.append, pending=pending, start=start)
    check("not again on the next tick", len([l for l in logged if "not ready" in l]), 1)

    set_todo(doc(task("wwww04", "Scheduled one", "T night agent")))
    check("a scheduled bucket's work never starts the on-assign wake", hooks.pending(agent())["t"]["run"], [])

    for env in ({"TODOS_DATA_ROOT": DATA}, {"BENCH_AGENTS": "0"}):
        saved = {k: os.environ.get(k) for k in env}
        os.environ.update(env)
        try:
            check("the wake never starts with %s" % env, bucket_wake.start(DATA), None)
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v


def test_on_assign_failure_waits():
    """A failed on-assign item waits for a change or a retry, rather than
    being tried again every minute."""
    reset_queue()
    set_todo(doc(task("xxxx01", "Fails once", "T ops agent", kinds=("implement", "work-review"))))
    item = hooks.items(TARGET)[0]
    a = agent()
    a.save_ledger("t", {item["id"]: {"last": "failed", "fingerprint": item["fingerprint"], "why": "boom"}})
    got = hooks.eligible(item, TARGET)
    check("a failed on-assign item is held until it changes", (got or {}).get("kind"), "unchanged")
    agent_runs.fail(item["sub"], "boom", path=paths.agent_runs_path())
    agent_runs.retry(item["sub"], path=paths.agent_runs_path())
    check("a retry from the board releases it", hooks.eligible(hooks.items(TARGET)[0], TARGET), None)
    a.save_ledger("t", {})


def test_wiring():
    spec = json.load(open(os.path.join(HERE, "agent.json"), encoding="utf-8"))
    check("agent.json is contract 1.7, id bucket-agent", (spec["contract"], spec["id"], spec["name"]),
          ("1.7", "bucket-agent", "Bucket agents"))
    check("every command points at run.py, the wake included",
          (spec.get("wake"), all(v[1] == "run.py" for v in spec.values() if isinstance(v, list))),
          (["python3", "run.py", "--wake"], True))
    for old in ("plan-agent", "implement-agent"):
        spec = json.load(open(os.path.join(ROOT, "agents", old, "agent.json"), encoding="utf-8"))
        check("the retired %s is no longer woken" % old, "wake" in spec, False)
    state = core.Agent(hooks, HERE)
    check("the runner's state lives under the data root", state.state_dir.startswith(DATA), True)
    card = hooks.card({"id": "t"}, {"problems": [], "detail": {"groups": []}})
    check("the card reports each bucket: name, ready or missing, mode, start, hours",
          sorted(card["buckets"][0]), ["bucket", "hours", "missing", "mode", "name", "ready", "start"])
    src = open(os.path.join(ROOT, "kanban", "server.py"), encoding="utf-8").read()
    check("the board server starts the on-assign wake", "bucket_wake.start(" in src, True)


def main():
    setup()
    try:
        for fn in (test_names_and_queue, test_plan_first, test_replan_after_send_back, test_free_rein,
                   test_board_off, test_scheduled, test_todo_guard, test_figma_and_plan_checks, test_guard,
                   test_handovers, test_wake, test_on_assign_failure_waits, test_wiring):
            try:
                fn()
            except Exception as exc:  # noqa: BLE001
                import traceback
                FAILED.append("%s raised %s: %s\n%s" % (fn.__name__, type(exc).__name__, exc,
                                                        traceback.format_exc()))
    finally:
        shutil.rmtree(TMP, ignore_errors=True)
    if FAILED:
        print("%d failed:\n" % len(FAILED))
        for f in FAILED:
            print("  " + f)
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
