# File conventions

The format is load-bearing. Every rule here exists because breaking it caused a real problem.

## Buckets

A list is split into buckets, one `##` heading each, and the board reads their names out of the file rather than assuming any. Keep the set small: a new bucket is a decision, and a sixth usually means a task is miscategorised. The owner can rename, reorder, add and remove buckets on the board. What each bucket in a list is for belongs in that list's own folder, in `data/<list>/CONVENTIONS.md` and `data/<list>/buckets/`, which git ignores.

## States

Inside each bucket, five states, Done first in the file because the board draws a bucket's headings the other way round. If a file still uses the old headings Now / Next / Later / Parked, rename them to Doing / To do / Backlog rather than adding new ones alongside. The readers still accept Waiting review and Waiting for review as Reviewing. There is no Blocked state: a column says the state of the card, and a blocked task sits in Reviewing or carries `blocked-by:`.

- **Done** — where a ticked task lives, the first heading in every bucket and the far right of the board. The two go together: ticking a task moves it under Done (newest first), and unticking one there sends it back to To do. Every reader treats a ticked task under any other heading as if it were under Done, so a tick made in place is read correctly and the board writes it under Done on its next save. When you tick a task, move it there in the same edit.
- **Reviewing** — finished as far as the owner is concerned, sitting with somebody else for sign-off. On the board it is the last column before Done, so in the file it is the heading right after Done. A task waiting on a person or an event gets a `Waiting on:` note here; a task waiting on another task uses `blocked-by:` instead, wherever it actually sits.
- **Doing** — the current focus window, roughly the next two weeks
- **To do** — two to four weeks out
- **Backlog** — real work, no time pressure yet. Also where anything deliberately not being done goes, with a revisit date in the note.

Backlog absorbed the old Parked state, so it holds two different things: real work nobody has scheduled yet, and work deliberately deferred. A deferred item needs a revisit date in its note, otherwise the two become indistinguishable and the deferred one is never looked at again.

**New tasks do not go into Doing.** That state is the owner's own statement that something is live, so it is only ever set from what the owner says: the owner has started it, is working on it, is mid-way through it. A task arriving on the list goes to To do if prioritisation puts it next up, or Backlog if it does not, whatever its score or date. Adding to Doing on the owner's behalf makes the state a wish list rather than a record of what is in flight.

**Nothing goes into Reviewing on the owner's behalf either.** Like Doing, it is a statement of fact about where the work sits, and only the owner knows whether the pack actually went. Move a task there when the owner says they have sent it, handed it over or is waiting on a reply; move it back to Doing when the review comes back with work in it, and tick it when it comes back clear. A task sitting in Reviewing with no note saying who has it is worth asking about. Waiting on a person is the state most likely to be forgotten.

A state can be empty. Leave the empty headings in place, they make the shape scannable and they stop a bucket looking abandoned.

## Tags

Every top-level task carries impact, effort and a delegation tag. Dates only where real.

`impact` and `effort` together are tier one of how the owner prioritises, and they are set at intake, not later. Neither is optional. A task missing either one shows a **needs scoring** marker on the board and is counted in the header, because a blank score reads as low and the task sinks without anyone deciding that it should.

- `[impact:: high]` / `med` / `low` — how much it moves the needle for the team, the design system or the business
- `[effort:: S]` / `M` / `L` — S is under half a day, M is one to three days, L is a week or more
- `[due:: YYYY-MM-DD]` — the deadline. When it has to be finished by. Only when there is a genuine date.
- `[time:: HH:MM]` — the hour the deadline falls at, 24h, written beside `[due:: ]` on a task or a sub-step. Optional. A time with no due date means nothing and is dropped on the next board save. A `repeat:` rule that carries its own time (`repeat:wed-9:15`) stands in when there is no `[time:: ]`; a sub-step never takes its task's time.
- `[to:: ]` — who does the work. A bucket's agent, by the name `core/bucket_agents.py` gives it ("Work people agent"), plans it or does it as that bucket's brief says. Anything else is a person's name as `people.md` writes it. `Plan agent` and `Implement agent`, the two retired agents, still parse, and the PA moves a line carrying one to its bucket's agent. Left off when the owner is doing it themselves, which is most of the list. It replaces the old `[ai:: ]`, and a line still carrying `ai:` loses it on the next save. What each agent does, cannot do and needs from the person is on the Agents tab, one card each (`AGENT_CARDS` in `kanban/js/02-state.js`); change it when an agent's rules change.
- `start:YYYY-MM-DD` — the earliest it can begin. Optional, and only where something real gates it.
- `urgent` — time-critical with no fixed date. Never combine with `due`, they are alternatives.
- `done:YYYY-MM-DD` — the day it was ticked off. Written by the board, not by hand. Never add it to an open task, and never remove it from a ticked one: it is what decides when finished work is old enough to be archived out of the file.
- `repeat:wed-9:15` — how often this task comes round: a three-letter weekday with an optional time, a day of the month, a working day of the month, the nth weekday of the month (`repeat:tue2` for the 2nd Tuesday), any of those with a `/n` after it for a longer cycle (`repeat:wed/2` fortnightly, `repeat:15/3` quarterly), and any of those with a `~` in front where the day is the usual shape rather than a rule. See recurring tasks below.

