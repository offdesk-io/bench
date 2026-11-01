#!/usr/bin/env python3
"""The owner's profile, read the same way by every Python caller.

`data/profile.md` holds the owner's setup (template:
`agents/pa_agent/profile.example.md`). Git ignores it. Two things in it matter
outside the PA:

- `Name:` under About, the first name as people.md and `[to::]` spell it. It is
  who the two review sub-tasks of a handover are assigned to. Missing, or still
  the template's `<placeholder>`, it is "Me".
- `Country:` under About, a two-letter code (`GB`, `PT`, `DE`), and an optional
  `Region:` (`GB-ENG`, `GB-SCT`). The public holidays that decide what counts as
  a working day, fetched by core/holidays.py. Neither set, the older
  `Holidays:` line is read instead: `UK`, `PT` or `UK, PT`, meaning England and
  Wales and Portugal. With none of these both count.
- `Facts file:` under About, the path to a file about the owner. Optional.
  Agents and skills read it when it is set and carry on without it otherwise.
- `Workspace folder:` and `Improve agent folder:` under Setup. Both optional:
  a parent folder the agents may read beyond this repo, and where an
  improve-agent checkout lives. Unset, the agents stay inside this repo and code
  plans are not run.

A line is `- Key: value`; backticks around the value are dropped, and `none` or
an unfilled `<placeholder>` counts as unset.

With `memory_root` set in data/settings.json (core/settings.py), the profile is
`<memory_root>/me/profile.md` when that file is there, and data/profile.md when
it is not. Reads and writes both go to whichever profile_path() names.

On a shared board (BENCH_AUTH=header, core/board_access.py) each signed-in
person has a profile of their own, `data/users/<hash>.profile.md` beside their
user record, in the same format. Every reader takes an `address`: given one,
it reads that person's file when they have one and the shared profile above
when they do not, so the shared file stays as everybody's fallback. A write
for an address always lands in the person's own file, which starts as a copy
of the profile they were reading. A board's working calendar is its owner's
(board_holiday_regions()), since a board has one calendar and the owner is the
one person every board has. With nobody signed in, nothing passes an address
and the profile is the one file it always was.
"""

import os
import re

import settings  # sits beside this file

DEFAULT_OWNER = "Me"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def data_root():
    return os.environ.get("TODOS_DATA_ROOT") or os.path.join(ROOT, "data")


def own_profile_path(address, root=None):
    """data/users/<hash>.profile.md, this person's own profile, there or not."""
    import board_access  # sits beside this file
    return board_access.profile_path(root or data_root(), address)


def profile_path(root=None, address=None):
    """The profile in force: for a signed-in person their own file when they
    have one, else the memory folder's `me/profile.md` when the setting names
    one and the file is there, else data/profile.md."""
    root = root or data_root()
    if address:
        own = own_profile_path(address, root)
        if os.path.isfile(own):
            return own
    memory = settings.memory_root(root)
    if memory:
        path = os.path.join(memory, "me", "profile.md")
        if os.path.isfile(path):
            return path
    return os.path.join(root, "profile.md")


