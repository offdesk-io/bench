#!/usr/bin/env python3
"""Which list is in force, worked out one way for every Python reader.

`data/.current` names it. Missing or blank, the one list on disk is used when
there is exactly one, which covers a fresh clone with a single list in it. With
none or several there is no safe guess, so this raises rather than quietly
reading or writing some other list: a tick queued against the wrong list is
applied to the wrong card.

A list is a folder under the data root with a `todo.md` in it. A leading dot or
underscore marks something that is not one (`_test` is a fixture), the same
rule `agents/bucket-agent/paths.py` lists them by.
"""

import os


def names(data_root):
    """Every list under `data_root`, sorted."""
    try:
        entries = os.listdir(data_root)
    except OSError:
        return []
    return sorted(n for n in entries
                  if not n.startswith((".", "_"))
                  and os.path.isfile(os.path.join(data_root, n, "todo.md")))


def current(data_root):
    """The list `data/.current` names, or the only one there is."""
    try:
        with open(os.path.join(data_root, ".current"), encoding="utf-8") as fh:
            name = fh.read().strip()
    except OSError:
        name = ""
    if name:
        return name
    found = names(data_root)
    if len(found) == 1:
        return found[0]
    raise LookupError(
        "No list is chosen and there are %d to choose from. Set data/.current: "
        "write a list's folder name into %s"
        % (len(found), os.path.join(data_root, ".current")))