Sub-steps carry their own `[due:: ]` where the parent needs back-planning, and their own `[to:: ]` where somebody other than the task's owner does that step. In a pack of steps for several people most of them differ, which is the whole point of tagging at that level.

### Two tag syntaxes, and which one to write

The first four are written as inline fields, in brackets with a double colon. Everything else is a backtick code span, because a line carrying eight bracketed fields is unreadable. Both lists are above.

**Write the bracket form.** The board writes it, and the checker flags a code span on a task line as a FIX. Old-form tags are still read correctly by both the board and the checker, and always will be — the backups and the done-archive are full of them, and losing a score off a restored task would be worse than accepting two syntaxes. That tolerance is for reading, not for writing.

The nuisance to accept: `[due:: 2026-08-21]` is uglier in a plain text editor than `` `due:2026-08-21` `` was. That was the trade, and it was made to stop the views being hand-maintained in a second place.

### Two dates, not one

`due:` and `start:` are two facts: the day something has to be finished, and the day it becomes possible to do. A September deadline on a bookable meeting is not the same thing as a September deadline on a step that cannot start until the request goes out.

- **`due:` is the deadline.** It never means "do it then". An overdue task is the most actionable thing on the list, not the least, so a passed deadline never hides anything.
- **`start:` is the gate.** Quick wins leaves out anything whose `start:` has not arrived, because the owner cannot act on it yet. A `start:` in the past does nothing and should come off the line — the checker flags it.

Only add `start:` where something real gates the work: a person is back on the 1st, the quarter has not begun, a form does not exist yet. Where the gate is **another task**, use `blocked-by:` instead. That is the more precise tool and it updates itself when the blocker is ticked, whereas a date has to be re-guessed by hand. A step now carries its own `blocked-by:`, so "cannot start until the step before it is done" is expressible directly.

A sub-step takes the later of its own `start:` and its parent's, since a step cannot begin before the task it sits inside can.

### The four tags that replaced the copies

Whether a task is in this week's plan, what it is blocked by, where it ranks for delegation and what its prompt says all live on the task, and the views are worked out from them. Nothing is copied to the top of the file.

- `week` — in this week's plan. Set by hand, because it is a judgement about what fits rather than something the dates imply. Goes on sub-steps as readily as on tasks, since half of This week is sub-steps.
- `#slug` — a short readable name. Given **only** to tasks something else points at, never to every task. A number would renumber on reorder and mean nothing on sight, which is why it is a slug.
- `blocked-by:slug` — waits on another task, comma-separated for more than one. Waiting on a person or an event rather than a task is not a dependency, it is a `Waiting on:` note, because there is no task to point at and inventing one would put a fake item on the board.
- `rank:N` — position in Delegate to Claude, which is ordered by how much time each one gives back. Judgement, so it is set by hand. Goes on the thing that carries the prompt, which is often a sub-step.

`#slug` works on sub-steps as well as tasks, and several blockers in the file are steps rather than whole tasks. A `blocked-by:` pointing at a step resolves normally when that step is ticked.

**A sub-step carries every tag a task does**, on its own line, and reads them the way a task's are read (`readTags()` in `core/todo.js`, `parse_task()` in `core/todo.py`). Two things are specific to it. A step may carry `id:` (six characters, the same shape as a task's) so something outside the file can point at it, and a bare `` `doing` `` tag, the one state a step has of its own: an agent is working on it now. Unticked is To do and the tick is Done, so there is no other state tag, and a task's column is never copied down. What a step does not carry it takes from its task: the due date, the impact, `urgent` and `week` (`inheritedFields()` and `inherited_fields()`), plus the bucket and the project. The assignee, `seen`, `feedback`, `resolution` and the state never come down: a task handed to an agent does not hand its steps over too.

### The one thing

Tier two of how the owner prioritises.

- `headline:YYYY-MM-DD` — the single task that makes the others easier or unnecessary, and the date it was chosen. **Exactly one in the file, or none.** Setting a new one means clearing the old one in the same edit.

It is not the top of the impact-against-effort sort. It is chosen, usually because other tasks wait on it, and it stays chosen until it is solved. The board shows it as a bar above the columns, with a count of how many tasks it frees, and a task can be made the headline from the panel or by dragging a card onto the bar.

