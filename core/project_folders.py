"""Where a task's project folder is allowed to be, and the one check that says so.

A task names its folder in a note, `- Project: data/projects/<name>` for the
default place or `- Project: /some/absolute/path` for a folder of the person's
own. The default place, `data/<dataset>/projects/`, is always allowed. Anything
else has to sit inside a folder listed in `data/<dataset>/project-folders.json`,
which only the board writes, and only after the person has confirmed it.

A list may name its own projects folder, under `projects_roots` in
data/settings.json (core/settings.py). Then a bare name is looked for in that
folder first and under `data/<dataset>/projects/` after, and a folder started
from the board is made in the first (`home()`). No two lists share one, so a
list never sees another's projects. `homes()` names them in order; a folder in
any of them needs no approval.

Everything that turns a note into a path on disk goes through `resolve()`: the
server's /project.json, its open-folder route, and the bucket agents when they
decide which folders a run may read. The check compares real paths with
os.path.commonpath, so a symlink or a `..` pointing out of an allowed folder is
caught after it is followed rather than before, and "/work-old" is never taken
for a child of "/work" the way a string-prefix test would take it.
"""

import json
import os
import re

import settings  # sits beside this file

APPROVED_FILE = "project-folders.json"
DEFAULT = "projects"

# The two shapes a Project: note takes. The first is the one the board has
# always read (see taskProject() in kanban/js/06-dates-substeps.js, which holds
# the same two rules); the second is a path of the person's own, in a code span
# when it may hold spaces.
_NAME_RE = re.compile(r"(?:^|[\s`(\[])data/projects/([A-Za-z0-9][A-Za-z0-9._-]*)")
_PATH_RE = re.compile(r"^\s*-\s*Project:\s*(?:`(/[^`]+)`|(/\S+))")


def default_dir(dataset_dir):
    """The list's own place, `data/<dataset>/projects/`, setting or not."""
    return os.path.join(dataset_dir, DEFAULT)


def chosen_dir(dataset_dir):
    """The list's own projects folder from settings, when it names one that is there."""
    dataset_dir = os.path.abspath(dataset_dir)
    return settings.projects_root(os.path.basename(dataset_dir), os.path.dirname(dataset_dir))


def homes(dataset_dir):
    """Where a bare name is looked for, in order: the list's projects folder,
    then data/<dataset>/projects/."""
    chosen = chosen_dir(dataset_dir)
    return ([chosen] if chosen else []) + [default_dir(dataset_dir)]


def home(dataset_dir):
    """Where a new project folder is made."""
    return homes(dataset_dir)[0]


def locate(name, dataset_dir):
    """The path a bare name stands for: the first home holding it, else where
    it would be made. Not checked; resolve() is the check."""
    for h in homes(dataset_dir):
        if os.path.isdir(os.path.join(h, name)):
            return os.path.join(h, name)
    return os.path.join(home(dataset_dir), name)


def approved_path(dataset_dir):
    return os.path.join(dataset_dir, APPROVED_FILE)


def read_approved(dataset_dir):
    """The folders the owner has approved, as written, in the order the owner added them."""
    try:
        with open(approved_path(dataset_dir), encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return []
    folders = data.get("folders") if isinstance(data, dict) else None
    if not isinstance(folders, list):
        return []
    return [f for f in folders if isinstance(f, str) and os.path.isabs(f)]


def inside(root, path):
    """Whether real path `path` is `root` or below it. Both must already be real."""
    try:
        return os.path.commonpath([root, path]) == root
    except ValueError:
        return False


def resolve(ref, dataset_dir):
    """A note's folder reference, as a real path on disk, or the reason it isn't one.

    Returns (path, None) or (None, (status, message)). `ref` is either a bare
    folder name, looked for in each of homes() in turn, or an absolute path,
    which has to land inside an approved folder or a home once every symlink
    is followed.
    """
    ref = (ref or "").strip()
    if not ref:
        return None, (400, "no project named")
    places = [os.path.realpath(h) for h in homes(dataset_dir)]
    if os.path.isabs(ref):
        real = os.path.realpath(ref)
        roots = [os.path.realpath(f) for f in read_approved(dataset_dir)]
        ok = any(inside(r, real) for r in roots) or any(
            real != p and inside(p, real) for p in places)
        if not ok:
            return None, (403, "that folder is not one you have approved")
    else:
        # A folder name and not a path: anything with a separator or a hop in
        # it is a way out of the default place.
        if ref.startswith(".") or "/" in ref or "\\" in ref:
            return None, (400, "bad project name")
        real = None
        for place in places:
            candidate = os.path.join(place, ref)
            if not os.path.lexists(candidate):
                continue
            real = os.path.realpath(candidate)
            # A symlink in a home that leads out of it is refused, not skipped
            # over for a folder of the same name further down.
            if real == place or not inside(place, real):
                return None, (403, "that folder is outside data/projects")
            break
        if real is None:
            return None, (404, "no such project")
    if not os.path.isdir(real):
        return None, (404, "no such project")
    return real, None


def approve(dataset_dir, raw):
    """Add a folder to the approved list. Returns (list, None) or (None, error).

    The folder has to exist already: approving is pointing at work the owner keeps
    somewhere, not a way to make a folder. The filesystem root is refused, since
    approving it would approve everything.
    """
    raw = os.path.expanduser((raw or "").strip())
    if not raw or not os.path.isabs(raw):
        return None, (400, "give an absolute path, starting with / or ~")
    real = os.path.realpath(raw)
    if real == os.path.dirname(real):
        return None, (400, "the whole disk cannot be approved")
    if not os.path.isdir(real):
        return None, (404, "there is no folder at that path")
    folders = read_approved(dataset_dir)
    if real not in folders:
        folders.append(real)
        os.makedirs(dataset_dir, exist_ok=True)
        tmp = approved_path(dataset_dir) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"folders": folders}, fh, indent=2)
            fh.write("\n")
        os.replace(tmp, approved_path(dataset_dir))
    return folders, None


def note_ref(body):
    """The folder a task's note lines point at: a bare name, an absolute path, or ""."""
    for line in body or []:
        m = _NAME_RE.search(line)
        if m:
            return m.group(1)
        m = _PATH_RE.match(line)
        if m:
            return (m.group(1) or m.group(2).rstrip(".,;:)")).rstrip("/") or "/"
    return ""
