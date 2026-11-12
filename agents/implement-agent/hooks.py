"""The Implement agent's part of an unattended run. The shared runner does the rest.

Built from IMPROVEMENTS.md, "The implementing agent only runs with
the owner in the room because nothing says which kinds of work it can do alone".
`PACKAGES/agents-engine/RUNNER.md` owns the wake, the lock, the budget, the
ledger and the daily log. What is here is which work it may take and the guards
around each kind.

- **The queue** is every open Implement sub-task on the list whose blocker is
  ticked, whose task went through the Plan agent, and whose plan's `type:`
  (core/plan_types.py) is one it may do alone. A task handed straight to the
  Implement agent has no plan and waits for `do`. So does a sub-task whose tick
  is already queued and not yet applied by the board.
- **Types 1 to 5** (write-up, draft, prompt, data, deck) write into the task's
  project folder only, never over a file. The tool list grants Write and Edit on
  that folder alone, and guard.py checks afterwards: a file written over or
  removed is put back, anything written outside is moved aside, and the item is
  set aside for the owner.
- **Code** runs the way AGENTS/improve-agent does, using its git module and its
  registry of repos and suites: clean tree or no run, an `implement/<date>`
  branch, tests, a commit, never a merge or a push, and no Bash for the agent.
- **Figma** never runs here. See FIGMA_REFUSAL.

It never writes todo.md. When the work is done it queues the tick on its own
Implement sub-task through core/tick_queue.py, and appends what it did to the
plan, which is what `do` has the driving session do. Where the run stands is
kept in `agent-runs.json` (core/agent_runs.py) for the status line on the card.

Off until the owner sets its hours on the agents dashboard: the runner treats a list it
has no settings for as off. A list whose `agents` is false in settings.json's
`boards` (core/settings.py) is skipped whole, with the runner's one log line
saying why.
"""

import datetime as dt
import hashlib
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
PLAN_AGENT = os.path.join(ROOT, "agents", "plan-agent")
# Appended rather than inserted: the Plan agent's folder has a hooks.py of its
# own, and this file must stay the one `import hooks` finds.
for _p in (os.path.join(ROOT, "core"), PLAN_AGENT):
    if _p not in sys.path:
        sys.path.append(_p)

import agent_runs  # noqa: E402
import owner_profile  # noqa: E402
import guard  # noqa: E402
import paths  # noqa: E402
import pick  # noqa: E402
import plan  # noqa: E402
import plan_types  # noqa: E402
import project_folders  # noqa: E402
import settings  # noqa: E402
import tick_queue  # noqa: E402
import todo  # noqa: E402

ID = "implement-agent"
NAME = "Implement agent"
BLURB = ("carries out approved plans of the kinds it may do alone, into the task's project folder "
         "or onto a branch, and never sends, merges or pushes anything")
STATE = os.path.join("..", "..", "data", "runner", "implement-agent")
QUEUE_HINT = ("the Implement agent's queue is the to-do board: an Implement sub-task whose plan is "
              "approved and of a type it may do alone. Anything else waits for /do")
FIELDS = [
    {"key": "item_budget", "label": "Budget, task", "type": "number",
     "default": 3.0, "min": 0, "max": 50, "step": 0.5},
]

TASK_TIMEOUT = 20 * 60
BY = todo.IMPLEMENT_AGENT

# Where improve-agent lives, for code plans only. Its git module and registry are
# read, never written. The profile of the list the run is for names it
# (Improve agent folder; see core/owner_profile.py for which profile that is)
# and $IMPLEMENT_IMPROVE_DIR overrides that, for the tests. Unset, code plans
# are turned away.
def improve_dir():
    return (os.environ.get("IMPLEMENT_IMPROVE_DIR")
            or owner_profile.improve_agent_folder(paths.DATA_ROOT, board=paths.dataset()) or "")