Do not invent another tag to avoid writing a note. The test is whether one of the views needs it. If no view reads it, it is a note.

### Why a task scored the way it did

Where the score is worth explaining, it goes on a note line of its own, named the same way every other named note line is:

```
  - score_reasoning: same as the sign-off chase note, one message, unblocks someone.
```

**The score itself is not repeated in the line.** `[impact:: ]` and `[effort:: ]` already hold it, and a line that also says "med/S" is a second record of one fact, which then has to be corrected twice or goes quietly out of date. Write what the comparison was and why, and let the tags carry the values.

## Projects

Some work carries more context than a task line can hold: a plan, a ticket history, source documents, a decision and the reason it went the way it did. That goes in `<name>/` in the list's projects folder when set, otherwise in `data/<dataset>/projects/<name>/`, one folder per project, with a `CLAUDE.md` inside holding the background and the source files beside it. A list's projects folder is set in Bench's Settings and kept in `data/settings.json` under `projects_roots`. Under `data/` or that folder rather than at the repo root, because a project folder is full of real names and real dates, and a folder cannot be forgotten by the ignore rules the way a new file can.

The task in todo.md stays short and points at the folder, as an ordinary note on the task, first in its notes and above the stream line. The note itself stays written as `data/projects/<name>` — short for the project's folder, looked for in the list's projects folder first when set and in the current dataset's own folder after, the same shorthand as everywhere else in this skill:

```
- [ ] **Q3 planning: redefine the initiative and deliver it** [impact:: high] [effort:: L] [due:: 2026-09-02] [ai:: partial]
  - Project: `data/projects/q3-planning`. Background in its `CLAUDE.md`, the raw material for the rescope in `redefinition-brief.md`, the planning deck and the 1:1 notes in `sources/`.
```

**Write `Project:` and then the path in a code span.** The board reads the folder name straight out of that note, shows it as a chip on the card, and clicking the chip opens a panel listing every task pointing at the same folder. There is no `project:` tag: the note came first, it is what the file already had, and a tag saying the same thing would only give the two a chance to disagree. Everything after the path stays prose, and is worth writing — it is what tells the next session which file in there to open.

The rest of the note says what is in the folder. Name the files, because a folder listing is not a description and the next session has to open all of them to find out which one matters.

A project is not a bucket and not a state. Its tasks stay where they belong: the presentation is one bucket's work, the review that feeds it is another's, and the list is right to keep them apart. The panel is what puts them back together, which is why the pointer has to be on every one of them and not just the biggest.

Rules that keep it honest:

- **One folder per project, named as a slug.** Lowercase and hyphens, or the shape the project already has a name in, as `Q3-planning` might. It becomes the chip on the card, so it has to read at a glance.
- **Every task on the project carries the pointer.** A task without it is invisible to the panel, which is the one place the whole of the project is visible.
- **The folder holds the context, todo.md holds the tasks.** Do not write a task list into the project's `CLAUDE.md`, and do not copy the background into the task. Two copies of the same fact is the failure this whole file exists to avoid.
- **Do not create a folder to hold one sentence.** A project earns a folder when the context does not fit on the task and would otherwise be re-explained every session. Below that, it is a note.
- **Read the folder's `CLAUDE.md` before touching its tasks.** That is why it is there. A session that re-plans a project without reading its background produces a plan the last session already rejected.
- **The board never reads those files.** It reads the pointer and nothing else, so the folder can hold anything, in any format, without the board having an opinion about it.

Everything private lives under `data/`, and a project folder is no exception. Nothing in there goes in a commit, a report or a message.

## Prompts

Every `ai:full` task or sub-step carries a prompt, on the task, indented one level deeper, in the same shape as a suggested message:

```
  - [ ] Collect responses into the feedback sheet [due:: 2026-08-19] [ai:: full] `rank:8`
    - Prompt: "Take the survey responses for [name], ..."
```

The prompt used to live only in Delegate to Claude, which meant it was the one piece of content with no home in the buckets and could not be rebuilt, only maintained. Writing it on the task fixes that.

The owner's own rules under `### How I want messages and prompts written` in `context.md` override the rules below. Rules for the prompt itself are otherwise unchanged: one to three sentences, second person imperative, name the skill where one applies, say what the output should be, and leave `[path]`, `[name]`, `[fill in]` rather than guessing. Name the person rather than leaving `[name]` where the task is about a specific person, otherwise two review packs collapse into one prompt the owner has to edit every time.

## Suggested messages

Any live step whose real work is contacting a person carries a pre-written message underneath it, ready to copy and send. That covers asking someone for something, reminding or chasing, sending a request, sharing a document for review, booking a call or session, and checking in. The checker flags contact steps that are missing one.

