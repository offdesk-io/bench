"""The kinds of work a plan can be, and how each is carried out.

A plan-first bucket's agent writes one of these as `type:` in a plan's
frontmatter, and `write_plan()` in agents/bucket-agent/plans.py reads it back.

No type is approved on arrival: the owner ticks every Review the plan, and no
type runs before that. Once it is ticked, the bucket agents' runner
(eligible() and options() in agents/bucket-agent/hooks.py) carries out every
type but one: `code` on an `implement/<date>` branch, `figma` never unattended
(it waits for the `do` skill), and every other type, `other` included, as new
files in the task's project folder.
"""

TYPES = ("write-up", "draft", "prompt", "data", "deck", "figma", "code", "other")

# Only add new files inside one project folder and send nothing.
FILES = ("write-up", "draft")

# May sit beside something that exists, so they write into the project folder,
# never over a file, and save a new version as `name-v2.md` beside the original.
GUARDED = ("prompt", "data", "deck")

# Read only by the retired Implement agent's runner (agents/implement-agent/),
# which took these on alone and nothing else. The bucket agents' runner does not
# read it: it refuses figma alone (FIGMA_REFUSAL in agents/bucket-agent/hooks.py).
UNATTENDED = FILES + GUARDED + ("code",)


def read(value):
    """A `type:` value as written by an agent, as one of TYPES.

    Strict on purpose: a word that is not on the list is `other`, which is never
    carried out as code or Figma, rather than a guess at which type it meant."""
    v = (value or "").strip().strip("`\"'").lower()
    return v if v in TYPES else "other"