# Figma work may run alone only with the desktop app open
# on the right file and the Figma Console bridge paired. The bridge is a server
# the MCP starts inside each Claude session, so there is nothing to ask before
# the run starts: pairing can only be seen from inside the session that will do
# the work. Until it can be checked from here, Figma plans wait for `do`.
FIGMA_REFUSAL = ("Figma work needs the Figma Console bridge paired on the right file, which cannot "
                 "be checked before a run starts, so it waits for /do")

# The four page rules, and the write tools granted for a Figma run alone. Kept
# here ready for the day figma_ready() can say yes; nothing uses them until then.
FIGMA_RULES = """- Only work on a page you created, empty, in this run. Never on a page that already has layers.
- Never edit an existing main component.
- Never edit any text, colour or other style that already exists.
- Give variables as suggestions in your reply, in text only. Never create or change one."""
FIGMA_WRITE_TOOLS = ["mcp__figma-console__figma_execute", "mcp__figma-console__figma_create_child",
                     "mcp__figma-console__figma_instantiate_component",
                     "mcp__figma-console__figma_take_screenshot"]


def figma_ready(item):
    """(ready, why not). Always not ready: see FIGMA_REFUSAL."""
    return False, FIGMA_REFUSAL


PLAN_NOTE = re.compile(r"^\s*-\s*Plan:\s*plans/([\w./-]+\.md)\s*$", re.I)
OUTCOME_RE = re.compile(r"^\s*OUTCOME:\s*([a-z-]+)\s*$", re.M | re.I)
SUMMARY_RE = re.compile(r"^\s*SUMMARY:\s*(.+?)\s*$", re.M)
# A Figma file or branch the work is in, named on a line of its own in the reply.
FIGMA_RE = re.compile(r"^\s*FIGMA:\s*(https://(?:www\.)?figma\.com/\S+)\s*$", re.M | re.I)
REPORT = "What the implementing agent did"

# What one item is doing between starting() and land(), by item id.
_runs = {}


def _use(target_id):
    os.environ["PLANNING_DATASET"] = target_id


OFF = "agents are off for this board in Settings"


def _off(target):
    return not settings.agents_on(target["id"], paths.DATA_ROOT)


def before(target, todo_, dry):
    """Only ever a refusal: a list with its agents off runs nothing."""
    if _off(target):
        return {"note": OFF} if dry else {"skip": OFF}
    return None


def problems(target):
    return ["Agents are off for this board in Bench's Settings, so nothing runs on it."] if _off(target) else []


# --------------------------------------------------------------------------
# targets


def targets():
    return [{"id": n, "name": "%s list" % n, "subtitle": os.path.join(ROOT, "data", n),
             "where": project_folders.chosen_dir(os.path.join(paths.DATA_ROOT, n))
             or os.path.join("data", n, "projects")} for n in paths.datasets()]


# --------------------------------------------------------------------------
# the queue


def _pending(sub_ids):
    """The sub-tasks whose tick from this agent is queued and not yet applied."""
    return {e.get("sub") for e in tick_queue.read(paths.tick_queue_path())
            if e.get("by") == BY and e.get("sub") in sub_ids}


def _plan_rel(steps, tid):
    """The plan the review of it names, `- Plan: plans/<file>`, or ""."""
    for s in steps:
        if s["task"].slug == tid + "-plan-review":
            for line in s["notes"]:
                m = PLAN_NOTE.match(line)
                if m and ".." not in m.group(1).split("/"):
                    return m.group(1)
    return ""


def _feedback(steps, tid):
    """Everything the owner said on the Plan and on Implement, `feedback:` notes."""
    said = []
    for s in steps:
        if s["task"].slug in (tid + "-plan", tid + "-implement"):
            for line in s["notes"]:
                m = re.match(r"^\s*-\s*feedback:\s*(.*)$", line, re.I)
                if m and m.group(1).strip():
                    said.append(m.group(1).strip())
    return said


def _plan_digest(path):
    """The plan's text less the report this agent adds to it, hashed. Without
    leaving the report out, a run set aside would change its own plan and be
    tried again the next night as though the owner had edited it."""
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
    except (OSError, TypeError):
        return ""
    return hashlib.sha1(plan.drop_section(text, REPORT).encode("utf-8")).hexdigest()


