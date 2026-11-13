#!/usr/bin/env python3
"""Each bucket's agent, as the owner defined it, and whether it is ready to run.

    python3 core/bucket_agents.py <list>     each bucket, ready or not, and what is missing

A bucket's agent is defined in one file, the bucket's brief, which the owner
fills in (template: agents/bucket-agent/bucket-brief.template.md). Its
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
The guidance is read out of the template itself, so the template is the one
copy of it.

The file is `data/<list>/buckets/<bucket>/<bucket>.md`, the brief's own place,
where the board's brief editor reads it too. Anything
about a bucket stays in Bench, and only people, about, context and the profile
go to the memory folder, so it is never routed through the memory lookup.
Every reader here goes through definition_path(), so the file's place is said
once.

Each bucket's agent has a name, agent_name(), which is what a sub-task handed
to it carries in `[to::]` and what its ticks are queued under. by_name() reads
one back to its bucket.

A column of the board is a heading in todo.md, and stream_of() says which
bucket it is: the row for it in buckets/README.md, else the heading's own slug.
The board's brief editor and the PA's handover migration both go through it.

processes() reads a brief the other way, as the processes its owner runs and
the skills that already do each, for the PA check-in's process match
(core/aggregate.py).
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import settings  # noqa: E402

ROOT = os.path.dirname(HERE)
TEMPLATE = os.path.join(ROOT, "agents", "bucket-agent", "bucket-brief.template.md")

MODES = ("plan-first", "free-rein")
STARTS = ("on-assign", "scheduled")
DEFAULT_START = "on-assign"

# The line every brief ships with, and the one line that has to come out before
# the brief counts as written. The board's brief editor shows it as the marker.
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


def api_row(b):
    """A load() result as GET /api/bucket-agents sends it: who and how the agent
    works, whether it is ready, and `sections`, each brief field's text by key."""
    return {"bucket": b["bucket"], "name": b["name"], "mode": b["mode"], "start": b["start"],
            "ready": b["ready"], "missing": b["missing"], "sections": dict(b["fields"])}


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


def heading_slug(heading):
    """A heading as a stream name. "## 3. DS" -> "ds"."""
    key = re.sub(r"^#+\s*", "", (heading or ""))
    key = re.sub(r"^\d+[.)]\s*", "", key).strip().lower()
    return re.sub(r"[^a-z0-9]+", "-", key).strip("-")


# The README's own header row and separator, which are not a bucket.
README_HEADINGS = ("Heading in `todo.md`", "---", "\u2014")


def stream_map(dataset, root=None):
    """heading_slug(heading) -> stream, out of the list's buckets/README.md.
    Empty when there is no such file, so every heading is its own slug."""
    out = {}
    try:
        with open(os.path.join(buckets_dir(dataset, _root(root)), "README.md"), encoding="utf-8") as fh:
            for line in fh:
                m = README_ROW.match(line.strip())
                if not m or m.group(1).strip() in README_HEADINGS:
                    continue
                key = heading_slug(m.group(1).strip())
                if key:
                    out[key] = m.group(2).strip()
    except OSError:
        return {}
    return out


def stream_of(dataset, heading, root=None):
    """Which bucket a todo.md heading is: its README row first, so a column
    renamed on the board keeps its brief, then the heading's own slug. None
    for a heading with no letters or digits in it."""
    key = heading_slug(heading)
    if not key:
        return None
    stream = stream_map(dataset, root).get(key, key)
    return stream if BUCKET_RE.match(stream) else None


def all_buckets(dataset, root=None):
    """Each bucket of a list with its load() result, in bucket_names() order."""
    return [load(dataset, name, root) for name in bucket_names(dataset, root)]


# The two sections of a brief the check-in's process match reads, by the
# headings the template ships with. A brief that renames them is a brief the
# match cannot see into, the same cost as any other string-matched heading here.
PROCESSES_HEADING = "the processes i run in this bucket"
COVERED_HEADING = "what already does it"
# A skill or agent name as briefs write one: a backticked, hyphenated,
# lowercase word. A backticked path has a slash or a dot in it and is not one.
SKILL_RE = re.compile(r"`([a-z0-9][a-z0-9-]*)`")
LEAD_RE = re.compile(r"^\*{1,2}([^*]+?)\.?\*{1,2}\.?\s*")


