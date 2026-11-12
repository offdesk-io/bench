/* The to-do format, as the board reads and writes it.

   This is the authority. `core/todo.py` beside it is a port for the Python
   readers — the companion, the planning agent, the PA's checker — and its
   own docstring says that where the two disagree, this file is right and the
   Python is the bug. `core/fixtures/` is what stops that being a promise: both
   suites read the same tables, so a change here the fixtures do not expect
   fails in Python as well as in JavaScript.

   Three halves, which is one more than the name suggests:

     - parse and serialise. A document is buckets of tiers of tasks. Every line
       the board did not itself rewrite comes back verbatim, so saving a file
       nobody edited gives back the same bytes.
     - sub-steps and suggested messages. How deep a note is indented is what
       says whether it serves the task or one step inside it.
     - recurrence. `repeat:` says how often, `[due:: ]` says which occurrence the
       card is pointing at now, and neither is derivable from the other.

   What is deliberately not here: anything touching the DOM or `state`, and the
   working calendar. The calendar stays in todo.py alone — two files holding the
   same holiday list is two lists to keep in step.

   A classic script, not a module. index.html's own script is classic and
   inline, and a module here would be deferred past it, so every symbol below
   would be missing at the moment the board first needs it. Loaded before that
   script, these land in the shared global lexical environment and it simply
   sees them. core/test_todo.mjs picks them up the same way, out of a `vm`
   context, which is why nothing here reaches for `window`. */

'use strict';

/* ---- Parse and serialise ---------------------------------------------- */

const TASK_RE   = /^-\s+\[([ xX])\]\s?(.*)$/;
const BUCKET_RE = /^##\s+(\d+)\.\s+(.*)$/;
const TIER_RE   = /^###\s+(.*)$/;
const HR_RE     = /^---\s*$/;

/* Column headings that have been renamed, old name to new. Read on parse, so
   a backup or a list not yet rewritten still lands in the right column, and
   the next save writes the new heading. Waiting review and Waiting for review
   are now Reviewing, because a column says the state of a card and nothing else.
   core/todo.py holds the same table. */
const TIER_RENAMED = { 'Waiting review': 'Reviewing', 'Waiting for review': 'Reviewing' };

/* The heading a finished task lives under. It is first in a bucket, because the
   board draws a bucket's headings in the reverse order and Done is its far
   right. The tick and the place agree, and
   gatherDone() below is what makes an older file agree too. core/todo.py holds
   the same name. */
const DONE_HEADING = 'Done';

let uidCounter = 0;
const uid = () => 't' + (++uidCounter);

/* Two tag syntaxes, one meaning. `impact`, `effort`, `due` and `ai` are written in
   Dataview's inline-field form — `[due:: 2026-08-21]` rather than
   a code span — because those four are what the Dataview queries in views.md
   filter on, and Dataview cannot see inside a code span. The rest stay code
   spans: nothing queries them, and the line is already busy enough.

   Both forms are read everywhere, permanently, not as a migration window. The
   backups, the done-archive and anything the owner pastes back out of an old snapshot
   are full of the old form, and a board that silently loses the scores off a
   restored task is worse than one that reads both. Only the new form is
   written.

   The bracket pattern insists on the double colon, so `[[a wikilink]]` and
   `[label](a link)` are left alone.

   One pass over both forms rather than one pass each, so an unrecognised tag
   keeps its position on the line instead of drifting to the end of it the next
   time the task is saved. */