The reason is that these steps stall for days, and what stalls them is writing the opening line, not doing the thing. A message already sitting there turns a five minute task into a ten second one.

Format, indented one level deeper than the step it belongs to:

```
  - [ ] Remind [name] I need their list of achievements [due:: 2026-08-12] [ai:: none]
    - Suggested message: "Hey [name] 👋 ..."
```

Sensitive messages use `Suggested message (draft):` instead, with a following note line saying why. The marker used to be free prose in the middle of the label, which meant nothing could reliably tell a ready message from a draft. The bracket is now the marker and the prose is the explanation.

One level deeper matters, because parents carry notes and sub-steps at the same indent, so a message at the same level as its step is ambiguous about which step it serves.

Rules for the message itself. **The owner's own rules under `### How I want messages and prompts written` in `context.md` override everything below, and everything in the Prompts section above.** The owner can see and edit that section on the board, the owner cannot see this file, so where the two disagree the owner's copy is the one that is current:

- **Open with the wave.** To a named person, `Hey [name] 👋` then straight into the message. To a group or a channel, `Hey 👋`. No greeting line after it, no "I hope this finds you well".
- **Write in the owner's voice, not yours.** Plain, direct, warm enough to not read as curt. No em dashes, the owner does not use them, use commas. No bullet points inside a message. No corporate throat-clearing like "I hope this finds you well".
- **Keep it short.** Two or three sentences. If it needs more, the message is doing work the task should be doing.
- **Name the deadline where there is one**, since a request with no date is the thing that comes back late.
- **Say what good enough looks like** where it removes work for the other person, for example that rough bullets are fine rather than a written piece.
- **One message per step.** If a step contacts two different people, that is two steps, so split it first.
- **Do not invent facts** to make the message flow. If the message needs a detail that is not in the file, leave a clearly marked gap like `[date]` rather than guessing.
- **Sensitive messages stay drafts.** Anything touching a review outcome, performance, pay or someone's contract gets a message the owner is expected to edit, and the note should say so. Do not write those as if they are ready to fire.

Rewrite the message when the surrounding facts change. A chase message that still refers to a date that has passed is worse than no message, because the owner will send it without rereading.

## Recurring tasks

Work that comes round on a cycle rather than being finished once: the standing 1:1s, the monthly status update. One recurring task replaces retyping it each cycle, which is how the same task ends up on the list three times in slightly different words.

One tag and one card:

```
- [ ] **Prepare for 1:1 with Priya** [impact:: med] [effort:: S] [due:: 2026-09-02] [ai:: partial] `repeat:wed-9:15`
```

- `repeat:wed` — every Wednesday. A three-letter day.
- `repeat:wed-9:15` — every Wednesday at 9:15. The time is for meetings and is optional.
- `repeat:15` — the 15th of every month. A month too short for the day lands on its last day rather than skipping.
- `repeat:wd5` — the fifth working day of every month. For an obligation dated by working days rather than by the calendar, which a monthly status update is. Working means Monday to Friday; the tag knows nothing about bank holidays, and the checker's working-day check catches one landing on a holiday separately.
- `repeat:tue2` — the 2nd Tuesday of every month. For a meeting that is monthly but pinned to a weekday rather than a day of the month, the way a monthly guild meeting runs. Takes a time the same way the weekly form does: `repeat:tue2-15:00`. A month with no 5th occurrence of the day clamps to its last one, the same rule the working-day form uses.
- `repeat:wed/2` — every other Wednesday. The `/n` suffix multiplies whatever comes before it, so it works on all four forms above: `repeat:15/3` is the 15th quarterly, `repeat:tue2/3` is the 2nd Tuesday quarterly, `repeat:wd5/3` is the fifth working day quarterly, `repeat:mon1/6` is the first Monday twice a year. `/2` on a weekly form is fortnightly; on a monthly one it is every other month. Anything from `/2` to `/24` is accepted.

  **Which occurrence it is on lives in `[due:: ]`, not in the tag.** "Every other Wednesday" is not a fact about Wednesdays, it is a fact about which Wednesday the owner is on, and the card already carries that. So the interval counts forward from the date on the card: move that date by hand and the whole series moves with it, which is what a rebooked fortnightly meeting wants. A `/n` task with no date yet gets the next plain occurrence of its base cycle, and the interval runs from there — so set the first date deliberately, because every later one is counted off it.

  The checker does not verify the phase, only the shape. It will tell you a fortnightly Wednesday task is dated on a Thursday; it cannot tell you it is on the wrong Wednesday, because nothing on the card says which Wednesday is right.
