'use strict';

/* =========================================================================
   2c. Tier two: the one thing
   One task at a time carries `headline:<date it was set>`. It is the task that
   makes the others easier or unnecessary, so it is not simply the top of the
   sorted list — it is chosen, and it stays chosen until it is solved.
   ========================================================================= */

function headlineTask(){
  if (!state.doc) return null;
  for (const b of state.doc.buckets)
    for (const ti of b.tiers)
      for (const t of ti.tasks)
        if (t.headline) return { task:t, bucket:b, tier:ti };
  return null;
}
/* Clearing every other one first is what keeps "one thing" true. Two headlines
   in the file is the same failure as a week with two priorities. */
function setHeadline(id){
  if (state.locked) return;
  const loc = locate(id);
  if (!loc) return;
  clearHeadline(true);
  loc.task.headline = ymd(today());
  loc.task.dirty = true;
  markDirty(); refreshView();
  if (state.openTask) openDrawer(state.openTask);
}
function clearHeadline(quiet){
  if (state.locked) return;
  state.doc.buckets.forEach(b => b.tiers.forEach(ti => ti.tasks.forEach(t => {
    if (t.headline) { t.headline = ''; t.dirty = true; }
  })));
  if (quiet) return;
  markDirty(); refreshView();
  if (state.openTask) openDrawer(state.openTask);
}
/* How many live tasks name this one as their blocker. This is the evidence for
   picking it, so the bar shows the number rather than asking the owner to trust it. */
function unblockCount(t){
  if (!t.slug) return 0;
  return allItems().filter(i => !i.done && i.blockedBy.indexOf(t.slug) > -1).length;
}

/* The board calls this column Backlog, so the file says Backlog too. */
/* Tasks ticked off before the board started dating them have no `done:` at all,
   so nothing can tell whether they were finished yesterday or in March. They are
   stamped with today on first sight: the clock has to start somewhere, and
   starting it now means nothing is archived before it has been sat with for the
   full thirty days. Returns how many were stamped, to say so rather than quietly
   marking the file dirty. */
/* Gives an id to any task that has not got one, on load.

   The 137 tasks that existed when ids arrived were done in one pass by
   core/migrations/mint-ids.mjs. This is what keeps it true afterwards: a task
   added by the pa skill, pasted in, or restored from a backup taken before the
   migration arrives without one, and picks one up the first time the board sees
   it. The same shape as stampDoneDates and renameParked below, and it counts as
   a tidy-up rather than the owner's own work, so migratedOnly stays true and the
   watcher may still reload over it.

   Marks only the tasks it touches dirty, so a file where everything already has
   an id is not rewritten at all. */
function mintMissingIds(doc){
  const taken = idsInDoc(doc);
  let n = 0;
  for (const b of doc.buckets)
    for (const tier of b.tiers)
      for (const t of tier.tasks){
        if (t.stableId) continue;
        t.stableId = mintId(taken);
        taken.add(t.stableId);
        t.dirty = true;
        n++;
      }
  return n;
}

function stampDoneDates(doc){
  let n = 0;
  const now = ymd(today());
  doc.buckets.forEach(b => b.tiers.forEach(tier => tier.tasks.forEach(t => {
    if (t.done && !t.doneOn) { t.doneOn = now; t.dirty = true; n++; }
  })));
  return n;
}

