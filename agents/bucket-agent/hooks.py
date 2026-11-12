"""The bucket agents' part of a run. The shared runner does the rest.

`PACKAGES/agents-engine/RUNNER.md` owns the wake, the lock, the budget, the
ledger and the daily log. What is here is which work a bucket's agent takes,
what it is asked, and the guards around what comes back. Built from the Plan
agent's hooks (agents/plan-agent/) and the Implement agent's
(agents/implement-agent/), which this replaces.

- **One target per board.** Every list with a todo.md. `PLANNING_DATASET` is
  set for whichever list a hook is answering about, so paths.py resolves
  against it.
- **The queue** is the board's: every Plan or Implement sub-task assigned to
  one of the list's bucket agents (bucket_work.py), open, with what it waits on
  ticked. Each bucket's agent is defined in its brief,
  `data/<list>/buckets/<bucket>/<bucket>.md` (core/bucket_agents.py).
- **Skipped, with the reason in the day's log:** a bucket whose definition is
  not ready, a board whose agents are off in Bench's Settings, and a
  `start: scheduled` bucket outside the board's hours (set on the agents
  dashboard; its switch off counts as outside them). An on-assign bucket is
  started by core/bucket_wake.py as soon as it holds work, whatever the hours.
- **Plan** (plan-first only): the plan is written to `data/<list>/plans/` and
  the Plan sub-task's tick queued. The owner ticks Review the plan. No plan
  type is approved on arrival.
- **Implement**: the work, inside the bucket's guidelines, what it may touch
  and what it must never touch, pasted into the prompt as the owner wrote them.
  Code goes on an `implement/<date>` branch through improve-agent's git module;
  Figma is refused; anything else adds new files to the task's project folder,
  with guard.py putting back anything it was not allowed to do. Its tick is
  queued, and Review the work stays the owner's.

It never writes todo.md (plans.todo_moved() checks around every run), ticks
only through core/tick_queue.py, and never sends, pushes, merges or restarts
anything. The agent definition is one tracked file, bucket-agent.md, read into
the prompt with the bucket's own sections under it.
"""

import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
for _p in (os.path.join(ROOT, "core"), HERE):
    if _p in sys.path:
        sys.path.remove(_p)
    sys.path.insert(0, _p)

import agent_runs  # noqa: E402
import bucket_agents  # noqa: E402
import bucket_wake  # noqa: E402
import bucket_work  # noqa: E402
import guard  # noqa: E402
import owner_profile  # noqa: E402
import paths  # noqa: E402
import plan_types  # noqa: E402
import plans  # noqa: E402
import project_folders  # noqa: E402
import settings  # noqa: E402
import tick_queue  # noqa: E402
import todo  # noqa: E402
import windows  # noqa: E402

ID = "bucket-agent"
NAME = "Bucket agents"
BLURB = ("one agent per bucket of each list, as the bucket's brief defines it: plans a task or does the "
         "work inside the bucket's own guidelines, and never sends, merges or pushes anything")
# The runner's ledger, daily logs and settings hold task titles, so they live
# under the data root, which git ignores and a test moves.
STATE = os.path.join(paths.DATA_ROOT, "runner", "bucket-agent")
HOURS_PREFERRED = list(range(19, 24)) + list(range(0, 7))
QUEUE_HINT = ("a bucket agent's queue is the board: hand a task to the bucket's agent there, "
              "or ask the pa skill to. Run one now with --now --target <list> --item \"<task title>\"")
DEFINITION = os.path.join(HERE, "bucket-agent.md")
TRIGGER_ENV = bucket_wake.TRIGGER_ENV

OFF = "agents are off for this board in Settings"
FIGMA_REFUSAL = ("Figma work needs the Figma Console bridge paired on the right file, which cannot "
                 "be checked before a run starts, so it waits for /do")
IMPLEMENT_TIMEOUT = 20 * 60
IMPLEMENT_BUDGET = 3.00
READ_TOOLS = ["Read", "Grep", "Glob", "WebFetch", "WebSearch"]

OUTCOME_RE = re.compile(r"^\s*OUTCOME:\s*([a-z-]+)\s*$", re.M | re.I)
SUMMARY_RE = re.compile(r"^\s*SUMMARY:\s*(.+?)\s*$", re.M)
FIGMA_RE = re.compile(r"^\s*FIGMA:\s*(https://(?:www\.)?figma\.com/\S+)\s*$", re.M | re.I)
REPORT = "What the implementing agent did"

# What one list's run has gathered between before() and after(), and what one
# item is doing between starting() and land(), by item id.
_night = {}
_runs = {}


def _use(target_id):
    os.environ["PLANNING_DATASET"] = target_id


def _night_of(target_id):
    return _night.setdefault(target_id, {"planned": [], "folded": [], "done": [], "day": dt.date.today()})


def _off(target_id):
    return not settings.agents_on(target_id, paths.DATA_ROOT)


