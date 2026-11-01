# PA profile

The owner's setup for the PA. This is the template; the real file lives at
`data/profile.md`, which git ignores. The PA fills it in on first run by asking
the questions below, and the board's Settings edits every section: the About
lines as fields, each other section as one text box. Facts about who the owner
is live in their own facts file, linked under About, and are not repeated here.

On a shared board each signed-in person has their own copy beside their user
record, `data/users/<hash>.profile.md`, in this same shape, and `data/profile.md`
is the fallback for anyone who has not saved one. Setup and the facts file name
paths, which there would be paths on the server, so Settings leaves them out.

## About

- Name: <first name>
- How to address them: <e.g. "Hey <name>" opening, or none>
- Country: <two-letter code, e.g. GB or PT. Its public holidays count as days off; leave out for UK and Portugal>
- Region: <optional, e.g. GB-ENG, GB-SCT. Leave out for the whole country>
- Facts file: <path to a file about them, or "none">

## Setup

- Bench repo: <absolute path to the bench folder>
- Active list: whatever `data/.current` names. Do not copy it here.
- Workspace folder: <optional parent folder the agents may read beyond this repo, or "none">
- Improve agent folder: <optional path to an improve-agent checkout, or "none">

## Writing

- Spelling: <e.g. British English>
- Message opening: <how every message to a person starts, or "none">
- Rules: <path to a writing rules file, or a few lines of their own>

## Meeting recorder

- Recorder: <name matching a notes file at `data/docs/<name>.md` or `skills/pa-retrieve-tasks/references/sources/<name>.md`, or "none">
- Account: <which account the recorder runs under>
- Appears as: <the name the recorder uses for them in action items>
- Notes: <anything about how they use it>

## Working habits

How the owner works, so the PA can weigh tasks against it. One bullet each.

- Deferring: <do they log ideas and build later, or act straight away?>
- Time estimates: <do they run optimistic? by how much?>
- Delegating: <what do they hand off, and what do they keep?>