/* ---- Rolling a recurring task onto its next occurrence ----
   Runs on load, beside the two fixups above and for the same reason: it is a
   fact about the calendar rather than a decision, so waiting to be asked would
   only mean the card said something untrue until somebody noticed.

   The board rather than the skill does it because the board is open every day
   and a check-in is not. A week without a check-in would otherwise leave last
   week's date on the card.

   Four things happen when an occurrence has passed:

   1. The agenda that was on it becomes `Previous agenda (that date):`, replacing
      whatever was there before. One cycle of history, which is what writing the
      next agenda actually needs — anything older is in the owner's meeting notes.
   2. The tick comes off. On a recurring task the tick means "prepared for this
      one", so it has to come off when "this one" changes, or the card claims
      next week is done.
   3. `[due:: ]` moves to the next occurrence. In a loop, since the gap since the
      last time the board was open can be longer than one cycle.
   4. A task that was ticked gets parked somewhere that says how soon it matters
      again, rather than sitting wherever it happened to be finished from. Under
      two days to the next occurrence and it goes to To do, which is the window
      in which preparing for a meeting is actually this session's work; two days
      or more and it goes to Backlog, out of the way until it is worth thinking
      about again. An occurrence that was never prepared for — still unticked
      when its date passed — has nothing to move on from, so it is left exactly
      where it was; only a "done" carries an opinion about what comes next.

   None of that happens at all while the next occurrence is still a week or more
   off and the card was ticked. A monthly meeting prepared for and delivered has
   nothing waiting on it for weeks, so it is held exactly as it is — ticked, in
   Done, with the agenda and the date it was prepared for still on it — and the
   roll simply does not fire. It fires on a later load, once that week has
   closed, because the date it is holding is still in the past and so the roll
   keeps being offered the card every time the board opens.

   The cost of holding it is that the card carries a date that has gone until
   the roll finally fires, and reads as prepared for an occurrence that is over.
   That is the trade that was taken deliberately: see the Done-is-not-a-column
   entry in IMPROVEMENTS.md, which is the change that would remove the need for
   it.

   Parking once is not enough on its own. The roll fires the day after an
   occurrence passes, which for a weekly meeting is six days out — Backlog, under
   the rule above — and nothing would ever move it to To do as the day came
   round. So a second pass runs on every load and walks recurring cards sitting
   in Backlog with an occurrence under two days away, moving those to To do. It
   only ever moves that one way: a card the owner has dragged somewhere themself stays
   dragged.

   Nothing is rolled while the board is showing a backup: that document is a
   record of a past state and rewriting the dates in it would be a lie about
   what was on disk that day. */
/* The two lines the placement rules above are drawn at, in days to the next
   occurrence. Named rather than typed at each of the three places that ask,
   since the two answers have to agree about where To do stops. */
const RECUR_TODO_DAYS = 2;
const RECUR_HOLD_DAYS = 7;
/* How many lines a block-shaped note occupies, counting its heading. Used to cut
   one out without disturbing anything at or above its own indent. */
function blockLength(lines, at){
  const base = leadIndent(lines[at]);
  let end = at + 1;
  while (end < lines.length && (!lines[end].trim() || leadIndent(lines[end]) > base)) end++;
  return end - at;
}

/* Moves a date field on one line by a number of days, in whichever of the two
   syntaxes it was written in. Leaves the line alone when it carries no such
   field, which is the ordinary case. */
function shiftFieldDate(text, key, days){
  if (!days) return text;
  const re = new RegExp('(\\[' + key + '::\\s*)(\\d{4}-\\d{2}-\\d{2})(\\s*\\])|(`' + key +
                        ':)(\\d{4}-\\d{2}-\\d{2})(`)', 'i');
  return text.replace(re, (whole, a, d1, b, c, d2, e) => {
    const iso = d1 || d2;
    const d = parseDue(iso);
    if (!d) return whole;
    d.setDate(d.getDate() + days);
    return d1 ? a + ymd(d) + b : c + ymd(d) + e;
  });
}