def _conf(target_id):
    from agents_engine.runner import settings as runner_settings
    return runner_settings.load(STATE, sys.modules[__name__], target_id)


def _ledger(target_id):
    from agents_engine.runner import daylog
    try:
        with open(os.path.join(STATE, daylog.slug(target_id), "ledger.json"), encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def board_hours(target_id):
    """The hours a scheduled bucket on this board may start in: the board's
    hours on the dashboard, or none while its switch there is off."""
    conf = _conf(target_id)
    return sorted(conf["hours"]) if conf["on"] else []


def on_assign():
    """Whether this process is a run core/bucket_wake.py started."""
    return os.environ.get(TRIGGER_ENV) == "on-assign"


# --------------------------------------------------------------------------
# targets and the lock


def targets():
    return [{"id": n, "name": "%s board" % n, "subtitle": os.path.join(paths.DATA_ROOT, n),
             "where": os.path.join("data", n, "plans")} for n in paths.datasets()]


def lock_path(target_id):
    """The one lock per board that the hourly wake, Run now and
    core/bucket_wake.py all take or check."""
    return bucket_wake.lock_path(paths.DATA_ROOT, target_id)


# --------------------------------------------------------------------------
# the queue


def _pending(names_subs):
    """The sub-tasks whose tick from their own agent is queued and not yet applied."""
    return {e.get("sub") for e in tick_queue.read(paths.tick_queue_path())
            if (e.get("by"), e.get("sub")) in names_subs}


def _plan_digest(path):
    """The plan's text less the report this agent adds to it, hashed, so a run
    set aside does not read as the owner having edited the plan."""
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
    except (OSError, TypeError):
        return ""
    return hashlib.sha1(plans.drop_section(text, REPORT).encode("utf-8")).hexdigest()


def items(target):
    _use(target["id"])
    try:
        with open(paths.todo_path(), encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        return []
    known = bucket_work.agents(target["id"], paths.DATA_ROOT)
    out = []
    for row in bucket_work.work(text, known):
        task, sub, kind, agent = row["task"], row["sub"], row["kind"], row["agent"]
        rel = row["plan_rel"]
        if kind == "implement" and not rel and plans.existing_plan(task):
            rel = plans.plan_filename(task)
        path = os.path.join(paths.plans_dir(), rel) if (kind == "implement" and rel) else ""
        front = plans.read_front(path) if path else {}
        h = hashlib.sha1()
        h.update(bucket_work.fingerprint(task).encode())
        h.update(("%s|%s|%s" % (kind, agent["mode"], agent["start"])).encode())
        h.update(_plan_digest(path).encode())
        h.update(agent_runs.retry_stamp(sub.stable_id, paths.agent_runs_path()).encode())
        out.append({"id": sub.stable_id or "%s-%s" % (task.stable_id, kind), "title": task.title,
                    "fields": {}, "body": "", "fingerprint": h.hexdigest()[:12],
                    "task": task, "sub": sub.stable_id, "kind": kind, "agent": agent,
                    "name": agent["name"], "bucket": agent["bucket"], "start": agent["start"],
                    "plan": path, "plan_rel": rel, "front": front,
                    "type": plan_types.read(front.get("type")) if front else "",
                    "feedback": row["feedback"], "skip": row["skip"]})
    pending = _pending({(i["name"], i["sub"]) for i in out if i["sub"]})
    for i in out:
        i["pending"] = i["sub"] in pending
    return out


def _missing(agent):
    said = ["the NOT FILLED IN YET line is still there" if m == bucket_agents.MARKER else m
            for m in agent["missing"]]
    if not agent["exists"]:
        return "it has no definition at %s" % os.path.relpath(agent["path"], paths.DATA_ROOT)
    return "its definition is missing %s" % ", ".join(said)


def eligible(item, target):
    _use(target["id"])
    agent, name = item["agent"], item["name"]
    if item.get("pending"):
        return {"why": "finished; its tick is waiting for the board to be opened", "kind": "unchanged"}
    if _off(target["id"]):
        return OFF
    if not agent["ready"]:
        return "the %s is not ready: %s" % (name, _missing(agent))
    if item["skip"]:
        return item["skip"]
    if not item["sub"]:
        return "its sub-task has no id on its line, so its tick could not be queued"
    if agent["start"] == "scheduled":
        hours = board_hours(target["id"])
        now = dt.datetime.now()
        if not hours:
            return "the %s starts only in this board's scheduled hours, and none are set" % name
        if now.hour not in hours:
            return "the %s starts only in this board's scheduled hours, and %02d:00 is not one" % (name, now.hour)
    else:
        row = _ledger(target["id"]).get(item["id"]) or {}
        if row.get("last") == "failed" and row.get("fingerprint") == item["fingerprint"]:
            return {"why": "failed last time (%s). Retry it on the card, or change the task"
                    % (row.get("why") or "see the log"), "kind": "unchanged"}
    if item["kind"] == "plan":
        if agent["mode"] != "plan-first":
            return "the %s is free-rein, so it does not plan: hand the task over again" % name
        return None
    if agent["mode"] == "plan-first":
        if not item["plan_rel"]:
            return "its Review the plan names no plan"
        if not item["front"]:
            return "its plan, plans/%s, is missing" % item["plan_rel"]
    if item["front"].get("needs_you", "").lower() == "yes":
        return "its plan asks you something first"
    if item["type"] == "figma":
        return FIGMA_REFUSAL
    if item["type"] == "code":
        repo, why = code_repo(item["task"])
        if why:
            return why
        tools = _improve()
        if not tools:
            return "improve-agent is not set up (Improve agent folder in the profile), and code runs on its guards"
        if not tools[1].clean(repo["path"]):
            return "the working tree of %s is not clean" % repo["path"]
        return None
    return project_folder(item["task"])[1]


def pending(agent):
    """What an on-assign run of each board would do now, for core/bucket_wake.py:
    {"run": [titles], "skipped": [[title, why]]}, on-assign buckets only."""
    from agents_engine.runner import core
    out = {}
    for target in agent.targets():
        todo_, left, _ = core.select(agent, target)
        items_ = {i["id"]: i for i in agent.items(target)[0]}
        mine = lambda i: (i or {}).get("start") == "on-assign"  # noqa: E731
        out[target["id"]] = {
            "run": [i["title"] for i in todo_ if mine(i)],
            "skipped": [[l["title"], l["why"]] for l in left
                        if mine(items_.get(l["id"])) and l.get("kind") != "unchanged"]}
    return out


# --------------------------------------------------------------------------
# project folders and repos, as the Implement agent found them


def improve_dir():
    """improve-agent's folder, for code plans only: $IMPLEMENT_IMPROVE_DIR, or
    the Improve agent folder the list's profile names. Unset, code is refused."""
    return (os.environ.get("IMPLEMENT_IMPROVE_DIR")
            or owner_profile.improve_agent_folder(paths.DATA_ROOT, board=paths.dataset()) or "")


def _improve():
    """improve-agent's git module and suite runner, or None where it is not there."""
    where = improve_dir()
    if not where or not os.path.isdir(os.path.join(where, "improve")):
        return None
    if where not in sys.path:
        sys.path.append(where)
    from improve import build, gitwork  # noqa: E402
    return build, gitwork


def project_folder(task):
    """(folder, why not). The `Project:` note's folder, or `<slug>` in the
    list's projects folder when it has none. A note that does not resolve is a
    refusal, since the work was asked for in that folder."""
    ref = project_folders.note_ref(task.body)
    if ref:
        real, err = project_folders.resolve(ref, paths.data_dir())
        if err:
            return None, "its Project: note does not name a folder it may use (%s)" % err[1]
        return real, None
    return os.path.join(project_folders.home(paths.data_dir()), plans.slugify(task.title)), None


def code_repo(task):
    """(repo, why not). The task's Project: folder, a git repo improve-agent's
    registry lists with its suites and protected paths."""
    ref = project_folders.note_ref(task.body)
    if not ref or not os.path.isabs(ref):
        return None, "a code plan needs a Project: note naming the repo"
    real, err = project_folders.resolve(ref, paths.data_dir())
    if err:
        return None, "its Project: note does not name a folder it may use (%s)" % err[1]
    if not os.path.exists(os.path.join(real, ".git")):
        return None, "%s is not a git repo" % real
    try:
        with open(os.path.join(improve_dir(), "registry.json"), encoding="utf-8") as fh:
            repos = json.load(fh).get("repos") or []
    except (OSError, ValueError):
        repos = []
    for r in repos:
        if os.path.realpath(r.get("path") or "") == real:
            return dict(r, path=real), None
    return None, "%s is not in improve-agent's registry, so no suite is agreed for it" % real


# --------------------------------------------------------------------------
# around the run


def before(target, todo_, dry):
    _use(target["id"])
    if _off(target["id"]):
        return {"note": OFF} if dry else {"skip": OFF}
    if dry:
        return None
    _night[target["id"]] = {"planned": [], "folded": [], "done": [], "day": dt.date.today(),
                            "expiry": windows.current(state=windows.read_state(paths.window_path()))["expires"]}
    plans.log("start: %d to run%s" % (len(todo_), " (on-assign)" if on_assign() else ""))
    return {"where": os.path.relpath(paths.plans_dir(), ROOT)}


def should_stop(target, run):
    expiry = (_night.get(target["id"]) or {}).get("expiry")
    if expiry and expiry - dt.datetime.now().astimezone() < plans.FLOOR:
        return "under %d minutes of the usage window remaining" % (plans.FLOOR.seconds // 60)
    return None


def after(target, run):
    _use(target["id"])
    if _off(target["id"]):
        plans.log("skipped: %s" % OFF)
        return
    for l in run["left"]:
        if l.get("kind") not in ("unchanged",):
            plans.log("  skipped %-50s %s" % (l["title"][:50], l["why"]))
    _queue_handovers(target["id"])
    night = _night.pop(target["id"], None)
    try:
        with open(paths.todo_path(), encoding="utf-8") as fh:
            plans.prune(dt.date.today(), todo.parse_doc(fh.read()))
    except OSError:
        pass
    if night is None:
        return
    if run["stopped"]:
        plans.log("stopped: %s" % run["stopped"])
    plans.log("done: %d planned, %d folded, %d done, $%.2f spent" % (
        len(night["planned"]), len(night["folded"]), len(night["done"]), run["cost"]))
    plans.announce(night["planned"], night["folded"], night["done"])


def _queue_handovers(target_id):
    """A task tagged to a bucket's agent with no handover behind it, handed over
    by the board (bucket_work.unhanded()). Never raises into the run."""
    try:
        with open(paths.todo_path(), encoding="utf-8") as fh:
            tasks = todo.parse_doc(fh.read())
        known = bucket_work.agents(target_id, paths.DATA_ROOT)
        q = paths.tick_queue_path()
        waiting = {e.get("handover") for e in tick_queue.read(q) if e.get("handover")}
        asked = []
        for task, name in bucket_work.unhanded(tasks, known):
            if task.stable_id.lower() in waiting:
                continue
            tick_queue.append_handover(task.stable_id, name, name,
                                       note="tagged [to:: %s] with no handover" % name, path=q)
            asked.append(task.title)
    except Exception as exc:  # noqa: BLE001
        plans.log("handover requests failed: %s: %s" % (type(exc).__name__, exc))
        return
    if asked:
        plans.log("asked the board to hand over %d tagged task%s: %s" % (
            len(asked), "" if len(asked) == 1 else "s", "; ".join(asked)))


def notify(target, run, text):
    """after() already queued the one banner a run puts up."""
    return None


def on_wake(target):
    """Once per scheduled wake: the briefings and the written reports, which
    the Plan agent's wake used to run."""
    if _off(target["id"]):
        return
    _use(target["id"])
    env = dict(os.environ, PLANNING_DATASET=target["id"])
    for script in ("brief.py", "report.py"):
        code = subprocess.call([sys.executable, os.path.join(HERE, script)], env=env, cwd=ROOT)
        if code:
            plans.log("%s failed with exit %d" % (script, code))


# --------------------------------------------------------------------------
# one item


def definition(item):
    """bucket-agent.md, then the bucket's own sections as the owner wrote them."""
    with open(DEFINITION, encoding="utf-8") as fh:
        text = fh.read()
    if text.startswith("---\n"):
        text = text.split("\n---\n", 1)[1]
    agent = item["agent"]
    parts = [text.strip(), "",
             "--- Your bucket ---", "",
             "You are the %s, the agent for the %s bucket of the %s list. Your bucket is %s. "
             "The owner wrote your definition in %s, and what it says is below, as written."
             % (agent["name"], agent["bucket"], paths.dataset(), agent["mode"],
                os.path.relpath(agent["path"], paths.ROOT)), ""]
    for key, heading in bucket_agents.FIELDS:
        if agent["fields"].get(key):
            parts += ["## %s" % heading, "", agent["fields"][key], ""]
    return "\n".join(parts) + "\n"


def _task_block(task):
    return "```markdown\n%s\n```" % "\n".join([task.raw] + list(task.body))


def plan_prompt(item):
    """The Plan agent's ask, after the definition: the task verbatim, a cached
    briefing, and why the last plan was sent back with what it had found."""
    task = item["task"]
    parts = ["--- This run: plan ---\n\n"
             "Plan this one task from the to-do list. Read agents/bucket-agent/PLAN-BRIEF.md first "
             "for the format and the rules; your bucket's definition above applies on top of it.\n\n"
             "The task, exactly as it stands in %s:\n\n%s\n\n"
             "Bucket: %s. State: %s. Its Plan sub-task is handed to: %s.\n"
             % (os.path.relpath(paths.todo_path(), paths.ROOT), _task_block(task),
                task.bucket, task.column, item["name"])]
    briefing = plans.task_briefing(task)
    if briefing:
        parts.append("\nA quick orientation generated earlier, before you read the notes yourself. "
                     "Useful for direction, not a substitute for reading them:\n\n%s\n" % briefing)
    said = plans.rejection(task)
    if said:
        summary, note, was_context, was_plan = said
        parts.append("\nYou have planned this task before and the owner sent that plan back.\n\n"
                     "What it proposed, in a line: %s\nWhy the owner sent it back: %s\n\n"
                     "Do not propose that again. Where the reason settles something the last plan was "
                     "guessing at, use it. Where it means the task cannot be planned without another "
                     "decision from the owner, fold and say which one.\n"
                     % (summary or "(no summary was written)", note))
        if was_context:
            parts.append("\nWhat the last plan had already established. Start from it, and correct it "
                         "where the reason says it was wrong.\n\n```markdown\n%s\n```\n" % was_context)
        if was_plan:
            parts.append("\nThe steps the owner sent back, in full:\n\n```markdown\n%s\n```\n" % was_plan)
    parts.append("\nResearch it and write the plan. Output the plan itself and nothing else, starting "
                 "with the frontmatter block. Do not create any files; your reply is the plan, and the "
                 "runner writes it to disk.\n")
    return "".join(parts)


WORK_HEAD = """--- This run: do the work ---

%(what)s

Task: %(title)s
Bucket: %(bucket)s, column: %(column)s
%(task)s

What the owner said about the plan or the work (feedback notes), which you keep in mind:
%(feedback)s

If it cannot be carried out as written, or it rests on something untrue, write
nothing and finish with OUTCOME: folded, saying what you found. Never write
todo.md, the plan, or anything under data/ other than what is allowed below.

"""

FILES = """--- Where you may write ---

Only inside this folder, and only new files:
%(folder)s

That holds whatever your bucket's definition says you may touch. Never change,
rename or delete a file that is already there. A new version of an existing
file is saved beside it as `name-v2.md` (then -v3, and so on), keeping the
original's extension. A message, Slack note or email goes in full in a file of
its own whose name ends `.draft.md`, so the board can show it ready to copy. If
the folder has no CLAUDE.md, write a short one saying what the project is. The
harness checks the folder after you: anything written over is put back,
anything written elsewhere is moved aside, and the whole run is set aside for
the owner.

"""

CODE = """--- The code ---

You are in the repo at %(repo)s, on the branch %(branch)s, which the harness
cut for this run. Make the change the plan describes and only that change.

You have no Bash tool: you cannot run the tests, start a server or use git. The
harness runs the repo's suites after you and commits what you leave. It never
merges or pushes. Do not write into a data folder, a .env, or anything holding
real content.

"""

FINISH = """--- How to finish ---

Your reply is your report: the harness adds it to the plan, when there is one,
under "%s". Say what you produced (paths), what you left, and what needs the
owner, in the owner's voice. If the work means the task itself should change,
say so as a request with the exact lines before and after; you never make it.

End your reply with exactly two lines, in this order and nothing after them:

SUMMARY: one sentence, plain English, saying what you did or why you did not.
OUTCOME: done      if you carried it out
OUTCOME: folded    if you could not, and wrote nothing
""" % REPORT


def work_prompt(item, run):
    task = item["task"]
    if item["plan"]:
        what = ("The owner approved this plan. Read it, then do what it says, not what you would have "
                "planned:\n%s" % item["plan"])
        block = ""
    else:
        what = ("Your bucket is free-rein: the task below is the instruction, and there is no plan. "
                "Do it inside your bucket's guidelines.")
        block = "\nThe task, exactly as it stands:\n\n%s\n" % _task_block(task)
    said = "\n".join("- %s" % f for f in item["feedback"]) or "(none)"
    head = WORK_HEAD % {"what": what, "title": task.title, "bucket": task.bucket, "column": task.column,
                        "task": block, "feedback": said}
    if item["type"] == "code":
        body = CODE % {"repo": run["repo"]["path"], "branch": run["branch"]}
    else:
        body = FILES % {"folder": run["folder"]}
    return head + body + FINISH


def prompt(item, target):
    _use(target["id"])
    run = _runs.get(item["id"]) or {}
    if run.get("error"):
        return ("Reply with exactly these two lines and do nothing else:\n"
                "SUMMARY: the harness could not prepare this run.\nOUTCOME: folded\n")
    ask = plan_prompt(item) if item["kind"] == "plan" else work_prompt(item, run)
    return definition(item) + "\n" + ask


def options(item, target):
    """The tool list is the first guard. No Bash, ever. A plan reads only. Work
    writes only into its project folder, or edits a repo on a branch."""
    _use(target["id"])
    if item["kind"] == "plan":
        return {"tools": list(READ_TOOLS), "disallowed": ["Bash", "Write", "Edit", "NotebookEdit"],
                "dirs": plans.extra_dirs(target["id"]) + plans.project_dirs(item["task"]),
                "budget": plans.BUDGET_PER_TASK, "timeout": plans.TASK_TIMEOUT, "cwd": paths.ROOT,
                "model": settings.planner_model()}
    base = {"budget": IMPLEMENT_BUDGET, "timeout": IMPLEMENT_TIMEOUT, "disallowed": ["Bash", "NotebookEdit"],
            "model": settings.model_for("implement")}
    if item["type"] == "code":
        repo, _ = code_repo(item["task"])
        return dict(base, cwd=(repo or {}).get("path") or ROOT, permission_mode="acceptEdits",
                    tools=["Read", "Grep", "Glob", "Edit", "Write"],
                    disallowed=["Bash", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Agent"])
    folder, _ = project_folder(item["task"])
    folder = os.path.realpath(folder or project_folders.home(paths.data_dir()))
    tools = READ_TOOLS + ["Write(/%s/**)" % folder, "Edit(/%s/**)" % folder]
    return dict(base, cwd=ROOT, tools=tools, dirs=[folder] + plans.extra_dirs(target["id"]))


def starting(item, target, opts):
    """Hash todo.md, then photograph the folder or cut the branch. A failure is kept for land()."""
    _use(target["id"])
    run = _runs[item["id"]] = {"kind": item["kind"], "type": item["type"], "day": dt.date.today(),
                               "hash": plans.file_hash(paths.todo_path()),
                               "since": dt.datetime.now().astimezone(), "began": time.time()}
    plans.log("  > %s (%s, %s)" % (item["title"][:60], item["name"], item["kind"]))
    if item.get("sub"):
        agent_runs.start(item["sub"], item["task"].stable_id, item["title"], item["name"],
                         path=paths.agent_runs_path())
    if item["kind"] == "plan":
        return
    try:
        if item["type"] == "code":
            build, gitwork = _improve()
            repo, why = code_repo(item["task"])
            if why or not gitwork.clean(repo["path"]):
                raise RuntimeError(why or "the working tree is not clean")
            base = gitwork.default_branch(repo["path"], repo.get("base"))
            run.update(repo=repo, was=gitwork.branch(repo["path"]), base=base,
                       branch=gitwork.start_branch(repo["path"], "implement/%s" % run["day"].isoformat(), base))
        else:
            folder, why = project_folder(item["task"])
            if why:
                raise RuntimeError(why)
            run["folder"] = folder
            run["guard"] = guard.before(folder, watch=paths.data_dir())
    except Exception as exc:  # noqa: BLE001 - reported by land() as the item's failure
        run["error"] = str(exc)


def _parse(text):
    m = OUTCOME_RE.search(text or "")
    s = SUMMARY_RE.search(text or "")
    return (m.group(1).lower() if m else ""), (s.group(1).strip() if s else "")


def _figma(text):
    m = FIGMA_RE.search(text or "")
    return m.group(1) if m else ""


def _report_into_plan(item, text, day, extra=""):
    """The agent's reply, under its own heading at the end of the plan. The
    harness writes this, not the agent. Nothing for a free-rein run with no plan."""
    if not item["plan"]:
        return
    body = "\n".join(l for l in (text or "").strip().splitlines()
                     if not OUTCOME_RE.match(l) and not SUMMARY_RE.match(l)).strip()
    try:
        with open(item["plan"], encoding="utf-8") as fh:
            was = fh.read()
    except OSError:
        return
    kept = plans.drop_section(was, REPORT)
    section = "## %s\n\nRun unattended on %s by the %s.%s\n\n%s\n" % (
        REPORT, day.isoformat(), item["name"], (" " + extra) if extra else "", body)
    with open(item["plan"], "w", encoding="utf-8", newline="") as fh:
        fh.write(kept.rstrip("\n") + "\n\n" + section)


def _failed(item, why, fix="", error=""):
    """The card's "<agent> · failed" line, and one banner (core/agent_runs.py)."""
    if item.get("sub"):
        said = "\n\n".join(x for x in (error or why, fix) if x)
        agent_runs.fail(item["sub"], why, said, path=paths.agent_runs_path(),
                        notify_path=paths.notify_queue_path(), task=item["task"].stable_id,
                        title=item["title"], agent=item["name"])


def _tick(item, note, plan=""):
    tick_queue.append(item["sub"], item["name"], note=note, path=paths.tick_queue_path(), plan=plan)


def land(item, result, target):
    """What came back, landed. A failure it reports is also the card's failed
    line and one banner."""
    got = _land(item, result, target)
    if isinstance(got, dict) and got.get("failed"):
        _failed(item, got["failed"], got.get("fix") or "")
    return got


def _land(item, result, target):
    _use(target["id"])
    run = _runs.pop(item["id"], {})
    text = result.get("text") or ""
    moved = plans.todo_moved(run.get("hash"), run.get("since") or dt.datetime.now().astimezone())
    if moved:
        plans.log("STOPPED: %s. Nothing else was attempted." % moved)
        plans.log("  the %s is the suspect for %r; check it before running again" % (item["name"], item["title"]))
        _undo(run)
        return {"failed": "%s, so its work was thrown away" % moved, "set_aside": True, "label": "refused",
                "fix": "Check what the %s did before running it again." % item["name"],
                "stop": "todo.md changed during the run"}
    if run.get("error"):
        return {"failed": "the run could not be prepared: %s" % run["error"], "set_aside": True,
                "fix": "Fix what it names, or carry it out with /do.", "label": "refused"}
    if item["kind"] == "plan":
        return _land_plan(item, result, target, run)
    if run["type"] == "code":
        return _land_code(item, run, text)
    return _land_files(item, run, text)


def _undo(run):
    """Put back whatever a work run left, after todo.md was written under it."""
    try:
        if run.get("guard"):
            guard.after(run["guard"], run["day"], revert_new=True)
        elif run.get("branch"):
            _, gitwork = _improve()
            path = run["repo"]["path"]
            if not gitwork.clean(path):
                gitwork.revert(path, run["branch"])
            if gitwork.branch(path) != run["was"]:
                gitwork.checkout(path, run["was"])
    except Exception as exc:  # noqa: BLE001
        plans.log("  could not put the run's work back: %s" % exc)


def _land_plan(item, result, target, run):
    task = item["task"]
    night = _night_of(target["id"])
    out, summary, folded, faults = plans.write_plan(task, result.get("text") or "", result.get("session"),
                                                    night["day"], item["name"])
    plans.queue_attach(task, result.get("session"))
    name = os.path.basename(out)
    _tick(item, "plan written to %s" % name, plan=name)
    night["folded" if folded else "planned"].append(task.title)
    agent_runs.finish(item["sub"], "needs a decision" if folded else "planned", summary,
                      path=paths.agent_runs_path(), plan=name)
    took = int(time.time() - run.get("began", time.time()))
    plans.log("  %s %-50s %3ds  $%.2f" % ("folded " if folded else "planned", task.title[:50], took,
                                          result.get("cost") or 0.0))
    for fault in faults:
        plans.log("    plan check: %s" % fault)
    detail = "Folded: the plan asks you something before it can go further." if folded else None
    if faults:
        detail = ((detail + " ") if detail else "") + "Plan check: " + " ".join(faults)
    return {"label": "needs a decision" if folded else "planned", "tone": "warn" if folded or faults else "good",
            "ref": os.path.join("data", target["id"], "plans", name),
            "summary": summary or ("folded: it needs a decision from you first" if folded else "plan written"),
            "detail": detail}


def _files_output(folder, added, text=""):
    real = os.path.realpath(folder)
    project = real
    for home in project_folders.homes(paths.data_dir()):
        home = os.path.realpath(home)
        if real != home and project_folders.inside(home, real):
            project = os.path.relpath(real, home)
            break
    return {"files": sorted(added), "project": project,
            "drafts": agent_runs.read_drafts(folder, added), "figma": _figma(text)}


def _land_files(item, run, text):
    outcome, summary = _parse(text)
    report = guard.after(run["guard"], run["day"], revert_new=outcome != "done")
    said = guard.breaches(report)
    rel = os.path.relpath(run["folder"], ROOT)
    if said:
        _report_into_plan(item, text, run["day"], "The harness set it aside: %s." % "; ".join(said))
        out = {"failed": "it broke the folder rules: %s" % "; ".join(said), "set_aside": True,
               "label": "refused", "ref": rel,
               "fix": "Read what it wrote under %s, then carry it out with /do." % os.path.basename(report["aside"])}
        if report["outside_changed"]:
            out["stop"] = "a file outside the project folder changed during the run"
        return out
    if outcome != "done":
        _report_into_plan(item, text, run["day"], "It did not carry the work out.")
        return {"failed": "it could not carry the work out: %s" % (summary or "no reason given"),
                "set_aside": True, "label": "folded", "ref": rel,
                "fix": "Read its report, then send it back or use /do."}
    if not report["added"]:
        return {"failed": "it said it was done but wrote nothing", "label": "nothing written", "ref": rel}
    _report_into_plan(item, text, run["day"])
    _tick(item, "work done")
    agent_runs.finish(item["sub"], "done", summary, path=paths.agent_runs_path(),
                      output=_files_output(run["folder"], report["added"], text))
    _night_of(paths.dataset())["done"].append(item["title"])
    return {"label": "done", "ref": rel, "summary": summary or "done",
            "detail": "%d new file%s" % (len(report["added"]), "" if len(report["added"]) == 1 else "s")}


def _commits(repo, base, branch):
    if not base:
        return 0
    try:
        out = subprocess.run(["git", "-C", repo, "rev-list", "--count", "%s..%s" % (base, branch)],
                             capture_output=True, text=True, timeout=30)
        return int(out.stdout.strip() or 0) if out.returncode == 0 else 0
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return 0


def _land_code(item, run, text):
    """As improve-agent's land(), less the backlog: protected paths, suites, commit."""
    outcome, summary = _parse(text)
    build, gitwork = _improve()
    repo, path, branch = run["repo"], run["repo"]["path"], run["branch"]
    try:
        changed = gitwork.changed(path)
        if outcome != "done" or not changed:
            if changed:
                gitwork.revert(path, branch)
            _report_into_plan(item, text, run["day"], "It changed nothing.")
            return {"failed": "it could not carry the plan out as written: %s" % (summary or "no change made"),
                    "set_aside": True, "label": "folded",
                    "fix": "Read its report at the end of the plan, then send the plan back or use /do."}
        bad = [p for p in changed if gitwork.matches(p, repo.get("protected"))]
        if bad:
            gitwork.revert(path, branch)
            return {"failed": "it wrote into protected paths (%s), so the change was thrown away"
                              % ", ".join(bad[:5]), "set_aside": True, "label": "refused",
                    "fix": "Carry it out with /do."}
        tests, green = build.run_tests(repo)
        lines = [summary, "", "Carried out unattended by the %s from an approved plan." % item["name"],
                 "It has no Bash tool and cannot merge or push, so this branch is a proposal.", ""]
        lines += ["  %-18s %s" % (t["name"], "ok" if t["ok"] else "FAILED") for t in tests] or \
                 ["  no suite covers this change"]
        lines += ["", "Co-Authored-By: Claude <noreply@anthropic.com>"]
        subject = item["title"].rstrip(".")
        if len(subject) > 68:
            subject = subject[:65].rsplit(" ", 1)[0] + "…"
        commit = gitwork.commit(path, subject, "\n".join(lines))
        if not green:
            _report_into_plan(item, text, run["day"], "The suites failed, so it is left on %s unticked." % branch)
            return {"failed": "tests failed (%s)" % ", ".join(t["name"] for t in tests if not t["ok"]),
                    "label": "tests failed", "ref": commit,
                    "fix": "The change is on %s with the failure named in the commit." % branch}
        _report_into_plan(item, text, run["day"], "Committed as %s on %s." % (commit, branch))
        _tick(item, "work done")
        agent_runs.finish(item["sub"], "built", summary, path=paths.agent_runs_path(), output={
            "branch": {"repo": path, "name": branch, "commit": commit, "summary": summary,
                       "commits": _commits(path, run.get("base"), branch)},
            "figma": _figma(text)})
        _night_of(paths.dataset())["done"].append(item["title"])
        return {"label": "built", "ref": "%s %s" % (branch, commit), "summary": summary or "built"}
    finally:
        if gitwork.clean(path) and gitwork.branch(path) != run["was"]:
            gitwork.checkout(path, run["was"])


def failed(item, result, target):
    """Claude failed part way. Whatever it left goes, and the repo goes back."""
    _use(target["id"])
    run = _runs.pop(item["id"], {})
    err = result.get("error") or ""
    if result.get("kind") == "limit":
        plans.record_limit(err)
        # The window ran out, which is not the task's failure: it goes again.
        if item.get("sub"):
            agent_runs.clear(item["sub"], path=paths.agent_runs_path())
    else:
        plans.log("  failed %-50s %s" % (item["title"][:50], (err.splitlines() or [""])[0][:120]))
        _failed(item, (err.splitlines() or ["the run failed"])[0][:200], error=err)
    if not run.get("error"):
        _undo(run)


# --------------------------------------------------------------------------
# the dashboard, beyond what the runner draws


def bucket_rows(target_id):
    """Per bucket of the board: its agent's name, ready or what is missing,
    mode, start, and the hours it may start in (None for on-assign)."""
    hours = board_hours(target_id)
    rows = []
    for d in bucket_agents.all_buckets(target_id, paths.DATA_ROOT):
        rows.append({"bucket": d["bucket"], "name": d["name"], "ready": d["ready"], "missing": d["missing"],
                     "mode": d["mode"], "start": d["start"],
                     "hours": hours if d["start"] == "scheduled" else None})
    return rows


def problems(target):
    return ["Agents are off for this board in Bench's Settings, so nothing runs on it."] \
        if _off(target["id"]) else []


def card(target, card):
    rows = bucket_rows(target["id"])
    card["buckets"] = rows
    card["note"] = ("A scheduled bucket starts only in the hours set here. An on-assign bucket starts "
                    "as soon as a task is handed to it, while the board is open.")
    cards = []
    for r in rows:
        if r["ready"]:
            why = "%s, %s" % (r["mode"], r["start"])
            if r["start"] == "scheduled":
                why += ", %s" % (("hours " + ", ".join("%02d" % h for h in r["hours"])) if r["hours"]
                                 else "no hours set")
        else:
            why = "missing: %s" % ", ".join(r["missing"])
        cards.append({"text": r["name"], "state": "ready" if r["ready"] else "not ready",
                      "status": "ready" if r["ready"] else "blocked",
                      "tone": "good" if r["ready"] else "warn", "why": why})
    if cards:
        card.setdefault("detail", {}).setdefault("groups", []).insert(0, {"name": "Buckets", "cards": cards})
    return card