- `repeat:~fri-15:00` — the `~` prefix works on any of the forms above and says the cadence is the usual shape rather than a rule. Use it where the meeting is real but gets rebooked: a weekly drop-in has run Friday, Thursday, Friday, Thursday. The board still rolls to the tagged day, and the checker stops flagging a date that lands off it.

`[due:: ]` is the occurrence the card is currently pointing at. So the tag says how often and the date says which one, and neither is derivable from the other.

**The board owns that date.** On load, once the date on the card has passed, it moves the date to the next occurrence, unticks the card, and files whatever agenda was on it as a `Previous agenda (that date):` note. Which means:

- **Never hand-edit `[due:: ]` on a recurring task** to advance it a cycle. The board has done it, or is about to, and two writers on one date is how it ends up a week out.
- **Never delete or rewrite a `Previous agenda` note.** The board writes it and replaces it each cycle.
- **The tick means "prepared for this one", not "this happened".** It comes off when the occurrence changes, and so do the ticks on every sub-step, since a step's work belongs to one occurrence.
- **A sub-step's own `[due:: ]` or `start:` moves with the roll**, by the same number of days the parent moved, because those dates are offsets from the occurrence rather than fixed days. Write them as the real date for the current cycle and let the board carry them; do not re-date them by hand.
- The tag goes on the task, never on a sub-step. A cycle belongs to the whole task, and the checker flags it as a FIX.

**When a meeting does not happen.** The board knows the date passed; it cannot know whether the meeting did. The tick is what separates them:

- **Ticked and the date passed, with the next occurrence under a week away** — the prep was delivered, so the agenda is filed as `Previous agenda (that date):`, and the task is parked out of wherever it was sitting: To do if the next occurrence is under two days away, Backlog if it is two days or more. A card parked in Backlog is brought across to To do on a later load, once its day is under two days off.
- **Ticked and the date passed, with a week or more to the next occurrence** — nothing happens at all. The card keeps its date, its tick, its agenda and its place in Done, because a monthly meeting already prepared for has nothing waiting on it for weeks. The roll fires on a later load once that week has closed, and until then the card carries a date that has gone and reads as prepared for an occurrence that is over.
- **Unticked and the date passed** — the prep never happened, so those topics were never raised. The agenda **carries forward** onto the new date instead of being archived, and the card is left exactly where it was: only a “done” carries an opinion about what comes next.
- **Known in advance** — change `[due:: ]` to the new day and nothing rolls at all, since the roll only fires on a date in the past. This is the one to reach for, and the one to tell the owner about when they say a meeting moved.
- **Cancelled after the owner prepared** — the agenda is archived, because that case is indistinguishable from a delivered one. The `Previous agenda` block carries its own Copy, dated with the occurrence the card points at now, so recovering it is one click. The card keeps only the one cycle: the next roll archives whatever `Previous agenda` is already on it to `agenda-history.md` before overwriting it, so a month back is still readable, just not on the card itself.

One card that rolls rather than a template that spawns copies. A card per occurrence would put a ticked "prepare for the 1:1" in Done every week for as long as the meeting exists, and the only question ever asked of last week's is what was on it — which is one note, not a whole card.

**Making something recurring is the owner's call**, since it changes what ticking the task means. Do not convert one on your own judgement. A review pack looks recurring and is not: it follows a person's start date rather than the calendar.

### Meeting agendas

A recurring meeting also carries the topics to take into the next one, as an `Agenda:` block on the task:

```
- [ ] **Prepare for 1:1 with Priya** [impact:: med] [effort:: S] [due:: 2026-09-02] [ai:: partial] `repeat:wed-9:15`
  - Agenda:
    - Q3 planning
      - Confirm the rescoped recommendation is agreed so the tracker update can go out, due tomorrow.
    - Personal objectives
      - Shared 26 Aug, pending validation before adding to the tracker.
```

Unlike every other note in this file this one is a block rather than a quoted line, because what the owner pastes into the shared meeting notes is a bullet list: one bullet for the topic, one bullet nested under it for the context. Both levels are bullets, and that is the format rather than a rendering choice. The block ends at the first line not indented past the `Agenda:` line, so an ordinary note can follow it.

No date on the note. `[due:: ]` on the task is the meeting date and the board reads it from there, so a date here would be the same fact twice with two chances to disagree. Nothing has to say whether the agenda is current, either: rolling the task forward clears the block.

**What the Copy button produces** is not that markdown verbatim. It is:

```
Wednesday, 2 September 2026

Agenda
- Q3 planning
  - Confirm the rescoped recommendation is agreed so the tracker update can go out, due tomorrow.
```

