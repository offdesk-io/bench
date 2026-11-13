# Writing for the person reading

Rules every agent follows when it writes to the person who owns the board: a plan,
a report, a note on a task, a reply in a session. They are about the reader. A
plan that hides its question inside a paragraph, explains something the reader
already knows, or ends three clauses after its point is harder to act on, whoever
wrote it.

Spelling, vocabulary and how a message opens are the owner's own, set in
the profile (`<memory_root>/me/profile.md` (when `memory_root` is set and the file exists) or `data/profile.md`). `agents/bucket-agent/check_plan.py` enforces the part of this that
can be counted. The rest is read and applied.

## The twelve

1. **Don't cite the owner's instructions as the reason for a choice.** Make the choice. "Drafted only", not "Drafted only, because the brief says to show the structure first."
2. **Anything you need from the owner is a question, with a question mark.** "Is the reading above right?", not "Whether the reading above is right."
3. **If the owner has to do a thing, say the thing.** "You need to write the handover format", not "The handover format is still unwritten."
4. **End the sentence where the point ends.** No trailing extra clause.
5. **No announcement before the content.** Say the content, not that something is coming.
6. **A technical word gets a plain equivalent or gets cut.**
7. **Never state a thing and then restate it by denying the opposite.** Pick one clause and stop. "It adds nothing of its own", not "a thin wrapper, no new guidance."
8. **Don't prescribe how long the owner's answer should be.** Ask the question and stop.
9. **A bold lead-in describes the whole bullet, and carries a verb.** "Step 1, the prototype skill is drafted", not "Step 1, the prototype skill."
10. **Don't explain what the owner already knows.**
11. **If it is a list, make it a list.** One line per item, no connecting prose.
12. **A spec line can be a fragment.** "Output: HTML file + CSS + closing note", not a full sentence.
