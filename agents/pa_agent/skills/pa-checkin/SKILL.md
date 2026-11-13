---
name: pa-checkin
description: Run the daily check-in over the owner's master to-do list, at data/<dataset>/todo.md in the Bench checkout (<dataset> named by data/.current). It reads the list, gives the owner the brief for the day and the week rendered from a template the owner edits, asks what has moved, and hands the writing to the pa skill. Use it whenever the owner asks for a check-in or a status read on the list, including phrasings like "let's do a check-in", "morning check-in", "let's do a todo meeting", "brief me", "what's on my plate", "what's due this week", "what am I doing today", "where am I", "what did I miss", or "let's go through my buckets". Do not use it for a change the owner has already decided on, which is the pa skill on its own, for the backlog sweeps, which are pa-checkout and pa-focus, or from a phone, which is pa-mobile.
---

# The daily check-in

`$BENCH_ROOT` is the Bench checkout: the `BENCH_ROOT` environment variable, or `~/Code/bench` when unset. Before running any command or reading any file below, `cd "${BENCH_ROOT:-$HOME/Code/bench}"`. Paths in this skill are relative to the checkout.

The morning session over the list: what came in overnight, what today and this week look like, what has moved, and whether the one thing still holds.

**Read `agents/pa_agent/PA.md` first, every session, then `CONVENTIONS.md`.** The first holds who the owner is, where the list lives, how the owner prioritises, the standing rules and the tone. The second holds the file format. Everything below assumes both have been read, and does not repeat them.

**This skill does not write `todo.md`.** It reads, it reports, it asks, and it hands what the owner agreed to `pa`. That skill owns the tag syntax, the scores, the agendas, the checker and the Reload line, in one copy, so there is one place a convention can be wrong. Invoke it with the Skill tool at the end of the session and let it finish before you close.

## What a check-in is for

The value is in the two things the owner cannot easily do themself: the brief and the headline check. The middle of the session, applying what the owner tells you, is the cheap part.

On a quiet morning where nothing has changed, moves 2, 3 and 5 are the whole session: here is the day, the headline still holds, plus the one process-match question in move 4 when there is a match. Do not manufacture work to fill the rest.

## Move 1: pull what came in, only when asked

**Off by default.** The check-in does not pull meeting actions on its own and does not mention the recorder or the `Meeting actions last pulled` line. Invoke `pa-retrieve-tasks` only when the owner asks for it in this session ("check my calls", "pull my action items"). Otherwise go straight to move 2.

## Move 2: confirm the board, then read

**Ask which board to review before reading or rendering anything.** Read `data/.current`, name it in the question ("Current list is `<name>`, is that the one?") and wait for the owner's answer. Never brief from `data/.current` unconfirmed. If the owner names a different board, use that one for the whole session.

Then read the confirmed dataset's `todo.md`, and its `context.md` through the memory lookup (`<memory_root>/bench/<dataset>/` when Bench's `memory_root` is set and holds the file, else `data/<dataset>/`). Context is its own file, no longer a section of `todo.md`. It holds who is who, who is on leave and whose contract runs out when. It also holds `### How I want messages and prompts written` and `### Recurring meeting prep scripts`, both the owner's own words, and both override anything in the reference files wherever they disagree.

Then run the checker:

```bash
python3 "${BENCH_ROOT:-$HOME/Code/bench}"/agents/pa_agent/skills/pa/scripts/check_todo.py "${BENCH_ROOT:-$HOME/Code/bench}"/data/<dataset>/todo.md
```

**Do not ask whether the board is open.** Start straight away. The risk that question is aimed at is closed off by the Reload line `pa` gives the owner at the end.

## Move 3: the brief

**Render it, don't write it out.** `templates/` holds one file per shape of brief. Read the whole folder at the start of the session, because the owner adds and edits these and the folder is the current set, not the list in this file.

Pick by what the owner asked for, using the `use:` line in each template's frontmatter. When two fit, pick the shorter one. When nothing fits, say so in one line and ask which the owner wants rather than inventing a shape, and note that a template for it is worth writing.

The headline, overdue, due today/tomorrow/this week, doing, waiting, blocked, week, delegate, meetings and every count are worked out by `core/aggregate.py` now, not read off the file by eye — and the placeholder rules, the empty-line rule and the `lines:` ceiling are `core/render.py`'s job, not something to reason through by hand:

