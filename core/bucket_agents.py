#!/usr/bin/env python3
"""Each bucket's agent, as the owner defined it, and whether it is ready to run.

    python3 core/bucket_agents.py <list>     each bucket, ready or not, and what is missing

A bucket's agent is defined in one file, the bucket's brief, which the owner
fills in (template: agents/plan-agent/bucket-brief.template.md). Its
frontmatter says how the agent works:

    ---
    mode: plan-first      # or free-rein
    start: on-assign      # or scheduled
    ---

- `mode`: `plan-first` writes a plan, waits for the owner to approve it, then
  does the work. `free-rein` does the work straight away, inside its
  guidelines. Either way the owner reviews the finished work, through the
  handover's Review the work sub-task. Required, and no default.
- `start`: `on-assign` begins as soon as a task is handed to the agent,
  `scheduled` only in the bucket's set hours. Absent, it is `on-assign`.

Under the title and the one-line summary, the `## ` sections in FIELDS hold
the rest. Six are required (REQUIRED): what the agent is for, the processes it
runs, the guidelines it follows, what it may touch, what it must never touch,
and what good looks like. What already does it and Who is involved are kept
from the brief this grew out of, and may stay empty.

A definition is ready when the template's `<!-- NOT FILLED IN YET -->` line
has gone, `mode` is one of MODES, `start` is absent or one of STARTS, and no
required section is empty. A section counts as empty when all that is left
under its heading is the template's own guidance, an HTML comment or an
`<angle-bracket placeholder>`, so an owner who keeps the guidance and writes
under it is read as having written, and one who left the page alone is not.
The guidance is read out of the template itself, as plan.py's
_template_paragraphs() does, so the template is the one copy of it.

The file is `data/<list>/buckets/<bucket>/<bucket>.md`, the brief's own place,
where the board's brief editor and the Plan agent already read it. Anything
about a bucket stays in Bench, and only people, about, context and the profile
go to the memory folder, so it is never routed through the memory lookup.
Every reader here goes through definition_path(), so the file's place is said
once.

Each bucket's agent has a name, agent_name(), which is what a sub-task handed
to it carries in `[to::]` and what its ticks are queued under. by_name() reads
one back to its bucket.
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import settings  # noqa: E402

ROOT = os.path.dirname(HERE)
TEMPLATE = os.path.join(ROOT, "agents", "plan-agent", "bucket-brief.template.md")

MODES = ("plan-first", "free-rein")
STARTS = ("on-assign", "scheduled")
DEFAULT_START = "on-assign"

# The line every brief ships with, and the one line that has to come out before
# the brief counts as written. The same marker as plan.py's BRIEF_EMPTY.
NOT_FILLED = "<!-- NOT FILLED IN YET -->"
# What `missing` says when that line is still there. Not a field, but the
# reason the owner most needs to hear first.
MARKER = "marker"

# Field name -> the `## ` heading it is written under, in the template's order.
FIELDS = (
    ("purpose", "What this agent is for"),
    ("processes", "The processes I run in this bucket"),
    ("guidelines", "Guidelines it follows"),
    ("may_touch", "What it may touch"),
    ("never_touch", "What it must never touch"),
    ("already_does_it", "What already does it"),
    ("involved", "Who is involved"),
    ("good", "What good looks like here"),
)
REQUIRED = ("purpose", "processes", "guidelines", "may_touch", "never_touch", "good")

# A stream as buckets/README.md names one, which is also its folder's name.
BUCKET_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
README_ROW = re.compile(r"^\|\s*`?([^|`]+)`?\s*\|\s*`?([a-z0-9-]+)`?\s*\|")
PLACEHOLDER_RE = re.compile(r"^<[^<>]+>$")
COMMENT_RE = re.compile(r"<!--.*?-->", re.S)


def _root(root):
    return root or settings.data_root()


def _check_names(dataset, bucket, root):
    """Refuse a list that is not a folder under `root` with a todo.md, or a
    bucket that is not a stream name, so neither can climb out of `root`."""
    if (not isinstance(dataset, str) or not dataset or dataset.startswith(".")
            or os.sep in dataset or not os.path.isfile(os.path.join(root, dataset, "todo.md"))):
        raise ValueError("there is no list called %r" % (dataset,))
    if bucket is not None and not (isinstance(bucket, str) and BUCKET_RE.match(bucket)):
        raise ValueError("%r is not a bucket name" % (bucket,))


def buckets_dir(dataset, root=None):
    return os.path.join(_root(root), dataset, "buckets")


def definition_path(dataset, bucket, root=None):
    """Where a bucket's agent definition is read: its brief,
    `data/<list>/buckets/<bucket>/<bucket>.md`. The one place that says so."""
    root = _root(root)
    _check_names(dataset, bucket, root)
    return os.path.join(buckets_dir(dataset, root), bucket, "%s.md" % bucket)


def _fold(text):
    return " ".join(text.split())


def _template_paragraphs():
    """The template's own guidance, each paragraph whitespace folded."""
    try:
        with open(TEMPLATE, encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        return set()
    return {_fold(p) for p in re.split(r"\n\s*\n", text) if p.strip()}


def _frontmatter(text):
    """(`key: value` pairs from a leading `---` block, the text after it).
    Values lose quotes and a trailing `# comment`; keys are lowercased."""
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        return {}, text
    for end in range(1, len(lines)):
        if lines[end].strip() == "---":
            break
    else:
        return {}, text
    out = {}
    for line in lines[1:end]:
        if ":" not in line or line.lstrip().startswith("#"):
            continue
        key, value = line.split(":", 1)
        value = re.sub(r"\s+#.*$", "", value).strip().strip("'\"").strip()
        out[key.strip().lower()] = value
    return out, "\n".join(lines[end + 1:])


def _sections(text):
    """`## ` heading, lowercased -> the text under it."""
    out, cur = {}, None
    for line in text.split("\n"):
        m = re.match(r"^##\s+(.+?)\s*$", line)
        if m:
            cur = m.group(1).strip().lower()
            out[cur] = []
        elif cur is not None:
            out[cur].append(line)
    return {k: "\n".join(v) for k, v in out.items()}


def _written(body, skip):
    """What the owner wrote under a heading: its paragraphs less the
    template's guidance, comments and placeholders. "" when nothing is left."""
    body = COMMENT_RE.sub("", body)
    keep = []
    for para in re.split(r"\n\s*\n", body):
        folded = _fold(para)
        if not folded or folded in skip or PLACEHOLDER_RE.match(folded):
            continue
        keep.append(para.strip("\n").rstrip())
    return "\n\n".join(keep).strip()


def parse(text):
    """A definition's text read as {mode, start, fields, ready, missing}.

    `mode` and `start` are as written, or None when absent; `start` None is
    read as DEFAULT_START by `ready`. `fields` holds every name in FIELDS,
    "" for a section that is missing or still the template's."""
    front, body = _frontmatter(text)
    skip = _template_paragraphs()
    sections = _sections(body)
    fields = {name: _written(sections.get(heading.lower(), ""), skip)
              for name, heading in FIELDS}
    mode = front.get("mode") or None
    start = front.get("start") or None
    missing = []
    if NOT_FILLED in text:
        missing.append(MARKER)
    if mode not in MODES:
        missing.append("mode")
    if start is not None and start not in STARTS:
        missing.append("start")
    missing += [name for name in REQUIRED if not fields[name]]
    return {"mode": mode if mode in MODES else None,
            "start": start if start in STARTS else (DEFAULT_START if start is None else None),
            "fields": fields, "ready": not missing, "missing": missing}


def _words(name):
    """A list or bucket name as words: hyphens and underscores become spaces."""
    return " ".join(re.split(r"[-_]+", name)).strip()


def agent_name(dataset, bucket):
    """"[List] [bucket] agent", the name a bucket's agent goes by on the board.

    The list in words with its first letter capitalised, then the bucket as its
    stream is spelt: `Work and career tenon-ds agent`. A bucket that already
    starts with the list's name keeps one copy of it, its remainder in words,
    so `personal-tasks` in `personal` is `Personal tasks agent`."""
    if bucket == dataset:
        rest = ""
    elif bucket.startswith(dataset + "-"):
        rest = _words(bucket[len(dataset) + 1:])
    else:
        rest = bucket
    head = _words(dataset)
    head = head[:1].upper() + head[1:]
    return " ".join(w for w in (head, rest, "agent") if w)


def by_name(dataset, name, root=None):
    """The bucket whose agent_name() is `name` (case and spacing aside), or None."""
    want = " ".join((name or "").split()).lower()
    if not want:
        return None
    for bucket in bucket_names(dataset, root):
        if agent_name(dataset, bucket).lower() == want:
            return bucket
    return None


def load(dataset, bucket, root=None):
    """One bucket's agent definition: `mode`, `start`, `fields` (name -> text),
    `ready` and `missing` (field names, `marker` first when the template's line
    is still there), plus `bucket`, `name` (agent_name()), `path` and `exists`. A bucket with no file
    is not ready, with every required field missing. `mode` and `start` are
    None when what is written is not one of MODES or STARTS."""
    path = definition_path(dataset, bucket, root)
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        exists = True
    except OSError:
        text, exists = "", False
    if exists:
        out = parse(text)
    else:
        out = {"mode": None, "start": DEFAULT_START,
               "fields": {name: "" for name, _ in FIELDS},
               "ready": False, "missing": ["mode"] + list(REQUIRED)}
    out.update({"bucket": bucket, "name": agent_name(dataset, bucket), "path": path, "exists": exists})
    return out


def bucket_names(dataset, root=None):
    """A list's buckets: the streams its buckets/README.md names, in its order,
    then any other folder under buckets/. The README is the board's record of
    the list's buckets, so a bucket it names with no folder yet is still one."""
    root = _root(root)
    _check_names(dataset, None, root)
    folder = buckets_dir(dataset, root)
    names = []
    try:
        with open(os.path.join(folder, "README.md"), encoding="utf-8") as fh:
            for line in fh:
                m = README_ROW.match(line.strip())
                if m and BUCKET_RE.match(m.group(2)) and m.group(2) not in names:
                    names.append(m.group(2))
    except OSError:
        pass
    try:
        entries = sorted(os.listdir(folder))
    except OSError:
        entries = []
    for name in entries:
        if (BUCKET_RE.match(name) and name not in names
                and os.path.isdir(os.path.join(folder, name))):
            names.append(name)
    return names


def all_buckets(dataset, root=None):
    """Each bucket of a list with its load() result, in bucket_names() order."""
    return [load(dataset, name, root) for name in bucket_names(dataset, root)]


def describe(result):
    """One line for the CLI."""
    if result["ready"]:
        return "ready (%s, %s)" % (result["mode"], result["start"])
    if not result["exists"]:
        return "not ready: no file at %s" % result["path"]
    missing = ["the NOT FILLED IN YET line is still there" if m == MARKER else m
               for m in result["missing"]]
    return "not ready, missing: %s" % ", ".join(missing)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1 or argv[0].startswith("-"):
        print("usage: python3 core/bucket_agents.py <list>", file=sys.stderr)
        return 2
    try:
        results = all_buckets(argv[0])
    except ValueError as err:
        print(err, file=sys.stderr)
        return 2
    if not results:
        print("%s has no buckets" % argv[0])
        return 0
    width = max(len(r["bucket"]) for r in results)
    for r in results:
        print("%s  %s" % (r["bucket"].ljust(width), describe(r)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
