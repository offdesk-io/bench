# Bucket agents

One runner for every bucket's agent on every list. It replaces the Plan agent
(`agents/plan-agent/`) and the Implement agent (`agents/implement-agent/`),
whose folders stay on disk, unwired, until a later change deletes them.

## Why one runner

Bench used to split an agent's part of a task by stage: the Plan agent wrote a
plan at night, the owner approved it, and the Implement agent carried it out
if its type was one it could do alone. What a bucket needed lived in two
places, a planner definition per bucket and a brief the implementer read, and
neither said how much the owner wanted to see before the work started.

Now each bucket's brief is its agent's definition
(`data/<list>/buckets/<bucket>/<bucket>.md`, read by `core/bucket_agents.py`),
and its frontmatter says both things that used to be implicit: `mode`
(`plan-first` writes a plan and waits for the owner to approve it, `free-rein`
goes straight to the work) and `start` (`on-assign` begins as soon as a task is
handed over, `scheduled` only in the board's hours). The same agent plans and
does the work, so there is one runner, and one tracked definition,
`bucket-agent.md`, which the runner reads into every prompt with the bucket's
own sections under it as the owner wrote them. Nothing is symlinked into
`.claude/agents/` any more.

## How a task reaches it

The board hands a task to a bucket's agent by laying out sub-tasks on its card,
`[to:: <the agent's name>]` on Plan and Implement, the owner on the two
reviews. The name is `agent_name()` in `core/bucket_agents.py`: the list in
words, then the bucket, so `Personal family agent` or
`Work and career tenon-ds agent`. `bucket_work.py` reads those sub-tasks off
`todo.md`, and a sub-task is work while it is open and what it waits on is
ticked. A review is never work, whoever it is assigned to, so the runner never
ticks one and Review the work is always the owner's.

A plan-first bucket writes its plan to `data/<list>/plans/` and queues the tick
on its Plan sub-task. No plan type is approved on arrival: the owner ticks
Review the plan, and only then does Implement become work. A free-rein bucket's
handover has no Plan, so Implement is work at once, with the task itself as
the instruction.

## When it runs

One target per board. A `scheduled` bucket runs in the hours set for its board
on the agents dashboard, through the shared hourly wake (`agent.json`), and is
skipped with that reason in the day's log at any other time. An `on-assign`
bucket is started by `core/bucket_wake.py`, which the board server runs beside
its banners: once a minute it asks `run.py --pending` whether any board holds
on-assign work and starts `run.py --now` for that board if so. The runner's own
lock (`data/.bucket-agent-<list>.lock`) and the wake's one-process-per-board
rule mean two runs on one board never overlap. An on-assign item that failed
waits for a change or a Retry on the card rather than being tried every minute.

A bucket whose definition is not ready, or a board whose agents are off in
Bench's Settings, is skipped with the reason. The briefings and written reports
the Plan agent's wake used to run (`brief.py`, `report.py`) run on each
scheduled wake here.

## What keeps it safe

It never writes `todo.md`. No run is given a tool that can, and the file is
hashed around every run anyway. Because a run often happens while the owner is
at the board, a change alone is not taken as the agent's: `plans.todo_moved()`
accepts it only when the file is exactly what the board server last wrote and
the board logged no outside edit during the run. Anything else throws the
run's work away and stops the run. It asks for ticks only through
`core/tick_queue.py`, never sends, pushes, merges or restarts anything, and
refuses Figma work unattended. Work that is not code may only add new files to
the task's project folder, which `guard.py` checks afterwards. Code goes on an
`implement/<date>` branch through improve-agent's git module and its registry
of suites, as the Implement agent did.

```
python3 agents/bucket-agent/run.py --dry-run [--target <list>]   what would run, no spend
python3 agents/bucket-agent/run.py --now --target <list>         a run by hand
python3 agents/bucket-agent/bucket_work.py <list>                what the list holds for its agents
python3 agents/bucket-agent/test_bucket_agent.py
```
