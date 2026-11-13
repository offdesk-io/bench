---
name: do
description: Carry out a bucket agent's Implement sub-task with the owner in the session, on the list at data/<dataset>/todo.md in the Bench checkout (<dataset> named by data/.current), one task at a time, following that bucket's brief and mode. Use whenever the owner says to do, run, carry out, action or get on with an agreed plan or a handed-over task, asks what is waiting to be run, says "let's do the ones I agreed", "run that plan", "action the agreed ones", "what did I say yes to", or names one task and asks to get it done. Use it too for work a bucket agent refused to do alone, such as anything in Figma, and after a pa-review-plans session where the owner approved a plan. Do not use it to read or triage plans, which is pa-review-plans, and do not use it to start the bucket agents' unattended run, which is the Data menu's Run the bucket agents now.
---

# Carrying out a bucket agent's work, with the owner here

`$BENCH_ROOT` is the Bench checkout: the `BENCH_ROOT` environment variable, or `~/Code/bench` when unset. Before running any command or reading any file below, `cd "${BENCH_ROOT:-$HOME/Code/bench}"`. Paths in this skill are relative to the checkout.

**Read `agents/pa_agent/PA.md` first, then `CONVENTIONS.md`.** The
first holds who the owner is, where the list lives, how the owner prioritises, the standing
rules and the tone. The second holds the file format. Neither is repeated below.

This is the only skill in the set that causes work to happen rather than
recording a decision about it. Everything else here reads the list or writes to
it after a conversation. In this one the session does a bucket agent's work
itself, with the owner there to answer.

## What is waiting, and why it runs here

Each bucket of a list has one agent, defined by its brief,
`data/<dataset>/buckets/<bucket>/<bucket>.md` (`core/bucket_agents.py` reads it).
Handing a task to it lays out sub-tasks on the task's own card
(`handOver()` in the board's `kanban/js/04-tier-two-the-one-thing.js`), each
blocked by the one before. A `plan-first` bucket gets Plan, Review the plan,
Implement and Review the work. A `free-rein` bucket gets Implement and Review the
work, and the task itself is the instruction. Plan and Implement carry the
bucket agent's name in `[to::]`, "Work and career tenon-ds agent", and the two
reviews carry the owner's.

The work waiting for this skill is an **Implement sub-task assigned to a bucket's
agent, open, with what it waits on ticked**. For a plan-first bucket that means
the owner has approved the plan. For a free-rein bucket it is waiting from the
moment the owner handed it over.

The bucket agents' own runner (`agents/bucket-agent/`) takes most of these
alone, on assignment or in the board's hours, depending on the brief's `start:`.
It refuses what it cannot check before it starts, Figma above all, and leaves
those for this skill with a line on the card saying so. The owner can also ask
for any waiting item here rather than wait for the runner. A sub-task the runner
has already finished has its tick queued, so check
`data/<dataset>/tick-queue.json` before offering one: if its tick is waiting, it
is done and only needs the board opened.

## Move 1: what is waiting

Read `data/.current` for the dataset, then run
`python3 agents/bucket-agent/bucket_work.py <dataset>`. It lists every Plan and
Implement sub-task that is work for a bucket's agent, with the reason beside any
that is set aside. Offer the `implement` rows only; a Plan sub-task is the
runner's, and its review is the owner's. Report the count and list them: the task
title, its bucket's agent, and the plan it was written from, which is the `Plan:`
note under the Review the plan sub-task above it (none for a free-rein bucket).
If there are none, say so and stop. Do not go looking for work the owner might
like to hand over; that is the owner's call, made on the card.

Anything the owner said sits as `feedback:` notes under the Plan or Implement
sub-task and in the review's chat. On a plan the owner approved it is what the
owner wants kept in mind while it is built, not a complaint about it.

## Move 2: one at a time, and the owner picks

Never start work on more than one task at once. Ask which one, or take them in the
order the owner gives.

Before starting, say in two or three lines what will be done and what it will
produce: from the plan for a plan-first bucket, from the task for a free-rein one.
The owner approved the plan when they read it, possibly days ago, and the thing
about to happen should not be a surprise.

## Move 3: do it as the bucket's agent

Read, in this order, and work inside them:

- `agents/bucket-agent/bucket-agent.md`, what is true of every bucket's agent.
  Where it says unattended, read "with the owner here": you can stop and ask, and
  should, rather than fold.
- The bucket's brief, `data/<dataset>/buckets/<bucket>/<bucket>.md`. Its
  guidelines, what it may touch and what it must never touch hold for this run as
  they do for the runner. Never-touch is absolute, even when the plan seems to ask
  for it.
- The plan from the `Plan:` note (`data/<dataset>/plans/<file>.md`) for a
  plan-first bucket, or the task and its notes for a free-rein one. That is the
  instruction.
- The task's `Project:` folder when it has one, its `CLAUDE.md` first.

Then do the work. If the plan turns out wrong, stop and tell the owner rather
than re-plan it as you go. Work that is not code goes into the task's project
folder, in the list's projects folder when set, otherwise under
`data/<dataset>/projects/`, both private and outside git. Code goes on a branch
in the repo the `Project:` note names, never committed to its main branch, never
pushed or merged. Figma work needs the Figma Console bridge paired on the right
file; check it with the owner before the first change.

## Move 4: what comes back

Tell the owner what got done in a line or two, then a `**Needs you**` heading
holding what actually stopped or needs a decision. Follow
`How much to say back` in `PA.md` as for any other reply.

Three things to do before you call it done:

- **Record what it produced**, so the card's activity feed shows it:
  `python3 core/agent_runs.py output <sub-id> --by "<the bucket's agent>"`
  with `--project` and `--file` for files written, `--branch`, `--repo` and
  `--commit` for code, `--figma` for a Figma link, and `--summary` in a line.
- **Queue the tick on the Implement sub-task**:
  `python3 core/tick_queue.py tick <sub-id> --by "<the bucket's agent>" --note "work done"`.
  It is the agent's own tick, made under the agent's name because the board
  applies a tick only from the agent the sub-task is assigned to, and through the
  board's queue because nobody but the board writes the list. The board applies
  it the next time it loads, moving the card to Reviewing and unblocking the
  owner's review of the work.
- **Nothing from it goes into a report, a message or a commit outside its branch.**

Approving what was done is the owner's move, on the Review the work sub-task, and
it is not yours to make. Sending it back is the owner's too: it unticks Implement
with a `feedback:` note, and it is waiting again.

If the work means the task should change, **it goes through `pa`.** Show the owner
the exact lines before and after, get a yes, then invoke `pa` with what the owner
agreed and let it write, check and close with the Reload line. Reload rather than
save, in that order: a tab open since before the write is holding a stale
document, and a save from it would undo the change.

## What this skill never does

- **It never writes `todo.md` itself.** Ticks go through the queue, list changes
  through `pa`.
- **It never approves a plan, and it never approves the work.** If the owner says
  "that one looks fine, do it", the owner is approving the plan; that is ticking
  the review on the card, or asking `pa` to. Approving what was produced is the
  same move on the next review.
- **It never writes a plan.** A Plan sub-task is the runner's; Run the bucket
  agents now in the Data menu starts it, and it spends money.
- **It never sends, pushes, merges or restarts anything**, and never runs
  unattended. No cron, no schedule, no background: the unattended route is the
  bucket agents' runner, under each brief's `start:` and the board's hours.