def _units(lines, skip):
    """A section cut into its processes: one per `### ` heading, one per
    `**Bold.**` lead-in or bullet, otherwise one per paragraph."""
    units, cur = [], None

    def start(name, text=""):
        nonlocal cur
        cur = {"process": name, "text": text}
        units.append(cur)

    for raw in lines:
        line = raw.strip()
        if line.startswith(("<!--", ">")):
            continue
        if not line:
            if cur is not None and not cur.get("heading"):
                cur = None
            continue
        m = re.match(r"^###\s+(.+)$", line)
        if m:
            start(m.group(1).strip())
            cur["heading"] = True
            continue
        bullet = re.match(r"^[-*]\s+(.*)$", line)
        body = bullet.group(1) if bullet else line
        lead = LEAD_RE.match(body)
        if lead or (bullet and not (cur and cur.get("heading"))) or cur is None:
            if lead:
                start(lead.group(1).strip(), body[lead.end():])
            else:
                start("", body)
            continue
        cur["text"] += " " + body

    out = []
    for u in units:
        text = " ".join(re.sub(r"\|\s*-{3,}\s*|\|", " ", u["text"]).split())
        if not text and not u["process"]:
            continue
        if text in skip:
            continue
        name = u["process"]
        if not name:
            # An unheaded paragraph is named by its first clause, short enough
            # to say in one line of the question.
            first = re.split(r"[.,;:]\s|\s\u2014\s", text, maxsplit=1)[0]
            words = first.replace("`", "").split()[:8]
            while len(words) > 1 and words[-1].lower() in ("and", "or", "of", "the", "a", "to"):
                words.pop()
            name = " ".join(words)
        out.append({"process": name, "text": text,
                    "skills": sorted(set(SKILL_RE.findall(text)))})
    return out


def _clauses(lines):
    """What already does it, cut fine enough that a skill sits with what it
    does: a table row each, otherwise a sentence, and a sentence listing
    several skills with a verb each (`a` answers this, `b` runs that) cut at
    each one. A bare run of names (`a`, `b` and `c` apply when) stays with the
    verb that follows it."""
    rows, prose = [], []
    for raw in lines:
        line = raw.strip()
        if line.startswith("|"):
            if not re.match(r"^\|[\s:|-]+\|$", line):
                rows.append(line)
        else:
            prose.append(line)
    out = list(rows)
    for sentence in re.split(r"(?<=[.!?])\s+", " ".join(prose)):
        pieces, carry = [], ""
        for piece in re.split(r",\s+(?=`)", sentence):
            piece = carry + piece
            if not re.sub(r"`[^`]*`|\band\b|[,\s]", "", piece):
                carry = piece + ", "
                continue
            carry = ""
            pieces.append(piece)
        if carry:
            pieces.append(carry)
        out.extend(p for p in pieces if p.strip())
    return out


def parse_processes(text, known=None):
    """A written brief as the processes its owner runs, each with the skills
    that already do it.

    A process's skills are the ones named inside it, and any clause of What
    already does it that names a skill and shares a word with the process's
    name: `ds-component-docs` writes usage documentation, so it covers
    Documentation. `known` says whether a backticked name is a skill or agent
    at all, since a brief backticks repos and boards the same way. Prose read
    as prose, so the match it feeds is a candidate for the check-in to judge,
    never a decision.
    """
    known = known or (lambda name: True)
    sections = {k: v.split("\n") for k, v in _sections(text).items()}
    skip = _template_paragraphs()
    title = next((l[2:].strip() for l in text.split("\n") if l.startswith("# ")), "")
    found = _units(sections.get(PROCESSES_HEADING, []), skip)
    clauses = [(c.lower(), SKILL_RE.findall(c))
               for c in _clauses(sections.get(COVERED_HEADING, []))]
    for p in found:
        skills = set(p["skills"])
        words = set(re.findall(r"[a-z]{4,}", p["process"].lower()))
        for line, named in clauses:
            if named and any(w in line for w in words):
                skills |= set(named)
        p["skills"] = sorted(s for s in skills if known(s))
    return {"title": title, "processes": found}


def skill_installed(name):
    """Whether Claude Code would find a skill or agent of that name: linked
    into ~/.claude/skills/, or defined in either agents folder."""
    home = os.path.expanduser("~/.claude")
    return (os.path.isdir(os.path.join(home, "skills", name))
            or os.path.isfile(os.path.join(home, "agents", "%s.md" % name))
            or os.path.isfile(os.path.join(ROOT, ".claude", "agents", "%s.md" % name)))


def processes(dataset, heading, root=None, known=skill_installed):
    """What the check-in matches a column's open tasks against, or None where
    its bucket has no written brief. `planner` is the bucket's agent when it
    is ready, since it reads the brief and knows every process in it, so a
    process no skill covers still has somewhere to go."""
    stream = stream_of(dataset, heading, root)
    if not stream:
        return None
    path = definition_path(dataset, stream, root)
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        return None
    if NOT_FILLED in text:
        return None
    out = parse_processes(text, known=known)
    out["brief"] = path
    out["planner"] = agent_name(dataset, stream) if parse(text)["ready"] else ""
    return out


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