function rollRecurring(doc){
  const now = today();
  let n = 0, c = 0, moved = 0;
  const archived = [];
  // Collected rather than applied in place: this runs inside a forEach over
  // tier.tasks itself, and splicing the array a task's own iteration is
  // sitting in is how the next task in the same tier gets silently skipped.
  // Applied once, after every tier has been walked.
  const parks = [];
  doc.buckets.forEach(b => b.tiers.forEach(tier => tier.tasks.forEach(t => {
    const rep = readRepeat(t.repeat);
    if (!rep) return;

    /* No date yet — a task the owner has just tagged, or one the skill wrote without
       one. Give it its next occurrence rather than flagging it: the tag already
       says which day, so the date is derivable and asking would be busywork. */
    const cur = parseDue(t.due);
    if (!cur) {
      t.due = ymd(occurrenceFrom(rep, now));
      t.dirty = true;
      n++;
      return;
    }
    if (cur >= now) return;

    let next = occurrenceAfter(rep, cur);
    while (next < now) next = occurrenceAfter(rep, next);
    const shift = Math.round((next - cur) / 86400000);
    const gap = Math.round((next - now) / 86400000);

    /* Held rather than rolled: a ticked card with a week or more before it comes
       round again keeps everything it has — its date, its tick, its agenda and
       its place in Done — because nothing about it is waiting on the owner yet. The
       roll is not skipped for good, only not now: the date it is holding is
       still in the past, so the next load offers the card again, and the one
       after the week closes rolls it properly. Checked before anything below
       writes, since holding means nothing below runs at all. */
    if (t.done && gap >= RECUR_HOLD_DAYS) return;

    /* Edited on `t.body` in place, line by line, rather than through
       bodyParts/rebuildBody. Those two split every sub-step line away from every
       note line and reassemble the two runs back to back, which is right for the
       drawer's Description box — it only ever shows the task's own notes — and
       lossy here: a note belonging to a sub-step, a suggested message under
       "send the nudge", comes back attached to whichever step happens to end up
       last. In place, nothing moves that was not meant to. */
    /* The tick is what decides whether the agenda has been used. It means
       "prepared for this occurrence", so a ticked card whose date has gone is
       one where the prep was delivered — file the agenda as last cycle's. An
       unticked one is prep that never happened, which means those topics were
       never raised, so they carry forward to the new date instead.

       That distinction is the whole answer to a 1:1 that does not happen. The
       topics survive rather than being filed as history the owner then has to dig out,
       and carrying a topic that did get discussed is the cheaper mistake of the
       two: the owner deletes a line the owner can see, rather than losing one the owner cannot. */
    const agAt = t.body.findIndex(l => AGENDA_NOTE.test(l));
    let carried = false;
    if (agAt > -1 && t.done) {
      /* Cut last cycle's Previous block first, or a year of them accumulates
         under a task nobody scrolls to the bottom of. Cut before rewriting, and
         re-find the agenda afterwards, since cutting shifts the indices.

         The card keeps one cycle of history, which is what writing the next
         agenda needs — but the one being cut here is not nothing, it is a
         record of a meeting that happened. Filed to agenda-history.md before
         it goes, so a month back is still readable somewhere, just not on the
         card itself. */
      const prevAt = t.body.findIndex(l => PREV_AGENDA_NOTE.test(l));
      if (prevAt > -1) {
        const old = readPrevAgenda(t.body);
        if (old) archived.push({ title: t.title, when: old.date, topics: old.topics });
        t.body.splice(prevAt, blockLength(t.body, prevAt));
      }
      const at = t.body.findIndex(l => AGENDA_NOTE.test(l));
      const m = AGENDA_NOTE.exec(t.body[at]);
      t.body[at] = m[1] + '- Previous agenda (' + t.due + '):';
    } else if (agAt > -1) {
      carried = true;
    }

    /* Checked before setDone() clears it below — this is the state the task
       is rolling out of, not the one it's rolling into. Two days is the line
       because preparing for a meeting is work for the day before it at the
       earliest: inside that, it is this session's business and goes to To do;
       outside it, there is nothing to do about it yet and it is parked in
       Backlog. The pass at the bottom of this function is what brings it back
       across when the day does come round. */
    if (t.done) {
      parks.push({ bucket: b, from: tier, task: t, to: gap >= RECUR_TODO_DAYS ? BACKLOG_TIER : TODO_TIER });
      moved++;
    }

    setDone(t, false, { stay: true });
    /* And every sub-step with it. A recurring task's steps are the work of one
       occurrence — send the nudge, review what came back — so a step still
       ticked from last time reads as already done for a cycle it has never seen.
       Their `done:` dates go the same way the task's does.

       A step's own `[due:: ]` is an offset from the occurrence rather than a
       fixed date — "the nudge goes out two days before" — so it moves by exactly
       what the parent moved by. Clearing it would lose that intent and leaving it
       would point at a session that has already happened. */
    t.body.forEach((line, i) => {
      const sm = SUB_RE.exec(line);
      if (!sm) return;
      let text = sm[3];
      if (sm[2].toLowerCase() === 'x') {
        text = text.replace(/\[done::\s*[^\]]*\]|`done:[^`]*`/i, '')
                   .replace(/\s{2,}/g, ' ').trim();
      }
      text = shiftFieldDate(text, 'due', shift);
      text = shiftFieldDate(text, 'start', shift);
      t.body[i] = sm[1] + '- [ ] ' + text;
    });
    t.due = ymd(next);
    t.dirty = true;
    n++;
    if (carried) c++;
  })));
  /* Bringing one back across as its day arrives. The roll above parks a card
     once, on the load after its occurrence passed, which for a weekly meeting is
     six days out — Backlog, correctly, and then nothing would ever move it. So
     this walks every recurring card sitting in Backlog with its occurrence under
     two days away and moves it to To do, on every load rather than once.

     Backlog to To do and no other direction. Moving one back would overrule a
     card the owner dragged somewhere themself, and the board has no way to tell that
     drag from a card that was never moved. A card still ticked is left alone
     too: it is either prepared for the occurrence coming or being held by the
     rule above, and neither wants moving. */
  doc.buckets.forEach(b => b.tiers.forEach(tier => {
    if (tier.name !== BACKLOG_TIER) return;
    tier.tasks.forEach(t => {
      if (t.done || !readRepeat(t.repeat)) return;
      /* The roll has already decided about this one and unticked it, and its
         move has not been applied yet, so it is still sitting in the tier the
         roll found it in. Deciding again here would push a second move for the
         same card and the applier would land it in To do twice. */
      if (parks.some(p => p.task === t)) return;
      const d = parseDue(t.due);
      if (!d || d < now) return;
      if (Math.round((d - now) / 86400000) >= RECUR_TODO_DAYS) return;
      parks.push({ bucket: b, from: tier, task: t, to: TODO_TIER });
      moved++;
    });
  }));
  // Same move the Column field's own slider makes (see wireStepSlider('f-tier',
  // ...) in 19-drawer.js) — splice out of the tier the roll found it in, push
  // onto the target, skip the write entirely when they're already the same
  // tier so a task already sitting in To do isn't reshuffled to the bottom of
  // its own column for no reason.
  parks.forEach(({ bucket, from, task, to }) => {
    const target = ensureTier(bucket, to);
    if (target === from) return;
    const at = from.tasks.indexOf(task);
    // Gone from where it was decided about means something else has already
    // moved it, and pushing it onto the target anyway would put one task in two
    // columns. Nothing writes that today; the guard is here so nothing can.
    if (at === -1) return;
    from.tasks.splice(at, 1);
    target.tasks.push(task);
  });
  return { n, carried: c, moved, archived };
}

/* The plain-text shape of one filed agenda, reused from agendaClipboard's
   bullet-building but without the clipboard's title/blank-line wrapper —
   this is a heading in a file that already carries the date and the task
   it belonged to, not a document pasted somewhere else. */
function agendaHistoryMarkdown(entries){
  return entries.map(e => {
    const heading = '## ' + e.title + (e.when ? ' (' + e.when + ')' : '');
    const body = e.topics.map(t =>
      ['- ' + t.title].concat(t.context.map(c => '  - ' + c)).join('\n')
    ).join('\n');
    return heading + '\n\n' + body;
  }).join('\n\n');
}

/* Best effort, and silent on failure. Before this existed, a previous agenda
   the roll cut was simply gone — so a write that fails here leaves things no
   worse than they always were, and is not worth interrupting a page load
   over. Fired once, right after the roll that produced these entries. */
async function flushAgendaHistory(entries){
  if (!entries || !entries.length) return;
  try {
    await postJSON('/agenda-history', { text: agendaHistoryMarkdown(entries) });
  } catch (err) { /* nothing to do — see comment above */ }
}

function renameParked(doc){
  let changed = false;
  doc.buckets.forEach(b => b.tiers.forEach(t => { if (t.name === 'Parked') { t.name = 'Backlog'; t.raw = null; changed = true; } }));
  if (changed) doc.pre = doc.pre.map(l => l.replace(/\*\*Parked\*\*/g, '**Backlog**'));
  return changed;
}

const $  = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* The board's fetch shapes, collapsed out of what used to be 32 separate
   call sites copy-pasted from whichever one was nearest. A GET that forgets
   the cache-bust, or a POST that forgets X-Board, is how the two drift; going
   through here instead means a new endpoint gets both for free.

   getJSON throws on a non-OK response so callers get one try/catch rather
   than an `if (!res.ok)` of their own. postJSON always sends the two headers
   every write route wants (see the X-Board comment in server.py — the header
   itself is harmless on the handful of routes that don't check for it) and
   reads the body as JSON even on failure, since a write route's error rides
   in the same {error} shape as its success reply. */
async function getJSON(url){
  const sep = url.indexOf('?') === -1 ? '?' : '&';
  const res = await fetch(url + sep + 't=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) throw new Error('the server answered ' + res.status);
  return res.json();
}
async function sendJSON(method, url, data){
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Board': '1' },
    body: JSON.stringify(data)
  });
  const info = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(info.error || ('the server answered ' + res.status));
  return info;
}
function postJSON(url, data){ return sendJSON('POST', url, data); }
/* The one route the board writes with PUT rather than POST, because it
   replaces a whole file with a whole file: a bucket's brief. todo.md's own
   save is not this shape and does not go through here — it carries
   preconditions of its own (see 24-autosave-watching.js). */
function putJSON(url, data){ return sendJSON('PUT', url, data); }

function allTiers(){
  const names = [];
  (state.doc ? state.doc.buckets : []).forEach(b => b.tiers.forEach(t => { if (names.indexOf(t.name) < 0) names.push(t.name); }));
  if (!names.length) return [DONE_COL, 'Now','Next','Later','Parked'];
  /* Done is always the first heading, so it is the far right of the board. A
     bucket that has the heading somewhere else would otherwise decide where the
     scan above finds it, and a bucket with none has no say at all. */
  const at = names.indexOf(DONE_COL);
  if (at > -1) names.splice(at, 1);
  names.unshift(DONE_COL);
  return names;
}
/* A bucket may not have every column heading yet (e.g. an empty "Now").
   Create it in the right place the first time a card lands there. */
function ensureTier(bucket, name){
  const found = bucket.tiers.find(t => t.name === name);
  if (found) return found;
  const tier = { name, raw: null, lead: [''], tasks: [], tail: [''] };
  const order = allTiers();
  const pos = order.indexOf(name);
  let at = bucket.tiers.length;
  for (let i = 0; i < bucket.tiers.length; i++){
    if (order.indexOf(bucket.tiers[i].name) > pos) { at = i; break; }
  }
  bucket.tiers.splice(at, 0, tier);
  return tier;
}
function locate(id){
  const d = state.doc;
  for (let bi = 0; bi < d.buckets.length; bi++){
    const b = d.buckets[bi];
    for (let ti = 0; ti < b.tiers.length; ti++){
      const idx = b.tiers[ti].tasks.findIndex(t => t.id === id);
      if (idx > -1) return { bucket:b, bi, tier:b.tiers[ti], ti, index:idx, task:b.tiers[ti].tasks[idx] };
    }
  }
  return null;
}
/* ---- The bucket agents ----
   Each bucket has one agent, defined in its brief (core/bucket_agents.py).
   /api/bucket-agents says, per bucket, its name ("Personal family agent"), its
   mode (plan-first or free-rein) and whether the brief is filled in enough to
   run on (`ready`, and `missing` when it is not). `columns` maps the board's
   column names to their bucket, since a column's name and its bucket's folder
   are not always the same word. Loaded with each list; empty where there is no
   server, and then nothing can be handed over.

   agentOf() in core/todo.js reads any `[to::]` ending in " agent" as an agent,
   which is what a tick, a card's face and the Delegate to filter ask it. */
let bucketAgentData = { list: null, buckets: [], columns: {} };
let bucketAgentLoad = null;
function loadBucketAgents(){
  const list = state.dataset || '';
  bucketAgentLoad = (async () => {
    let got = null;
    try { got = await getJSON('/api/bucket-agents?list=' + encodeURIComponent(list)); } catch (err) { got = null; }
    const had = bucketAgentData.buckets.length;
    bucketAgentData = { list, buckets: (got && got.buckets) || [], columns: (got && got.columns) || {} };
    /* Only a redraw when something on screen can have changed. */
    if (state.doc && (had || bucketAgentData.buckets.length)) refreshView();
  })();
  return bucketAgentLoad;
}
/* Resolves once the list's bucket agents have been asked for, so a tick that
   names one is not read before the names are known. */
async function bucketAgentsLoaded(){
  if (!bucketAgentLoad || bucketAgentData.list !== (state.dataset || '')) await loadBucketAgents();
  else await bucketAgentLoad;
}
function bucketAgentNamed(name){
  const v = String(name || '').trim().toLowerCase();
  return v ? bucketAgentData.buckets.find(b => String(b.name).toLowerCase() === v) || null : null;
}
/* The agent of the bucket a column belongs to, or null. */
function bucketAgentOfColumn(columnName){
  const bucket = bucketAgentData.columns[columnName] || columnName;
  return bucketAgentData.buckets.find(b => b.bucket === bucket) || null;
}
function bucketAgentOfTask(t){
  const loc = t && locate(t.id);
  return loc ? bucketAgentOfColumn(loc.bucket.name) : null;
}
/* What is wrong with an agent that is not ready, in the owner's words. */
const BUCKET_AGENT_MISSING = {
  marker: 'the NOT FILLED IN YET line is still in the brief', mode: 'how it works (plan first or free rein)',
  start: 'a valid start', purpose: 'what it is for', processes: 'its processes', guidelines: 'its guidelines',
  may_touch: 'what it may touch', never_touch: 'what it must never touch', good: 'what good looks like'
};
function bucketAgentMissingText(a){
  return (a.missing || []).map(m => BUCKET_AGENT_MISSING[m] || m).join(', ');
}
const LEGACY_AGENTS = ['Plan agent', 'Implement agent'];
function legacyAgent(to){ return LEGACY_AGENTS.indexOf(agentOf(to)) > -1 ? agentOf(to) : ''; }

/* ---- Handing a task to an agent, and the two reviews that follow ----
   Handing a task over is the owner's act, and it becomes sub-tasks on the card rather than
   a column of its own. To the Plan agent it is four, each blocked by the one
   before: Plan (Plan agent), Review the plan (the owner), Implement (Implement agent),
   Review the work (the owner). Straight to the Implement agent, because the task
   already says how it is to be done, it is the last two. The board mints the
   slugs from the task's id and the step (`ab12cd-plan`, `ab12cd-plan-review`,
   `ab12cd-implement`, `ab12cd-work-review`) so they are unique across the file
   and readable, and gives every sub-task an id of its own for an agent to name
   when it asks for a tick. The card moves to Doing if it was in To do or Backlog.
   `[to::]` on the task itself records who has it. */
const HANDOVER_STEPS = {
  'plan':        { title: 'Plan',            to: 'Plan agent' },
  'plan-review': { title: 'Review the plan', to: OWNER_NAME },
  'implement':   { title: 'Implement',       to: 'Implement agent' },
  'work-review': { title: 'Review the work', to: OWNER_NAME }
};
/* ---- How much of an agent's work waits on the owner: its handover level ----
   Set per agent, per list, on the agent's card in the Agents tab.
     off         the agent is not offered under Delegate to and takes nothing.
     plan-first  the four sub-tasks above: the owner reads and approves the plan
                 before the work starts. The Plan agent's default.
     just-do-it  the same four, but Review the plan carries a `Handover: just
                 do it` note, and when the plan lands the board ticks that
                 review for the owner (drainTickQueue(), 10-reference-sections.js),
                 so the work goes on to Implement and the owner meets it at Review the
                 work, with the plan still there to read. A plan that folded,
                 asking the owner something, still waits for the owner.
   The Implement agent has no plan of its own, so it is just do it or off.
   Read at the moment of handover and written onto the card, so changing the
   level later leaves the tasks already handed over as they were. Kept in
   localStorage like the drawer's width: it is how the owner likes to work with an
   agent, not a fact about any task. */
const HANDOVER_LEVELS = {
  'Plan agent':      ['plan-first', 'just-do-it', 'off'],
  'Implement agent': ['just-do-it', 'off']
};
const HANDOVER_LEVEL_LABEL = { 'plan-first': 'Plan first', 'just-do-it': 'Just do it', 'off': 'Off' };
const JUST_DO_IT_NOTE = '- Handover: just do it';
function handoverLevelsKey(){ return 'bench-handover:' + (state.dataset || ''); }
function handoverLevels(){
  try { const got = JSON.parse(localStorage.getItem(handoverLevelsKey()) || '{}'); return got && typeof got === 'object' ? got : {}; }
  catch (err) { return {}; }
}
function handoverLevel(agent){
  const allowed = HANDOVER_LEVELS[agentOf(agent)];
  if (!allowed) return '';
  const saved = handoverLevels()[agentOf(agent)];
  return allowed.indexOf(saved) > -1 ? saved : allowed[0];
}
function setHandoverLevel(agent, level){
  const allowed = HANDOVER_LEVELS[agentOf(agent)];
  if (!allowed || allowed.indexOf(level) < 0) return false;
  const all = handoverLevels();
  all[agentOf(agent)] = level;
  try { localStorage.setItem(handoverLevelsKey(), JSON.stringify(all)); } catch (err) { return false; }
  return true;
}
/* Whether a Review the plan sub-task was laid out to approve itself. */
function justDoIt(t, line){
  return stepNoteText(t, line).split('\n').some(l => l.trim().toLowerCase() === JUST_DO_IT_NOTE.toLowerCase());
}

/* Handing a task to its bucket's agent: plan-first lays out Plan (the bucket
   agent), Review the plan (the owner), Implement (the bucket agent) and Review
   the work (the owner), each blocked by the one before; free-rein lays out
   Implement and Review the work. A bucket whose agent is not ready takes
   nothing. The two old agents still hand over the way they did (see
   handOverLegacy), for a tag already written or a request already queued. */
function handOver(t, agent, level){
  if (legacyAgent(agent)) return handOverLegacy(t, agent, level);
  const a = bucketAgentNamed(agent);
  if (state.locked || !a || !a.ready) return false;
  return layOutHandover(t, a.name, a.mode === 'plan-first'
    ? ['plan', 'plan-review', 'implement', 'work-review']
    : ['implement', 'work-review'], { plan: a.name, implement: a.name });
}

function layOutHandover(t, agent, kinds, doers, level){
  t.to = agent;
  t.dirty = true;
  /* Already laid out when a sub-task carries the slug a handover makes. An
     ordinary step that happens to be assigned to an agent is a step it does, not
     a handover. */
  const made = new RegExp('^' + (t.stableId || '-') + '-(plan|implement)$');
  if (subSteps(t).some(s => agentOf(s.to) && made.test(s.slug))) return false;
  const taken = idsInDoc(state.doc);
  if (!t.stableId) { t.stableId = mintId(taken); taken.add(t.stableId); }
  const existing = subSteps(t);
  const indent = existing.length ? existing[0].indent : '  ';
  let before = '';
  kinds.forEach(kind => {
    const id = mintId(taken); taken.add(id);
    const slug = t.stableId + '-' + kind;
    const to = doers[kind] || HANDOVER_STEPS[kind].to;
    const f = { done: false, bold: false, title: HANDOVER_STEPS[kind].title, to,
                slug, blockedBy: before ? [before] : [], stableId: id, body: [], dirty: true, extra: [] };
    t.body.push(indent + serializeTask(f)[0]);
    /* Written as the review's own note, the way setStepNoteText() indents one,
       and not through it: that marks an undo point half way through a handover. */
    if (kind === 'plan-review' && level === 'just-do-it') t.body.push(indent + '  ' + JUST_DO_IT_NOTE);
    before = slug;
  });
  const loc = locate(t.id);
  if (loc && (loc.tier.name === TODO_TIER || loc.tier.name === BACKLOG_TIER)) {
    loc.tier.tasks.splice(loc.index, 1);
    ensureTier(loc.bucket, DOING_TIER).tasks.unshift(t);
  }
  return true;
}

function handOverLegacy(t, agent, level){
  if (state.locked || !legacyAgent(agent)) return false;
  agent = legacyAgent(agent);
  level = level || handoverLevel(agent);
  if (level === 'off') return false;
  return layOutHandover(t, agent, agent === 'Plan agent'
    ? ['plan', 'plan-review', 'implement', 'work-review']
    : ['implement', 'work-review'], { plan: 'Plan agent', implement: 'Implement agent' }, level);
}
/* Where a card goes for the state of its sub-tasks, and only these two ways:
   Implement ticked puts it in Reviewing, and unticked by a send-back puts it
   back in Doing. A ticked Plan leaves it where it is. */
function moveCardTo(t, tierName){
  const loc = locate(t.id);
  if (!loc || loc.tier.name === tierName || loc.tier.name === DONE_COL) return;
  loc.tier.tasks.splice(loc.index, 1);
  ensureTier(loc.bucket, tierName).tasks.unshift(t);
}

/* The sub-task a review sits behind: the one its `blocked-by` names. */
function stepBefore(t, review){
  const slug = (review.blockedBy || [])[0];
  return slug ? subSteps(t).find(s => s.slug === slug) || null : null;
}

/* Approving is ticking the review. */
function approveReview(t, line){
  const cur = readSub(t, line);
  if (!cur || cur.done) return '';
  const msg = blockedMessage(allItems(), (cur.blockedBy || []).concat(t.blockedBy || []));
  if (msg) return msg;
  cur.done = true; cur.doneOn = ymd(today()); cur.doing = false;
  writeSub(t, line, cur);
  markDirty();
  return '';
}

/* Sending back unticks the sub-task before the review, with what was wrong as a
   `feedback:` note under it, so the agent takes it up again and the review
   blocks again. Sending back the work also puts the card back in Doing. */
function sendBack(t, line, why){
  const cur = readSub(t, line);
  const prev = cur && stepBefore(t, cur);
  if (!prev) return false;
  if (cur.done) { cur.done = false; cur.doneOn = ''; writeSub(t, line, cur); }
  const back = readSub(t, prev.line);
  back.done = false; back.doneOn = ''; back.doing = false;
  writeSub(t, prev.line, back);
  const said = String(why || '').trim();
  if (said) {
    const now = stepNoteText(t, prev.line);
    setStepNoteText(t, prev.line, (now ? now + '\n' : '') + '- feedback: ' + said.replace(/\n+/g, ' '));
  }
  if (/-implement$/.test(back.slug || '') || agentOf(back.to) === 'Implement agent') moveCardTo(t, DOING_TIER);
  markDirty();
  return true;
}

/* Whether a sub-task assigned to the owner is open with its blocker ticked, which is
   the whole of "your move". Worked out every time, never stored. Blockers are
   looked up among the task's own sub-tasks, which is where a handover puts them. */
function yourMove(t){
  const steps = subSteps(t);
  /* Signed in, yours is your email and nothing else (namesMe()); on the Mac
     it is the owner's name, as it always was. */
  const mine = s => state.who ? namesMe(s.to) : s.to === OWNER_NAME;
  return steps.some(s => !s.done && mine(s) &&
    (s.blockedBy || []).every(sl => { const b = steps.find(x => x.slug === sl); return b && b.done; }));
}

/* A sub-task by the id written on its line, the six characters that survive a
   line number shifting. Returns the task it sits under, where that task is, and
   the step as subSteps() reads it, or null when nothing carries that id. */
function locateSub(subId){
  if (!subId || !state.doc) return null;
  for (const b of state.doc.buckets)
    for (const tier of b.tiers)
      for (let i = 0; i < tier.tasks.length; i++) {
        const step = subSteps(tier.tasks[i]).find(s => s.stableId === subId);
        if (step) return { loc: locate(tier.tasks[i].id), step };
      }
  return null;
}
/* The single way a task's tick is changed. Five places used to set .done by hand,
   and every one of them would now have to remember to date it — so they all go
   through here instead. Returns true if anything actually changed.

   The tick and the Done heading move together: a ticked task goes to the top of
   its bucket's Done, so the newest is the first one you see, and one unticked
   while it sits there goes to the top of To do. The caller that places the task
   itself, having captured where it was — a drop on a column, the drawer's Column
   field, the recurring roll — passes `stay` and does its own move. */
function setDone(t, on, opts){
  if (state.locked) return false;
  if (t.done === on) return false;
  t.done = on;
  t.doneOn = on ? ymd(today()) : '';
  t.dirty = true;
  // A one-off ticked into Done is solved, so it stops being the one thing. A
  // recurring one comes round again and stays the headline until it is solved.
  if (on && !t.repeat && t.headline) t.headline = '';
  if (!(opts && opts.stay)) moveForTick(t, on);
  // Ticking the card off ticks its sub-steps too — a card in Done with open
  // steps under it reads as unfinished work, which it no longer is. Going the
  // other way leaves steps alone: dragging a card back out of Done doesn't
  // mean the steps that were already ticked got undone.
  if (on) splitBody(t).steps.forEach(s => { if (!s.done) toggleSub(t, s.line); });
  return true;
}

function moveForTick(t, on){
  const loc = locate(t.id);
  if (!loc) return;
  const inDone = loc.tier.name === DONE_COL;
  if (on === inDone) return;
  const to = ensureTier(loc.bucket, on ? DONE_COL : TODO_TIER);
  loc.tier.tasks.splice(loc.index, 1);
  to.tasks.unshift(t);
}

function markDirty(){
  if (state.locked) return;
  noteUndo();
  applyDirty();
}
function applyDirty(msg){
  state.dirty = true;
  state.migratedOnly = false;
  const s = $('#status');
  s.textContent = msg || 'unsaved changes';
  s.classList.add('dirty');
}

