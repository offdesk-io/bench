---
name: pa-bucket-setup
description: Interview the owner about one bucket, or each bucket that is not set up in turn, and write the answers into that bucket's agent definition, data/<list>/buckets/<bucket>/<bucket>.md in the Bench checkout, then check whether the agent is ready. Use when the owner says "set up the <bucket> agent", "fill in the bucket brief", "which buckets aren't set up", or when a task is being delegated to a bucket whose agent is not ready. Never writes todo.md; moving old handovers over is the pa skill.
---

# Setting up a bucket's agent

`$BENCH_ROOT` is the Bench checkout: the `BENCH_ROOT` environment variable, or `~/Code/bench` when unset. `cd "${BENCH_ROOT:-$HOME/Code/bench}"` before running anything below.

**Read `agents/pa_agent/PA.md` first.** It holds who the owner is and the tone.

A bucket's agent is defined in one file, `data/<list>/buckets/<bucket>/<bucket>.md`, from the template `agents/bucket-agent/bucket-brief.template.md`. The board hands a task to a bucket's agent only once the file is ready. `core/bucket_agents.py` is the one reader and the one judge of ready, so this skill never decides that itself.

## 1. Find the bucket

Name the list first and get the owner's yes, as `pa` does. Then run `python3 core/bucket_agents.py <list>`. It prints each bucket, ready or what is missing.

- "Which buckets aren't set up": print that output as a list, one line per bucket, and ask which to start with.
- "Set up the X agent": that bucket only.
- "Fill in the bucket brief" with no name: each bucket that is not ready, one after the other, owner's pick of order.

A bucket with no file yet starts from the template: copy it to the bucket's path and keep its headings.

## 2. Interview, one field at a time

Read the bucket's file and any existing text first. Ask one plain question per field, in this order, and wait for the answer before the next. Skip a field that is already written unless the owner wants it changed, and say which you skipped.

1. Mode. Offer two choices: `plan-first` (it writes a plan, waits for you to approve it, then does the work) or `free-rein` (it does the work straight away, inside its guidelines). You review the finished work either way.
2. Start. Offer two choices: `on-assign` (it begins as soon as a task is handed to it, the default) or `scheduled` (only in the bucket's set hours).
3. What this agent is for, and what it leaves to you.
4. The processes it runs in this bucket: what triggers each, how often, and the artefact it produces.
5. Guidelines it follows: tone, format, order, who gets told. The rules you would otherwise correct.
6. What it may touch: folders, files, boards, tools, each named.
7. What it must never touch: people it never messages, files it never writes, anything that cannot be undone.
8. What good looks like here: what you would accept unchanged, and what always comes back for a rewrite.

Then two optional ones, asked once each and skipped on "nothing": what already does it (which skills cover which process, and the gaps) and who is involved (names and what each owns in this bucket, never their role, which `people.md` holds).

Ask for the owner's own words. Where an answer is thin, ask one follow-up for the missing detail rather than padding it.

## 3. Write the file

Write each answer under its heading, in the owner's words. Keep any existing text the owner wants kept, and the template's guidance paragraph may stay above the answer. Set `mode` and `start` in the frontmatter. Remove the `<!-- NOT FILLED IN YET -->` line, and the blockquote under it, only once every required field is filled. Show the finished file to the owner before writing if any field was drafted from a loose answer.

Write the file directly with the Write tool. It is not `todo.md`, which this skill never writes.

## 4. Check and report

Run `python3 core/bucket_agents.py <list>` and report that bucket in one line: ready (mode, start), or what is still missing. If missing fields remain, ask the next question for them. When several buckets were queued, move on to the next.

## What it never does

- It never writes `todo.md`, and never hands a task over. Delegating is the owner's act on the card, or `pa`'s.
- It never invents an answer for a field. A field the owner has not answered stays empty and the bucket stays not ready.
- It never touches another bucket's file.
