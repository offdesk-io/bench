#!/usr/bin/env python3
"""One settings file per checkout, read the same way by every Python caller.

`data/settings.json` (template: `core/settings.example.json`) holds
which model each job runs on. Git ignores it. Missing,
unreadable or invalid, every function here answers as if it were empty, and
nothing raises.

    {"version": 1,
     "models": {"default": null, "plan": null, "implement": null,
                "chat": null, "brief": null, "planner": null},
     "agents": {"plan": {"start": "scheduled"},
                "implement": {"start": "scheduled"}},
     "chime": true}

- `models`: a model per job (`plan`, `implement`, `chat`, `brief`, `planner`), then
  `default` for any job without its own. `$BENCH_MODEL_<JOB>` wins over both.
  A null means the caller keeps the model it uses today. `planner` is the
  per-bucket planners'; null follows `plan`.
- `agents`: per agent (`plan`, `implement`), `start` says what happens when a
  task is handed to it. `scheduled` waits for its hours in the board's Agents
  tab (today's behaviour); `now` has the board start a run as soon as the hand
  over is saved.
- `chime`: true plays a short sound when a reply finishes in any chat on the
  board, a soft two-note rise for done and one low note for an error or a
  stop. False keeps the board silent. On by default.
- `memory_root`: optional, a folder outside the repo that holds the owner's
  long-lived facts, shared with agents outside Bench. Set, the owner's profile
  is read from `<memory_root>/me/profile.md`, and each list's people, company
  text and context from `people.md`, `about.md` and `context.md` in
  `<memory_root>/bench/<list>/` (see memory_file). Each read falls back to its
  old place under `data/` when the file is not there, and every write of a
  list's file goes to the memory folder. Bench also keeps
  `<memory_root>/boards.md` listing its lists (see write_boards). Task lists,
  buckets, plans, chats, queues, locks, history, backups and runs stay under
  `data/` either way. Unset, the key is absent from what load() returns and
  nothing changes.
- `projects_roots`: optional, a map from a list's name to its projects folder,
  an existing folder that may sit outside the repo, one per list and never
  shared by two. For a list in it, a task's project is looked for at
  `<folder>/<name>/` first and at `data/<list>/projects/<name>/` after, and a
  project started from the board is made there (core/project_folders.py). A
  list not in it keeps `data/<list>/projects/`. Unset, the key is absent from
  what load() returns and nothing changes.
- `boards`: optional, a map from a list's name to settings of its own, a list
  not in it taking every default. `memory_root` there is that list's memory
  folder: absent, it inherits the global `memory_root` above; a folder, the
  list's people, about and context are in `<folder>/bench/<list>/` and its
  profile is `<folder>/me/profile.md`; null, it has none and keeps everything
  in `data/<list>/`. A list with a folder of its own or none never reads the
  owner's `data/profile.md` (core/owner_profile.py). Unset, the key is absent
  from what load() returns and nothing changes. `banners` false keeps the
  list quiet: no due banners, catch-ups included, and the lines agents queue
  for it are dropped rather than posted (core/notify_due.py,
  companion/notify.py). True, or absent, is today's behaviour.

    "boards": {"demo": {"memory_root": null, "banners": false}}

Daily budgets are kept out of this file, in the agents engine's fences file
(`data/agents/fences.json`, `$AGENTS_FENCES`), because the engine reads them
there: `daily_budget` for all agents together, and `agent_budgets` keyed by the
runner's agent id. `budgets()` and `save_budgets()` read and write those two
keys and keep every other key in that file.
"""

import copy
import json
import os
import re
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bench_root  # noqa: E402

ROOT = bench_root.root()

# Claude Code CLI aliases, the fixed list onboarding offers.
MODELS = ("opus", "sonnet", "haiku")
JOBS = ("plan", "implement", "chat", "brief", "planner")
AGENTS = ("plan", "implement")
STARTS = ("now", "scheduled")

# The runner ids the fences file keys a budget by. The bucket planners run as
# the Plan agent, so they spend from its budget and have none of their own.
BUDGET_AGENTS = ("plan-agent", "implement-agent")

DEFAULTS = {
    "version": 1,
    "models": {"default": None, "plan": None, "implement": None,
               "chat": None, "brief": None, "planner": None},
    "agents": {"plan": {"start": "scheduled"},
               "implement": {"start": "scheduled"}},
    "chime": True,
}


def data_root():
    return os.environ.get("TODOS_DATA_ROOT") or os.path.join(ROOT, "data")