const ANY_TAG_RE = /\[([A-Za-z][\w-]*)::\s*([^\]]*)\]|`([A-Za-z][\w-]*):([^`]*)`/g;
/* Every tag form, for stripping a line back to its readable title. */
const ALL_TAGS_RE = /\[[A-Za-z][\w-]*::[^\]]*\]|`[A-Za-z#][\w-]*:?[^`]*`/g;

/* One field, either syntax, or '' when the line does not carry it. */
function readField(text, key){
  const m = new RegExp('\\[' + key + '::\\s*([^\\]]*)\\]|`' + key + ':([^`]*)`', 'i').exec(text);
  if (!m) return '';
  return (m[1] != null ? m[1] : m[2]).trim();
}
/* The agents a task can be handed to, spelt the way `[to::]` writes them. The
   Plan agent and the Implement agent are the two old ones, kept readable. A
   bucket's agent ("Personal family agent", core/bucket_agents.py) is any other
   name ending in " agent". Everything else in `[to::]` is a person. */
const AGENT_NAMES = ['Plan agent', 'Implement agent'];
function agentOf(to){
  const v = String(to || '').trim();
  const old = AGENT_NAMES.find(a => a.toLowerCase() === v.toLowerCase());
  if (old) return old;
  return /\S\s+agent$/i.test(v) ? v : '';
}
function hasField(text, key){
  return new RegExp('\\[' + key + '::|`' + key + ':', 'i').test(text);
}
/* Strips every tag in both syntaxes, leaving the words a human wrote. */
function stripTags(text){
  return text.replace(ALL_TAGS_RE, '').replace(/`(urgent|week)`/g, '');
}

/* Pulls every tag off a task line. The four tags #slug, week,
   blocked-by: and rank: are the sole source for the sections above the board,
   so they are parsed as first-class fields rather than left in `extra`. Anything
   still unrecognised goes to `extra` and is written back untouched. */
/* What a task line says once its tick box is off: every tag it carries and the
   title left over. The one reading a top-level task and a sub-task share, so a
   sub-task has every tag a task has and the two cannot drift. It makes no id and
   touches no counter, since a sub-task is read again on every render. */
function readTags(rest){
  const tags = {};
  const extra = [];                                   // any tag we don't know about, kept verbatim
  let blockedBy = [], rank = null, tlrank = null, slug = '', headline = '', chat = '', repeat = '';
  let stableId = '', cancelled = '', archived = '', createdBy = '', editedBy = '';
  /* Either syntax lands here, so a tag means the same thing whichever form it
     arrived in. `whole` is what goes into `extra`, which keeps an unrecognised
     tag exactly as it was written. */
  const take = (whole, bk, bv, sk, sv) => {
    const k = bk != null ? bk : sk, v = bk != null ? bv : sv;
    const key = k.toLowerCase();
    if (key === 'impact' || key === 'effort' || key === 'due' ||
        key === 'start' || key === 'done' || key === 'to' || key === 'theme' || key === 'time') tags[key] = v.trim();
    /* Retired. `[to::]` says who does the work, an agent included,
       and a backup still carrying `ai:` loses it on the next save. */
    else if (key === 'ai') {}
    else if (key === 'blocked-by') blockedBy = v.split(',').map(s => s.trim()).filter(Boolean);
    else if (key === 'rank') rank = parseInt(v.trim(), 10);
    /* Where this task sits in its bucket's timeline lane — set by dragging a
       row up or down there, never by hand. Separate from `rank` because the
       two order different things: `rank` is Delegate's queue, this is one
       bucket's vertical position on the Gantt, and a task can hold both. */
    else if (key === 'tlrank') tlrank = parseInt(v.trim(), 10);
    else if (key === 'headline') headline = v.trim();
    /* Which conversations belong to this task. Six characters that mean nothing
       on their own — data/sessions.json is what turns them into a list. It sits
       on the task rather than in that file because a task gets renamed, moved
       between buckets and reordered, and a key written on the line survives all
       three where a key made out of the title survives none of them. */
    else if (key === 'chat') chat = v.trim().toLowerCase();
    /* How often this task comes round. First-class rather than left in `extra`
       because the load-time roll has to read it on every task, and because two
       views ask about it — the card's chip and the Quick wins group. */
    else if (key === 'repeat') repeat = v.trim().toLowerCase();
    /* The task's own identity, minted once and written here. Not `id` on the
       object below, which is a fresh number every parse and means nothing
       outside this tab — see uid(). This one is what a plan, a ledger row or a
       queue position points at, and it is the whole reason renaming a task no
       longer loses those. Six characters of base36, the same shape and the
       same generator as a `chat:` key, which has held up. */
    else if (key === 'id') stableId = v.trim().toLowerCase();
    /* Why a ticked task was ticked, when the answer is "it wasn't done".
       First-class rather than left in `extra` because every count of finished
       work has to be able to leave these out — see CONVENTIONS.md, Cancelling
       a task. `cancelled` is decided against; `archived` is no longer
       relevant. Both carry the date the decision was made, which is not
       necessarily `done:`. */
    else if (key === 'cancelled') cancelled = v.trim();
    else if (key === 'archived') archived = v.trim();
    /* Who wrote the task and who last changed it, by the email they signed in
       with. Only the server writes these, on a shared board, from the sign-in
       header and never from what a tab sends (stamp_authors() in
       core/todo.py); a list nobody signs in to never carries them. */
    else if (key === 'created-by') createdBy = v.trim().toLowerCase();
    else if (key === 'edited-by') editedBy = v.trim().toLowerCase();
    else extra.push(whole);
    return ' ';
  };
  rest = rest.replace(ANY_TAG_RE, take);
  rest = rest.replace(/`#([a-z0-9][a-z0-9-]*)`/gi, (whole, s) => { slug = s.toLowerCase(); return ' '; });
  let urgent = false, week = false;
  rest = rest.replace(/`urgent`/g, () => { urgent = true; return ' '; });
  rest = rest.replace(/`week`/g, () => { week = true; return ' '; });
  /* A sub-task an agent is working on right now. The only state a sub-task
     carries: unticked is To do, the tick is Done, and this is Doing. */
  let doing = false;
  rest = rest.replace(/`doing`/g, () => { doing = true; return ' '; });
  let title = rest.replace(/\s+/g, ' ').trim();
  const bold = /^\*\*[\s\S]*\*\*$/.test(title);
  if (bold) title = title.slice(2, -2).trim();
  return {
    title, bold,
    impact: tags.impact || '',
    effort: tags.effort || '',
    due: tags.due || '',
    /* The hour the due date falls at, HH:MM in 24h, for the desktop banner. It
       means nothing without a due date, so serializeTask() drops it then. */
    time: tags.time || '',
    /* The deadline and the earliest possible start are two different facts. One
       date was doing both jobs, which meant nothing could tell "finish by the
       7th" apart from "cannot begin until the 1st". */
    start: tags.start || '',
    /* The day it was ticked off. Nothing in the file used to record this, so
       "finished a while ago" was unanswerable — which is exactly what archiving
       old finished work needs to know. Written when a task is ticked. */
    doneOn: tags.done || '',
    /* Who does the work: one of AGENT_NAMES, or a person from people.md.
       Blank means the owner is doing it themself, which is most of the list. */
    to: tags.to || '',
    /* Which of the bucket's declared themes this task sits under — the
       sub-organisation inside a bucket (Design System's ways-of-working,
       audits, and so on), values declared per bucket rather than invented per
       task (see loadBucketThemes() in kanban/js/08-buckets.js). Until 25 Sep
       2026 this lived as free prose in the first line of Notes, `- Stream:
       audits.`, readable only by a language model rather than by a query. */
    theme: tags.theme || '',
    urgent, week, doing, slug, blockedBy, rank, tlrank, headline, chat, repeat, stableId,
    cancelled, archived, createdBy, editedBy, extra
  };
}

function parseTask(rawLines){
  const first = rawLines[0];
  const m = TASK_RE.exec(first);
  return Object.assign({ id: uid(), done: m[1].toLowerCase() === 'x' }, readTags(m[2]),
    { body: rawLines.slice(1), raw: first, dirty: false });
}

/* Whether a ticked task counts as work that was done. A cancellation is a tick
   plus `cancelled:` or `archived:` (CONVENTIONS.md, Cancelling a task), so the
   box being ticked no longer means "finished" on its own — and every count of
   completed work has to ask this rather than asking `t.done`. Undated finished
   work is not counted either: `done:` is what puts it in a window. */
function countsAsFinished(t){
  return !!(t.done && t.doneOn && !t.cancelled && !t.archived);
}

/* A new stable id, avoiding everything already in use. Six characters of
   base36: meaningless on its own, short enough to read on a line without
   crowding the tags beside it, and the same shape as the chat keys in
   ai_chat_engine, which this borrows wholesale rather than inventing a second
   scheme for the same job.

   `taken` is whatever the caller already knows about. Collisions are checked
   rather than assumed away, because 36^6 is large but a task list is not
   random and ids get copied between lines by hand. */
function mintId(taken){
  const used = taken instanceof Set ? taken : new Set(taken || []);
  let key = '';
  do { key = Math.random().toString(36).slice(2, 8); }
  while (key.length < 6 || used.has(key));
  return key;
}

/* Every stable id in a parsed document, for minting against. */
function idsInDoc(doc){
  const out = new Set();
  for (const b of doc.buckets)
    for (const tier of b.tiers)
      for (const t of tier.tasks) {
        if (t.stableId) out.add(t.stableId);
        /* A sub-task carries an id of its own, so one minted for a task must not
           collide with one already written on a step under it. */
        for (const st of splitBody(t).steps) if (st.stableId) out.add(st.stableId);
      }
  return out;
}

function serializeTask(t){
  let first;
  if (!t.dirty) {
    first = t.raw;
  } else {
    const box = t.done ? '[x]' : '[ ]';
    const name = t.bold === false ? t.title : '**' + t.title + '**';
    const tags = [];
    /* The four Dataview reads are written as inline fields; the rest stay code
       spans. Order is unchanged, so a task rewritten by the board still diffs
       cleanly against one edited by hand. */
    if (t.slug)   tags.push('`#' + t.slug + '`');
    if (t.impact) tags.push('[impact:: ' + t.impact + ']');
    if (t.effort) tags.push('[effort:: ' + t.effort + ']');
    if (t.start)  tags.push('`start:' + t.start + '`');
    if (t.due)    tags.push('[due:: ' + t.due + ']');
    if (t.due && t.time) tags.push('[time:: ' + t.time + ']');
    if (t.done && t.doneOn) tags.push('`done:' + t.doneOn + '`');
    /* Beside `done:`, and written whether or not the task is ticked. An
       unticked one carrying either is what check_todo.py reports as a FIX —
       most likely a tick that was forgotten — and dropping the tag on the next
       autosave would throw that away rather than let the owner fix it. Unlike
       `done:`, which is meaningless on an open task, these carry a decision. */
    if (t.cancelled) tags.push('`cancelled:' + t.cancelled + '`');
    if (t.archived)  tags.push('`archived:' + t.archived + '`');
    if (t.urgent) tags.push('`urgent`');
    if (t.week)   tags.push('`week`');
    if (t.doing)  tags.push('`doing`');
    if (t.to && t.to.trim()) tags.push('[to:: ' + t.to.trim() + ']');
    if (t.theme && t.theme.trim()) tags.push('[theme:: ' + t.theme.trim() + ']');
    if (t.blockedBy && t.blockedBy.length) tags.push('`blocked-by:' + t.blockedBy.join(',') + '`');
    if (t.rank != null && !isNaN(t.rank)) tags.push('`rank:' + t.rank + '`');
    if (t.tlrank != null && !isNaN(t.tlrank)) tags.push('`tlrank:' + t.tlrank + '`');
    if (t.headline) tags.push('`headline:' + t.headline + '`');
    if (t.chat)   tags.push('`chat:' + t.chat + '`');
    if (t.repeat) tags.push('`repeat:' + t.repeat + '`');
    /* Before the id rather than after it, for the reason the id's own comment
       gives: the server adds these to a line by inserting them in front of
       the id and touching nothing else, and this has to write the same line. */
    if (t.createdBy) tags.push('`created-by:' + t.createdBy + '`');
    if (t.editedBy)  tags.push('`edited-by:' + t.editedBy + '`');
    /* Last among the tags this file knows, and that position is load-bearing.
       Ids were added to a file of 137 existing tasks by appending this one
       token to each line and changing nothing else, which only round-trips
       through this function if the token belongs at the end. Moving it earlier
       would rewrite every line the first time each task is edited, and would
       have made that migration unreviewable. */
    if (t.stableId) tags.push('`id:' + t.stableId + '`');
    if (t.extra && t.extra.length) tags.push.apply(tags, t.extra);
    first = '- ' + box + ' ' + [name].concat(tags).join(' ');
  }
  const body = t.body.slice();
  while (body.length && body[body.length - 1].trim() === '') body.pop();
  return [first].concat(body);
}

/* Everything between the task lines — blank lines, stray prose, the `---` rule at
   the foot of a bucket — is kept verbatim so that saving a file nobody edited
   gives back the same bytes. `lead` is what sits under a column heading, `sep`
   is what follows a task, `tail` is what closes a column, `tail` on the bucket
   is what closes the bucket (so a column added later lands above the rule). */
function parseDoc(text){
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const doc = { pre: [], buckets: [], post: [] };
  let i = 0;

  while (i < lines.length && !BUCKET_RE.test(lines[i])) doc.pre.push(lines[i++]);

  while (i < lines.length) {
    const bm = BUCKET_RE.exec(lines[i]);
    if (!bm) break;
    const bucket = { num: bm[1], name: bm[2].trim(), raw: lines[i], intro: [], tiers: [], tail: [] };
    i++;
    while (i < lines.length && !TIER_RE.test(lines[i]) && !/^##\s/.test(lines[i])) bucket.intro.push(lines[i++]);

    while (i < lines.length && TIER_RE.test(lines[i])) {
      const heading = TIER_RE.exec(lines[i])[1].trim();
      const renamed = TIER_RENAMED[heading];
      const tier = { name: renamed || heading, raw: renamed ? null : lines[i],
                     lead: null, tasks: [], tail: [] };
      i++;
      let gap = [];                                   // lines seen since the last task
      while (i < lines.length && !TIER_RE.test(lines[i]) && !/^##\s/.test(lines[i])) {
        const line = lines[i];
        if (TASK_RE.test(line)) {
          if (tier.tasks.length) tier.tasks[tier.tasks.length - 1].sep = gap;
          else tier.lead = gap;
          gap = [];
          const raw = [line];
          i++;
          while (i < lines.length) {
            const l = lines[i];
            if (l.trim() === '') {                       // blank: keep only if the block continues
              let j = i;
              while (j < lines.length && lines[j].trim() === '') j++;
              if (j < lines.length && /^\s+\S/.test(lines[j])) { raw.push.apply(raw, lines.slice(i, j)); i = j; continue; }
              break;
            }
            if (/^\s+\S/.test(l)) { raw.push(l); i++; continue; }  // indented: part of this task
            break;
          }
          tier.tasks.push(parseTask(raw));
        } else {
          gap.push(line);
          i++;
        }
      }
      if (tier.tasks.length) {
        tier.tail = gap;
      } else {
        /* Empty column: the blank line belongs under the heading, anything after
           it closes the column, so a first card lands between the two. */
        let k = 0;
        while (k < gap.length && gap[k].trim() === '') k++;
        tier.lead = gap.slice(0, k);
        tier.tail = gap.slice(k);
      }
      bucket.tiers.push(tier);
    }
    /* Hand the closing blank/rule lines back to the bucket, so they stay at the
       bottom even if a new column is appended. */
    if (bucket.tiers.length) {
      const last = bucket.tiers[bucket.tiers.length - 1];
      let cut = last.tail.length;
      while (cut > 0 && (last.tail[cut - 1].trim() === '' || HR_RE.test(last.tail[cut - 1]))) cut--;
      /* Leave one blank line with the column, so a card appended to it is still
         separated from the rule below. */
      if (cut < last.tail.length && last.tail[cut].trim() === '') cut++;
      bucket.tail = last.tail.slice(cut);
      last.tail = last.tail.slice(0, cut);
    }
    doc.buckets.push(bucket);
  }
  doc.post = lines.slice(i);
  gatherDone(doc);
  return doc;
}

/* A ticked task belongs under its bucket's Done heading. A file written before
   that was true has them under whichever heading they were ticked in, so they
   are gathered here, on every read: an old backup lands the same way as a list
   not yet rewritten, and the next save writes them where they now live, the way
   a renamed heading is (TIER_RENAMED). The order is the file's own, appended
   after what Done already held; when a bucket has no Done heading yet one is
   made, first, and only if something ticked needs it. core/todo.py's parse_doc
   gathers in the same order, which is what the fixtures compare.

   The tick still means finished and the heading means where it is. A task in
   Done that is not ticked is left alone. */
function gatherDone(doc){
  doc.buckets.forEach(b => {
    const stray = [];
    b.tiers.forEach(tier => {
      if (tier.name === DONE_HEADING) return;
      const keep = tier.tasks.filter(t => !t.done);
      if (keep.length === tier.tasks.length) return;
      tier.tasks.forEach(t => { if (t.done) stray.push(t); });
      tier.tasks = keep;
      if (!keep.length) {
        /* Emptied: what is left is a heading with the blank line under it, the
           shape parseDoc gives a column it finds empty. Prose that sat after
           the last task is not ours to drop. */
        tier.lead = tier.lead && tier.lead.length ? tier.lead : [''];
        tier.tail = tier.tail.some(l => l.trim() !== '') ? tier.tail : [];
      }
    });
    if (!stray.length) return;
    let done = b.tiers.find(t => t.name === DONE_HEADING);
    if (!done) {
      done = { name: DONE_HEADING, raw: null, lead: [''], tasks: [], tail: [''] };
      b.tiers.unshift(done);
    }
    stray.forEach(t => { done.tasks.push(t); });
  });
}

function serializeDoc(doc){
  const out = doc.pre.slice();
  doc.buckets.forEach(b => {
    out.push(b.raw != null ? b.raw : '## ' + b.num + '. ' + b.name);
    out.push.apply(out, b.intro);
    b.tiers.forEach(tier => {
      out.push(tier.raw != null ? tier.raw : '### ' + tier.name);
      out.push.apply(out, tier.lead != null ? tier.lead : ['']);
      tier.tasks.forEach((t, idx) => {
        out.push.apply(out, serializeTask(t));
        const last = idx === tier.tasks.length - 1;
        out.push.apply(out, last ? (tier.tail || ['']) : (t.sep != null ? t.sep : ['']));
      });
      if (!tier.tasks.length) out.push.apply(out, tier.tail || []);
    });
    out.push.apply(out, b.tail != null ? b.tail : []);
  });
  out.push.apply(out, doc.post);
  return out.join('\n');
}

/* ---- Sub-steps, and the suggested messages inside them ----------------- */

const SUB_RE = /^(\s*)-\s+\[([ xX])\]\s+(.*)$/;

/* A task's body splits into its own notes and its sub-steps, each sub-step
   carrying the deeper-indented notes that belong to it. That depth is what says
   whether a suggested message serves the task or one step inside it. */
function splitBody(t){
  const notes = [], steps = [];
  let base = null, intoSteps = false;
  t.body.forEach((line, idx) => {
    const m = SUB_RE.exec(line);
    if (m && (base === null || m[1].length <= base)) {
      base = m[1].length;
      const text = m[3];
      /* A sub-task carries every tag a task does, read by the same function.
         What follows this call keeps the names the board already reads a step
         by; what it adds is the rest of the tags, under the names a task has. */
      const r = readTags(text);
      steps.push({
        line: idx,                           // index back into the body, so it can be ticked
        done: m[2].toLowerCase() === 'x',
        text,
        impact: r.impact, effort: r.effort, doneOn: r.doneOn, urgent: r.urgent,
        headline: r.headline, chat: r.chat, tlrank: r.tlrank, repeat: r.repeat,
        stableId: r.stableId, doing: r.doing, cancelled: r.cancelled, archived: r.archived,
        createdBy: r.createdBy, editedBy: r.editedBy, extra: r.extra,
        due:   readField(text, 'due'),
        time:  r.time,
        start: readField(text, 'start'),
        to:    readField(text, 'to'),
        /* Half the blockers in the file are steps, not whole tasks. Without the
           slug here, a `blocked-by:` pointing at one never resolves, so anything
           waiting on it looks permanently stuck. */
        slug: (/`#([a-z0-9][a-z0-9-]*)`/i.exec(text) || [,''])[1].toLowerCase(),
        rank: /`rank:(\d+)`/.test(text) ? +/`rank:(\d+)`/.exec(text)[1] : null,
        week: /`week`/.test(text),
        /* A step can wait on another step, which is the difference between "must
           be finished by the 7th" and "cannot start until the request goes out".
           A date cannot say the second thing, so without this the two are
           indistinguishable and Quick wins has to guess. */
        blockedBy: (/`blocked-by:([^`]*)`/.exec(text) || [,''])[1]
                     .split(',').map(s => s.trim()).filter(Boolean),
        clean: stripTags(text).replace(/\s+/g, ' ').replace(/\s*—\s*$/, '').trim(),
        notes: []
      });
      intoSteps = true;
      return;
    }
    /* A line back at the step indent or shallower ends the run of notes under
       the last step and hands the rest of the body back to the task, taking
       the lines deeper than it along with it. Without that, everything after
       the first step belonged to that step for the remainder of the body, so
       an `Agenda:` written below the steps landed on the task while its own
       topics landed on the last step — a heading in the drawer with nothing
       under it. */
    if (line.trim() && base !== null && leadIndent(line) <= base) intoSteps = false;
    if (steps.length && intoSteps && base !== null && /^\s+\S/.test(line) && leadIndent(line) > base) {
      steps[steps.length - 1].notes.push(line);
      return;
    }
    if (line.trim()) notes.push(line);
  });
  return { notes, steps };
}
/* What a sub-task takes from the task it sits under when it does not carry its
   own: the due date, the impact, and the two bare tags. Bucket and project come
   with them, from where the task is filed, and are the caller's to add. State (the
   tick, `doing`), the assignee, `seen`, `feedback` and `resolution` are never
   taken — a task handed to an agent does not hand its sub-tasks over too — and
   nor is anything else a step reads by its own name (effort, start, slug,
   blocked-by, rank, id), because those describe the step. core/todo.py's
   inherited_fields() is the same list in the same order. */
const INHERITED = ['due', 'impact', 'urgent', 'week'];
function inheritedFields(parent, step){
  const out = {}, took = [];
  INHERITED.forEach(key => {
    if (step[key]) out[key] = step[key];
    else { out[key] = parent[key]; if (parent[key]) took.push(key); }
  });
  out.inherited = took;
  return out;
}
function leadIndent(l){ return l.length - l.replace(/^\s+/, '').length; }

/* The marker for a message written to be sent as it is. "(draft)" says the owner has
   to edit it first — anything about reviews, performance or salary. It used
   to be free prose mid-sentence, which nothing could read reliably. */
const MSG_NOTE    = /^\s*-\s+Suggested message(\s*\(draft\))?\s*:/i;

/* The text of a note, without its label. Quotes win when there are two of them,
   so a colon inside the message does not split it in the wrong place; without
   them everything after the first colon is the message, which is the shape that
   survives being pasted out of an older file. Curly quotes count — they are what
   arrives from anything with autocorrect in it. */
function quoted(line){
  const q = [];
  for (let i = 0; i < line.length; i++) if (/["“”]/.test(line[i])) q.push(i);
  if (q.length >= 2) return line.slice(q[0] + 1, q[q.length - 1]).trim();
  return line.slice(line.indexOf(':') + 1).trim();
}

/* ---- Recurring tasks ----
   Work that comes round on a cycle: the standing 1:1s, the monthly status update.
   Until now every one of them was retyped by hand, which is how the same task
   ends up on the list three times in slightly different words.

   One tag, `repeat:`, and one card. Not a template that spawns copies: a card
   per occurrence would put a ticked "prepare for the 1:1" in Done every week
   for as long as the meeting exists, and the only question ever asked of last
   week's is what was on it — which is one note, not a whole card.

     `repeat:wed`       every Wednesday
     `repeat:wed-9:15`  every Wednesday at 9:15
     `repeat:15`        the 15th of every month
     `repeat:wd5`       the fifth working day of every month
     `repeat:tue2`      the 2nd Tuesday of every month
     `repeat:tue2-15:00`  the 2nd Tuesday of every month, at 15:00
     `repeat:~thu-14:00`  roughly weekly on Thursday, but the day moves
     `repeat:wed/2`     every other Wednesday
     `repeat:15/3`      the 15th, quarterly
     `repeat:tue2/3`    the 2nd Tuesday, quarterly

   The `/n` suffix multiplies whatever comes before it: `/2` on a weekly form is
   fortnightly, `/3` on any monthly one is quarterly, and it reads the same way
   on all four bases. It is a suffix rather than four new forms because a
   quarterly meeting is not a different kind of cycle from a monthly one, it is
   the same cycle counted differently — and `[due:: ]` was already carrying the
   phase that makes "every other" mean anything.

   The nth-weekday form is for a meeting that is monthly but pinned to a
   weekday rather than a day of the month — the guild sync is
   the case: the second Tuesday, not the 13th. `wd5` already covers "the
   nth working day"; this covers "the nth Tuesday" the same way, sharing the
   nth-Monday-to-Friday-or-clamp logic with it.

   The `~` says the cadence is the usual shape rather than a rule. The design
   system drop-in is the case: it is weekly, but which day it lands on gets
   rebooked around everything else, so it ran Fri, Thu, Fri, Thu across four
   sessions. Without `~` the checker would flag every one of those as a date
   disagreeing with its tag, which is right for a fixed slot and pure noise for
   this one. The board still rolls to the tagged day, since that is the best
   default available — the date is the owner's to correct when the session moves.

   The working-day form exists because a real obligation needed it: the monthly
   status update is due by the fifth working day, which is a different date every
   month and is not expressible as a day of the month at all. Working means
   Monday to Friday here, and nothing about bank holidays — the checker already
   flags any date landing on one, and teaching two files the same holiday list
   would be two lists to keep in step.

   `[due:: ]` is the occurrence the card is currently pointing at, and the board
   moves it on once that date has passed. So the tag says how often, the date
   says which one, and neither is derivable from the other. */
const REPEAT_VAL = /^(~?)(?:([a-z]{3})([1-5])?(?:[-\s]+(\d{1,2}:\d{2}))?|wd(\d{1,2})|(\d{1,2}))(?:\/(\d{1,2}))?$/i;
const REPEAT_DAYS = ['sun','mon','tue','wed','thu','fri','sat'];
const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
/* Two years either way. Past that a "cycle" is an anniversary, and a date typed
   once is clearer than a rule nobody will remember the phase of. */
const MAX_EVERY = 24;

/* How often the base cycle actually comes round: `/2` on a weekly form is
   fortnightly, `/3` on a monthly one is quarterly. One suffix rather than a form
   per cadence, because it multiplies every base the grammar already has — a
   quarterly report on the 15th is `15/3`, a quarterly one on the second Tuesday
   is `tue2/3`, and neither needed a new idea.

   The phase lives in `[due:: ]`, not in the tag. "Every other Wednesday" is not
   a fact about Wednesdays, it is a fact about which Wednesday you are on, and
   the card already carries that — so the interval counts from the current
   occurrence and `occurrenceAfter` is the only place it applies. A task tagged
   `/n` with no date yet gets the next plain occurrence of its base cycle, and
   the interval starts from there. */
function everyLabel(n, unit){
  if (n === 1) return '';
  if (unit === 'week') return n === 2 ? 'fortnightly' : 'every ' + n + ' weeks';
  return n === 3 ? 'quarterly' : (n === 6 ? 'twice a year' : 'every ' + n + ' months');
}

function readRepeat(val){
  const m = REPEAT_VAL.exec(String(val || '').trim());
  if (!m) return null;
  const loose = m[1] === '~';
  const every = m[7] ? +m[7] : 1;
  if (every < 1 || every > MAX_EVERY) return null;
  const cyc = u => everyLabel(every, u);
  if (m[5]) {
    const nth = +m[5];
    if (nth < 1 || nth > 23) return null;          // 23 working days is a long month
    return { kind:'workday', nth, time:'', loose, every,
             label:(cyc('month') || 'monthly') + ', ' + ordinal(nth) + ' working day' };
  }
  if (m[6]) {
    const dom = +m[6];
    if (dom < 1 || dom > 31) return null;
    return { kind:'monthly', dom, time:'', loose, every,
             label:(cyc('month') || 'monthly') + ', ' + ordinal(dom) };
  }
  const dow = REPEAT_DAYS.indexOf(m[2].toLowerCase());
  if (dow < 0) return null;
  const time = m[4] || '';
  if (m[3]) {
    const nth = +m[3];
    return { kind:'monthly-dow', dow, nth, time, loose, every,
             label:(cyc('month') || 'monthly') + ', ' + ordinal(nth) + ' ' + DAY_NAMES[dow] +
                   (time ? ' ' + time : '') };
  }
  return { kind:'weekly', dow, time, loose, every,
           label:(every === 1
                   ? (loose ? 'weekly, usually ' : 'every ')
                   : cyc('week') + ', ' + (loose ? 'usually ' : '')) + DAY_NAMES[dow] +
                 (time ? ' ' + time : '') };
}
/* The nth day in a month matching `test`, or the last match when the month is
   too short to have an nth. Same call the monthly form makes: a date
   somebody meant to hit is better clamped than skipped. Shared by the
   working-day form (nth Monday-to-Friday day) and the nth-weekday form (nth
   Tuesday, say) — same walk, different test. */
function nthDayMatching(y, mo, nth, test){
  const last = new Date(y, mo + 1, 0).getDate();
  let seen = 0, fallback = 1;
  for (let day = 1; day <= last; day++) {
    if (!test(new Date(y, mo, day).getDay())) continue;
    fallback = day;
    if (++seen === nth) return new Date(y, mo, day);
  }
  return new Date(y, mo, fallback);
}
function nthWorkday(y, mo, nth){
  return nthDayMatching(y, mo, nth, wd => wd !== 0 && wd !== 6);
}
function nthWeekday(y, mo, dow, nth){
  return nthDayMatching(y, mo, nth, wd => wd === dow);
}
function ordinal(n){
  const s = ['th','st','nd','rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/* The first occurrence on or after `from`. On the morning of the meeting that is
   still today, which is right: the agenda is wanted before it starts, so the day
   of it is not yet the next one.

   A monthly day that a short month does not have lands on that month's last day
   rather than skipping the month. The 31st in February is a date the owner still means
   to hit, and skipping is the one answer that is certainly wrong. */
function occurrenceFrom(rep, from){
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  if (rep.kind === 'weekly') {
    d.setDate(d.getDate() + ((rep.dow - d.getDay() + 7) % 7));
    return d;
  }
  let y = d.getFullYear(), mo = d.getMonth();
  if (rep.kind === 'workday') {
    /* Compared against the real date rather than a day number, since the nth
       working day of this month can be later than the nth of the next one. */
    let hit = nthWorkday(y, mo, rep.nth);
    if (hit < d) hit = nthWorkday(mo === 11 ? y + 1 : y, (mo + 1) % 12, rep.nth);
    return hit;
  }
  if (rep.kind === 'monthly-dow') {
    let hit = nthWeekday(y, mo, rep.dow, rep.nth);
    if (hit < d) hit = nthWeekday(mo === 11 ? y + 1 : y, (mo + 1) % 12, rep.dow, rep.nth);
    return hit;
  }
  if (d.getDate() > Math.min(rep.dom, new Date(y, mo + 1, 0).getDate())) mo++;
  const last = new Date(y, mo + 1, 0).getDate();
  return new Date(y, mo, Math.min(rep.dom, last));
}
/* The occurrence strictly after this one, which is what rolling forward needs.

   This is where an interval applies, and the only place it does. `occurrenceFrom`
   answers "the next Wednesday", which needs no phase; this answers "the next one
   of mine", which is entirely phase, counted from the occurrence handed in. The
   roll always hands in the card's current date, so the phase is whatever the owner last
   set — move the date by hand and the whole series moves with it, which is the
   behaviour a rebooked fortnightly meeting wants. */
function occurrenceAfter(rep, date){
  const n = rep.every || 1;
  if (n === 1) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
    return occurrenceFrom(rep, d);
  }
  if (rep.kind === 'weekly') {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 7 * n);
    // Zero unless the date was moved onto some other weekday by hand, in which
    // case this snaps back onto the tagged day rather than drifting on it.
    d.setDate(d.getDate() + ((rep.dow - d.getDay() + 7) % 7));
    return d;
  }
  // Month overflow is Date's own — month 12 is next January — so n months on is
  // an addition and nothing else.
  const y = date.getFullYear(), mo = date.getMonth() + n;
  if (rep.kind === 'workday') return nthWorkday(y, mo, rep.nth);
  if (rep.kind === 'monthly-dow') return nthWeekday(y, mo, rep.dow, rep.nth);
  return new Date(y, mo, Math.min(rep.dom, new Date(y, mo + 1, 0).getDate()));
}


/* =========================================================================
   Tier one: impact against effort

   The nightly picker needs the same answer to order its queue. Two copies of
   "high is 3" is exactly the drift this file exists to stop, so it lives here
   with everything else the board and its Python readers both need. index.html loads this file as a
   classic script before its own, so the names below are already global by the
   time it uses them.
   ========================================================================= */

const IMPACT_N = { high:3, med:2, low:1 };
const EFFORT_N = { S:1, M:2, L:3 };
/* A task missing either score cannot be placed at all, so the board says so out
   loud rather than quietly sorting it as though it scored zero. */
function unscored(t){ return !IMPACT_N[t.impact] || !EFFORT_N[t.effort]; }
/* Higher comes first. Deliberately impact ÷ effort rather than impact − effort:
   a high/S beats a high/L, and a med/S beats a high/L too, which is the whole
   point of favouring lighter lifts. */
function priorityScore(t){
  if (unscored(t)) return -1;               // sinks below everything that is scored
  return IMPACT_N[t.impact] / EFFORT_N[t.effort];
}


/* =========================================================================
   Merging two saves

   Two people on one list, or one person in two tabs, each working from the
   version they last read. Until this, the second save to arrive was refused
   and its owner was asked which whole document should win, which on a shared
   list is a question asked every few minutes about edits that never touched
   each other. So a save built on an old version is merged instead: the
   version it started from (base), the save itself (mine) and the file as it
   is now (theirs), compared task by task and field by field.

   A field one side changed and the other did not takes the change. Both sides
   changing it to different values is the only conflict, and the only thing
   that ever reaches the owner as a question, named by task and field. A task
   deleted on one side and edited on the other is a conflict too, because
   either answer throws away somebody's work. Sub-tasks merge the same way,
   inside their task.

   Order is the current file's, with whatever the save added slotted in after
   the task it followed when it was added. A reorder made only on the save's
   side is the one thing a merge gives up, and it is a drag, not a task.

   Tasks are matched by `id:` first and by title only where one side has no id
   yet, which is the case of a task written by hand or by pa and given an id by
   whichever tab loaded it first. Two tabs minting two different ids for the
   same task take the file's.

   core/todo.py's merge_saves() is the same function, line for line, and
   core/fixtures/merge.json holds the cases both are held to. */

const MERGE_FIELDS = ['title', 'bold', 'done', 'impact', 'effort', 'due', 'time', 'start', 'doneOn', 'to',
  'theme', 'urgent', 'week', 'doing', 'slug', 'blockedBy', 'rank', 'tlrank', 'headline', 'chat',
  'repeat', 'stableId', 'cancelled', 'archived', 'createdBy', 'editedBy', 'extra'];

function mgSame(a, b){ return JSON.stringify(a) === JSON.stringify(b); }
/* Who wrote and last changed a task are the server's to say (stamp_authors()
   in core/todo.py), restamped on every save against the file. So a merge
   takes them from the file and never counts them as an edit. */
const MERGE_AUTHORS = ['createdBy', 'editedBy'];
function mgPlain(f){
  const out = Object.assign({}, f);
  MERGE_AUTHORS.forEach(k => { delete out[k]; });
  return out;
}
function mgKey(title){ return String(title || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

/* A task or sub-task line as fields: its tick and every tag readTags() reads. */
function mgFields(line){
  const m = TASK_RE.exec(line.replace(/^\s+/, ''));
  const r = readTags(m[2]);
  const out = {};
  MERGE_FIELDS.forEach(f => { out[f] = f === 'done' ? m[1].toLowerCase() === 'x' : r[f]; });
  if (out.rank != null && isNaN(out.rank)) out.rank = null;
  if (out.tlrank != null && isNaN(out.tlrank)) out.tlrank = null;
  return out;
}
/* The line those fields make, written the way the board writes an edited task. */
function mgLine(f, indent){
  return indent + serializeTask(Object.assign({}, f, { dirty:true, body:[] }))[0];
}

/* A body split the way splitBody() reads it, keeping every line: the task's
   own notes before its first step (head) and after it (tail), and each step
   with the lines under it. A note after the first step always starts at the
   step indent or shallower, which is what made it the task's, so writing all
   of them after the last step keeps them the task's. */
function mgBody(body){
  const head = [], tail = [], steps = [];
  let base = null, into = false;
  body.forEach((line, at) => {
    const m = SUB_RE.exec(line);
    if (m && (base === null || m[1].length <= base)) {
      base = m[1].length;
      const f = mgFields(line);
      steps.push({ fields:f, head:line, at, indent:m[1], more:[], id:f.stableId, key:mgKey(f.title) });
      into = true;
      return;
    }
    if (line.trim() && base !== null && leadIndent(line) <= base) into = false;
    if (into) steps[steps.length - 1].more.push(line);
    else (steps.length ? tail : head).push(line);
  });
  steps.forEach(s => { s.notes = s.more.filter(l => l.trim()); });
  return { head, tail, steps, notes: head.concat(tail).filter(l => l.trim()) };
}

function mgSide(text){
  const doc = parseDoc(text);
  const buckets = doc.buckets.map(b => ({
    name: b.name, num: b.num, header: b.raw != null ? b.raw : '## ' + b.num + '. ' + b.name,
    intro: b.intro, tail: b.tail,
    tiers: b.tiers.map(tier => ({
      name: tier.name, header: tier.raw != null ? tier.raw : '### ' + tier.name,
      lead: tier.lead != null ? tier.lead : [''], tail: tier.tail || [],
      tasks: tier.tasks.map(t => {
        const f = mgFields(t.raw);
        return { fields:f, head:t.raw, body:t.body, sep:t.sep, parts:mgBody(t.body),
                 id:f.stableId, key:mgKey(f.title), tier:tier.name };
      })
    }))
  }));
  buckets.forEach(b => b.tiers.forEach(tier => tier.tasks.forEach(r => { r.bucket = b; })));
  return { pre: doc.pre, post: doc.post, buckets };
}

/* Which record of `base` each record of `side` is, or -1. By id, then by title
   where one of the pair has no id. */
function mgMatchTasks(base, side){
  const out = side.map(() => -1), used = new Set(), byId = new Map();
  base.forEach((r, i) => { if (r.id && !byId.has(r.id)) byId.set(r.id, i); });
  side.forEach((r, j) => {
    const i = r.id && byId.has(r.id) ? byId.get(r.id) : -1;
    if (i >= 0 && !used.has(i)) { out[j] = i; used.add(i); }
  });
  side.forEach((r, j) => {
    if (out[j] >= 0) return;
    const i = base.findIndex((b, k) => !used.has(k) && b.key === r.key && (!b.id || !r.id));
    if (i >= 0) { out[j] = i; used.add(i); }
  });
  return out;
}
/* Buckets by name, then a renamed one by its number. Columns by name. */
function mgMatchBuckets(base, side){
  const out = side.map(() => -1), used = new Set();
  ['name', 'num'].forEach(by => side.forEach((r, j) => {
    if (out[j] >= 0) return;
    const i = base.findIndex((b, k) => !used.has(k) && b[by] === r[by]);
    if (i >= 0) { out[j] = i; used.add(i); }
  }));
  return out;
}
function mgMatchTiers(base, side){
  const out = side.map(() => -1), used = new Set();
  side.forEach((r, j) => {
    const i = base.findIndex((b, k) => !used.has(k) && b.name === r.name);
    if (i >= 0) { out[j] = i; used.add(i); }
  });
  return out;
}

/* Every thing the three versions hold, as { b, m, t } with the absent ones
   null and a `gid` that orders them. Something added on both sides is paired
   when `pair` says the two are one. Each record is told its group (r.g). */
function mgGroups(B, M, T, match, pair){
  const groups = B.map(b => ({ b, m:null, t:null }));
  const mi = match(B, M), ti = match(B, T), added = [];
  M.forEach((r, j) => {
    if (mi[j] >= 0) groups[mi[j]].m = r;
    else { const g = { b:null, m:r, t:null }; groups.push(g); added.push(g); }
  });
  T.forEach((r, j) => {
    if (ti[j] >= 0) { groups[ti[j]].t = r; return; }
    const g = added.find(a => !a.t && pair(a.m, r));
    if (g) g.t = r; else groups.push({ b:null, m:null, t:r });
  });
  groups.forEach((g, i) => {
    g.gid = i;
    [g.b, g.m, g.t].forEach(r => { if (r) r.g = g; });
  });
  return groups;
}

/* One value from three. Whichever side moved it wins; both moving it apart is
   `clash`, which records the conflict and answers for it. */
function mgPick(b, m, t, clash){
  if (mgSame(m, t)) return m;
  if (mgSame(m, b)) return t;
  if (mgSame(t, b)) return m;
  return clash(m, t);
}

/* Whether a group survives, and from which side. Present on both: 'both'.
   Added on one: that side. Deleted on one side: gone if the other left it
   alone, a conflict if the other changed it. */
function mgKeep(g, sig, clash){
  if (g.m && g.t) return 'both';
  if (!g.m && !g.t) return null;
  const kept = g.m ? 'mine' : 'theirs';
  if (!g.b) return kept;
  if (mgSame(sig(g.m || g.t), sig(g.b))) return null;
  return clash('deleted', g.m ? 'mine' : null, g.t ? 'theirs' : null) || null;
}

/* Lines in `primary`'s order, with what only `secondary` has slotted after
   whatever came before it there. `keep` is everything wanted, and anything
   neither order places goes last rather than nowhere. */
function mgOrder(primary, secondary, keep){
  const want = new Set(keep);
  const out = primary.filter(k => want.has(k));
  const placed = new Set(out);
  let prev = null;
  secondary.forEach(k => {
    if (!want.has(k)) return;
    if (!placed.has(k)) { out.splice(prev === null ? 0 : out.indexOf(prev) + 1, 0, k); placed.add(k); }
    prev = k;
  });
  keep.forEach(k => { if (!placed.has(k)) { out.push(k); placed.add(k); } });
  return out;
}

function mgMergeFields(g, clash){
  const out = {};
  MERGE_FIELDS.forEach(f => {
    const b = g.b ? g.b.fields[f] : undefined, m = g.m.fields[f], t = g.t.fields[f];
    /* Both tabs gave a task with no id one of their own: the file's stands. */
    if (f === 'stableId' && !b && m && t) { out[f] = t; return; }
    if (MERGE_AUTHORS.indexOf(f) >= 0) { out[f] = t; return; }
    out[f] = mgPick(b, m, t, (mv, tv) => clash(f, mv, tv));
  });
  return out;
}
/* Takes a side's line as it was written when the merged fields are that side's. */
function mgHead(f, g, indent){
  if (g.t && mgSame(f, g.t.fields)) return g.t.head;
  if (g.m && mgSame(f, g.m.fields)) return g.m.head;
  return mgLine(f, indent);
}

const mgStepSig = s => ({ fields:mgPlain(s.fields), notes:s.notes });
const mgTaskSig = r => ({ fields:mgPlain(r.fields), where:r.where, notes:r.parts.notes,
                          steps:r.parts.steps.map(mgStepSig) });

/* A task's steps, merged. Each comes back as { fields, notes, lines }. */
function mgMergeSteps(g, clash){
  const groups = mgGroups(g.b ? g.b.parts.steps : [], g.m.parts.steps, g.t.parts.steps,
                          mgMatchTasks, (a, b) => !!a.id && a.id === b.id);
  const merged = new Map();
  groups.forEach(sg => {
    const title = (sg.m || sg.t || sg.b).fields.title;
    const keep = mgKeep(sg, mgStepSig, (field, mv, tv) => clash(title, field, mv, tv));
    if (!keep) return;
    if (keep !== 'both') {
      const r = keep === 'mine' ? sg.m : sg.t;
      merged.set(sg.gid, { fields:r.fields, notes:r.notes, lines:[r.head].concat(r.more) });
      return;
    }
    const fields = mgMergeFields(sg, (f, mv, tv) => clash(title, f, mv, tv));
    const notes = mgPick(sg.b ? sg.b.notes : undefined, sg.m.notes, sg.t.notes,
                         (mv, tv) => clash(title, 'notes', mv, tv));
    const from = mgSame(notes, sg.t.notes) ? sg.t : sg.m;
    merged.set(sg.gid, { fields, notes, lines:[mgHead(fields, sg, sg.t.indent)].concat(from.more) });
  });
  const order = mgOrder(g.t.parts.steps.map(s => s.g.gid), g.m.parts.steps.map(s => s.g.gid),
                        Array.from(merged.keys()));
  return order.map(k => merged.get(k));
}

/* Three versions of the list into one. opts.prefer ('mine' or 'theirs')
   answers every conflict; without it a merge with conflicts has no text, and
   `conflicts` says what has to be decided: [{ task, step, field }], step ''
   for the task itself, task '' for the file's top or bottom. */
function mergeSaves(baseText, mineText, theirsText, opts){
  const prefer = (opts && opts.prefer) || '';
  if (mineText === theirsText || theirsText === baseText) return { text:mineText, conflicts:[] };
  if (mineText === baseText) return { text:theirsText, conflicts:[] };
  const B = mgSide(baseText), M = mgSide(mineText), T = mgSide(theirsText);
  const conflicts = [];
  const answer = (mv, tv) => prefer === 'theirs' ? tv : mv;
  const clash = (task, step, field) => (mv, tv) => {
    conflicts.push({ task, step, field });
    return answer(mv, tv);
  };

  const pre = mgPick(B.pre, M.pre, T.pre, clash('', '', 'top of the file'));
  const post = mgPick(B.post, M.post, T.post, clash('', '', 'bottom of the file'));

  /* Buckets first, so a task's place can be said as bucket and column. */
  const bgroups = mgGroups(B.buckets, M.buckets, T.buckets, mgMatchBuckets, (a, b) => a.name === b.name);
  const tasksOf = side => [].concat.apply([], side.buckets.map(b => [].concat.apply([], b.tiers.map(t => t.tasks))));
  [B, M, T].forEach(side => tasksOf(side).forEach(r => { r.where = r.bucket.g.gid + '\n' + r.tier; }));

  /* Then every task. */
  const tgroups = mgGroups(tasksOf(B), tasksOf(M), tasksOf(T), mgMatchTasks, (a, b) => !!a.id && a.id === b.id);
  const placed = new Map();
  tgroups.forEach(g => {
    const title = (g.m || g.t || g.b).fields.title;
    const onTask = (field, mv, tv) => clash(title, '', field)(mv, tv);
    const keep = mgKeep(g, mgTaskSig, onTask);
    if (!keep) return;
    if (keep !== 'both') {
      const r = keep === 'mine' ? g.m : g.t;
      placed.set(g.gid, { where:r.where, head:r.head, body:r.body, sep:r.sep });
      return;
    }
    const fields = mgMergeFields(g, onTask);
    const where = mgPick(g.b ? g.b.where : undefined, g.m.where, g.t.where, (mv, tv) => onTask('column', mv, tv));
    const notes = mgPick(g.b ? g.b.parts.notes : undefined, g.m.parts.notes, g.t.parts.notes,
                         (mv, tv) => onTask('notes', mv, tv));
    const steps = mgMergeSteps(g, (st, field, mv, tv) => clash(title, st, field)(mv, tv));
    const sig = { notes, steps:steps.map(mgStepSig) };
    let body;
    if (mgSame(sig, { notes:g.t.parts.notes, steps:g.t.parts.steps.map(mgStepSig) })) body = g.t.body;
    else if (mgSame(sig, { notes:g.m.parts.notes, steps:g.m.parts.steps.map(mgStepSig) })) body = g.m.body;
    else {
      const from = mgSame(notes, g.t.parts.notes) ? g.t : g.m;
      body = from.parts.head.concat([].concat.apply([], steps.map(s => s.lines)), from.parts.tail);
    }
    placed.set(g.gid, { where, head:mgHead(fields, g, ''), body, sep:(g.t || g.m).sep });
  });

  /* The skeleton, keeping a bucket or column one side deleted only while a
     task still sits in it. */
  const used = new Set(Array.from(placed.values()).map(p => p.where));
  const holds = (bgid, name) => name == null
    ? Array.from(used).some(w => w.split('\n')[0] === String(bgid))
    : used.has(bgid + '\n' + name);
  const keptBuckets = bgroups.filter(g => (g.m && g.t) || (!g.b && (g.m || g.t)) || ((g.m || g.t) && holds(g.gid)));
  const border = mgOrder(T.buckets.map(b => b.g.gid), M.buckets.map(b => b.g.gid), keptBuckets.map(g => g.gid));
  const buckets = border.map(gid => {
    const g = bgroups[gid];
    const src = g.t || g.m;
    const both = g.m && g.t;
    const header = both ? mgPick(g.b ? g.b.header : undefined, g.m.header, g.t.header,
                                 clash(src.name, '', 'bucket name')) : src.header;
    const intro = both ? mgPick(g.b ? g.b.intro : undefined, g.m.intro, g.t.intro,
                                clash(src.name, '', 'bucket notes')) : src.intro;
    const tgr = mgGroups(g.b ? g.b.tiers : [], g.m ? g.m.tiers : [], g.t ? g.t.tiers : [],
                         mgMatchTiers, (a, b) => a.name === b.name);
    const keptTiers = tgr.filter(x => (x.m && x.t) || (!x.b && (x.m || x.t)) ||
                                      ((x.m || x.t) && holds(gid, (x.m || x.t).name)));
    const torder = mgOrder(g.t ? g.t.tiers.map(x => x.g.gid) : [], g.m ? g.m.tiers.map(x => x.g.gid) : [],
                           keptTiers.map(x => x.gid));
    const tiers = torder.map(tgid => {
      const x = tgr[tgid], tsrc = x.t || x.m;
      const here = gid + '\n' + tsrc.name;
      const keys = tgroups.filter(tg => placed.has(tg.gid) && placed.get(tg.gid).where === here).map(tg => tg.gid);
      const order = mgOrder(x.t ? x.t.tasks.map(r => r.g.gid) : [], x.m ? x.m.tasks.map(r => r.g.gid) : [], keys);
      let lead = tsrc.lead, tail = tsrc.tail;
      if (order.length && !tsrc.tasks.length && !tail.length) tail = [''];
      if (!order.length && tsrc.tasks.length) {
        lead = lead.length ? lead : [''];
        tail = tail.some(l => l.trim() !== '') ? tail : [];
      }
      return { name:tsrc.name, raw:tsrc.header, lead, tail,
               tasks:order.map(k => { const p = placed.get(k); return { raw:p.head, dirty:false, body:p.body, sep:p.sep }; }) };
    });
    return { raw:header, intro, tiers, tail:src.tail };
  });

  const text = serializeDoc({ pre, buckets, post });
  return { text: conflicts.length && !prefer ? null : text, conflicts };
}