The meeting date in full on its own line, a blank line, the word `Agenda` on its own line, then the topics. The board also puts an HTML flavour on the clipboard, so a paste into Google Docs keeps both levels as real bullets instead of literal hyphens. None of that is written by hand — write the block and the format follows. It is here because it says what the topics have to survive being read as: a heading and a list in somebody else's document.

**The block is rewritten each cycle, never appended to.** It holds the agenda for the date on the card and nothing else. Whatever came out of the last meeting is a task in the buckets, which is where actions live.

The brief for what goes in it is the owner's, not this file's. `context.md` carries `### Recurring meeting prep scripts`, one line per meeting in the owner's own words: when it happens, what it is usually about, and what to check before it. Read it every session and follow it; where it disagrees with anything below, the owner's copy wins.

Rules for the writing:

- **Both levels are bullets.** One bullet for the topic, one nested under it for the context. Not a title with a paragraph.
- **A few words as the title.** `Q3 planning`, `Personal objectives`. It is a heading in a shared document, not a sentence.
- **One context bullet, two at most.** What has moved, what is being asked for, by when.
- **Written neutrally, because they read the same notes.** No pronouns for the other person, no "she needs to", no "chase her on this". Write it as the shared record the notes become.
- **Nothing that is not theirs.** The agenda is not a status report on the owner's week. Work the owner is getting on with, that needs nothing from them, stays off it.
- **Three to five topics.** A 1:1 is thirty minutes. Six means the last two read as covered without having been discussed, and the checker flags it.
- **Something that has not moved since the last meeting is not a topic**, and `Previous agenda` is how you can tell.
- **Leave `[fill in]` rather than inventing a detail**, the same rule as prompts and Jira summaries.

## Jira tickets

Work that leaves the list as a ticket on somebody's board carries a `Jira` note, in the same shape as a prompt. The board turns it into a **Raise in PLAT** button that opens Jira's create form with the summary already filled in, and raises nothing until the owner presses Create there.

```
- [ ] **Raise the button variant gap on the contributions board** [impact:: med] [effort:: S] [ai:: none]
  - Jira (PLAT): "Button: three variants in Figma with no Storybook equivalent"
```

The body goes on the line under it, and the button carries that too:

```
  - [ ] Create the docs contribution on error patterns
    - Jira (PLAT): "Documentation contribution: error patterns"
    - Description: "Document the error patterns in the design system: inline field errors, ..."
```

Write `Description:`. The first of these were written as `Description to paste:`, from when the board only carried the summary and the body really did have to be pasted by hand; that phrasing still parses so nothing has to be converted on sight, but it is no longer true and should not be written again.

A ticket with no description is a ticket somebody has to come back and ask about, so write one unless the summary genuinely says everything. End it with what done looks like — that is the part the board's readers cannot infer.

The brackets name the board. The boards are configured per list in `jira.json`, see the README; `PLAT` here is only an example key. Leave the brackets off — `- Jira: "..."` — and the board offers every configured board, which is the honest answer when it is not yet decided where the ticket belongs. Do not guess a board to avoid the plain form.

Write one whenever a task or a step means raising a ticket: contributing a component, reporting a gap found in an audit, asking another team for work, recording a decision that needs a ticket to be actioned. The test is the same as the one for a suggested message — the thing that stalls it is writing the summary, not raising it.

**Never raise the ticket, only write the note.** The whole point of the button is that the owner presses Create with their own eyes on the form. A ticket appearing on a shared board without the owner having seen it is worse than a ticket not raised: they cannot tell what they are answering for, and the team cannot tell whether a human meant it.

Rules for the summary:

- **One line each, no quotes inside them.** Both go in the URL. Keep the two together under a thousand characters or so; they are a starting point on the form, not the finished ticket.
- **Write it for the board's readers, not for the list.** The people reading it have not seen the owner's to-do list, so `Button: three variants in Figma with no Storybook equivalent` beats `Fix the button thing we discussed`.
- **Lead with the component or the area** where the board is organised that way, as Platform Requests is.
- **Leave `[fill in]` rather than inventing a detail.** The same rule as prompts: a summary that reads as complete and is wrong is worse than one with a visible gap.
- **Rewrite it when the task changes**, and delete it when the ticket has actually been raised. A note left behind reads as a ticket still to raise, and the owner raises it twice.

## The five views

The board shows five views: This week, Quick wins, Big rocks, Dependency chain and Delegate to Claude. They are worked out by the board, live, from the tags below, and are never written into the file.

| View | Built from |
| --- | --- |
| This week | `week` |
| Quick wins | `[effort:: S]` grouped by `[ai:: ]`, plus any live step carrying a suggested message, plus every `repeat:` task with an agenda written on it, nearest first. Anything waiting on an unfinished blocker, or whose `start:` has not arrived, is left out. |
| Big rocks | `[impact:: high]` and `[effort:: L]` |
| Dependency chain | `blocked-by:`, resolved against `#slug` |
| Delegate to Claude | `[ai:: full]`, ordered by `rank:` |

