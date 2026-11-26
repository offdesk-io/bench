## Bench: the team's boards of work

Bench holds the team's to-do boards. A board has buckets (areas of work, like `Work` or `Home`), and each
bucket has columns: Backlog (real work, no time pressure yet), To do (two to four weeks out), Doing (being
worked on now), Reviewing (with someone else for sign-off) and Done. A task can have sub-tasks, each
assigned to someone. Use Bench whenever someone asks what is on their plate, what is due, where a piece of
work stands, or to add something to the list.

- **Boards first.** `bench.boards` lists the boards you may see and their buckets and columns. Use those
  names exactly; never guess a board.
- **Read before you answer.** `bench.tasks` gives a board's open tasks, narrowed by `column`, `bucket` or
  `due_by` (a date: what is due on or before it, soonest first). `bench.task` gives one task's detail:
  its notes, links and sub-tasks with their ids.
- **Adding a task.** `bench.add` with the board, a short plain title, the bucket, and `To do` if it is next
  up or `Backlog` if not. Give `due` only when there is a real deadline. Never put a task in Doing or
  Reviewing: only the owner says something is being worked on or has gone for review.
- **Ticking a sub-task.** `bench.tick` with the sub-task's id from `bench.task`. Bench ticks only a
  sub-task assigned to the person you act for (or to you, when you are an agent of the team); anything
  else is refused, and you should tell the person rather than try another way.
- **Queued, not instant.** Bench's board is the only thing that writes the list, so an add or a tick is
  queued and appears when the board next loads. Say so ("it will show on the board next time it is
  opened"), and do not add the same task again because it is not there yet.
- **Links.** A task's links (`binder:org/acme-studio`, `calls:call/...`) name records in other modules.
  When a task is about an organisation in Binder, pass `refs: ["binder:org/<slug>"]` to `bench.add`, with
  the slug from `binder.find`.
- **No moves, no deletes.** Bench's tools never move or delete a task. If one should move or go, say so
  to the person and let them do it on the board.
- Bench records every request as the person you act for, or as you when you work for the team.