def _text(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return None


def _unset(value):
    value = value.strip().strip("`").strip()
    return not value or value.lower() == "none" or bool(re.search(r"<[^>]*>", value))


def read(root=None, address=None):
    """Every `- Key: value` line in the profile, keys lower-cased."""
    out = {}
    for line in (_text(profile_path(root, address)) or "").split("\n"):
        m = re.match(r"\s*[-*]\s+([^:]+):\s*(.*?)\s*$", line)
        if not m or _unset(m.group(2)):
            continue
        out.setdefault(m.group(1).strip().lower(), m.group(2).strip().strip("`").strip())
    return out


def owner_name(root=None, address=None):
    return read(root, address).get("name", DEFAULT_OWNER)


def holiday_place(root=None, address=None):
    """(country, region) the profile names, region "" when none; (None, "") when
    it names neither. An old `Holidays:` line reads as GB + GB-ENG for UK, and
    PT for PT; UK wins when both are listed."""
    prof = read(root, address)
    country = prof.get("country", "").strip().upper()
    if re.fullmatch(r"[A-Z]{2}", country):
        region = prof.get("region", "").strip().upper()
        return country, region if re.fullmatch(r"[A-Z]{2}-[A-Z0-9]{1,3}", region) else ""
    old = re.split(r"[,\s/&]+", prof.get("holidays", "").upper())
    if "UK" in old:
        return "GB", "GB-ENG"
    if "PT" in old:
        return "PT", ""
    return None, ""


def holiday_regions(root=None, address=None):
    """The holiday calendars the profile names, as a tuple of keys for todo.py.

    `Country:` gives one key, "CC:REGION". Otherwise the `Holidays:` line gives
    todo.py's built-in "UK" and "PT", both when the line is missing or names
    none it knows. Unknown entries are skipped, so `UK, FR` is just `UK`."""
    import todo  # sits beside this file; imported here so todo can import this one later
    prof = read(root, address)
    if re.fullmatch(r"[A-Za-z]{2}", prof.get("country", "")):
        country, region = holiday_place(root, address)
        return ("%s:%s" % (country, region),)
    wanted = re.split(r"[,\s/&]+", prof.get("holidays", "").upper())
    picked = tuple(r for r in todo.REGIONS if r in wanted)
    return picked or tuple(todo.REGIONS)


def calendar_address(board_dir):
    """Whose profile sets a board's working calendar: signed in, the owner in
    its access.json; otherwise None, the shared profile."""
    import board_access  # sits beside this file
    try:
        if board_access.mode() != "header":
            return None
    except ValueError:
        return None
    access = board_access.read(board_dir)
    return access["owner"] if access else None


def board_holiday_regions(board_dir, root=None):
    """holiday_regions() for one board, by its owner's profile when signed in."""
    return holiday_regions(root, calendar_address(board_dir))


def facts_file(root=None, address=None):
    """The owner's facts file as an absolute path, or None when unset or missing."""
    value = read(root, address).get("facts file")
    if not value:
        return None
    path = os.path.expanduser(value)
    return path if os.path.isfile(path) else None


def _folder(key, root=None):
    value = read(root).get(key)
    return os.path.expanduser(value) if value else None


def workspace_folder(root=None):
    """The parent folder the agents may read beyond this repo, or None."""
    return _folder("workspace folder", root)


def improve_agent_folder(root=None):
    """Where improve-agent lives, or None."""
    return _folder("improve agent folder", root)


TEMPLATE = os.path.join(ROOT, "agents", "pa_agent", "profile.example.md")
REGION_ORDER = ("UK", "PT")


def needs_setup(root=None, address=None):
    """True when there is no profile or its Name is missing or still the placeholder."""
    return "name" not in read(root, address)


# The About lines Settings edits as fields, beyond Name, Country and Region,
# by the key the board sends.
ABOUT = (("addressing", "How to address them"), ("facts_file", "Facts file"))
# The sections Settings edits as one text box each.
SECTIONS = (("setup", "Setup"), ("writing", "Writing"),
            ("recorder", "Meeting recorder"), ("habits", "Working habits"))


def _span(lines, heading):
    """(first line of the body, line after it) of `## heading`, or None."""
    for i, line in enumerate(lines):
        if re.match(r"^##\s+%s\s*$" % re.escape(heading), line, re.I):
            j = i + 1
            while j < len(lines) and not lines[j].startswith("## "):
                j += 1
            return i + 1, j
    return None


def _body(text, heading):
    """A section's text with its blank edges trimmed, "" when there is none."""
    lines = (text or "").split("\n")
    got = _span(lines, heading)
    return "\n".join(lines[got[0]:got[1]]).strip("\n") if got else ""


def about_fields(root=None, address=None):
    """The ABOUT fields as the board sends them, "" for unset."""
    prof = read(root, address)
    return {key: prof.get(label.lower(), "") for key, label in ABOUT}


def section_texts(root=None, address=None):
    """Each of SECTIONS as Settings shows it, as written. A section still as
    the template has it reads as "", so the box is empty and shows the
    template as its hint, and saving it empty puts the template back."""
    text, tmpl = _text(profile_path(root, address)) or "", _text(TEMPLATE) or ""
    out = {}
    for key, heading in SECTIONS:
        got = _body(text, heading)
        out[key] = "" if got == _body(tmpl, heading) else got
    return out


def section_hints():
    """Each of SECTIONS as the template has it, for an empty box's hint."""
    tmpl = _text(TEMPLATE) or ""
    return {key: _body(tmpl, heading) for key, heading in SECTIONS}


def _set_section(text, heading, body):
    """`## heading` with `body` in place of whatever it held, added at the end
    when the profile has no such section."""
    lines = text.split("\n")
    got = _span(lines, heading)
    if not got:
        return text.rstrip("\n") + "\n\n## %s\n\n%s\n" % (heading, body)
    i, j = got
    lines[i:j] = [""] + body.split("\n") + [""]
    return "\n".join(lines)


def _about_error(label, value):
    if not isinstance(value, str) or len(value) > 300 or re.search(r"[<>`\r\n]", value):
        return "%s must be one line of text without < > or backticks" % label.lower()
    return None


def _section_error(heading, value):
    if not isinstance(value, str) or len(value) > 4000:
        return "%s must be text of at most 4000 characters" % heading.lower()
    if any(re.match(r"^#{1,2}(\s|$)", l) for l in value.split("\n")):
        return "%s cannot hold a # or ## heading" % heading.lower()
    return None


def _set_line(text, key, value):
    """Put `- Key: value` in place of the first line for that key, leaving the rest."""
    lines = text.split("\n")
    pattern = re.compile(r"^(\s*[-*]\s+)%s:.*$" % re.escape(key), re.I)
    for i, line in enumerate(lines):
        m = pattern.match(line)
        if m:
            lines[i] = ("%s%s: %s" % (m.group(1), key, value)).rstrip()
            return "\n".join(lines)
    # Not there: add it under About, or at the end when there is no About.
    new = ("- %s: %s" % (key, value)).rstrip()
    for i, line in enumerate(lines):
        if re.match(r"^##\s+About\s*$", line):
            j = i + 1
            while j < len(lines) and not lines[j].startswith("## "):
                j += 1
            while j > i + 1 and not lines[j - 1].strip():
                j -= 1
            lines.insert(j, new)
            return "\n".join(lines)
    return text.rstrip("\n") + "\n\n## About\n\n" + new + "\n"


def _drop_line(text, key):
    pattern = re.compile(r"^\s*[-*]\s+%s:" % re.escape(key), re.I)
    return "\n".join(l for l in text.split("\n") if not pattern.match(l))


def write_basics(root=None, name=None, holidays=None, country=None, region=None,
                 about=None, sections=None, address=None):
    """Write the `Name:` line, the holiday lines, and whatever else Settings sent.

    `country` and `region` write `Country:` and `Region:` (an empty region
    removes its line) and retire an old `Holidays:` line. The caller checks them
    against the country list. `holidays` is the older way, a list of `UK`, `PT`;
    none picked means both. `about` maps ABOUT keys to one-line values ("" for
    unset), and `sections` maps SECTIONS keys to a section's whole text, an
    empty one putting the template's back. Anything not sent stays as it was.
    A missing file starts from the template.

    With an `address` the write is that person's own file. Their first write
    starts from the profile they were reading until then, the shared one, so
    nothing they saw is lost by saving something else. Returns an error
    message, or None."""
    root = root or data_root()
    about = about or {}
    sections = sections or {}
    labels, headings = dict(ABOUT), dict(SECTIONS)
    for key, value in about.items():
        if key not in labels:
            return "%s is not a profile field" % str(key)[:40]
        err = _about_error(labels[key], value)
        if err:
            return err
    for key, value in sections.items():
        if key not in headings:
            return "%s is not a profile section" % str(key)[:40]
        err = _section_error(headings[key], value)
        if err:
            return err
    if name is not None:
        name = " ".join(str(name).split())
        if not name or re.search(r"[<>`]", name):
            return "name must be text without < > or backticks"
    if holidays is not None:
        if not isinstance(holidays, (list, tuple)) or any(h not in REGION_ORDER for h in holidays):
            return "holidays must be a list of: %s" % ", ".join(REGION_ORDER)
    if country is not None:
        country = str(country).strip().upper()
        region = str(region or "").strip().upper()
        if not re.fullmatch(r"[A-Z]{2}", country):
            return "country must be a two-letter code"
        if region and not re.fullmatch(r"%s-[A-Z0-9]{1,3}" % country, region):
            return "region must look like %s-XX" % country
    path = own_profile_path(address, root) if address else profile_path(root)
    text = _text(profile_path(root, address))
    if text is None:
        text = _text(TEMPLATE) or "# PA profile\n\n## About\n\n"
    if name is not None:
        text = _set_line(text, "Name", name)
    if country is not None:
        text = _drop_line(text, "Holidays")
        text = _set_line(text, "Country", country)
        text = _drop_line(text, "Region")
        if region:
            text = _set_line(text, "Region", region)
    elif holidays is not None:
        picked = [r for r in REGION_ORDER if r in holidays] or list(REGION_ORDER)
        text = _set_line(text, "Holidays", ", ".join(picked))
    for key, value in about.items():
        text = _set_line(text, labels[key], value.strip())
    for key, value in sections.items():
        body = value.replace("\r", "").strip("\n")
        text = _set_section(text, headings[key], body or _body(_text(TEMPLATE) or "", headings[key]))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)
    return None