def path(root=None):
    return os.path.join(root or data_root(), "settings.json")


def _model(value):
    return value if isinstance(value, str) and value.strip() else None


def _memory_value(value):
    return value.strip() if isinstance(value, str) and value.strip() else None


# The keys a list's entry in `boards` may hold beyond `memory_root`, each a
# true-or-false that defaults to true.
BOARD_FLAGS = ("banners",)


def _board_entry(entry):
    """One list's entry in `boards` as load() keeps it, {} when it holds
    nothing. A `memory_root` that is there but not a folder path reads as null,
    so a list meant to be kept apart never falls back to the owner's folder."""
    out = {}
    if "memory_root" in entry:
        out["memory_root"] = _memory_value(entry["memory_root"])
    for key in BOARD_FLAGS:
        if isinstance(entry.get(key), bool):
            out[key] = entry[key]
    return out


def load(root=None):
    """The settings, with defaults filling anything missing or malformed.
    `memory_root`, `projects_roots` and `boards` are there only when they are
    set."""
    out = copy.deepcopy(DEFAULTS)
    try:
        with open(path(root), encoding="utf-8") as fh:
            raw = json.load(fh)
    except (OSError, ValueError):
        return out
    if not isinstance(raw, dict):
        return out
    models = raw.get("models")
    if isinstance(models, dict):
        for key in out["models"]:
            out["models"][key] = _model(models.get(key))
    agents = raw.get("agents")
    if isinstance(agents, dict):
        for key in AGENTS:
            entry = agents.get(key)
            if isinstance(entry, dict):
                out["agents"][key].update({k: v for k, v in entry.items() if k != "start"})
                if entry.get("start") in STARTS:
                    out["agents"][key]["start"] = entry["start"]
    if isinstance(raw.get("chime"), bool):
        out["chime"] = raw["chime"]
    memory = _memory_value(raw.get("memory_root"))
    if memory:
        out["memory_root"] = memory
    roots = raw.get("projects_roots")
    if isinstance(roots, dict):
        roots = {k: _memory_value(v) for k, v in roots.items() if _memory_value(v)}
        if roots:
            out["projects_roots"] = roots
    boards = raw.get("boards")
    if isinstance(boards, dict):
        boards = {k: _board_entry(v) for k, v in boards.items()
                  if isinstance(k, str) and isinstance(v, dict)}
        boards = {k: v for k, v in boards.items() if v}
        if boards:
            out["boards"] = boards
    return out


def _folder(value):
    if not value:
        return None
    path = os.path.abspath(os.path.expanduser(value))
    return path if os.path.isdir(path) else None


def memory_root(root=None):
    """The memory folder as an absolute path, or None when unset or not there."""
    return _folder(load(root).get("memory_root"))


def board(dataset, root=None):
    """A list's own entry in `boards`, {} when it has none."""
    return dict(load(root).get("boards", {}).get(dataset) or {})


def inherits_memory(dataset, root=None):
    """True when the list takes the global memory folder, which is when its
    entry in `boards` names no `memory_root` of its own."""
    return "memory_root" not in board(dataset, root)


def board_memory_root(dataset, root=None):
    """The list's memory folder as an absolute path: its own when `boards`
    names one, none when that says null, else the global one. None when there
    is none or the folder is not there."""
    entry = board(dataset, root)
    if "memory_root" not in entry:
        return memory_root(root)
    return _folder(entry["memory_root"])


def _flag(dataset, key, root=None):
    return board(dataset, root).get(key, True)


def banners_on(dataset, root=None):
    """False when `boards` switches the list's desktop banners off."""
    return _flag(dataset, "banners", root)


def projects_root(dataset, root=None):
    """The list's own projects folder as an absolute path, or None when it
    names none or the folder is not there."""
    return _folder(load(root).get("projects_roots", {}).get(dataset))


def start_for(agent, root=None):
    """`now` or `scheduled`: when a task handed to `agent` starts."""
    entry = load(root)["agents"].get(agent) or {}
    return entry.get("start") or "scheduled"


def model_for(job, root=None, default=None):
    """The model `job` should run on, or `default` when nothing says."""
    env = os.environ.get("BENCH_MODEL_%s" % str(job).upper(), "").strip()
    if env:
        return env
    models = load(root)["models"]
    return models.get(job) or models["default"] or default