Above the board sits the headline, from `headline:`. It is one task, not a view of many.

**Do not write any of them back into the file.** A section in the file is a copy, and a copy is only correct until the next thing changes. That was the actual failure mode: the board could tick a sub-step and the section above it would keep saying the work was outstanding, and whichever one the owner happened to read is what they believed. Nothing is stored twice now, so nothing can disagree.

The consequence to accept is that todo.md on its own no longer shows the owner a weekly plan. That is the trade, and it was made deliberately.

### What the views still expect of the tasks

- **Quick wins earns its place from the message, not the effort tag.** Any live step with a written message appears there whatever its parent is, because sending one message out of an `effort:L` review pack is a gap-sized job. There is nothing to promote by hand, but it does mean a message written on the wrong step puts the wrong thing in front of the owner.
- **Quick wins only shows what the owner can act on now.** Two things take a task out: a `blocked-by:` naming an unticked task or a slug that does not exist, and a `start:` that has not arrived. Both are counted in a line at the top so the section never quietly shrinks. A quick win the owner cannot start is not a win. The consequence: a stale `blocked-by:` or a forgotten `start:` now hides a task rather than just mislabelling it, so when you tick a blocker, check what it was blocking in the same move.
- **A deadline never hides anything.** Quick wins ignores `due:` entirely. Something overdue is the most actionable item on the list.
- **Every message states whether it is safe to send.** `Suggested message:` is ready. `Suggested message (draft):` is one the owner edits first, and the board shows it with a warning. Sensitive subjects are always drafts.
- **Undated contact steps still surface.** They sort last rather than disappearing, because those are the ones that rot quietly. Leave the `[date]` gap in the text rather than inventing one.
- **A prompt lives on the thing it delegates**, which is usually a sub-step rather than a whole task.

## Delegate to Claude

Everything `ai:full`, ordered by `rank:`, which is how much time each one gives back. The ranking is judgement, so it is set by hand and worth re-reading rather than left to rot.

- **Every `ai:full` item carries a prompt.** The checker flags one without.
- **Keep prompts to one to three sentences.** They are a starting point the owner complements, not a spec. A prompt that tries to be complete is one the owner has to read before using.
- **Write the prompt as an instruction to Claude**, second person, imperative. Name the skill where one applies, for example `ds-snapshot` or a deck-building skill.
- **Say what the output should be** where it is not obvious, for example grouped by component, or ready to paste into the rationale doc.
- **Do not invent inputs.** Leave `[path]`, `[name]`, `[fill in]`. Guessing produces a prompt that runs and returns the wrong thing.
- **Name the person** where the task is about a specific person, rather than leaving `[name]`. Otherwise two similar packs collapse into one prompt the owner edits every time.
- **Rewrite the prompt when the task changes.** A prompt referring to a step that is already done sends the owner round a loop.

An item that is not live yet, waiting on something merging or being defined, keeps its rank and its prompt. It is there so it is not forgotten, and the prompt is ready for the day the blocker clears.

**Taking work back off Claude removes the prompt and the rank.** A prompt left on a task the owner has decided is the owner's reads as a standing instruction to hand it over, and the next session will act on it. The board does this automatically when the `ai:` tag is changed there; do it by hand when editing the file directly.

## Section order

The file is the title, the `Last updated` line, the `Meeting actions last pulled` line, the **How this works** legend, **Where the other views went**, then the buckets in the order the file has them, whatever the list has. Sections are separated by `---` on its own line.

## Ordering

Anything with `due:` or `urgent` jumps the queue regardless of impact and effort. Everything else: high impact first, and within the same impact, lower effort first. A `high`/`S` task above a `high`/`M` task is correct and worth preserving when editing.

## Dates

**Working days only.** Weekend deadlines get pulled back to the previous Friday. The exception is a step that waits on someone else replying, which pushes to the following Monday instead, because a Friday deadline on someone else's reply is really a Monday deadline.

**Public holidays count as non-working days.** Which apply is the `Country:` line in the profile (`<memory_root>/me/profile.md` (when `memory_root` is set and the file exists) or `data/profile.md`) (for example `Country: GB`) and an optional `Region:` (`GB-SCT`). The days come from Nager.Date and are cached in `data/holidays/`; offline, England and Wales and Portugal fall back to built-in tables. An older `Holidays: UK, PT` line still works, and with none of these both built-in calendars apply.

**Back-plan from the formal deadline.** A review formally due Sunday 6 September closes Friday 4 September in this file, and every sub-step is dated backwards from there. Never leave the formal date as the working date.

