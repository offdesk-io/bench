"""The kinds of work a plan can be, and which of them may run without the owner.

Decided in IMPROVEMENTS.md, "The implementing agent only runs
with the owner in the room because nothing says which kinds of work it can do
alone". The Plan agent writes one of these as `type:` in a plan's frontmatter,
`write_plan()` in agents/bucket-agent/plans.py reads it back.

No type is approved on arrival any more: the owner ticks every Review the plan.
What a type still decides is how the bucket agents' runner
(agents/bucket-agent/hooks.py) carries an approved plan out: `code` on a branch,
`figma` not at all unattended, and the rest as new files in the task's project
folder. The retired Implement agent's runner (agents/implement-agent/hooks.py)
still reads UNATTENDED.
"""

TYPES = ("write-up", "draft", "prompt", "data", "deck", "figma", "code", "other")

# Only add new files inside one project folder and send nothing.
FILES = ("write-up", "draft")

# May sit beside something that exists, so they write into the project folder,
# never over a file, and save a new version as `name-v2.md` beside the original.
GUARDED = ("prompt", "data", "deck")

# What the retired Implement agent's runner took on alone, once the plan's
# review was ticked. Figma is left out: see FIGMA_REFUSAL in
# agents/bucket-agent/hooks.py.
UNATTENDED = FILES + GUARDED + ("code",)


def read(value):
    """A `type:` value as written by an agent, as one of TYPES.

    Strict on purpose: a word that is not on the list is `other`, which nothing
    runs alone, rather than a guess at which type it meant."""
    v = (value or "").strip().strip("`\"'").lower()
    return v if v in TYPES else "other"