def read_queue(text):
    """Every Implement sub-task that is open with its blocker ticked, as items.

    The runner decides nothing from these beyond what eligible() says; each
    carries what the rest of the hooks need: the task, the sub-task's id, the
    plan and its type.
    """
    tasks = todo.parse_doc(text)
    slugs = todo.slug_states(tasks)
    out = []
    for t in tasks:
        if t.done or not t.stable_id:
            continue
        steps = todo.split_body(t)[1]
        imp = next((s["task"] for s in steps if s["task"].slug == t.stable_id + "-implement"
                    and todo.agent_of(s["task"].to) == BY), None)
        if imp is None or imp.done or todo.is_blocked(imp, slugs) or todo.is_blocked(t, slugs):
            continue
        rel = _plan_rel(steps, t.stable_id)
        path = os.path.join(paths.plans_dir(), rel) if rel else ""
        front = plan.read_front(path) if path else {}
        kind = plan_types.read(front.get("type")) if front else ""
        h = hashlib.sha1()
        h.update(pick.fingerprint(t).encode())
        h.update(_plan_digest(path).encode())
        # A retry asked for from the board, so a run the runner set aside goes again.
        h.update(agent_runs.retry_stamp(imp.stable_id, paths.agent_runs_path()).encode())
        out.append({"id": imp.stable_id or imp.slug, "title": t.title, "fields": {}, "body": "",
                    "fingerprint": h.hexdigest()[:12], "task": t, "sub": imp.stable_id,
                    "plan": path, "plan_rel": rel, "front": front, "kind": kind,
                    "feedback": _feedback(steps, t.stable_id)})
    return out