def planner_model(root=None, default=None):
    """The model the per-bucket planners run on: their own setting when there is
    one, else the Plan agent's. They are the Plan agent's runs, one per task."""
    env = os.environ.get("BENCH_MODEL_PLANNER", "").strip()
    own = env or load(root)["models"].get("planner")
    return own or model_for("plan", root, default)


def for_boards(saved, boards):
    """`saved` as one person may read it on the shared board: no board they
    cannot see is named, and no folder is given as a path on the server. The
    memory folder goes, and each projects folder and list's own memory folder
    is its folder name alone. A list's null memory folder stays null."""
    out = copy.deepcopy(saved)
    out.pop("memory_root", None)
    own = {}
    for name, entry in (out.get("boards") or {}).items():
        if name not in boards:
            continue
        if entry.get("memory_root"):
            entry["memory_root"] = os.path.basename(os.path.normpath(entry["memory_root"]))
        own[name] = entry
    if own:
        out["boards"] = own
    else:
        out.pop("boards", None)
    roots = {k: os.path.basename(os.path.normpath(v))
             for k, v in (out.get("projects_roots") or {}).items() if k in boards}
    if roots:
        out["projects_roots"] = roots
    else:
        out.pop("projects_roots", None)
    return out


# ---- a list's memory files --------------------------------------------------
#
# A list's people, company text and context are facts that outlive the board,
# so with a memory folder set they live in `<memory_root>/bench/<list>/`, where
# agents outside Bench find them. A read takes the data/ copy while the memory
# folder has none, so a list kept from before the setting loses nothing. A
# write always lands in the memory folder and the data/ copy is never written
# again: the first save moves the file in effect, and a later merge can retire
# the copy left behind. The folder is the list's own (board_memory_root), which
# is the global one unless `boards` says otherwise.

MEMORY_FILES = ("people", "about", "context")


def _known_list(dataset, root):
    """Refuse a list name that is not a folder under `root` with a todo.md,
    spelled exactly as on disk. Names arrive from requests, so nothing that
    could climb out of `root` gets as far as a path."""
    try:
        names = os.listdir(root)
    except OSError:
        names = []
    if (not isinstance(dataset, str) or dataset.startswith(".") or dataset not in names
            or not os.path.isfile(os.path.join(root, dataset, "todo.md"))):
        raise ValueError("there is no list called %r" % (dataset,))


def memory_file(dataset, name, root=None, write=False):
    """Where a list's `name` file (one of MEMORY_FILES) is read, or with
    `write` where it is written, by the list's own memory folder
    (board_memory_root). With no memory folder both are
    `data/<list>/<name>.md`. With one, a read is `<memory_root>/bench/<list>/
    <name>.md` when that file is there and the data/ copy when it is not, and
    a write is always the memory folder's, its folder made here. Raises
    ValueError for any other `name` or a list that is not under `root`."""
    if name not in MEMORY_FILES:
        raise ValueError("no memory file called %r" % (name,))
    root = root or data_root()
    _known_list(dataset, root)
    here = os.path.join(root, dataset, name + ".md")
    memory = board_memory_root(dataset, root)
    if not memory:
        return here
    there = os.path.join(memory, "bench", dataset, name + ".md")
    if write:
        os.makedirs(os.path.dirname(there), exist_ok=True)
        return there
    return there if os.path.isfile(there) else here


def people_path(dataset, root=None, write=False):
    """A list's people.md, by memory_file()."""
    return memory_file(dataset, "people", root, write)


# ---- boards.md --------------------------------------------------------------
#
# With a memory folder set, Bench keeps `<memory_root>/boards.md` saying which
# lists exist, so an agent outside Bench can know without reading data/. Bench
# is its writer. It has no notion of what a list is for or of a list being
# frozen, so a line's marks other than `current` and the text after its folder
# are carried over from the file's last version: a description or a `frozen`
# written there survives, and a list new to the file gets neither.

BOARDS_HEADER = (
    "# Boards\n\n"
    "Written by Bench, which rewrites it when a list is made or the current one "
    "changes, and each time the board starts. Only PA changes boards. Any agent "
    "reads this file before it touches a board, and a board that is not listed "
    "gets nothing written to it.\n")

_BOARD_LINE = re.compile(r"^- ([^\s(:]+)(?: \(([^)]*)\))?: `[^`]*`(?:, (.*))?$")