**Sign-off costs a day.** Where a document goes to someone for approval before submission, the draft and the share are separate dated steps, and the submission is the day after. A manager's manager might sign off a rationale doc.

**Reminder steps are five days after the request**, moved to the next working day if that lands on a weekend. The note should say so, otherwise the arithmetic looks wrong to anyone reading it later.

**`Meeting actions last pulled` is a machine stamp, not a date the owner keeps.** It is a full UTC timestamp, `2026-09-01T09:33:21Z`, and it does two jobs. It tells this skill whether today's pull has happened, so the first check-in of any day runs `pa-retrieve-tasks` and later ones do not. And it is the watermark that skill filters on: anything the recorder created before it has already been put in front of the owner and is never shown again, whether the owner kept it or turned it down.

It is a timestamp rather than a date because the watermark has to cut a window mid-morning without swallowing the rest of the day.

It is set only by a run that actually happened, only by `pa-retrieve-tasks` and only after the tasks are written, it is never edited by hand, and `never` is a valid value meaning no pull has happened yet. Do not read it as when the file was last touched, which is what `Last updated` is for.

## This week

The honest filter on top of Doing: Doing is what is live, `week` is what actually fits.

**The capacity ceiling is two M-effort items per week**, once meetings are counted. Everything else should be S. If more than two M items are competing, say so and ask which one loses the tag rather than tagging three and pretending. The checker counts them; it will not decide.

**A `week` tag with a date outside the week is wrong.** Drop the tag or bring the date in.

**Untag as deliberately as you tag.** A `week` left on something that slipped turns the view into a record of intentions. This is the edit nobody makes, so make it explicitly at the end of a session.

**A `week` tag has exactly two ways to expire, and both are automatic, not judgement calls:**

- **Ticked clears it.** The moment a step or task is ticked off, remove `week` in the same edit. A finished item has nothing left to plan for, and leaving the tag on turns This week into a log of what already happened rather than what is coming.
- **A passed `due:` on an open item clears it too.** If the date has slipped and the work is still open, it is now Overdue, which is a stronger and different claim on attention than "fits this week." Leave it to Overdue rather than letting it sit in both.

Ticking a step and untagging it are one edit, never two. The checker flags both cases under "This week" (see `check_todo.py`), so a session that runs the checker before delivering will not hand back a file with either kind of stale tag in it. Fix what it flags rather than leaving it for next time.

**Name which dates in the week cannot move**, as a note on the task itself. That reasoning used to sit in the section and had nowhere to go when it was removed.


## Checkboxes

Tick sub-steps, not parents. A parent closes only when all its sub-steps are ticked. Add a short inline note on a completed step when the outcome matters later, for example "received and added to the spreadsheet", because that detail is what makes the next step possible.

## Cancelling a task

**A cancellation is a tick, plus a tag saying it was never done.** Tick the task the
normal way, so it carries `done:YYYY-MM-DD` and gets archived out with everything
else, and add one of these beside it:

- `` `cancelled:YYYY-MM-DD` `` — decided against. The work is not happening.
- `` `archived:YYYY-MM-DD` `` — no longer relevant. The reason it existed has gone,
  rather than the work being rejected.

Both dates are the day the decision was made. Write a note underneath saying why,
in one line, because that is the part a reader in three months actually needs.

**Never delete the block.** A deleted task cannot be found again, cannot be counted,
and leaves anybody it was delegated to holding something nobody is tracking. Ticking
it keeps it in `done-archive.md` where it can be read back.

The tag also stops the archive lying. Without it, a cancelled task and a finished one
look identical once they are out of the file, so any count of what was completed
quietly includes work nobody did.

Both are real fields, in `core/todo.js` and `core/todo.py` alike,
and `countsAsFinished()` / `counts_as_finished()` beside them is the one rule every
count asks — the board's three counted reports, `core/aggregate.py`'s `completed`
and `done_today`, and the archive as well as the live file. `check_todo.py` reports
either tag on an unticked task as a FIX. The board draws a cancelled task as an
ordinary done card wearing one more chip.

## Named people

Who is who, who is away, whose contract runs out when, and the spellings that matter are all in `context.md`, beside `people.md` and `about.md` and read through the memory lookup (the memory folder when `memory_root` is set, else `data/<dataset>/`). It is not a section of todo.md. Read it every session alongside the buckets.

It lives in todo.md so the owner can see and correct it and the board can use it. It is standing information about the owner's working life, not a rule about how the file is formatted, so it belongs with the owner's data rather than in this skill.

Do not copy it back into this file. One copy, in todo.md, for the same reason the five views were removed from the file.

Keep it current as a matter of course: a leave date that has passed, or a contract that has been extended, is exactly the kind of stale fact that produces a confidently wrong plan.