```bash
python3 -c "
import sys, json
sys.path.insert(0, 'core')
import todo, aggregate, render, bucket_agents
tasks = todo.parse_doc(open('data/<dataset>/todo.md', encoding='utf-8').read())
ctx = aggregate.today_view(tasks, processes_of=lambda b: bucket_agents.processes('<dataset>', b))
print(render.render('agents/pa_agent/skills/pa-checkin/templates/<name>.md', ctx))
print('--- process matches ---')
print(json.dumps(ctx['process_matches'], indent=1))
"
```

run from the bench repo root, with `<dataset>` and `<name>` filled in. Everything above the `--- process matches ---` line is the brief, verbatim — send it as it stands rather than editing it, the same way `pa`'s own writing rules never apply to something rendered. What is below the line is for move 4 and is not sent.

Three fields still come back empty on every template — `checker_flags`, `slipped` and `context_dates` — because nothing computes them yet. Treat that the way a template treats any other empty field: the line or section drops, and nothing here should try to fill the gap by re-reading the file for them. What the checker flagged and what has slipped since `Last updated` are still worth knowing, so read them yourself from the checker's own output above and from Context's dates, and say them separately if they matter — just not as though the template rendered them.

The syntax and every field available are in `agents/pa_agent/skills/pa/references/templates.md`, worth reading before the first render of a session if it has been a while.

Send the brief on its own. No preamble in front of it and no summary after it, since the brief already is the summary.

## Move 4: ask what has changed

Ask what has moved since the last session. Two useful shapes, pick by context:

- **Targeted**, when the owner has already named something: confirm just that, apply it, and offer the wider sweep afterwards.
- **Bucket by bucket**, when the owner says "let's review" or the file is more than a week stale: walk the buckets in the order the file has them, currently People, Design oversight, Design System, Strategic. One bucket per message, so the owner can answer without holding four contexts at once.

Do not ask about every task. Ask about the states that matter: what is in Doing, and anything with a date inside the next fortnight.

Straight after the brief, offering the obvious moves as choices is often faster than an open question: tick the headline's next step, move a date, write the agenda for the meeting that is coming, nothing for now. **"Nothing for now" is always one of the options.** Most mornings the owner wanted the brief and that is all.

**Help that already exists.** The process matches below the brief are up to three To do or Doing tasks that read as a process their bucket's brief already names, with the skill or planner that covers it in `covered_by`. They come from shared words, so open each row's `brief` and drop any that is not really that process before offering. Ask about what is left in one question, one lettered line per task: the task, the process, what covers it, and whether to hand it over or run it now. "None of these" is always an answer, and a wrong match costs the owner nothing more. A hand-over is the board's Delegate to, or `pa` in move 6 when the owner asks for it here, since `pa` writes those sub-tasks only when asked. Running a skill now happens in this session, after the brief's other answers. No matches, or none left after reading the briefs, means no question.

## Move 5: the headline

Check it, do not re-pick it. Most mornings this is one line and one question.

**If it still holds**, say so and stop. Do not re-open the choice because something newer looks shinier.

**If it is solved or blocked**, that is a pick, and picking is `pa`'s job under tier two: count what waits on each candidate, look for what a candidate makes unnecessary, prefer something the owner can finish this week. Pass it over with the reason it is no longer the headline.

## Move 6: hand it to pa

Invoke `pa` with everything the owner agreed to in one list: the task, what changes, and anything you know that the file does not show. It applies the changes under the conventions, runs the optimisation pass on the file as it now stands, re-runs the checker, stamps `Last updated`, reports in its own short shape, and closes with the Reload line.

Do not write anything yourself first, including `Last updated` and the watermark. `pa-retrieve-tasks` owns the watermark's value and `pa` owns the writing.

**If nothing changed**, there is nothing to hand over. Say the headline holds and stop.

## Judgement calls that come up

**The owner only wants the meeting prep.** "Get me ready for the Morgan 1:1", "what do I need to raise on Wednesday". That is not a check-in. Go straight to `pa`, which writes agendas, and skip everything here.

**The owner reports progress on one task and nothing else.** Also not a check-in. That is `pa` on its own, one change and one line back.

**The owner asked for a pull and the recorder is unreachable.** Say so in one line, carry on with the brief, and leave the watermark alone.

**The brief would run past the template's `lines:`.** Cut from the bottom, keep the headline and anything overdue, and end with the `+N more` count. Do not reflow the template to make room.

**The file has not been touched in over a week.** Say so in the brief and go bucket by bucket in move 4. A stale file usually means several dates have quietly passed rather than one.

**The checker flags something that was already there when you arrived.** Put it in the brief once, in the `checker_flags` block, and leave it. Do not open the session with it.

## Tone

See `agents/pa_agent/PA.md`. The brief is rendered rather than written, so the tone that matters here is everything around it: the question in move 4, the headline line in move 5. Keep both to one line each.