def boards_md(names, current, root=None, memory=None, previous=""):
    """The text of boards.md for the lists `names`, `current` marked, keeping
    each surviving list's place, marks and description from `previous`."""
    root = os.path.abspath(root or data_root())
    base = os.path.dirname(os.path.abspath(memory)) if memory else None
    kept, order = {}, []
    for line in (previous or "").splitlines():
        m = _BOARD_LINE.match(line.strip())
        if not m or m.group(1) in kept:
            continue
        marks = [x.strip() for x in (m.group(2) or "").split(",")]
        kept[m.group(1)] = ([x for x in marks if x and x != "current"], (m.group(3) or "").strip())
        order.append(m.group(1))
    names = list(names)
    ordered = [n for n in order if n in names] + sorted(n for n in names if n not in kept)
    lines = []
    for name in ordered:
        marks, about = kept.get(name, ([], ""))
        marks = (["current"] if name == current else []) + marks
        folder = os.path.join(root, name)
        if base and (folder + os.sep).startswith(base + os.sep):
            folder = os.path.relpath(folder, base)
        lines.append("- %s%s: `%s/`%s" % (
            name, " (%s)" % ", ".join(marks) if marks else "",
            folder, ", " + about if about else ""))
    return BOARDS_HEADER + "\n" + "\n".join(lines) + ("\n" if lines else "")