def items(target):
    _use(target["id"])
    try:
        with open(paths.todo_path(), encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        return []
    out = read_queue(text)
    pending = _pending({i["sub"] for i in out if i["sub"]})
    for i in out:
        i["pending"] = i["sub"] in pending
    return out


def project_folder(task):
    """(folder, why not). The `Project:` note's folder, or the default one for the task.

    A note that does not resolve (a folder the owner has not approved, one that is not
    there) is a refusal rather than a fallback: the plan was written for that
    folder. With no note the folder is `<slug>` in project_folders.home(), the
    list's projects folder when it has one and `data/<dataset>/projects/` when not, the
    one the interactive agent would create, and the report says the task needs
    a pointer to it.
    """
    ref = project_folders.note_ref(task.body)
    if ref:
        real, err = project_folders.resolve(ref, paths.data_dir())
        if err:
            return None, "its Project: note does not name a folder it may use (%s)" % err[1]
        return real, None
    return os.path.join(project_folders.home(paths.data_dir()), plan.slugify(task.title)), None


def _improve():
    """improve-agent's git module and suite runner, or None where it is not there."""
    where = improve_dir()
    if not where or not os.path.isdir(os.path.join(where, "improve")):
        return None
    if where not in sys.path:
        sys.path.append(where)
    from improve import build, gitwork  # noqa: E402
    return build, gitwork


def code_repo(task):
    """(repo, why not). The repo a code plan works in: the task's Project: folder,
    a git repo that improve-agent's registry lists, with its suites and protected
    paths. A repo it does not list has no suites anyone has agreed are safe to run
    unattended, so it is refused rather than guessed at."""
    import json
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


def eligible(item, target):
    _use(target["id"])
    if item.get("pending"):
        return {"why": "finished; its tick is waiting for the board to be opened", "kind": "unchanged"}
    if not item["sub"]:
        return "its Implement sub-task has no id on its line, so its tick could not be queued"
    if not item["plan_rel"]:
        return "handed straight to the Implement agent, with no plan: it waits for /do"
    if not item["front"]:
        return "its plan, plans/%s, is missing" % item["plan_rel"]
    if item["front"].get("needs_you", "").lower() == "yes":
        return "its plan asks you something first"
    kind = item["kind"]
    if kind == "figma":
        return figma_ready(item)[1]
    if kind not in plan_types.UNATTENDED:
        return "a plan of type %s is not one it does alone: it waits for /do" % kind
    if kind == "code":
        repo, why = code_repo(item["task"])
        if why:
            return why
        tools = _improve()
        if not tools:
            return "improve-agent is not set up (Improve agent folder in the profile), and code runs on its guards"
        if not tools[1].clean(repo["path"]):
            return "the working tree of %s is not clean" % repo["path"]
        return None
    folder, why = project_folder(item["task"])
    return why


# --------------------------------------------------------------------------
# one task


def starting(item, target, opts):
    """Photograph the folder, or cut the branch. A failure here is kept for land()."""
    _use(target["id"])
    run = _runs[item["id"]] = {"kind": item["kind"], "day": dt.date.today()}
    if item.get("sub"):
        agent_runs.start(item["sub"], item["task"].stable_id, item["title"], NAME, path=paths.agent_runs_path())
    try:
        if item["kind"] == "code":
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


def _brief(task):
    path = plan.bucket_brief(task.bucket)
    return path or "(none written for this bucket)"


def prompt(item, target):
    _use(target["id"])
    run = _runs.get(item["id"]) or {}
    if run.get("error"):
        return ("Reply with exactly these two lines and do nothing else:\n"
                "SUMMARY: the harness could not prepare this run.\nOUTCOME: folded\n")
    task = item["task"]
    said = "\n".join("- %s" % f for f in item["feedback"]) or "(none)"
    head = HEAD % {"brief_md": os.path.join(PLAN_AGENT, "PLAN-BRIEF.md"), "plan": item["plan"], "title": task.title, "bucket": task.bucket,
                   "column": task.column, "brief": _brief(task), "type": item["kind"], "feedback": said}
    if item["kind"] == "code":
        body = CODE % {"repo": run["repo"]["path"], "branch": run["branch"]}
    elif item["kind"] == "figma":
        body = FIGMA % {"rules": FIGMA_RULES}
    else:
        body = FILES % {"folder": run["folder"]}
    return head + body + FINISH


HEAD = """You are the Implement agent, running unattended. Nobody is here to answer a
question. The owner approved this plan, and its type (%(type)s) is one the owner has agreed
you may carry out without them in the room, under the rules below.

Read %(brief_md)s for the shape of a plan, then the plan:
%(plan)s

Task: %(title)s
Bucket: %(bucket)s, column: %(column)s
Bucket brief: %(brief)s
What the owner said about the plan or the work (feedback notes), which you keep in mind:
%(feedback)s

Do what the plan says, not what you would have planned. If it cannot be carried
out as written, or it rests on something untrue, write nothing and finish with
OUTCOME: folded, saying what you found.

Nothing leaves the machine: no message sent, no ticket raised, no email. A
message or ticket is written out in full and left for the owner to send. Never write
todo.md, the plan, or anything under data/ other than what is allowed below.

"""

FILES = """--- Where you may write ---

Only inside this folder, and only new files:
%(folder)s

Never change, rename or delete a file that is already there. A new version of an
existing file is saved beside it as `name-v2.md` (then -v3, and so on), keeping
the original's extension. A message, Slack note or email goes in full in a file
of its own whose name ends `.draft.md`, so the board can show it ready to copy. If the folder has no CLAUDE.md, write a short one
saying what the project is. The harness checks the folder after you: anything
written over is put back, anything written elsewhere is moved aside, and the
whole run is set aside for the owner.

"""

CODE = """--- The code ---

You are in the repo at %(repo)s, on the branch %(branch)s, which the harness
cut for this run. Make the change the plan describes and only that change.

You have no Bash tool: you cannot run the tests, start a server or use git, and
none of that is an oversight. The harness runs the repo's suites after you and
commits what you leave. It never merges or pushes. Do not write into a data
folder, a .env, or anything holding real content.

"""

FIGMA = """--- Figma ---

The four page rules, which the harness holds you to:
%(rules)s

"""

FINISH = """--- How to finish ---

Your reply is your report: the harness adds it to the plan under "%s".
Say what you produced (paths), what you left, and what needs the owner, in the owner's voice:
British English, plain, short sentences, no em dashes. If the work means the
task itself should change, say so as a request with the exact lines before and
after; you never make it.

End your reply with exactly two lines, in this order and nothing after them:

SUMMARY: one sentence, plain English, saying what you did or why you did not.
OUTCOME: done      if you carried the plan out
OUTCOME: folded    if you could not, and wrote nothing
""" % REPORT


def options(item, target):
    """The tool list is the first guard. No Bash for any type; Write and Edit only
    on the project folder for types 1 to 5, and no permission mode that would
    accept an edit anywhere else."""
    _use(target["id"])
    base = {"budget": 3.0, "timeout": TASK_TIMEOUT, "disallowed": ["Bash", "NotebookEdit"],
            "model": settings.model_for("implement")}
    if item["kind"] == "code":
        repo, _ = code_repo(item["task"])
        return dict(base, cwd=(repo or {}).get("path") or ROOT, permission_mode="acceptEdits",
                    tools=["Read", "Grep", "Glob", "Edit", "Write"],
                    disallowed=["Bash", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Agent"])
    folder, _ = project_folder(item["task"])
    folder = os.path.realpath(folder or project_folders.home(paths.data_dir()))
    tools = ["Read", "Grep", "Glob", "WebFetch", "WebSearch",
             "Write(/%s/**)" % folder, "Edit(/%s/**)" % folder]
    if item["kind"] == "figma" and figma_ready(item)[0]:
        tools += FIGMA_WRITE_TOOLS
    return dict(base, cwd=ROOT, agent="implement-agent", tools=tools, dirs=[folder] + plan.extra_dirs(target["id"]))


def _parse(text):
    m = OUTCOME_RE.search(text or "")
    outcome = m.group(1).lower() if m else ""
    s = SUMMARY_RE.search(text or "")
    return outcome, (s.group(1).strip() if s else "")


def _report_into_plan(item, text, day, extra=""):
    """The agent's reply, under its own heading at the end of the plan. The
    harness writes this, not the agent, which may not write the plan."""
    body = "\n".join(l for l in (text or "").strip().splitlines()
                     if not OUTCOME_RE.match(l) and not SUMMARY_RE.match(l)).strip()
    try:
        with open(item["plan"], encoding="utf-8") as fh:
            was = fh.read()
    except OSError:
        return
    kept = plan.drop_section(was, REPORT)
    section = "## %s\n\nRun unattended on %s, as a plan of type %s.%s\n\n%s\n" % (
        REPORT, day.isoformat(), item["kind"], (" " + extra) if extra else "", body)
    with open(item["plan"], "w", encoding="utf-8", newline="") as fh:
        fh.write(kept.rstrip("\n") + "\n\n" + section)


def _figma(text):
    m = FIGMA_RE.search(text or "")
    return m.group(1) if m else ""


def _files_output(folder, added, text=""):
    """What a files run left, for the activity feed: the files, the folder as
    the board names a project, and any `.draft.md` message with its text."""
    real = os.path.realpath(folder)
    project = real
    for home in project_folders.homes(paths.data_dir()):
        home = os.path.realpath(home)
        if real != home and project_folders.inside(home, real):
            project = os.path.relpath(real, home)
            break
    return {"files": sorted(added), "project": project,
            "drafts": agent_runs.read_drafts(folder, added), "figma": _figma(text)}


def _commits(repo, base, branch):
    """How many commits the branch carries past its base. 0 when git cannot say."""
    import subprocess
    if not base:
        return 0
    try:
        out = subprocess.run(["git", "-C", repo, "rev-list", "--count", "%s..%s" % (base, branch)],
                             capture_output=True, text=True, timeout=30)
        return int(out.stdout.strip() or 0) if out.returncode == 0 else 0
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return 0


def _finished(item, label, summary, output=None):
    if item.get("sub"):
        agent_runs.finish(item["sub"], label, summary, path=paths.agent_runs_path(), output=output)


def _tick(item):
    tick_queue.append(item["sub"], BY, note="report written", path=paths.tick_queue_path())


def land(item, result, target):
    """What came back, landed. A failure it reports is also the card's
    "Implement agent · failed" line and one banner (core/agent_runs.py)."""
    got = _land(item, result, target)
    if isinstance(got, dict) and got.get("failed"):
        _failed(item, got["failed"], got.get("fix") or "")
    return got


def _failed(item, why, fix="", error=""):
    if item.get("sub"):
        said = "\n\n".join(x for x in (error or why, fix) if x)
        agent_runs.fail(item["sub"], why, said, path=paths.agent_runs_path(),
                        notify_path=paths.notify_queue_path(), task=item["task"].stable_id,
                        title=item["title"], agent=NAME)


def _land(item, result, target):
    _use(target["id"])
    run = _runs.pop(item["id"], {})
    text = result.get("text") or ""
    outcome, summary = _parse(text)
    if run.get("error"):
        return {"failed": "the run could not be prepared: %s" % run["error"], "set_aside": True,
                "fix": "Fix what it names, or carry it out with /do.", "label": "refused"}
    if item["kind"] == "code":
        return _land_code(item, run, text, outcome, summary)

    report = guard.after(run["guard"], run["day"], revert_new=outcome != "done")
    said = guard.breaches(report)
    rel = os.path.relpath(run["folder"], ROOT)
    if said:
        _report_into_plan(item, text, run["day"], "The harness set it aside: %s." % "; ".join(said))
        out = {"failed": "it broke the folder rules: %s" % "; ".join(said), "set_aside": True,
               "label": "refused", "ref": rel,
               "fix": "Read what it wrote under %s, then carry it out with /do." % os.path.basename(report["aside"])}
        if report["outside_changed"] or report["todo"]:
            out["stop"] = "a file outside the project folder changed during the run"
        return out
    if outcome != "done":
        _report_into_plan(item, text, run["day"], "It did not carry the plan out.")
        return {"failed": "it could not carry the plan out as written: %s" % (summary or "no reason given"),
                "set_aside": True, "label": "folded", "ref": rel,
                "fix": "Read its report at the end of the plan, then send the plan back or use /do."}
    if not report["added"]:
        return {"failed": "it said it was done but wrote nothing", "label": "nothing written", "ref": rel}
    _report_into_plan(item, text, run["day"])
    _tick(item)
    _finished(item, "done", summary, _files_output(run["folder"], report["added"], text))
    return {"label": "done", "ref": rel, "summary": summary or "done",
            "detail": "%d new file%s" % (len(report["added"]), "" if len(report["added"]) == 1 else "s")}


def _land_code(item, run, text, outcome, summary):
    """As improve-agent's land(), less the backlog: protected paths, suites, commit."""
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
        lines = [summary, "", "Carried out unattended by the Implement agent from an approved plan.",
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
        _tick(item)
        _finished(item, "built", summary, {
            "branch": {"repo": path, "name": branch, "commit": commit, "summary": summary,
                       "commits": _commits(path, run.get("base"), branch)},
            "figma": _figma(text)})
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
        # The window ran out, which is not the task's failure: it goes again.
        if item.get("sub"):
            agent_runs.clear(item["sub"], path=paths.agent_runs_path())
    else:
        _failed(item, (err.splitlines() or ["the run failed"])[0][:200], error=err)
    if run.get("error"):
        return
    if run.get("kind") == "code":
        _, gitwork = _improve()
        path = run["repo"]["path"]
        if not gitwork.clean(path):
            gitwork.revert(path, run["branch"])
        if gitwork.branch(path) != run["was"]:
            gitwork.checkout(path, run["was"])
    elif run.get("guard"):
        guard.after(run["guard"], run["day"], revert_new=True)


def should_stop(target, run):
    """The Plan agent writes into the same dataset folder, so the two never share a night."""
    if os.path.exists(os.path.join(ROOT, "data", ".plan-agent-%s.lock" % target["id"])):
        return "the Plan agent is running on this list"
    return None