def write_boards(names, current, root=None):
    """Rewrite `<memory_root>/boards.md` atomically, when the setting names a
    memory folder and the text has changed. Returns its path, or None when
    there is no memory folder."""
    root = root or data_root()
    memory = memory_root(root)
    if not memory:
        return None
    target = os.path.join(memory, "boards.md")
    try:
        with open(target, encoding="utf-8") as fh:
            previous = fh.read()
    except OSError:
        previous = ""
    text = boards_md(names, current, root, memory, previous)
    if text == previous:
        return target
    fd, tmp = tempfile.mkstemp(dir=memory, prefix=".boards-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, target)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return target


def validate(data, root=None):
    """An error message, or None when `data` is fit to save."""
    if not isinstance(data, dict):
        return "settings must be an object"
    models = data.get("models", {})
    if not isinstance(models, dict):
        return "models must be an object"
    for key, value in models.items():
        if key != "default" and key not in JOBS:
            return "unknown model job: %s" % key
        if value is not None and value not in MODELS:
            return "model for %s must be one of %s" % (key, ", ".join(MODELS))
    agents = data.get("agents", {})
    if not isinstance(agents, dict):
        return "agents must be an object"
    for key, entry in agents.items():
        if key not in AGENTS:
            return "unknown agent: %s" % key
        if not isinstance(entry, dict):
            return "agents.%s must be an object" % key
        if "start" in entry and entry["start"] not in STARTS:
            return "start for %s must be one of %s" % (key, ", ".join(STARTS))
    if "chime" in data and not isinstance(data["chime"], bool):
        return "chime must be true or false"
    err = _folder_error("memory_root", data.get("memory_root"))
    if err:
        return err
    roots = data.get("projects_roots")
    if roots is None:
        return None
    if not isinstance(roots, dict):
        return "projects_roots must be an object of list name to folder"
    # Any folder with a todo.md is a list here, a `_test` fixture included,
    # since the board can have one open.
    base = root or data_root()
    for name, value in roots.items():
        if value in (None, ""):
            continue
        if (not name or name.startswith(".") or os.sep in name
                or not os.path.isfile(os.path.join(base, name, "todo.md"))):
            return "projects_roots: there is no list called %s" % name
        err = _folder_error("the projects folder for %s" % name, value)
        if err:
            return err
    # Checked against what the save would leave, so a folder taken by a list
    # that was not sent is caught as well.
    merged = dict(load(root).get("projects_roots", {}))
    for name, value in roots.items():
        if _memory_value(value):
            merged[name] = _memory_value(value)
        else:
            merged.pop(name, None)
    # By the folder's identity on disk rather than its spelling, so `Proj` and
    # `proj` on a case-insensitive volume, or a symlink to either, are one. A
    # saved folder that has since gone is compared by its path.
    seen = {}
    for name in sorted(merged):
        real = os.path.realpath(os.path.expanduser(merged[name]))
        try:
            st = os.stat(real)
            key = (st.st_dev, st.st_ino)
        except OSError:
            key = real
        if key in seen:
            return "%s and %s cannot share one projects folder" % (seen[key], name)
        seen[key] = name
    return None


def _folder_error(key, value):
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        return "%s must be a folder path, or empty for none" % key
    path = os.path.expanduser(value.strip())
    if not os.path.isabs(path):
        return "%s must be a full path, starting with / or ~" % key
    if not os.path.isdir(path):
        return "%s: there is no folder at %s" % (key, value.strip())
    return None


def save(root, data):
    """Validate and write atomically. Returns (settings, error)."""
    err = validate(data, root)
    if err:
        return None, err
    # Start from what is on disk so hand-added keys survive a save.
    merged = copy.deepcopy(DEFAULTS)
    try:
        with open(path(root), encoding="utf-8") as fh:
            existing = json.load(fh)
    except (OSError, ValueError):
        existing = None
    if isinstance(existing, dict):
        for key, value in existing.items():
            if key not in ("models", "agents"):
                merged[key] = value
        if isinstance(existing.get("models"), dict):
            merged["models"].update(existing["models"])
        if isinstance(existing.get("agents"), dict):
            for key, entry in existing["agents"].items():
                if isinstance(entry, dict):
                    merged["agents"].setdefault(key, {}).update(entry)
                else:
                    merged["agents"][key] = entry
    merged["models"].update({k: v for k, v in (data.get("models") or {}).items()
                             if k in merged["models"]})
    for key, entry in (data.get("agents") or {}).items():
        merged["agents"].setdefault(key, {}).update(entry)
    if isinstance(data.get("chime"), bool):
        merged["chime"] = data["chime"]
    # Sent empty or null clears it; not sent leaves what is on disk.
    if "memory_root" in data:
        memory = _memory_value(data["memory_root"])
        if memory:
            merged["memory_root"] = memory
        else:
            merged.pop("memory_root", None)
    # Per list: a list sent empty or null loses its folder, one not sent keeps it.
    if isinstance(data.get("projects_roots"), dict):
        roots = merged.get("projects_roots")
        roots = dict(roots) if isinstance(roots, dict) else {}
        for name, value in data["projects_roots"].items():
            if _memory_value(value):
                roots[name] = _memory_value(value)
            else:
                roots.pop(name, None)
        if roots:
            merged["projects_roots"] = roots
        else:
            merged.pop("projects_roots", None)
    merged["version"] = 1
    target = path(root)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(target), prefix=".settings-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(merged, fh, indent=2)
            fh.write("\n")
        os.replace(tmp, target)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return load(root), None


def _dollars(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _read_fences(fences):
    try:
        with open(fences, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def budgets(fences):
    """The daily budgets in the fences file at `fences`: `daily_budget` for all
    agents together and `agent_budgets` per agent in BUDGET_AGENTS, each in
    dollars or None for no limit."""
    data = _read_fences(fences)
    own = data.get("agent_budgets")
    own = own if isinstance(own, dict) else {}
    return {"daily_budget": _dollars(data.get("daily_budget")),
            "agent_budgets": {a: _dollars(own.get(a)) for a in BUDGET_AGENTS}}


def budgets_error(body):
    """An error message for the budget keys in `body`, or None."""
    def bad(value):
        return value not in (None, "") and (_dollars(value) is None or value < 0)
    if "daily_budget" in body and bad(body["daily_budget"]):
        return "daily_budget must be a number of dollars, or empty for no limit"
    own = body.get("agent_budgets", {})
    if not isinstance(own, dict):
        return "agent_budgets must be an object"
    for key, value in own.items():
        if key not in BUDGET_AGENTS:
            return "unknown agent for a budget: %s" % key
        if bad(value):
            return "the budget for %s must be a number of dollars, or empty for no limit" % key
    return None


def save_budgets(fences, body):
    """Set or clear whichever of `daily_budget` and `agent_budgets` `body` holds,
    keeping every other key in the fences file, and every agent `body` does not
    name. An empty or null value removes the limit. Returns an error, or None."""
    err = budgets_error(body)
    if err:
        return err
    if "daily_budget" not in body and "agent_budgets" not in body:
        return None
    data = _read_fences(fences)
    if "daily_budget" in body:
        if body["daily_budget"] in (None, ""):
            data.pop("daily_budget", None)
        else:
            data["daily_budget"] = float(body["daily_budget"])
    if "agent_budgets" in body:
        own = data.get("agent_budgets")
        own = dict(own) if isinstance(own, dict) else {}
        for key, value in body["agent_budgets"].items():
            if value in (None, ""):
                own.pop(key, None)
            else:
                own[key] = float(value)
        if own:
            data["agent_budgets"] = own
        else:
            data.pop("agent_budgets", None)
    os.makedirs(os.path.dirname(fences), exist_ok=True)
    tmp = fences + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, fences)
    return None
