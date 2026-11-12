'use strict';

/* =========================================================================
   5. Drawer
   ========================================================================= */

/* The names Delegate to offers after the two agents, read from the tables in
   people.md (the memory folder's, or data/<dataset>/) by /people.json so nobody keeps a second list. Asked
   for once per page load. Empty until it lands, or for good where there is no
   server (the demo build), and then the dropdown offers the agents alone. */
let peopleNames = [];
fetch('/people.json', { cache: 'no-store' })
  .then(r => r.ok ? r.json() : { people: [] })
  .then(d => { peopleNames = (d && d.people || []).map(p => p.name).filter(Boolean); })
  .catch(() => {});

/* Delegate to, and a sub-task's Assigned to, as Tenon's Dropdown with each
   agent's avatar beside its name, which an <option> cannot hold. The hidden
   <select> underneath stays the field's value: its id is what the change
   handlers and the suites read, and a pick sets it and fires its onchange, so
   everything wired to the select works as it did. The Dropdown is drawn into a
   host by mountPickers() once the panel is in the page. */
/* One host per dropdown: PICK_SPECS says what each draws. `onPick` is the
   field's own callback where it has no hidden <select> to hand the value to. */
const PICK_SPECS = {};
/* The Delegate to value of an agent that cannot take work yet; choosing it
   says what is missing and changes nothing. */
const NOT_SET_UP = '__not-set-up';
function delegateSelectHTML(value, dis, id, bucketAgent){
  id = id || 'f-to';
  const cur = String(value || '').trim();
  const opt = (v, label) => '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(label || v) + '</option>';
  /* A name already on the task that people.md does not list, "Mia" where the
     file says "Mia R.", stays offered as written rather than silently lost. */
  /* Signed in, the board's own people come first, stored by email and shown
     by name with their face (/board-people.json). The Mac board has none, and
     offers people.md's names alone, as it always has. */
  const everyone = state.who ? (state.boardPeople || []) : [];
  const emails = everyone.map(p => p.email);
  /* The PA's own sign-in (@offdesk.invalid) is on the list so its name still
     resolves on cards, but a task is not handed to it here; it stays offered
     only when this task already names it. */
  const board = everyone.filter(p => !/@offdesk\.invalid$/i.test(p.email) || p.email === cur);
  const known = new Set(AGENT_NAMES.concat(bucketAgentData.buckets.map(b => b.name), peopleNames, emails));
  const people = peopleNames.filter(n => emails.indexOf(String(n).toLowerCase()) < 0);
  if (cur && !agentOf(cur) && !known.has(cur)) people.unshift(cur);
  const label = v => isPersonEmail(v) ? assigneeLabel(v) : v;
  /* The one agent a task can be handed to is its bucket's, so that is the one
     offered (`bucketAgent`, from bucketAgentOfTask()). One whose brief is not
     filled in yet is listed all the same, saying it is not set up and what is
     missing, so the owner sees why there is nothing to pick. An agent the task
     already names, a bucket's or one of the two old ones, stays as written. */
  const curAgent = agentOf(cur);
  const agents = [], offered = [];
  if (curAgent) { agents.push(cur); offered.push(curAgent); }
  if (bucketAgent && bucketAgent.name !== curAgent) {
    if (bucketAgent.ready) { agents.push(bucketAgent.name); offered.push(bucketAgent.name); }
    else {
      agents.push(NOT_SET_UP);
      offered.push(bucketAgent.name + ' not set up' + (bucketAgentMissingText(bucketAgent) ? ': ' + bucketAgentMissingText(bucketAgent) : ''));
    }
  }
  PICK_SPECS[id] = {
    value: cur, ro: !!dis, label: 'Delegate to',
    options: [{ value: '', label: 'Nobody' }]
      .concat(agents.map((v, i) => ({ value: v, label: offered[i], group: 'Agents',
                                     iconHtml: v === NOT_SET_UP ? undefined : agentAvatarHTML(v, 18) })))
      .concat(board.map(p => ({ value: p.email, label: personName(p.email), group: 'People',
                                iconHtml: personAvatarHTML(p.email, personFullName(p.email), 18) })))
      .concat(people.map(p => ({ value: p, label: label(p), group: 'People', iconHtml: assigneeAvatarHTML(p, 18) || undefined })))
  };
  return '<div class="delegatefield">' +
    '<select id="' + id + '" class="hidden" tabindex="-1" aria-hidden="true"' + dis + '>' + opt('', 'Nobody') +
      (agents.length ? '<optgroup label="Agents">' + agents.map((v, i) => opt(v, offered[i])).join('') + '</optgroup>' : '') +
      (board.length || people.length ? '<optgroup label="People">' +
        board.map(p => opt(p.email, personName(p.email))).join('') + people.map(p => opt(p, label(p))).join('') +
        '</optgroup>' : '') +
    '</select>' +
    '<div data-pick-host="' + id + '"></div>' +
  '</div>';
}
function mountPickers(root){
  root.querySelectorAll('[data-pick-host]').forEach(host => {
    const id = host.dataset.pickHost, spec = PICK_SPECS[id];
    if (!spec) return;
    BoardUI.mountFlushed(host, BoardUI.h(BoardUI.PickField, {
      id, label: spec.label, options: spec.options, value: spec.value, disabled: spec.ro,
      onPick: spec.onPick || (v => {
        const sel = document.getElementById(id);
        if (!sel) return;
        sel.value = v;
        if (sel.onchange) sel.onchange({ target: sel });
      })
    }));
  });
}

/* The Theme field's dropdown, offered only from the values declared for the
   task's own bucket (state.bucketThemes, see 02-state.js and the Themes
   field in openBucketEditor, 08-buckets.js) — a query can only ever mean one
   of a fixed set, which is the whole point of declaring them rather than
   typing one in per task. A value already on the task that the bucket no
   longer declares — moved there, or dropped from the list since — stays
   offered as written rather than silently lost, the same rule
   delegateSelectHTML above applies to a name people.md has stopped naming. */
function themeSelectHTML(value, themes, dis){
  const cur = String(value || '').trim();
  const opt = (v, label) => '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(label || v) + '</option>';
  const list = themes.slice();
  if (cur && !list.includes(cur)) list.unshift(cur);
  PICK_SPECS['f-theme'] = {
    value: cur, ro: !!dis, label: 'Theme',
    options: [{ value: '', label: 'None' }].concat(list.map(v => ({ value: v, label: v })))
  };
  return '<select id="f-theme" class="hidden" tabindex="-1" aria-hidden="true"' + dis + '>' + opt('', 'None') + list.map(v => opt(v)).join('') + '</select>' +
    '<div data-pick-host="f-theme"></div>';
}

function dedent(lines){ return lines.map(l => l.replace(/^ {1,2}/, '')).join('\n').replace(/\n+$/, ''); }
function indent(text){
  return text.replace(/\s+$/,'').split('\n').map(l => l.trim() === '' ? '' : '  ' + l);
}

/* ---- Clicking rendered Markdown back into its source ----
   The Description shows rendered and edits raw (see the field in openDrawer),
   so a click on the rendering has to land on the same word in the Markdown
   underneath. Two steps: which character of the rendered text was clicked,
   and where that character is in the source.

   The second step is the awkward one, because mdInline drops the marks —
   backticks, asterisks, underscores, a link's URL — so the nth character you
   can see is not the nth character in the source. This builds the whole
   correspondence rather than counting up to the one it wants: one entry per
   character that survives rendering, holding where that character sits in the
   source, and a last entry for the end. Written out in full because the
   counting version got the ends of a marked run wrong in both directions —
   a click on the b of **bold** landed on an asterisk, and so did a click on
   the space after it.

   It knows exactly the marks mdInline knows and no others; anything else
   counts as itself, which is the right answer for plain text. */
function rawOffsetForVisible(src, want){
  const map = [];
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let m, lead = 0, shown = null;
    // A link shows its label and hides its URL. The rest are symmetric marks
    // of one or two characters each side.
    if ((m = /^\[([^\]]+)\]\([^)]+\)/.exec(rest))) { lead = 1; shown = m[1]; }
    else if ((m = /^`([^`]+)`/.exec(rest))) { lead = 1; shown = m[1]; }
    else if ((m = /^\*\*([^*]+)\*\*/.exec(rest))) { lead = 2; shown = m[1]; }
    // _em_ only counts at a word boundary, the same condition mdInline uses.
    else if ((i === 0 || /[\s(]/.test(src[i - 1])) && (m = /^_([^_]+)_/.exec(rest))) { lead = 1; shown = m[1]; }
    if (shown === null) { map.push(i); i++; continue; }
    for (let k = 0; k < shown.length; k++) map.push(i + lead + k);
    i += m[0].length;
  }
  map.push(src.length);
  return map[Math.max(0, Math.min(want, map.length - 1))];
}

/* How far into `root`'s text the point (x, y) falls. Firefox and the rest
   spell the same thing two different ways, and either can miss entirely — a
   click on the padding rather than on a glyph — in which case the end of the
   text is the honest answer. */
function textOffsetAtPoint(root, x, y){
  let node = null, off = 0;
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (p) { node = p.offsetNode; off = p.offset; }
  } else if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (r) { node = r.startContainer; off = r.startOffset; }
  }
  if (!node || node.nodeType !== 3 || !root.contains(node)) return root.textContent.length;
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n = 0, t;
  while ((t = walk.nextNode())) {
    if (t === node) return n + off;
    n += t.nodeValue.length;
  }
  return n;
}

/* Where in `value` a click on the rendered note should put the caret. The
   block carries the lines it came from in data-src; within the block, a
   heading's hashes and a bullet's dash are rendered away like any other mark,
   so they are skipped before the count starts. A paragraph joins its lines
   with a space where the source has a newline — one character either way, so
   the count still lines up across a wrapped paragraph. */
function noteCaret(view, value, e){
  const blk = e.target.closest('[data-src]');
  if (!blk) return value.length;
  const [a, b] = blk.dataset.src.split(',').map(Number);
  const lines = value.split('\n');
  let start = 0;
  for (let i = 0; i < a && i < lines.length; i++) start += lines[i].length + 1;
  const block = lines.slice(a, b + 1).join('\n');
  const pre = /^\s*(?:#{1,4}\s+|[-*]\s+)/.exec(block);
  const prefix = pre ? pre[0].length : 0;
  const vis = textOffsetAtPoint(blk, e.clientX, e.clientY);
  return start + prefix + rawOffsetForVisible(block.slice(prefix), vis);
}

/* ---- Date picker ----
   A month grid rather than <input type="date">, which hides its calendar behind
   a small icon and draws a different control in every browser. It opens in the
   flow under the field instead of floating over it: the panel scrolls, and a
   floating calendar gets cut off at the bottom edge. */
function ymd(d){
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
         '-' + String(d.getDate()).padStart(2, '0');
}
function dueLabel(s){
  const d = parseDue(s);
  if (!d) return 'No date';
  return d.toLocaleDateString(undefined, { weekday:'short', day:'numeric', month:'short', year:'numeric' });
}
/* impact:, effort: and the task's column all pick from a short, known
   set of values, so all three are drawn with the same fixed-stop slider. Each
   caller supplies its own ordered list of {value, label, color} stops —
   color is optional, and only meaningful on the stop actually selected, so a
   trailing stop with no color just keeps whatever the previous one set.

   impact: and effort: keep a blank stop at position 0 rather than folding it
   into the lowest real value, because unscored is a real, load-bearing state
   here — the matrix and the "needs scoring" count both key off it. */
const IMPACT_STOPS = [
  { value: '', label: '—', color: 'var(--tenon-text-faint)' },
  { value: 'low', label: 'Low', color: 'var(--tenon-text-faint)' },
  { value: 'med', label: 'Med', color: 'var(--tenon-text-warning)' },
  { value: 'high', label: 'High', color: 'var(--tenon-text-success)' },
];
const EFFORT_STOPS = [
  { value: '', label: '—', color: 'var(--tenon-text-faint)' },
  { value: 'S', label: 'S', color: 'var(--tenon-text-faint)' },
  { value: 'M', label: 'M', color: 'var(--tenon-text-warning)' },
  { value: 'L', label: 'L', color: 'var(--tenon-text-success)' },
];

/* The slider is Tenon's StepSlider, drawn by React (kanban/ui/DrawerFields.tsx).
   The panel is still a string, so these leave a host element behind and keep
   what to draw in STEP_SPECS; wireStepSlider() mounts it once the string is in
   the page. A stop's `color` is Tenon's `colour`. */
const STEP_SPECS = {};
/* Where each slider's handle was when it was last picked, and for which task.
   A pick that rebuilds the panel (a column, a sub-task's state) destroys the
   slider it came from, and the new one would draw at its final stop with
   nothing to animate. The next build for the same task starts the handle
   where it was instead, and it slides, the way Impact and Effort always did. */
const STEP_FROM = {};
function stepSpec(id, stops, value, ro, label, select){
  const f = STEP_FROM[id];
  delete STEP_FROM[id];
  STEP_SPECS[id] = { stops, value, ro, label, select, from: f && f.task === state.openTask ? f.value : undefined };
}
function stepSliderHTML(id, stops, value, ro, ariaLabel){
  stepSpec(id, stops, value, ro, ariaLabel, false);
  return '<div class="stepfield" id="' + id + '"></div>';
}
/* The Column field is a pick from a list rather than a scale, so on a phone it
   is a native <select> instead: six labels across 340px touch each other, and
   the OS list is one tap. Impact and Effort keep their sliders at every width. */
function stepPickerHTML(id, stops, value, ro, ariaLabel){
  stepSpec(id, stops, value, ro, ariaLabel, true);
  return '<div class="stepfield" id="' + id + '"></div>';
}
/* onCommit(value) is the only thing that varies by field. */
function wireStepSlider(id, stops, onCommit){
  const host = $('#' + id), spec = STEP_SPECS[id];
  if (!host || !spec) return;
  BoardUI.mountFlushed(host, BoardUI.h(BoardUI.StepField, {
    steps: stops.map(s => ({ value: s.value, label: s.label, colour: s.color })),
    value: spec.value, label: spec.label, disabled: spec.ro, select: spec.select, from: spec.from,
    onCommit: v => { STEP_FROM[id] = { task: state.openTask, value: spec.value }; spec.value = v; onCommit(v); }
  }));
}
const wireStepPicker = wireStepSlider;
/* Draws every slider in a freshly built panel, read-only ones included: a
   backup preview wires nothing, so a slider left to wireStepSlider() would
   never appear there. The wiring that follows redraws the same host with the
   real onCommit. */
function mountStepFields(root){
  root.querySelectorAll('.stepfield').forEach(el => {
    const spec = STEP_SPECS[el.id];
    if (spec) wireStepSlider(el.id, spec.stops, () => {});
  });
}
/* Can start and Due, drawn by Tenon's DateButton and Calendar (DateFields in
   kanban/ui/DrawerFields.tsx). `item` is whatever holds the two dates, read
   when the calendar is picked from; `after` runs once one is chosen. `time`,
   when given, adds the Due time input: { value, disabled, onChange }. */
function mountDateFields(hostId, prefix, ro, fields, onPick, time){
  BoardUI.mountFlushed($('#' + hostId), BoardUI.h(BoardUI.DateFields, {
    idPrefix: prefix, fields, disabled: ro, today: ymd(today()), onPick, time
  }));
}
function dateFieldModels(start, due, inheritedDue, inheritedStart){
  /* A sub-task with no start of its own can start when its task can, the way
     the timeline draws it. The value stays empty so picking one gives it its own. */
  const from = !start && parseDue(inheritedStart) ? inheritedStart : '';
  return [
    { key: 'start', label: 'Can start', value: start, text: start ? dueLabel(start) : (from ? 'From the task\'s start, ' + dueLabel(from) : 'Any time'),
      empty: !parseDue(start) && !from, inherited: !!from, hint: from ? 'Pick one here to give this its own.' : undefined },
    { key: 'due', label: 'Due', value: due, text: dueLabel(due), empty: !parseDue(due), inherited: !!inheritedDue }
  ];
}

/* ---- Dependencies, both directions, in the panel ----
   Backward is a plain read of `blocked-by:` — this line waits on that slug.
   Forward has no tag of its own: it is every other item in the file whose
   `blocked-by:` names this one, the same scan `unblockCount` already does
   for the headline bar, just kept as a list instead of collapsed to a
   number. A task or sub-step with neither a slug nor a `blocked-by:` has
   nothing to say either way, so it is left out rather than shown empty. */
function taskDependencies(t, editable){
  const items = allItems();
  const parts = splitBody(t);
  const out = [];
  const notes = waitingNotes(t);
  /* `line` says which line an edit in this group is written to: -1 for the task
     itself, otherwise the body index of the sub-step. The task's own group is
     kept even when empty once the panel can edit, since that is where Add sits. */
  const addFor = (slug, blockedBy, where, line, keep) => {
    const waitingOn = (blockedBy || []).map(s => ({ slug: s, item: itemBySlug(items, s) }));
    const blocks = slug ? items.filter(i => !i.done && i.blockedBy.indexOf(slug) > -1) : [];
    const people = notes.filter(n => n.where === where);
    if (keep || waitingOn.length || blocks.length || people.length)
      out.push({ where, line, slug, waitingOn, blocks, people, editable: !!editable });
  };
  addFor(t.slug, t.blockedBy, '', -1, editable);
  parts.steps.forEach(s => addFor(s.slug, s.blockedBy, s.clean, s.line, false));
  return out;
}
/* Stripped down from the full ref card: no bucket, no tier, no impact/effort/ai
   chips — just the name and whichever dates actually bear on when it's due,
   the two facts that matter while reading a chain of blockers rather than one
   task on its own. Same chaincard shape the Matrix dependency view already
   uses, so a mini task-card reads the same wherever it turns up. */
function depLink(item, missingSlug, remove){
  /* The × sits beside the card rather than inside it, since the card is itself
     a button that opens the task. */
  const x = remove
    ? '<button type="button" class="attachpick-close depremove" aria-label="Remove this dependency"' +
        ' title="Remove this dependency" data-depremove="' + esc(remove.dir) + '"' +
        ' data-dep-line="' + remove.line + '" data-dep-slug="' + esc(remove.slug) + '"' +
        (remove.task ? ' data-dep-task="' + esc(remove.task) + '"' : '') +
        (remove.otherLine != null ? ' data-dep-other-line="' + remove.otherLine + '"' : '') +
      '>×</button>'
    : '';
  if (!item) return '<li class="depitem"><div class="chaincard dep missing" title="No task carries this slug">' +
    '<span class="chaintitle">#' + esc(missingSlug) + ' missing</span></div>' + x + '</li>';
  const due = dueInfo(item.due, item.tier === WAIT_COL);
  const si = startInfo(item.start);
  const dates = (due || si) ? '<div class="depdates">' +
      (due ? '<span class="tag due ' + due.cls + '">' + esc(due.label) + (due.note ? ' · ' + esc(due.note) : '') + '</span>' : '') +
      (si  ? '<span class="tag startdate">' + esc(si.label) + '</span>' : '') +
    '</div>' : '';
  return '<li class="depitem">' +
    '<button type="button" class="chaincard dep deplink' + (item.done ? ' done' : '') + '"' +
      ' style="--bc:' + item.color + '" data-open="' + item.id + '" title="Open this task">' +
      '<span class="chaintitle">' + (item.done ? '✓ ' : '') + mdInline(item.title) + '</span>' +
      dates +
    '</button>' + x + '</li>';
}
function depGroupHTML(g){
  /* The two kinds sit under one heading, cards first: waiting on a task and
     waiting on a person are the same question, and splitting them into two
     labels would make a task waiting on both look like it had two problems. */
  const people = (g.people || []).map(p =>
    '<li class="depitem"><div class="chaincard dep depnote">' +
      '<span class="chaintitle">' + mdInline(p.text) + '</span>' +
    '</div></li>').join('');
  const ed = g.editable;
  const add = dir => ed
    ? '<button type="button" class="btn outline small depadd" data-depadd="' + dir + '"' +
        ' data-dep-line="' + g.line + '">Add</button>'
    : '';
  const waiting = (ed || g.waitingOn.length || people)
    ? '<div class="depcol"><span class="deplabel">Waiting on</span><ul class="deplist">' +
      g.waitingOn.map(w => depLink(w.item, w.slug,
        ed && { dir: 'waiting', line: g.line, slug: w.slug })).join('') + people + '</ul>' + add('waiting') + '</div>'
    : '';
  const blocks = (ed || g.blocks.length)
    ? '<div class="depcol"><span class="deplabel">Blocks</span><ul class="deplist">' +
      g.blocks.map(i => depLink(i, '',
        ed && { dir: 'blocks', line: g.line, slug: g.slug, task: i.id, otherLine: i.sub ? i.sub.line : -1 })).join('') +
      '</ul>' + add('blocks') + '</div>'
    : '';
  return '<div class="depgroup">' +
    (g.where ? '<em class="suggwhere">for: ' + esc(g.where) + '</em>' : '') +
    '<div class="depcols">' + waiting + blocks + '</div>' +
  '</div>';
}

/* ---- Setting and clearing a dependency from the panel ----
   Both directions are one tag, `blocked-by:`, written on whichever line waits.
   Waiting on writes it here; Blocks writes it onto the other task, naming this
   one. `line` is -1 for a task, or the body index of a sub-step under it. */
function depRead(task, line){
  if (line < 0) return { slug: task.slug || '', blockedBy: (task.blockedBy || []).slice(), title: task.title };
  const s = readSub(task, line);
  return s ? { slug: s.slug || '', blockedBy: (s.blockedBy || []).slice(), title: s.title } : null;
}
function depWrite(task, line, patch){
  if (line < 0) { Object.assign(task, patch); task.dirty = true; return; }
  const cur = readSub(task, line);
  if (cur) writeSub(task, line, Object.assign(cur, patch));
}
/* A slug for a task that never needed one, by the rule in CONVENTIONS.md: short,
   readable, lowercase and hyphens. The first few words of the title that carry
   meaning, with a number on the end only if the file already has that one. */
const SLUG_STOPWORDS = new Set(['the','a','an','and','or','of','to','for','in','on','with','from','by','at','is','it','my']);
function mintSlug(title, taken){
  const words = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const kept = words.filter(w => !SLUG_STOPWORDS.has(w));
  const base = (kept.length ? kept : words).slice(0, 4).join('-').slice(0, 32).replace(/-+$/, '') || 'task';
  let slug = base, n = 2;
  while (taken.has(slug)) slug = base + '-' + n++;
  return slug;
}
function ensureSlug(task, line){
  const cur = depRead(task, line);
  if (cur.slug) return cur.slug;
  const slug = mintSlug(cur.title, new Set(allItems().map(i => i.slug).filter(Boolean)));
  depWrite(task, line, { slug });
  return slug;
}
/* `dir` is from this line's side: 'waiting' makes this wait on `other`,
   'blocks' makes `other` wait on this. Returns '' when written, or why not. */
function addDependency(t, line, dir, other){
  if (state.locked) return 'locked';
  if (other.task === t && other.line === line) return 'self';
  const waiter  = dir === 'waiting' ? { task: t, line } : other;
  const blocker = dir === 'waiting' ? other : { task: t, line };
  const w = depRead(waiter.task, waiter.line), b = depRead(blocker.task, blocker.line);
  if (!w || !b) return 'missing';
  if (w.slug && b.blockedBy.indexOf(w.slug) > -1) {
    showToast('“' + b.title + '” already waits on “' + w.title + '”, so that would be a loop.', 'bad');
    return 'cycle';
  }
  if (b.slug && w.blockedBy.indexOf(b.slug) > -1) return 'exists';
  const slug = ensureSlug(blocker.task, blocker.line);
  depWrite(waiter.task, waiter.line, { blockedBy: depRead(waiter.task, waiter.line).blockedBy.concat(slug) });
  markDirty();
  return '';
}
function removeDependency(task, line, slug){
  if (state.locked) return false;
  const w = depRead(task, line);
  if (!w || w.blockedBy.indexOf(slug) < 0) return false;
  depWrite(task, line, { blockedBy: w.blockedBy.filter(s => s !== slug) });
  markDirty();
  return true;
}
/* The picker is the attach-a-session dialog's shape: a search box over a list
   of rows. Every open task and sub-step, less this line and whatever is
   already linked in that direction. */
function depCandidates(t, line, dir){
  const me = depRead(t, line);
  return allItems().filter(i => {
    if (i.done) return false;
    const iLine = i.sub ? i.sub.line : -1;
    if (i.task === t && iLine === line) return false;
    if (dir === 'waiting') return !(i.slug && me.blockedBy.indexOf(i.slug) > -1);
    return !(me.slug && i.blockedBy.indexOf(me.slug) > -1);
  });
}
function openDepPicker(t, line, dir){
  const overlay = document.createElement('div');
  overlay.className = 'attachpick-wrap deppick';
  overlay.innerHTML = '<div class="attachpick" role="dialog" aria-label="' + (dir === 'waiting' ? 'Waiting on' : 'Blocks') + '">' +
    '<header>' + (dir === 'waiting' ? 'Waiting on…' : 'Blocks…') +
      '<button type="button" class="attachpick-close" aria-label="Close">×</button>' +
    '</header>' +
    '<div class="attachpick-search-wrap">' +
      '<input type="search" class="attachpick-search" placeholder="Search open tasks…" aria-label="Search open tasks">' +
    '</div>' +
    '<div class="attachpick-body"></div>' +
  '</div>';
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.onclick = e => { if (e.target === overlay) close(); };
  overlay.querySelector('.attachpick-close').onclick = close;
  const body = overlay.querySelector('.attachpick-body');
  const searchBox = overlay.querySelector('.attachpick-search');
  const all = depCandidates(t, line, dir);
  const render = term => {
    const q = term.toLowerCase();
    const rows = all.filter(i => !q || (i.title + ' ' + i.parent).toLowerCase().indexOf(q) > -1);
    body.innerHTML = rows.length
      ? rows.map(i =>
          '<button type="button" class="attachpick-row" data-dep-task="' + esc(i.id) + '"' +
            ' data-dep-line="' + (i.sub ? i.sub.line : -1) + '">' +
            '<span class="attachpick-title">' + esc(i.title) + '</span>' +
            '<span class="attachpick-meta">' + esc((i.parent ? i.parent + ' · ' : '') + i.bucket + ' · ' + i.tier) + '</span>' +
          '</button>').join('')
      : '<p class="aic-none">' + (q ? 'Nothing matches that.' : 'No other open tasks.') + '</p>';
  };
  body.onclick = e => {
    const row = e.target.closest('.attachpick-row');
    if (!row) return;
    const loc = locate(row.dataset.depTask);
    if (!loc) return;
    const why = addDependency(t, line, dir, { task: loc.task, line: +row.dataset.depLine });
    if (why === 'cycle') return;
    close();
    if (!why) { refreshView(); openDrawer(t.id); }
  };
  searchBox.oninput = () => render(searchBox.value.trim());
  render('');
  searchBox.focus();
}
function bindDependencySection(t){
  $('#dbody').querySelectorAll('[data-depadd]').forEach(b => {
    b.onclick = () => openDepPicker(t, +b.dataset.depLine, b.dataset.depadd);
  });
  $('#dbody').querySelectorAll('[data-depremove]').forEach(b => {
    b.onclick = () => {
      const line = +b.dataset.depLine, slug = b.dataset.depSlug;
      let done = false;
      if (b.dataset.depremove === 'waiting') done = removeDependency(t, line, slug);
      else {
        const loc = locate(b.dataset.depTask);
        done = !!loc && removeDependency(loc.task, +b.dataset.depOtherLine, slug);
      }
      if (done) { refreshView(); openDrawer(t.id); }
    };
  });
}
/* ---- The note lines the second column already draws ----
   A suggested message, a prompt, an agenda, a Jira ticket, the project folder
   and who the task is waiting on are all written as a note under the task, and
   every one of them is pulled back out and drawn properly in the column beside
   this one. Left in the Description field as well they are the same thing
   written twice, and on a task carrying three or four of them the note the owner
   actually wrote is buried under scaffolding the owner never reads there.

   So the field holds the prose and nothing else. Held back rather than hidden:
   what is in the field is what gets written on commit, so a line merely hidden
   would be deleted by the first edit anybody made. Each one keeps the position
   it had among the notes and mergeDrawnNotes() puts it back — the same bargain
   bodyParts() already makes with sub-steps, for the same reason. */
const PROJECT_NOTE = /^\s*-\s+Project\s*:/i;
const WAITING_NOTE = /^\s*-\s+Waiting on\s*:/i;
function splitDrawnNotes(notes){
  const prose = [], held = [];
  for (let i = 0; i < notes.length; i++) {
    const l = notes[i];
    const block = AGENDA_NOTE.test(l) || PREV_AGENDA_NOTE.test(l);
    const drawn = block || MSG_NOTE.test(l) || PROMPT_NOTE.test(l) || JIRA_NOTE.test(l) ||
      WAITING_NOTE.test(l) ||
      (PROJECT_NOTE.test(l) && PROJECT_RE.test(l)) ||
      // A ticket body belongs to the note above it, so it only comes out when
      // that note did — a stray Description: line is somebody's prose.
      (DESC_NOTE.test(l) && held.length && JIRA_NOTE.test(held[held.length - 1].line));
    if (!drawn) { prose.push(l); continue; }
    held.push({ at: i, line: l });
    if (!block) continue;
    /* The topics under an agenda heading, by the rule readBlockNote already
       reads them with: everything indented past the heading, up to the last
       line that is. Blank lines inside the block come with it; a blank line
       after it is an ordinary gap and stays where it is. */
    const head = leadIndent(l);
    let j = i + 1, last = i;
    while (j < notes.length && (!notes[j].trim() || leadIndent(notes[j]) > head)) {
      if (notes[j].trim()) last = j;
      j++;
    }
    for (let k = i + 1; k <= last; k++) held.push({ at: k, line: notes[k] });
    i = last;
  }
  return { prose, held };
}
/* The other half, and the only reason the split above is safe. Held lines go
   back at the index they came from, in the order they were taken, which puts
   an untouched note back exactly as it was. A line whose index is now past the
   end — the owner deleted the prose it sat under — lands at the end rather than
   being dropped. */
function mergeDrawnNotes(prose, held){
  const out = prose.slice();
  held.forEach(h => out.splice(Math.min(h.at, out.length), 0, h.line));
  return out;
}

/* Who this task is waiting on when it is a person or an event rather than
   another task, written as `- Waiting on: ...` in the notes. blocked-by: is
   the half of this the file can resolve to a card; this is the half it cannot,
   and until now it read as prose in the note while the Dependencies section
   said the task had nothing holding it up. */
function waitingNotes(t){
  const parts = splitBody(t);
  const out = [];
  const take = (lines, where) => lines.forEach(l => {
    if (WAITING_NOTE.test(l)) out.push({ text: l.replace(WAITING_NOTE, '').trim(), where });
  });
  take(parts.notes, '');
  parts.steps.forEach(s => take(s.notes, s.clean));
  return out;
}

/* ---- One shape for every section in the drawer's second column ----
   Chats, Project, Dependencies, the agenda, the two suggestion lists and Jira
   all arrived separately and each drew its own heading — the chat list came
   with the shared package's `aic-field`, faint and a size down, the Jira list
   was a plain div that could not be put away at all, and the rest were
   `field sugg`. Three headings for one kind of thing. This is that kind of
   thing: a rule above it, a summary that collapses and remembers, and a count
   when there is more than one. What differs between them is what goes inside,
   which is the part that should differ. */
/* Every section in this column stays in the panel whether or not it has
   anything in it, so the column reads as the same list of things on every
   task and the shape of the panel doesn't move as tasks change. A section
   with nothing in it says what would put something there — most of these are
   written as a note in Description rather than edited here, and the empty
   state is the only place that syntax is written down. */
function emptyState(text){
  // Most of these name the exact syntax that would fill the section in, and a
  // run of it in the middle of a sentence wants to look like one — `like this`
  // becomes a code span, after escaping, so the text itself is still plain.
  return '<p class="empty">' +
    esc(text).replace(/`([^`]+)`/g, (m, code) => '<code>' + code + '</code>') +
    '</p>';
}
/* sub marks a subsection inside another side section (Outputs): no rule above
   it, and its title takes Description's grey rather than the white heading. */
/* Side-column sections switched off until they come back. The code stays. */
const DRAWER_HIDDEN = { deps: true, chats: true, prompts: true, jira: true, chatwith: true };
/* The same for the sub-task panel: its Flags are off. */
const SUBPANEL_HIDDEN = { flags: true };

/* A section that is only its title: Title, which is a heading with no fold. */
function plainSection(label, body){
  return '<div class="field sugg heading"><span>' + esc(label) + '</span>' + body + '</div>';
}
function sideSection(label, key, body, count, sub, action){
  const k = 'sugg:' + key;
  /* A subsection with nothing in it but "None yet." has nothing to fold: no
     caret, always shown, the same heading. It gets its caret and its stored
     state back as soon as it has content (the panel is redrawn on every edit). */
  if (sub && /^<p class="empty">[^]*<\/p>$/.test(body) && !/<p/.test(body.slice(1))) {
    return '<div class="field sugg subsec nocollapse" data-collapse="' + esc(k) + '"><span>' + esc(label) + '</span>' + body + '</div>';
  }
  return (sub ? '' : '<hr class="dsep">') +
    '<details class="field sugg' + (sub ? ' subsec' : '') + '" data-collapse="' + esc(k) + '"' +
    (sectionCollapsed(k) ? '' : ' open') + '>' +
    '<summary>' + esc(label) +
    (count > 1 ? ' <em class="sublabel">' + count + '</em>' : '') +
    (action ? '<span class="sumaction">' + action + '</span>' : '') + '</summary>' +
    body +
    '</details>';
}

/* A button in a section's title bar must not also open or shut the section.
   One listener for all of them, so a section only has to pass `action`. */
document.addEventListener('click', ev => {
  if (ev.target.closest('summary .sumaction')) ev.preventDefault();
});

/* Start a project and Use an existing folder both end the same way: the
   server has the folder, and setTaskProject() writes the note in memory for
   autosave. */
async function startProject(t){
  const name = prompt('Name the folder for this project. It is made in the projects folder.', t.title);
  if (name == null) return;
  try {
    const got = await postJSON('/project/start', { name, title: t.title });
    if (setTaskProject(t, got.name)) { refreshView(); openDrawer(t.id); }
    showToast('Started data/projects/' + got.name);
  } catch (err) {
    showToast('Could not start the project: ' + (err.message || err), 'bad');
  }
}

async function openProjectFolder(ref){
  try {
    await postJSON('/project/open', { name: ref });
  } catch (err) {
    showToast('Could not open the folder: ' + (err.message || err), 'bad');
  }
}

/* Pick a folder the board already knows (under data/projects/, or one the owner
   approved), or approve a new one by its absolute path. Approving writes
   data/<dataset>/project-folders.json, so it is confirmed first. */
async function drawProjectPicker(t){
  const box = $('#f-projpicker');
  if (!box) return;
  box.classList.remove('hidden');
  box.innerHTML = '<span class="help">Reading the folders…</span>';
  let projects = [];
  try {
    projects = (await getJSON('/projects.json')).projects || [];
  } catch (err) {
    box.innerHTML = '<span class="help">Could not read the folders. ' + esc(String(err.message || err)) + '</span>';
    return;
  }
  if (state.openTask !== t.id) return;
  box.innerHTML =
    (projects.length
      ? '<div class="pprow"><select id="f-projsel">' +
          projects.map(p => '<option value="' + esc(p.name) + '">' +
            esc(p.external ? p.name : 'data/projects/' + p.name) + '</option>').join('') +
        '</select><button type="button" class="btn small" id="f-projuse">Use</button></div>'
      : '<span class="help">No project folders yet.</span>') +
    '<div class="pprow"><input type="text" id="f-projpath" placeholder="/absolute/path/to/a/folder" spellcheck="false">' +
      '<button type="button" class="btn outline small" id="f-projapprove">Approve</button></div>' +
    '<span class="help">Approving lets a task on this list point at that folder, and anything inside it.</span>';
  const use = $('#f-projuse');
  if (use) use.onclick = () => {
    const ref = $('#f-projsel').value;
    if (ref && setTaskProject(t, ref)) { refreshView(); openDrawer(t.id); }
  };
  $('#f-projapprove').onclick = async () => {
    const path = $('#f-projpath').value.trim();
    if (!path) return;
    if (!confirm('Approve ' + path + ' as a project folder for this list?\n\n' +
                 'Tasks will be able to point at it and at any folder inside it.')) return;
    try {
      await postJSON('/project-folders', { path });
      drawProjectPicker(t);
    } catch (err) {
      showToast('Could not approve that folder: ' + (err.message || err), 'bad');
    }
  };
}

/* The two lines under the folder name, out of the same read the project drawer
   does. Quiet about failure on purpose: this is a caption on a button that
   already works, so a helper too old to answer leaves the name and nothing
   else rather than an error where a sentence goes. */
/* The task's history: which specialist an owning agent brought in on it, one
   line per call (historyLine() in 02-state.js). Drawn empty and filled by
   loadTaskHistory() once the panel is up, the way the Project card is. */
/* The files in the task's project folder, drawn empty and filled by
   loadTaskProject() once the panel is up, the way History is. */
function filesSection(startLinks){
  return sideSection('Files', 'files',
    (startLinks || '') +
    '<input type="file" id="f-fileinput" multiple hidden>' +
    '<p class="empty hidden" id="f-fileerr"></p>' +
    '<div id="f-files">' + emptyState('No files yet.') + '</div>', undefined, true,
    '<button type="button" class="btn outline small hidden" id="f-fileaddbtn">Add file…</button>');
}

/* A file dropped anywhere in the drawer that is not the Files section would
   otherwise be opened by the browser, navigating away from the board. Bound
   once; the drawer element outlives every redraw of its body. */
let drawerDropGuarded = false;
function guardDrawerFileDrops(){
  if (drawerDropGuarded) return;
  const drawer = $('#drawer');
  if (!drawer) return;
  drawerDropGuarded = true;
  const files = ev => ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes('Files');
  ['dragover', 'drop'].forEach(type =>
    drawer.addEventListener(type, ev => { if (files(ev)) ev.preventDefault(); }));
}

/* The Add file button and drag-and-drop on the Files section. Shown only where
   the server routes exist and the task can be edited, the way Start a project
   is. A task with no folder yet gets one first, through /project/start. */
function bindFileAdd(t, ro){
  guardDrawerFileDrops();
  const input = $('#f-fileinput');
  if (!input || state.demo || listFolder || ro) return;
  $('#f-fileaddbtn').classList.remove('hidden');
  const err = $('#f-fileerr'), zone = input.closest('details');
  const say = msg => { err.textContent = msg || ''; err.classList.toggle('hidden', !msg); };
  const add = async files => {
    files = Array.from(files || []);
    if (!files.length) return;
    say('');
    let proj = taskProject(t), created = false;
    try {
      if (!proj) {
        const name = prompt('Name the folder for this project. It is made in the projects folder.', t.title);
        if (name == null) return;
        const got = await postJSON('/project/start', { name, title: t.title });
        if (!setTaskProject(t, got.name)) throw new Error('could not link the folder to the task');
        proj = got.name;
        created = true;
      }
    } catch (e) { say('Could not start the project: ' + (e.message || e)); return; }
    const failed = [];
    const send = async f => {
      const res = await fetch('/project/upload?name=' + encodeURIComponent(proj) +
                              '&file=' + encodeURIComponent(f.name),
                              { method: 'POST', headers: { 'X-Board': '1' }, body: f });
      const info = await res.json().catch(() => ({}));
      if (!res.ok) { const e = new Error(info.error || ('the server answered ' + res.status)); e.code = info.code; throw e; }
    };
    /* The folder the task names is not usable. Gone: make the default one and
       point the task at it. There but not approved: the same confirm the folder
       picker asks. Either way the upload carries on; only a refusal shows an
       error. Asked once per drop. */
    let fixed = false;
    const fix = async code => {
      fixed = true;
      if (code === 'missing') {
        let got, n = 1;
        for (;;) {
          try { got = await postJSON('/project/start', { name: n > 1 ? t.title + ' ' + n : t.title, title: t.title }); break; }
          catch (e) { if (n < 9 && /already a project folder/.test(e.message || '')) { n++; continue; } throw e; }
        }
        if (!replaceTaskProject(t, got.name)) throw new Error('could not link the folder to the task');
        proj = got.name;
        created = true;
        return true;
      }
      if (!confirm('Approve ' + proj + ' as a project folder for this list?\n\n' +
                   'Tasks will be able to point at it and at any folder inside it.')) return false;
      await postJSON('/project-folders', { path: proj });
      return true;
    };
    for (const f of files) {
      try {
        try { await send(f); }
        catch (e) {
          if (fixed || (e.code !== 'missing' && e.code !== 'unapproved') || !(await fix(e.code))) throw e;
          await send(f);
        }
      } catch (e) { failed.push(f.name + ': ' + (e.message || e)); }
    }
    const msg = failed.length ? 'Not added. ' + failed.join(' · ') : '';
    if (state.openTask !== t.id) { if (msg) showToast(msg, 'bad'); return; }
    if (created) {
      // The card itself changes once the task has a folder, so redraw it all.
      refreshView(); openDrawer(t.id);
      if (msg) showToast(msg, 'bad');
    } else {
      say(msg);
      loadTaskProject(proj, t.id);
    }
  };
  $('#f-fileaddbtn').onclick = ev => { ev.preventDefault(); ev.stopPropagation(); input.click(); };
  input.onchange = () => { add(input.files); input.value = ''; };
  // Highlight while a file is over the section. dragenter/dragleave fire for
  // every child crossed, so a counter, not a flag, says when it really left.
  // A shut section opens on the first dragenter so the list is in view.
  let depth = 0;
  const isFiles = ev => ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes('Files');
  const clear = () => { depth = 0; zone.classList.remove('dropping'); };
  zone.addEventListener('dragenter', ev => {
    if (!isFiles(ev)) return;
    ev.preventDefault();
    if (depth++ === 0) { zone.classList.add('dropping'); zone.open = true; }
  });
  zone.addEventListener('dragover', ev => {
    if (!isFiles(ev)) return;
    ev.preventDefault();
    zone.classList.add('dropping');
  });
  zone.addEventListener('dragleave', ev => {
    if (!isFiles(ev)) return;
    if (--depth <= 0) clear();
  });
  zone.addEventListener('dragend', clear);
  zone.addEventListener('drop', ev => {
    ev.preventDefault();
    clear();
    add(ev.dataTransfer && ev.dataTransfer.files);
  });
}

async function loadTaskHistory(t){
  if (!t || !t.stableId) return;
  const taskId = t.id;
  let got;
  try {
    const res = await fetch('/history.json?task=' + encodeURIComponent(t.stableId) + '&t=' + Date.now(),
                            { cache:'no-store' });
    if (!res.ok) return;
    got = await res.json();
  } catch (err) { return; }
  if (state.openTask !== taskId) return;
  const box = $('#f-history');
  const rows = ((got && got.events) || []).map(ev => ({ ev, line: historyLine(ev) })).filter(r => r.line);
  if (!box || !rows.length) return;
  box.innerHTML = '<ul class="dhistory">' + rows.slice().reverse().map(r =>
    '<li><span>' + esc(r.line) + '</span>' +
      '<em class="sublabel">' + esc([cvWhen(r.ev.at), r.ev.note].filter(Boolean).join(' · ')) + '</em></li>'
  ).join('') + '</ul>';
}

async function loadTaskProject(name, taskId){
  let meta;
  try {
    const res = await fetch('/project.json?name=' + encodeURIComponent(name) + '&t=' + Date.now(),
                            { cache:'no-store' });
    if (!res.ok) return;
    meta = await res.json();
  } catch (err) { return; }
  // The panel may have moved to another task, or to a project, while this was
  // in flight — every openDrawer() on a task with a project starts one.
  if (state.openTask !== taskId) return;
  const box = $('#f-files');
  const list = meta.entries || [];
  if (!box) return;
  if (!list.length) { box.innerHTML = emptyState('No files yet.'); return; }
  box.classList.add('projfiles');
  paintProjectFiles(box, list, name);
}

function dependenciesSection(t){
  const groups = taskDependencies(t, !state.locked);
  const empty = !groups.some(g => g.waitingOn.length || g.blocks.length || g.people.length);
  const hint = emptyState('None yet.');
  const body = groups.map(depGroupHTML).join('') + (empty ? hint : '');
  return sideSection('Dependencies', 'deps', body);
}

/* ---- Every tag actually on the task, in one list ----
   parseTaskLine() (core/todo.js) reads a dozen known tags into their own
   fields and keeps anything it doesn't recognise verbatim in t.extra — which
   nothing anywhere else in kanban/js ever reads. This is the one place a
   task's whole tag set is visible at a glance, extra included, and it doubles
   as the editor: a click edits the same field a slider or checkbox elsewhere
   already owns, so there is one stored value per tag, never two copies that
   could fall out of step.

   Left out on purpose, because each already has a real editor of its own
   elsewhere on this same panel that does more than a plain text box could —
   impact, effort, due, start, ai and to all have their own slider, picker or
   input above; headline has its own button; urgent has its own checkbox;
   #slug has its own syntax; blocked-by has the Dependencies section above.
   Showing any of those here too would just be a second, worse way to edit
   the same value. What's left — rank, tlrank, chat, repeat — is exactly the
   set with no editor anywhere else on the card. */
const KNOWN_TAG_FIELDS = [
  { field: 'rank',    label: 'rank' },
  { field: 'tlrank',  label: 'tlrank' },
  { field: 'chat',    label: 'chat' },
  { field: 'repeat',  label: 'repeat' }
];
/* Every key readTags() (core/todo.js) already claims as a first-class field,
   plus the bare tags it reads on their own syntax. A new tag typed in below
   is refused on one of these, since writing it into t.extra anyway would put
   a second, unread copy beside the field the board actually uses. */
const RESERVED_TAG_KEYS = [
  'impact', 'effort', 'due', 'time', 'start', 'done', 'to', 'theme', 'blocked-by', 'rank',
  'tlrank', 'headline', 'chat', 'repeat', 'id', 'cancelled', 'archived',
  'urgent', 'week', 'doing'
];
function taskTagChips(t){
  const chips = [];
  KNOWN_TAG_FIELDS.forEach(f => {
    const v = t[f.field];
    if (v == null || v === '') return;
    chips.push({ label: f.label, value: String(v), editable: true, field: f.field });
  });
  // week has no checkbox of its own anywhere in the app yet, unlike urgent —
  // shown here, read-only, for the same reason #slug and blocked-by are:
  // there is nowhere else on the card that says it is set at all.
  if (t.week) chips.push({ label: 'week', value: '', editable: false });
  if (t.slug) chips.push({ label: '#' + t.slug, value: '', editable: false });
  if (t.blockedBy && t.blockedBy.length) chips.push({ label: 'blocked-by', value: t.blockedBy.join(', '), editable: false });
  (t.extra || []).forEach((raw, i) => {
    ANY_TAG_RE.lastIndex = 0;
    const m = ANY_TAG_RE.exec(raw);
    if (m) {
      const key = m[1] != null ? m[1] : m[3];
      const value = (m[1] != null ? m[2] : m[4]).trim();
      chips.push({ label: key, value, editable: true, extraIndex: i, unrecognised: true, form: m[1] != null ? 'bracket' : 'code' });
    } else {
      chips.push({ label: raw, value: '', editable: false, unrecognised: true });
    }
  });
  return chips;
}
function tagsSection(t){
  const chips = taskTagChips(t);
  const ro = state.locked;
  const head = '<span class="fieldhead">Tags' + (chips.length > 1 ? ' <em class="sublabel">' + chips.length + '</em>' : '') +
    '<span class="sumaction" id="f-tagadd"></span></span>';
  if (!chips.length && ro) return head +
    emptyState('None yet.');
  const hasExtra = chips.some(c => c.unrecognised && c.editable);
  // The one control that writes a new tag rather than editing or clearing an
  // existing one — a plain-text key and value on click, the same way editing
  // an existing chip swaps it for an input, so a tag never has to be typed
  // into the raw task line by hand.
  return head + '<div class="tagchips"></div>' +
    (hasExtra ? '<span class="help">Amber ones are tags nothing else on the board reads — click to edit or clear.</span>' : '');
}
/* Mounts the chips: Tenon's TagChip swaps itself for an input on click, commits
   on Enter or blur and cancels on Escape. Rebuilding the whole panel on every
   keystroke would lose focus, so the page only hears once, on commit.

   The "+ Add tag" chip pushes `[key:: value]` onto t.extra, the exact syntax
   readTags() (core/todo.js) already reads back into an amber chip, so nothing
   here needs its own reader. A key that collides with a field the board already
   parses is refused rather than written, since a second copy in t.extra would
   sit beside the real field and never be read. */
function wireTagChips(t){
  const wrap = $('#drawer').querySelector('.tagchips');
  if (!wrap) return;
  const chips = taskTagChips(t);
  const done = () => { t.dirty = true; markDirty(); refreshView(); openDrawer(t.id); };
  BoardUI.mountFlushed(wrap, BoardUI.h(BoardUI.TagsField, {
    tags: chips.map(c => ({ label: c.label, value: c.value, editable: c.editable, unrecognised: !!c.unrecognised })),
    locked: state.locked,
    addHost: $('#f-tagadd'),
    onCommit: (i, v) => {
      const c = chips[i];
      if (c.field) {
        if (c.field === 'rank' || c.field === 'tlrank') t[c.field] = v ? parseInt(v, 10) : null;
        else t[c.field] = v;
      } else if (c.extraIndex != null) {
        if (!v) t.extra.splice(c.extraIndex, 1);
        else if (c.form === 'bracket') t.extra[c.extraIndex] = '[' + c.label + ':: ' + v + ']';
        else t.extra[c.extraIndex] = '`' + c.label + ':' + v + '`';
      }
      done();
    },
    onAdd: (k, v) => {
      if (RESERVED_TAG_KEYS.includes(k.toLowerCase())) {
        return '“' + k + '” is already a field the board reads on its own — pick a different key.';
      }
      t.extra = t.extra || [];
      t.extra.push('[' + k + ':: ' + v + ']');
      done();
    },
    onRefuse: msg => showToast(msg, 'bad')
  }));
}

/* ---- Messages and prompts written for this task ----
   Both live in the markdown as a note under the thing they serve, which means
   they arrive as one line buried in Notes. Pulled out here so the two things
   that are actually ready to send get their own place at the bottom of the
   panel, with a Copy button. The text itself is still edited in Notes — this is
   the same line, shown properly. */
function suggestions(t){
  const parts = splitBody(t);
  const out = { message: [], prompt: [], jira: [], agenda: [] };
  const take = (lines, where) => lines.forEach(l => {
    if (MSG_NOTE.test(l))         out.message.push({ text: quoted(l), draft: /\(draft\)/i.test(l), where, raw: l });
    else if (PROMPT_NOTE.test(l)) out.prompt.push({ text: quoted(l), draft: false, where, raw: l });
  });
  take(parts.notes, '');
  parts.steps.forEach(s => take(s.notes, s.clean));
  out.jira = jiraNotes(t);
  /* Read as a block rather than line by line, like a Jira description, so it
     goes through readAgenda on each run of notes instead of through take(). */
  const own = readAgenda(parts.notes);
  if (own) out.agenda.push(Object.assign({ where: '' }, own));
  parts.steps.forEach(s => {
    const ag = readAgenda(s.notes);
    if (ag) out.agenda.push(Object.assign({ where: s.clean }, ag));
  });
  return out;
}
function suggestionSection(label, list, opts){
  opts = opts || {};
  const body = list.length
    ? list.map(s => messageHTML(s.text, {
        where: s.where, draft: s.draft, claude: opts.claude, task: opts.task,
        dismiss: state.locked ? '' : s.raw
      })).join('')
    : emptyState(opts.emptyText || 'None yet.');
  return sideSection(label, label, body, list.length, opts.sub);
}

/* The agenda for a recurring meeting, in the panel. Its own section rather than
   a third kind of message suggestion, because it is many lines rather than one
   and because the date the topics belong to comes from the task rather than from
   the note, which a message suggestion has no equivalent of.

   Open by default, unlike the other two: on a meeting task this is the whole of
   what the panel is for.

   `prev` is last cycle's agenda, kept by the roll. Shown under this one and
   without a Copy, because its only job is to be read while the next is written. */
function agendaSection(list, when, prev, sub){
  if (!list.length && !prev) return sideSection('Meeting agenda', 'agenda',
    emptyState('None yet.'), undefined, sub);
  return sideSection('Meeting agenda', 'agenda',
    list.map(ag => agendaHTML(ag, when, { where: ag.where })).join('') +
    (prev ? agendaHTML(prev, '', { prev:true }) : '') +
    '', list.length, sub);
}

/* Tickets waiting to be raised. Its own section rather than a third kind of
   suggestion, because the button is a link out to Jira rather than a copy, and
   because which board it goes to is part of what the row has to say. */
function jiraSection(list, sub){
  if (!list.length) return sideSection('Jira tickets', 'jira',
    emptyState('None yet.'), undefined, sub);
  return sideSection('Jira tickets', 'jira',
    list.map(n => jiraHTML(n, {
      where: n.where, dismiss: state.locked ? '' : n.raw, dismissDesc: n.descRaw
    })).join(''), list.length, sub);
}

/* Adds a step and puts the cursor straight in it. Shared by the Add button and
   by Enter inside a new step, so both arrive in the same state. subEdit tells
   the list which line to draw as a field when the panel is rebuilt. */
let subEdit = null;
function addStepAndEdit(t, id){
  addSub(t);
  const steps = splitBody(t).steps;
  subEdit = { task: id, line: steps[steps.length - 1].line };
  refreshView();
  openDrawer(id);
}

/* The sub-task list, drawn by React (SubRows in kanban/ui/DrawerFields.tsx).
   A row opens that sub-task in the second panel. The tick, the grip, the
   delete button, a link in the text and a step being typed into each keep
   their own click. Mounted in a read-only tab as well, since looking at a
   sub-task changes nothing. A step with no id yet is given one on the click,
   so every row opens the same way; only a read-only tab, which cannot write
   one, leaves such a row shut. */
/* The tag after a sub-task's title: the agent's run state when it is assigned
   to one and a run is on record, else Doing. To do and Done are the tick's. */
const RUN_TAGS = { running: 'Working', failed: 'Failed', stale: 'Failed', queued: 'Queued', done: 'Finished' };
function subRowStatus(s){
  if (s.done) return undefined;
  const rec = s.to && agentOf(s.to) ? agentRunFor(s) : null;
  const run = runState(rec);
  // Only a run that has failed before and been queued again is a retry.
  if (run === 'queued' && rec.fails > 0) return { label: 'Retrying', tone: run };
  if (RUN_TAGS[run]) return { label: RUN_TAGS[run], tone: run === 'stale' ? 'failed' : run };
  return s.doing ? { label: 'Doing', tone: 'doing' } : undefined;
}
function mountSubRows(t, id, subs, ro){
  const host = $('#f-subs-host');
  if (!host) return;
  const edit = subEdit && subEdit.task === id ? subEdit : null;
  subEdit = null;
  BoardUI.mountFlushed(host, BoardUI.h(BoardUI.SubRows, {
    rows: subs.map(s => {
      const sd = dueInfo(s.due);
      return {
        line: s.line, done: !!s.done, stableId: s.stableId || '', opens: !!s.stableId || !ro,
        avatarHtml: assigneeAvatarHTML(s.to, 16), title: s.clean,
        due: sd ? { label: sd.label, cls: sd.cls } : undefined,
        hasNote: !!stepNoteText(t, s.line),
        status: subRowStatus(s)
      };
    }),
    locked: ro,
    editLine: edit ? edit.line : null,
    editText: edit && SUB_RE.exec(t.body[edit.line]) ? subEditText(SUB_RE.exec(t.body[edit.line])[3]) : '',
    chain: true,
    onOpen: row => {
      let sid = row.stableId;
      if (!sid) {
        sid = ensureSubId(t, row.line);
        if (!sid) return;
        refreshView();
      }
      openDrawer(sid);
    },
    onToggle: (lineIdx, checked) => {
      if (checked) {
        const step = splitBody(t).steps.find(s => s.line === lineIdx);
        const msg = blockedMessage(allItems(), (step ? step.blockedBy : []).concat(t.blockedBy || []));
        if (msg) { showToast(msg, 'blocked'); openDrawer(id); return; }
      }
      toggleSub(t, lineIdx); refreshView(); openDrawer(id);
    },
    onDelete: lineIdx => {
      const m = SUB_RE.exec(t.body[lineIdx]);
      const label = m ? stripTags(m[3]).replace(/\s+/g, ' ').trim() : 'this step';
      if (!confirm('Delete "' + label + '"? This removes it from todo.md when you save.')) return;
      removeSubLine(t, lineIdx);
      refreshView(); openDrawer(id);
    },
    onMove: (from, to) => { moveSub(t, from, to); refreshView(); openDrawer(id); },
    /* Clearing the text and leaving removes the step, so there is no separate
       delete control to add just for this. Enter on a non-empty step in a run
       commits it and opens the next, so a list of five is five lines and four
       Enters rather than five trips to the Add button. */
    onEditDone: (lineIdx, text, save, more) => {
      if (save) {
        const val = text.trim();
        if (val) setSubText(t, lineIdx, val); else removeSubLine(t, lineIdx);
      }
      if (more) { addStepAndEdit(t, id); return; }
      refreshView(); openDrawer(id);
    },
    /* subDrag is the timeline's own flag (18-timeline.js) that a sub-step drag
       is live somewhere on the page, so its board drop zone knows to ignore it
       rather than read it as a card. */
    onDragState: live => { subDrag = live ? 0 : null; }
  }));
}

/* The left half of the panel's head and the body below it are React roots
   (DrawerHeadLead, DrawerBody in kanban/ui/DrawerPanel.tsx), shared by the
   task panel and the project panel. The head re-renders in place; the body is
   replaced by a new key on each task open, and unmounted before the project
   panel writes its own markup into #dbody. */
let drawerSeq = 0;
function mountDrawerHead(model){
  BoardUI.mountFlushed($('#dheadLead'), BoardUI.h(BoardUI.DrawerHeadLead, model));
}
function clearDrawerBody(){
  BoardUI.unmount($('#dbody'));
  $('#dbody').textContent = '';
}

function openDrawer(id, focusTitle){
  const loc = locate(id);
  if (!loc) {
    /* Not a task, so it may be the id written on a sub-task's line. Its task
       opens underneath and the sub-task slides in over it. */
    const found = locateSub(id);
    if (!found) return;
    /* The task is redrawn behind it only when its panel is already the one
       open. Otherwise the sub-task opens on its own, and whatever else was
       open closes. */
    if (parentDrawerOpen(found.loc.task.id)) {
      drawingUnderSub = true;
      try { openDrawer(found.loc.task.id); } finally { drawingUnderSub = false; }
    } else if ($('#drawer').classList.contains('open')) {
      $('#drawer').classList.remove('open', 'projectview');
      $('#scrim').classList.remove('open');
      state.openProject = null;
    }
    openSubtaskDrawer(locateSub(id));
    return;
  }
  state.openTask = id;
  state.openSubParent = null;
  /* Drawn under an open sub-task (see openSubtaskDrawer), the task's own panel
     is only being brought up to date behind it, so the second panel stays. */
  if (!drawingUnderSub) hideSubPanel();
  const t = loc.task;
  // A backup preview opens the same panel to look at a task, but nothing in it
  // may change — every field below is disabled and nothing is wired to it.
  const ro = state.locked;
  // Same list as the board, Done included: a ticked-off task is in the Done
  // column there, so the panel says the same thing rather than hiding it in a
  // tick box that has nothing to do with the other columns.
  const cols = boardColumns();
  const nowIn = t.done ? DONE_COL : loc.tier.name;
  // Neutral rather than a per-column palette — the columns themselves vary by
  // board and carry no fixed meaning beyond "further along", except the last
  // one, which always means done.
  // Labelled the way the board labels them, valued by the heading the document
  // carries: this stepper is what moves a card on a phone, where there is no
  // drag, so the two must read as the same column.
  const tierStops = cols.map(n => ({ value: n, label: tierLabel(n), color: n === DONE_COL ? 'var(--tenon-text-success)' : 'var(--tenon-text-accent)' }));
  const subs = subSteps(t);
  const sugg = suggestions(t);
  const proj = taskProject(t);
  const bucketThemes = (state.bucketThemes && state.bucketThemes[loc.bucket.name]) || [];
  const rep = t.repeat ? readRepeat(t.repeat) : null;
  /* The same fallback rollRecurring() itself uses (04-tier-two-the-one-thing.js):
     trust `due` when it's a real, future date — that's the occurrence the roll
     already landed on, and on a `~` tag it may be a hand-corrected date the
     rule alone wouldn't produce — and only fall back to the rule when there's
     nothing usable yet, which is a backup/read-only view, where load() skips
     the roll on purpose. */
  const nextDue = rep && (parseDue(t.due) && parseDue(t.due) >= today() ? parseDue(t.due) : occurrenceFrom(rep, today()));
  const dis = ro ? ' disabled' : '';

  state.openProject = null;
  $('#drawer').classList.remove('projectview');
  $('#drawer').classList.toggle('readonly', ro);
  /* The headline is the one thing on the whole list, so the control for it sits
     in the panel's frame rather than in the run of fields — a decision about
     the task, next to the other one, instead of the eighth thing to scroll
     past. The explanation it used to carry underneath moves to the tooltip:
     it is worth reading once, not on every task.
     Open folder sits beside it. Only for a task with a folder, and only where a
     server can open one; a backup preview can still open a folder.
     The help line truncates rather than wrapping when the drawer is narrow, and
     the read-only one is the sentence worth reading. */
  mountDrawerHead({
    title: ro ? 'View task (read-only)' : 'Edit task',
    help: (ro ? 'Read-only — from a backup, nothing here can be changed.' : 'Changes save automatically') +
          (authorLong(t) ? ' · ' + authorLong(t) : ''),
    headline: {
      on: !!t.headline,
      label: t.headline ? 'The one thing' : 'Make headline',
      hint: t.headline
        ? 'Set ' + dueLabel(t.headline) + '. It stays the headline until you solve it. Click to remove it.'
        : 'The task that makes the others easier or unnecessary. Only one at a time.',
      disabled: ro,
      onClick: ro ? undefined : () => { if (t.headline) clearHeadline(false); else setHeadline(id); },
    },
    folder: proj && !state.demo && !listFolder ? { onClick: () => openProjectFolder(proj) } : null,
  });

  /* The Bucket field: moving to another keeps the column the task is in. The
     task is looked up fresh from state.openTask rather than closed over, since
     the panel can be rebuilt between drawing the field and picking from it. */
  PICK_SPECS['f-bucket'] = {
    value: loc.bucket.name, ro, label: 'Bucket',
    options: state.doc.buckets.map((b, i) => ({ value: b.name, label: b.name, dot: bucketColor(b.name, i) })),
    onPick: name => {
      const id = state.openTask;
      const cur = id && locate(id);
      const nb = cur && state.doc.buckets.find(b => b.name === name);
      if (!cur || !nb || nb === cur.bucket) return;
      const target = ensureTier(nb, cur.tier.name);
      cur.tier.tasks.splice(cur.index, 1);
      target.tasks.push(cur.task);
      // The filter stays put rather than following the task to its new bucket
      // — moving a card out of the one you're looking at should look like
      // moving it out, the same as any other edit that drops a task from view.
      markDirty(); refreshView(); openDrawer(id);
    }
  };
  const canStart = !proj && !ro && !state.demo && !listFolder;
  const startLinks = canStart
    ? '<div class="dlinks"><button type="button" class="btn outline small" id="f-projstart">Start a project</button>' +
      '<button type="button" class="btn outline small" id="f-projpick">Use an existing folder</button></div>' +
      '<div class="ppick hidden" id="f-projpicker"></div>'
    : '';
  /* The outputs the task produces (agenda, message and prompt suggestions, Jira
     tickets) sit under one Outputs heading, each a subsection with its own
     count. History stays a section of its own after them. Both are "about the
     task" rather than "of the task", kept in a second column when the drawer is
     wide enough to hold one, same content and order as when it isn't (see
     .dcols). Every one of them draws whether or not it has anything in it, so
     nothing below the column moves as you read from one task to the next. */
  const outputs =
    agendaSection(sugg.agenda, t.due, readPrevAgenda(bodyParts(t).notes), true) +
    suggestionSection('Message suggestions', sugg.message,
      { sub: true, emptyText: 'None yet.' }) +
    (DRAWER_HIDDEN.prompts ? '' : suggestionSection('Prompt suggestions', sugg.prompt,
      { sub: true, claude:true, task:t.id, emptyText: 'None yet.' })) +
    (DRAWER_HIDDEN.jira ? '' : jiraSection(sugg.jira, true)) +
    filesSection(startLinks);
  const historyEmpty = emptyState('None yet.');

  /* Mounted afresh on every open (a new key), so the panel is replaced rather
     than patched, which is what assigning #dbody's innerHTML always meant. The
     Delegate select is drawn before the Theme one so each fills PICK_SPECS the
     way it did when they were joined in a string. The Bucket, the Column
     slider and the date pickers mount into the hosts this leaves. */
  drawerSeq++;
  BoardUI.mountFlushed($('#dbody'), BoardUI.h(BoardUI.DrawerBody, {
    key: drawerSeq,
    ro,
    title: t.title,
    /* Only when the bucket has declared themes, or the task already carries
       one the bucket no longer does (see themeSelectHTML above) — most
       buckets have none, and a field offering an empty dropdown on every
       task would be a question with no answer worth asking. */
    themeHTML: bucketThemes.length || t.theme ? themeSelectHTML(t.theme, bucketThemes, dis) : null,
    open: key => !sectionCollapsed(key),
    /* Full width rather than sharing a grid2 with Bucket: a column name like
       "Reviewing" needs the room a slider half that wide wouldn't give its
       label. */
    columnHTML: stepPickerHTML('f-tier', tierStops, nowIn, ro, 'Column'),
    impactHTML: stepSliderHTML('f-impact', IMPACT_STOPS, t.impact, ro, 'Impact'),
    effortHTML: stepSliderHTML('f-effort', EFFORT_STOPS, t.effort, ro, 'Effort'),
    /* One question, one field: who does the work. Left on Nobody for anything
       the owner is doing themself, which is most of the list. A <select> cannot
       hold an image, so the avatar sits beside it instead. */
    delegateHTML: delegateSelectHTML(t.to, dis, 'f-to', bucketAgentOfTask(t)) +
      (bucketAgentOfTask(t) || agentOf(t.to)
        ? '<span class="help">The bucket’s agent does the work. Plan first, it waits for your yes to the plan; free rein, it starts straight away. You review what it makes.</span>'
        : '') +
      (!DRAWER_HIDDEN.chatwith && chat.available() && !ro
        ? '<button type="button" class="btn outline small" id="f-chatwith">New chat with this task</button>'
        : ''),
    /* Read-only — the `repeat:` tag is set by the pa skill, never typed into
       the drawer — so this is the same reading the card's own "Recurring" tag
       tooltip already does, just given room to say it in full. */
    repeat: rep ? { label: rep.label.charAt(0).toUpperCase() + rep.label.slice(1), next: dueLabel(ymd(nextDue)), loose: !!rep.loose } : null,
    dateWarn: !!(parseDue(t.start) && parseDue(t.due) && parseDue(t.start) > parseDue(t.due)),
    dateNote: notYet(t.start) ? 'Hidden from Quick wins until ' + dueLabel(t.start) + '.' : '',
    urgent: !!t.urgent,
    tagsHTML: tagsSection(t),
    subCount: subs.length,
    canCompleteAll: !ro && subs.some(s => !s.done),
    outputsHTML: outputs,
    extraSideHTML: (DRAWER_HIDDEN.chats ? '' : chatSection(t)) + (DRAWER_HIDDEN.deps ? '' : dependenciesSection(t)),
    historyHTML: '<div id="f-history">' + historyEmpty + '</div>',
  }));

  // The Description field, on Tenon's Textarea. Mounted
  // rather than drawn as a string, into the placeholder #f-body-mount left in
  // mainFields above; everything below still finds #f-body by id and wires it
  // exactly as it always has, since Tenon's Textarea forwards its ref to a
  // real <textarea>. Committed with mountFlushed so it exists before the
  // wiring later in this function queries it.
  if (bodyMountEl) BoardUI.unmount(bodyMountEl);
  bodyMountEl = $('#f-body-mount');
  BoardUI.mountFlushed(bodyMountEl, BoardUI.h(BoardUI.Textarea, {
    id: 'f-body',
    spellCheck: false,
    hidden: true,
    disabled: ro,
    defaultValue: dedent(splitDrawnNotes(bodyParts(t).notes).prose),
  }));

  const chatWith = $('#f-chatwith');
  if (chatWith) chatWith.onclick = () => newChatWithTask(id);
  const startBtn = $('#f-projstart');
  if (startBtn) startBtn.onclick = () => startProject(t);
  const pickBtn = $('#f-projpick');
  if (pickBtn) pickBtn.onclick = () => drawProjectPicker(t);
  if (proj) loadTaskProject(proj, t.id);
  bindFileAdd(t, ro);
  loadTaskHistory(t);
  bindDependencySection(t);
  mountSubRows(t, id, subs, ro);
  mountStepFields($('#dbody'));
  mountPickers($('#dbody'));
  let pickDate = () => {};
  mountDateFields('f-dates', 'f', ro, dateFieldModels(t.start, t.due), (k, v) => pickDate(k, v),
    { value: t.due ? t.time || '' : '', disabled: !parseDue(t.due), onChange: v => { t.time = v; touch(); } });
  wireTagChips(t);

  // Every handler below changes the task, so none of them are wired up in a
  // backup preview — the fields are also disabled above, but this is what
  // actually stops a change from happening rather than just looking stopped.
  if (!ro) {
  const touch = () => { t.dirty = true; markDirty(); refreshView(); };

  $('#f-title').oninput  = e => { t.title = e.target.value; touch(); };
  $('#f-to').onchange = e => {
    const was = agentOf(t.to);
    if (e.target.value === NOT_SET_UP) {
      const a = bucketAgentOfTask(t);
      showToast((a ? a.name : 'This bucket’s agent') + ' is not set up' +
        (a && bucketAgentMissingText(a) ? ', it still needs ' + bucketAgentMissingText(a) : '') + '. Fill in its brief first.', 'blocked');
      openDrawer(id);
      return;
    }
    /* Choosing an agent is the handover: the sub-tasks are laid out on the card
       and it moves to Doing. See handOver() in 04-tier-two-the-one-thing.js.
       A bucket agent starts itself (on assignment or on its schedule); only the
       two old agents are started from here. */
    if (agentOf(e.target.value)) {
      const laid = handOver(t, e.target.value);
      const to = agentOf(e.target.value), old = legacyAgent(to);
      if (laid && old) queueAgentStart(old === 'Plan agent' ? 'plan' : 'implement');
      touch();
      openDrawer(id);
      if (laid) {
        $('#status').textContent = 'handed to the ' + to + ' — sub-tasks added, and the card is in Doing';
        $('#status').classList.add('dirty');
      }
      return;
    }
    t.to = e.target.value;
    /* Taken back off the agents altogether: the prompt and the rank go with it,
       or they read as a standing instruction to hand it over. */
    if (was && !agentOf(t.to)) {
      const dropped = stripDelegation(t);
      if (dropped.length) {
        touch();
        openDrawer(id);
        $('#status').textContent = 'removed ' + dropped.length + ' prompt' +
          (dropped.length > 1 ? 's' : '') + ' — no longer with an agent';
        $('#status').classList.add('dirty');
        return;
      }
    }
    // The only path left where the drawer isn't rebuilt whole; the delegated
    // click handler redraws the dropdown's button once this returns.
    touch();
  };
  if ($('#f-theme')) $('#f-theme').onchange = e => { t.theme = e.target.value; touch(); };
  wireStepSlider('f-impact', IMPACT_STOPS, v => { t.impact = v; touch(); });
  wireStepSlider('f-effort', EFFORT_STOPS, v => { t.effort = v; touch(); });
  $('#f-urgent').onchange = e => { t.urgent = e.target.checked; touch(); };
  pickDate = (k, v) => {
    t[k] = v;
    if (k === 'due' && !v) t.time = '';
    touch();
    // The two dates constrain each other, so a change can make the other one
    // wrong. Re-open so the warning appears or clears straight away.
    openDrawer(state.openTask);
  };

  /* Picking Done here ticks the task off, which moves it under the Done heading,
     and picking anything else unticks it into that column — exactly what
     dragging a card in or out of the Done column does. */
  wireStepPicker('f-tier', tierStops, pick => {
    if (pick === DONE_COL) {
      const msg = blockedMessage(allItems(), t.blockedBy);
      if (msg) { showToast(msg, 'blocked'); openDrawer(id); return; }
      setDone(t, true);
      markDirty(); refreshView(); openDrawer(id);
      return;
    }
    setDone(t, false, { stay: true });
    const target = ensureTier(loc.bucket, pick);
    if (target !== loc.tier) {
      loc.tier.tasks.splice(loc.index, 1);
      target.tasks.push(t);
    }
    markDirty(); refreshView(); openDrawer(id);
  });
  /* Ticks every open subtask in one click — the same blocked check each box
     makes on its own, applied per subtask rather than to the button as a
     whole, since some waiting on a blocker while the rest are free to close
     is the ordinary case, not a reason to refuse the lot. Several toggleSub()
     calls in one synchronous run land in the same undo step (see noteUndo),
     so this undoes as the one action it looks like. */
  const allBtn = $('#f-completeall');
  if (allBtn) {
    allBtn.onclick = () => {
      const items = allItems();
      let done = 0, waiting = 0;
      splitBody(t).steps.forEach(s => {
        if (s.done) return;
        if (blockedMessage(items, (s.blockedBy || []).concat(t.blockedBy || []))) { waiting++; return; }
        toggleSub(t, s.line);
        done++;
      });
      if (done) { refreshView(); openDrawer(id); }
      $('#status').textContent = !done
        ? 'Every open subtask is still waiting on something — finish that first'
        : waiting
          ? 'Completed ' + done + ', ' + waiting + ' still waiting on something'
          : 'Completed ' + done + ' subtask' + (done === 1 ? '' : 's');
      if (done) $('#status').classList.add('dirty');
    };
  }
  /* Adds the step, then drops straight into editing its (empty) text — an
     "Add" click that still left a blank, unlabelled row would just be a second
     click waiting to happen. */
  $('#f-addsub').onclick = () => addStepAndEdit(t, id);
  }

  /* ---- Description: rendered, click to edit ----
     Drawn before the wiring below so a backup preview gets the rendering too —
     reading is not editing, and a note is easier to read rendered whether or
     not this panel is allowed to change anything. */
  const bodyTa = $('#f-body'), bodyView = $('#f-body-view');
  let bodySaved = bodyTa.value;
  const renderBody = () => {
    bodyView.innerHTML = mdBlocks(bodyTa.value, { srcmap:true, keepH1:true }) ||
      '<p class="empty">' + (ro ? 'Nothing written.' : 'Nothing written yet. Click to add a note.') + '</p>';
  };
  renderBody();

  /* One height on both halves, so the panel below the field does not move
     when the field changes state. The owner sets it by dragging the field's
     own corner, and it is remembered for the next task. */
  let bodyH = noteHeight();
  const showBodyHeight = h => {
    bodyH = Math.max(NOTE_H_MIN, Math.round(h));
    bodyView.style.height = bodyH + 'px';
    bodyTa.style.height = bodyH + 'px';
  };
  showBodyHeight(bodyH);

  /* Dragging the field's own corner is a browser control with no event of its
     own, and a ResizeObserver is the only way to hear it. A height that is
     not the one just applied came from the owner's drag, so it becomes the height —
     on both halves, and on the next task the owner opens. The comparison is also
     what stops this from feeding itself: applying the new height fires the
     observer again, and the second pass matches and stops. */
  if (noteResizeObs) noteResizeObs.disconnect();
  if (window.ResizeObserver) {
    noteResizeObs = new ResizeObserver(() => {
      const h = (bodyTa.hidden ? bodyView : bodyTa).offsetHeight;
      if (!h || Math.abs(h - bodyH) < 2) return;
      showBodyHeight(h);
      setNoteHeight(bodyH);
    });
    noteResizeObs.observe(bodyTa);
    noteResizeObs.observe(bodyView);
  }

  if (!ro) {
    /* onchange rather than oninput: rebuildBody rewrites the task's lines and
       refreshView redraws the board behind the drawer, which is not something
       to do on every keystroke. Both ways out of the editor go through here,
       and bodySaved keeps a second call with the same text from marking the
       document dirty for nothing. */
    const commitBody = () => {
      if (bodyTa.value === bodySaved) return;
      bodySaved = bodyTa.value;
      const p = bodyParts(t);
      /* Read again here rather than reused from the render: a tag edit or a
         dismissed suggestion can have rewritten the body since the field was
         filled, and what goes back has to be what is on the task now. */
      const held = splitDrawnNotes(p.notes).held;
      rebuildBody(t, mergeDrawnNotes(indent(bodyTa.value), held), p.subs, p.subsAt);
      markDirty(); refreshView();
    };
    const stopEditing = () => {
      commitBody();
      renderBody();
      bodyTa.hidden = true;
      bodyView.hidden = false;
    };
    bodyView.onclick = e => {
      // A link in a rendered note is there to be followed, the same as one in
      // a subtask — the editor opens on everything except that.
      if (e.target.closest('a')) return;
      const caret = noteCaret(bodyView, bodyTa.value, e);
      bodyView.hidden = true;
      bodyTa.hidden = false;
      bodyTa.focus();
      bodyTa.setSelectionRange(caret, caret);
    };
    bodyTa.onblur = stopEditing;
    bodyTa.onkeydown = e => {
      // Escape leaves the field rather than the drawer, and keeps what was
      // typed — there is no draft here to throw away, the text is the task's.
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); bodyTa.blur(); }
    };
  }

  // Where an agent's run on this task stands, and what to do when it failed
  // (28-agent-runs.js). Put in at the top of the main column.
  if (typeof mountRunBlock === 'function') mountRunBlock(t);
  $('#drawer').classList.add('open');
  $('#scrim').classList.add('open');
  if (focusTitle) { const el = $('#f-title'); const sec = el.closest('details'); if (sec) sec.open = true; el.focus(); el.select(); }
  // Written into the URL now rather than left for the next full render —
  // opening the drawer alone doesn't otherwise touch the hash. It pushes: a
  // card is somewhere the owner went, and Back is the way out of it. See syncHash()
  // in 07-render-board.js. Not when the sub-task panel is about to go over
  // it, which writes its own.
  if (!drawingUnderSub) syncHash(!closingSub);
}

/* Set while openDrawer draws the task behind an open sub-task, and while the
   sub-task panel is closing back onto its task — the one move that is a step
   back rather than somewhere new, so it overwrites the history entry. */
let drawingUnderSub = false;
let closingSub = false;

function hideSubPanel(){
  $('#subpanel').classList.remove('open');
  $('#subscrim').classList.remove('open');
}
/* Escape, the faded area and the panel's own Close all land here: the
   sub-task goes, and the task it sits under is left open behind it. */
function closeSubPanel(){
  const parent = state.openSubParent;
  subSendBackFor = null;
  if (!parent || !locate(parent) || !$('#drawer').classList.contains('open')) { closeDrawer(); return; }
  closingSub = true;
  try { openDrawer(parent); } finally { closingSub = false; }
}
function subPanelOpen(){ return $('#subpanel').classList.contains('open'); }
/* The task's own panel is open: showing the task, or behind one of its
   sub-tasks. */
function parentDrawerOpen(taskId){
  const d = $('#drawer');
  if (!d.classList.contains('open') || d.classList.contains('projectview')) return false;
  return state.openTask === taskId || state.openSubParent === taskId;
}

/* ---- The panel, showing a sub-task ----
   Opened by the id written on its line: `openDrawer(id)` takes either a task's
   or a sub-task's, and the two cannot be confused, since a task's is a number
   this tab made and a sub-task's is six characters from the file.

   The same panel with fewer things in it. A sub-task has a title, a state (To
   do, Doing, Done: the tick, and the one tag an agent's work carries), an
   assignee, and the rest of the tags a task has. What it does not carry it takes
   from its task, and those are drawn faded with a note saying so: the due
   date, impact, urgent and week (inheritedFields() in core/todo.js), and the
   bucket and project, which are only ever the task's. Picking a value of its own
   for one takes it out of the faded state. The button at the top left goes back
   to the task. Every edit reads the line, changes a field and writes the line
   back (readSub() and writeSub()), so the tags come out the way a task's do. */
let subSendBackFor = null;   // the sub-task whose "send it back" box is open

/* The plan a review points at, read in a sheet. Fetched off the plans folder
   every time, since a plan is rewritten when it is sent back. */
async function openPlanReader(rel, title){
  showModal(title || 'The plan', '', '<p class="empty">Loading…</p>', [{ label: 'Close' }], { wide: true, cls: 'planmodal' });
  let html;
  try {
    const res = await fetch('/data/plans/' + rel + '?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    const text = (await res.text()).replace(/^---[\s\S]*?\n---\s*\n/, '');
    html = mdBlocks(text);
  } catch (err) {
    html = '<p class="empty">The plan could not be read.</p>';
  }
  const mid = modalEl && modalEl.querySelector('.planmodal .mid');
  if (mid) mid.innerHTML = '<div class="planmain">' + html + '</div>';
}

/* The plan written for a task, found by the task's id in /plans.json rather
   than through the review's `Plan:` note. Newest first, so the first match is
   the one to read. Empty when there is none or the server cannot say. */
async function planForTask(stableId){
  try {
    const res = await fetch('/plans.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return '';
    const hit = ((await res.json()).plans || []).find(p => p.about === 'task:' + stableId);
    return hit && /^[\w.-]+\.md$/.test(hit.name || '') ? hit.name : '';
  } catch (err) { return ''; }
}

function openSubtaskDrawer(found){
  const { loc, step } = found;
  const t = loc.task, line = step.line, subId = step.stableId;
  const wasOpen = subPanelOpen() && state.openTask === subId;
  state.openTask = subId;
  state.openSubParent = t.id;
  const ro = state.locked;
  const dis = ro ? ' disabled' : '';
  const f = readSub(t, line);
  const inh = inheritedFields(t, step);
  const took = k => inh.inherited.indexOf(k) > -1;
  const proj = taskProject(t);

  const panel = $('#subpanel');
  panel.classList.toggle('readonly', ro);
  $('#subTitle').textContent = ro ? 'View sub-task (read-only)' : 'Sub-task';
  const help = $('#subHelp');
  help.textContent = (ro ? 'Read-only — from a backup, nothing here can be changed.' : 'Changes save automatically') +
                     (authorLong(step) ? ' · ' + authorLong(step) : '');
  help.title = help.textContent;

  const SUB_STATES = [
    { value: 'todo', label: 'To do', color: 'var(--tenon-text-accent)' },
    { value: 'doing', label: 'Doing', color: 'var(--tenon-text-running)' },
    { value: 'done', label: 'Done', color: 'var(--tenon-text-success)' }
  ];
  const now = f.done ? 'done' : (f.doing ? 'doing' : 'todo');
  /* A field that is not the step's own reads as the task's, faded, and says so. */
  const field = (k, label, body) =>
    '<div class="field' + (took(k) ? ' inherited' : '') + '"><span>' + label + '</span>' + body +
    (took(k) ? '<span class="help">From the task. Pick one here to give this its own.</span>' : '') + '</div>';

  const waitingOn = (f.blockedBy || []).map(slug => {
    const src = itemBySlug(allItems(), slug);
    return '<div class="subwait' + (src && src.done ? ' done' : '') + '">' +
      (src ? mdInline(src.title) + (src.done ? ' — done' : ' — open') : esc('#' + slug + ' is not in the list')) + '</div>';
  }).join('');

  /* The two reviews of a handover, which are the owner's to answer: read what was made,
     talk it through, and either approve it, which ticks this, or send it back,
     which unticks the sub-task before it with what was wrong. */
  const kind = /-plan-review$/.test(f.slug) ? 'plan' : (/-work-review$/.test(f.slug) ? 'work' : '');
  let planRel = kind === 'plan' ? ((stepNoteText(t, line).match(/^-\s*Plan:\s*`?plans\/([^\s`]+\.md)/mi) || [])[1] || '') : '';
  const waiting = (f.blockedBy || []).some(sl => { const b = itemBySlug(allItems(), sl); return !b || !b.done; });
  const reviewHTML = !kind ? '' :
    '<div class="field"><span>' + (kind === 'plan' ? 'The plan' : 'The work') + '</span>' +
      '<div class="reviewbtns">' +
        (planRel ? '<button type="button" class="btn small" id="f-readplan">Read the plan</button>' : '') +
        '<button type="button" class="btn small" id="f-chatrev">Talk it through</button>' +
        '<button type="button" class="btn small agree" id="f-approve"' + (ro || f.done || waiting ? ' disabled' : '') + '>Approve</button>' +
        '<button type="button" class="btn small reject" id="f-sendback"' + (ro || waiting && !f.done ? ' disabled' : '') + '>Send back</button>' +
      '</div>' +
      (waiting && !f.done ? '<span class="help">' + (kind === 'plan' ? 'The plan is not written yet.' : 'The work is not finished yet.') + '</span>' : '') +
      (subSendBackFor === subId
        ? '<div id="f-sendback-mount"></div>' +
          '<button type="button" class="btn small reject" id="f-sendback-go">Send it back</button>'
        : '') +
    '</div>';

  $('#sbody').innerHTML = '<div class="dcols"><div class="dcol dcol-main">' +
    plainSection('Title', '<input type="text" id="s-title" value="' + esc(f.title) + '"' + dis + '>') +
    reviewHTML +
    '<div class="field"><span>State</span>' + stepPickerHTML('s-substate', SUB_STATES, now, ro, 'State') + '</div>' +
    '<div class="field"><span>Assigned to</span>' + delegateSelectHTML(f.to, dis, 's-to', bucketAgentOfTask(t)) + '</div>' +
    '<div class="grid2">' +
      field('impact', 'Impact', stepSliderHTML('s-impact', IMPACT_STOPS, inh.impact, ro, 'Impact')) +
      '<div class="field"><span>Effort</span>' + stepSliderHTML('s-effort', EFFORT_STOPS, f.effort, ro, 'Effort') + '</div>' +
    '</div>' +
    '<div id="s-dates"></div>' +
    (SUBPANEL_HIDDEN.flags ? '' : '<div class="field' + (took('urgent') || took('week') ? ' inherited' : '') + '"><span>Flags</span>' +
      '<label class="toggle"><input type="checkbox" id="s-urgent"' + (inh.urgent ? ' checked' : '') + dis + '> urgent</label>' +
      '<label class="toggle"><input type="checkbox" id="s-week"' + (inh.week ? ' checked' : '') + dis + '> this week</label>' +
      (took('urgent') || took('week') ? '<span class="help">Any that is ticked and faded is the task\'s.</span>' : '') +
    '</div>') +
    (waitingOn ? '<div class="field"><span>Waiting on</span>' + waitingOn + '</div>' : '') +
    sideSection('Note', 'subnote', '<div id="s-note-mount"></div>') +
    '<div class="field inherited"><span>Task</span><span class="dpbtn" style="cursor:default">' + mdInline(t.title) + '</span></div>' +
    '<div class="field inherited"><span>Bucket</span><span class="dpbtn" style="cursor:default">' + esc(loc.bucket.name) + '</span></div>' +
    (proj ? '<div class="field inherited"><span>Project</span><span class="dpbtn" style="cursor:default">' + esc(proj) + '</span></div>' : '') +
  '</div></div>';

  // The sub-task's Note, and the send-back message when that box is open, on
  // Tenon's Textarea — same mount-a-placeholder approach as
  // the task drawer's own Description field above.
  if (subNoteMountEl) BoardUI.unmount(subNoteMountEl);
  subNoteMountEl = $('#s-note-mount');
  BoardUI.mountFlushed(subNoteMountEl, BoardUI.h(BoardUI.Textarea, {
    id: 's-note', spellCheck: false, disabled: ro, defaultValue: stepNoteText(t, line),
  }));
  if (sendbackMountEl) BoardUI.unmount(sendbackMountEl);
  sendbackMountEl = $('#f-sendback-mount');
  if (sendbackMountEl) {
    BoardUI.mountFlushed(sendbackMountEl, BoardUI.h(BoardUI.Textarea, {
      id: 'f-sendback-text', placeholder: 'What should change? The agent reads this when it takes it up again.',
    }));
  }

  if (kind) {
    const readBtn = $('#f-readplan');
    if (readBtn) readBtn.onclick = () => openPlanReader(planRel, t.title);
    /* No `Plan:` line yet: a run started from the Agents tab or overnight
       writes its plan before the board has drained the tick that would have
       written the line. The plan's own frontmatter names its task, so ask
       /plans.json and add the button if one is there. */
    if (kind === 'plan' && !planRel && t.stableId) {
      planForTask(t.stableId).then(rel => {
        if (!rel || state.openTask !== subId || $('#f-readplan')) return;
        const chat = $('#f-chatrev');
        if (!chat) return;
        planRel = rel;
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'btn small'; btn.id = 'f-readplan';
        btn.textContent = 'Read the plan';
        btn.onclick = () => openPlanReader(planRel, t.title);
        chat.parentNode.insertBefore(btn, chat);
      });
    }
    $('#f-chatrev').onclick = () => askFromPrompt(t.id, kind === 'plan'
      ? 'Here is the plan for "' + t.title + '". ' + (planRel ? 'It is in plans/' + planRel + '. ' : '') +
        'Go through it with me before I decide.\n\n'
      : 'Here is the work done on "' + t.title + '". Go through what was produced with me before I decide.\n\n', null);
  }

  mountStepFields($('#sbody'));
  mountPickers($('#sbody'));
  let pickSubDate = () => {};
  let pickSubTime = () => {};
  /* A time only means something beside the sub-task's own date, so one that
     takes its task's due has the input switched off. */
  mountDateFields('s-dates', 's', ro, dateFieldModels(f.start, inh.due, took('due'), t.start), (k, v) => pickSubDate(k, v),
    { value: f.due ? f.time || '' : '', disabled: !parseDue(f.due),
      onChange: v => pickSubTime(v) });
  if (!ro) {
    /* One edit: read the line as it is now, change what changed, write it back.
       Read again every time, since another edit may have rewritten it. */
    const edit = fn => {
      const cur = readSub(t, line);
      if (!cur) return;
      fn(cur);
      writeSub(t, line, cur);
      markDirty(); refreshView();
    };
    const again = () => openDrawer(subId);
    if (kind) {
      $('#f-approve').onclick = () => {
        const msg = approveReview(t, line);
        if (msg) { showToast(msg, 'blocked'); return; }
        /* An approved plan is the Implement agent's cue, when it is the old one; a bucket agent takes its own. */
        if (kind === 'plan') {
          const doer = subSteps(t).find(x => x.slug === t.stableId + '-implement');
          if (doer && legacyAgent(doer.to)) queueAgentStart('implement');
        }
        subSendBackFor = null; refreshView(); again();
      };
      $('#f-sendback').onclick = () => { subSendBackFor = subSendBackFor === subId ? null : subId; again(); };
      const go = $('#f-sendback-go');
      if (go) go.onclick = () => {
        if (sendBack(t, line, $('#f-sendback-text').value)) { subSendBackFor = null; refreshView(); again(); }
      };
    }

    $('#s-title').oninput = e => edit(cur => { cur.title = e.target.value; });
    $('#s-to').onchange = e => { edit(cur => { cur.to = e.target.value; }); again(); };
    wireStepPicker('s-substate', SUB_STATES, pick => {
      const cur = readSub(t, line);
      if (pick === 'done' && !cur.done) {
        const msg = blockedMessage(allItems(), (cur.blockedBy || []).concat(t.blockedBy || []));
        if (msg) { showToast(msg, 'blocked'); again(); return; }
      }
      edit(c => {
        c.doing = pick === 'doing';
        if (pick === 'done' && !c.done) { c.done = true; c.doneOn = ymd(today()); }
        else if (pick !== 'done' && c.done) { c.done = false; c.doneOn = ''; }
      });
      again();
    });
    wireStepSlider('s-impact', IMPACT_STOPS, v => { edit(cur => { cur.impact = v; }); again(); });
    wireStepSlider('s-effort', EFFORT_STOPS, v => { edit(cur => { cur.effort = v; }); again(); });
    /* The date pickers write one field of whatever they are given, and reopen
       the drawer by state.openTask, which is this sub-task's id. */
    const dates = {
      get start(){ return readSub(t, line).start; }, set start(v){ edit(cur => { cur.start = v; }); },
      get due(){ return inh.due; }, set due(v){ edit(cur => { cur.due = v; if (!v) cur.time = ''; }); }
    };
    pickSubDate = (k, v) => { dates[k] = v; openDrawer(state.openTask); };
    pickSubTime = v => { edit(cur => { cur.time = v; }); };
    if ($('#s-urgent')) $('#s-urgent').onchange = e => { edit(cur => { cur.urgent = e.target.checked; }); again(); };
    if ($('#s-week')) $('#s-week').onchange = e => { edit(cur => { cur.week = e.target.checked; }); again(); };
    const note = $('#s-note');
    const saved = note.value;
    note.onblur = () => { if (note.value !== saved) { setStepNoteText(t, line, note.value); refreshView(); } };
    note.onkeydown = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); note.blur(); } };
  }

  // The run on a handover's sub-task, and its activity feed (28-agent-runs.js).
  if (typeof mountSubRun === 'function') mountSubRun(t, step);

  /* As wide as the task drawer's own left column, where the sub-task's row
     sits, rather than the whole drawer's dragged width. */
  const main = $('#drawer').classList.contains('open') && $('#dbody .dcol-main');
  const w = main ? Math.round(main.getBoundingClientRect().width) : 0;
  panel.style.width = w ? Math.max(w + 28, 340) + 'px' : '';
  panel.classList.add('open');
  $('#subscrim').classList.add('open');
  syncHash(!wasOpen);
}

/* Press and hold on the task drawer, the same hold the board's cards have
   (hold.ts, shared with TaskCard.tsx): 600ms on a sub-task card or on a
   section of the drawer (Title, Description, Details, Subtasks and the side
   column's Project, Dependencies and the rest) rings that one element and
   fades the whole page around it, spotlight() in 09a-spotlight.js. One
   delegated listener on #dbody, so it survives openDrawer() rebuilding the
   panel. The innermost match wins, so a sub-task holds on its own rather than
   its section. A press that starts in a field, button or link is theirs, which
   keeps typing, selecting text and the grip's drag as they were. Called once
   from boot.js, since the bundle loads after this file. */
function wireDrawerHold(){
  BoardUI.bindHold($('#dbody'), {
    selector: '.sub, .dcol > .field, .dcol > details',
    own: BoardUI.DRAWER_OWN_PRESS,
    describe: el => {
      const taskId = state.openTask || null;
      if (el.classList.contains('sub')) {
        return { kind: 'subtask', taskId, subIndex: Array.from($('#dbody').querySelectorAll('.sub')).indexOf(el) };
      }
      return { kind: 'section', taskId, section: drawerSectionLabel(el) };
    },
    onStart: el => spotlight(el),
    onEnd: () => clearSpotlight()
  });
}

/* A drawer section's name, as its head reads: "Description", not the small
   print and buttons the head carries beside it. The focus events name a
   section by this, and the focus prompt finds one again by it after the drawer
   is redrawn. */
function drawerSectionLabel(el){
  const head = el.querySelector(':scope > summary, :scope > span, :scope > label > span, :scope > .fieldhead');
  if (!head) return '';
  const copy = head.cloneNode(true);
  copy.querySelectorAll('em, button, .sublabel').forEach(n => n.remove());
  return copy.textContent.replace(/\s+/g, ' ').trim();
}

/* The drawer's sections, the ones a hold can take (wireDrawerHold above). */
function drawerSections(){
  return Array.from($('#dbody').querySelectorAll('.dcol > .field, .dcol > details'));
}

function closeDrawer(){
  state.openTask = null;
  state.openSubParent = null;
  hideSubPanel();
  state.openProject = null;
  $('#drawer').classList.remove('open');
  $('#drawer').classList.remove('projectview');
  $('#scrim').classList.remove('open');
  syncHash();
}

/* ---- The panel, showing a project instead of a task ----
   A project is spread across buckets by design: the presentation is Design
   System work, the deck review is People work, and the list is right to keep
   them apart. That makes "what is left on this" a question the columns cannot
   answer, which is what this is for. It reads, and nothing more — every row is
   a way back into the task that owns it. */
function openProjectDrawer(name){
  const rows = projectTasks(name);
  state.openTask = null;
  state.openProject = name;
  // Drops a `!task=` a click through from the task drawer left behind — see
  // syncHash() in 07-render-board.js — rather than leaving it stale until
  // whatever renders next happens to call syncHash() itself. Pushes, for the
  // same reason opening a card does.
  syncHash(true);

  state.openSubParent = null;
  hideSubPanel();
  $('#drawer').classList.add('projectview');
  $('#drawer').classList.toggle('readonly', state.locked);
  mountDrawerHead({
    title: name,
    help: 'A project is a folder, not a task — nothing here can be edited.',
    headline: null,
    folder: null,
  });

  const open = rows.filter(r => !r.task.done);
  const done = rows.filter(r => r.task.done);
  const count = rows.length === 1 ? '1 task' : rows.length + ' tasks';
  const split = done.length
    ? count + ', ' + done.length + ' finished'
    : count;

  const row = r => {
    const di = dueInfo(r.task.due);
    return '<button type="button" class="projrow' + (r.task.done ? ' done' : '') +
        '" data-open="' + r.task.id + '">' +
      // Rendered, like the same title on a card and in every other list.
      '<span class="pt">' + mdInline(r.task.title) + '</span>' +
      '<span class="pw">' + esc(r.bucket + ' · ' + r.tier) +
        (di ? '<em class="tag due ' + di.cls + '">' + esc(di.label) + '</em>' : '') +
        (r.task.headline ? '<em class="tag">the one thing</em>' : '') +
      '</span>' +
    '</button>';
  };

  clearDrawerBody();
  $('#dbody').innerHTML =
    // Filled in by loadProjectFiles() below, out of the folder's own
    // CLAUDE.md — what this project is, when it was opened, when it was last
    // touched. Empty until then rather than a placeholder: it is one line of
    // prose, and a spinner where a sentence is going is worse than a beat of
    // nothing.
    '<div class="projabout" id="projAbout"></div>' +
    '<div class="field"><span>Files in this folder</span>' +
      // A folder of the owner's own is not served over HTTP, so its path is text and
      // Open folder (on the live board only) is the way in.
      (isProjectPath(name)
        ? '<code class="projpath">' + esc(name) + '/</code>'
        : '<a class="projpath" href="' + esc(projectUrl(name)) + '" target="_blank" rel="noopener">' +
            'data/projects/' + esc(name) + '/</a>') +
      (state.demo || listFolder ? '' : '<div class="pactions"><button type="button" class="btn outline small" ' +
        'id="projOpenFolder">Open folder</button></div>') +
      '<div class="projfiles" id="projFiles"><span class="help">Reading the folder…</span></div>' +
    '</div>' +
    '<div class="field"><span>Tasks on this project</span>' +
      (rows.length
        ? '<div class="projlist">' + open.map(row).join('') + done.map(row).join('') + '</div>' +
          '<span class="help">' + esc(split) + '. Click one to open it.</span>'
        : '<span class="help">Nothing on the list points at this folder yet. A task joins it by ' +
          'naming the folder in a note: <code>' + esc(projectNoteLine(name).trim().replace(/^- /, '')) + '</code>.</span>') +
    '</div>';

  $('#dbody').querySelectorAll('.projrow').forEach(el => {
    el.onclick = () => openDrawer(el.dataset.open);
  });
  const openBtn = $('#projOpenFolder');
  if (openBtn) openBtn.onclick = () => openProjectFolder(name);

  $('#drawer').classList.add('open');
  $('#scrim').classList.add('open');
  loadProjectFiles(name);
}

/* Where the folder itself is served. translate_path() (kanban/server.py)
   resolves /data/ against the current dataset, so this is the same path
   whichever list is open, and the browser's own directory listing is what
   answers for a folder. */
function projectUrl(name){
  return '/data/projects/' + encodeURIComponent(name) + '/';
}

function fileSize(n){
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

/* ---- The folder's rows, shared by the task drawer's Files box and the
   project panel ----
   One list, Finder-style: folders first and opening in place under an
   aria-expanded toggle; one line a file, the name cut short by an ellipsis
   with the whole of it in the title, the size on the right. A Markdown name
   that starts with a date (2026-11-05-0900-ive-joined-the-team.md) reads as
   "Ive joined the team" with "5 Nov" beside the size, newest first. The files that
   run the folder rather than fill it (CLAUDE.md, and anything that is neither
   Markdown nor an image) wait under one shut "Project files" row.

   A folder's own rows are fetched when it is opened, one level a request
   (project_subfolder() in kanban/server.py), so a project keeping a
   checkout in sources/ costs nothing until somebody looks. */
const PF_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const PF_ICONS = {
  folder: '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12z"/>',
  doc:    '<path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3M6 8h4M6 10.5h4"/>',
  config: '<circle cx="8" cy="8" r="2"/><path d="M8 2v2M8 12v2M2 8h2M12 8h2M3.8 3.8l1.4 1.4M10.8 10.8l1.4 1.4M12.2 3.8l-1.4 1.4M5.2 10.8l-1.4 1.4"/>'
};
function pfIcon(kind){
  return '<svg class="pficon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" ' +
    'stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + PF_ICONS[kind] + '</svg>';
}
function tidyProjectName(name){
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:-(\d{4}))?-(.+)\.md$/i.exec(name);
  if (!m || +m[2] < 1 || +m[2] > 12) return null;
  const words = m[5].replace(/[-_]+/g, ' ').trim();
  if (!words) return null;
  return { label: words.charAt(0).toUpperCase() + words.slice(1),
           date: (+m[3]) + ' ' + PF_MONTHS[+m[2] - 1], key: m[1] + m[2] + m[3] + (m[4] || '0000') };
}
function isContentFile(e){
  return e.name !== 'CLAUDE.md' && /\.(md|markdown|png|jpe?g|gif|webp|svg|avif)$/i.test(e.name);
}
/* Where a folder is served from, or null for one outside data/ that is not
   served: its rows are plain text rather than links that would 404. */
function projectBase(name){ return isProjectPath(name) ? null : projectUrl(name); }

function projectFilesHTML(list, o){
  const sub = o.sub || '';
  const href = e => o.base + (sub ? sub.split('/').map(encodeURIComponent).join('/') + '/' : '') +
                    encodeURIComponent(e.name) + (e.dir ? '/' : '');
  const fileRow = e => {
    const tidy = !isContentFile(e) ? null : tidyProjectName(e.name);
    const kind = isContentFile(e) ? 'doc' : 'config';
    const inner = '<span class="pfchev none"></span>' + pfIcon(kind) +
      '<span class="pf">' + esc(tidy ? tidy.label : e.name) + '</span>' +
      '<span class="pfd">' + esc(tidy ? tidy.date : '') + '</span>' +
      '<span class="pfm">' + esc(fileSize(e.size)) + '</span>';
    return o.base
      ? '<a class="projfile" title="' + esc(e.name) + '" target="_blank" rel="noopener" href="' + esc(href(e)) + '">' + inner + '</a>'
      : '<div class="projfile" title="' + esc(e.name) + '">' + inner + '</div>';
  };
  const toggle = (cls, kind, label, meta, data, kids, title) =>
    '<div class="pfnode">' +
      '<button type="button" class="projfile pftoggle' + cls + '" aria-expanded="false" ' + data +
        ' title="' + esc(title) + '"><span class="pfchev"></span>' + pfIcon(kind) +
        '<span class="pf">' + esc(label) + '</span><span class="pfd"></span><span class="pfm">' + esc(meta) + '</span></button>' +
      '<div class="pfkids" hidden>' + kids + '</div></div>';
  const dirs = list.filter(e => e.dir).map(e => toggle(' isdir', 'folder', e.name + '/',
    e.children === null ? 'folder' : e.children + ' item' + (e.children === 1 ? '' : 's'),
    'data-sub="' + esc((sub ? sub + '/' : '') + e.name) + '"', '', e.name));
  const files = list.filter(e => !e.dir);
  const content = files.filter(isContentFile).sort((a, b) => {
    const ta = tidyProjectName(a.name), tb = tidyProjectName(b.name);
    if (ta && tb) return ta.key < tb.key ? 1 : ta.key > tb.key ? -1 : 0;
    if (ta || tb) return ta ? -1 : 1;
    return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
  });
  const running = files.filter(e => !isContentFile(e));
  const group = running.length
    ? toggle(' pfgroup', 'config', 'Project files', running.length + ' file' + (running.length === 1 ? '' : 's'),
             'data-group="1"', running.map(fileRow).join(''), 'Project files')
    : '';
  return dirs.join('') + content.map(fileRow).join('') + group;
}

/* One click handler on the box, so the rows it redraws need no wiring of
   their own. Opening a folder fetches its rows once and keeps them. */
function bindProjectFiles(box, name){
  const base = projectBase(name);
  box.onclick = async ev => {
    const btn = ev.target.closest('.pftoggle');
    if (!btn || !box.contains(btn)) return;
    const kids = btn.nextElementSibling;
    const open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(open));
    kids.hidden = !open;
    const sub = btn.dataset.sub;
    if (!open || !sub || kids.dataset.loaded) return;
    kids.dataset.loaded = '1';
    kids.innerHTML = '<span class="help">Reading the folder…</span>';
    try {
      const res = await fetch('/project.json?name=' + encodeURIComponent(name) +
                              '&sub=' + encodeURIComponent(sub) + '&t=' + Date.now(), { cache:'no-store' });
      if (!res.ok) throw new Error(res.status === 404 ? 'That folder is not on disk.' : 'Could not read that folder.');
      const got = await res.json();
      const rows = got.entries || [];
      kids.innerHTML = rows.length ? projectFilesHTML(rows, { base, sub }) : '<span class="help">The folder is empty.</span>';
    } catch (err) {
      delete kids.dataset.loaded;
      kids.innerHTML = '<span class="help">' + esc(String(err.message || err)) + '</span>';
    }
  };
}
function paintProjectFiles(box, list, name){
  box.innerHTML = projectFilesHTML(list, { base: projectBase(name), sub: '' });
  bindProjectFiles(box, name);
}

/* Whether the folder's CLAUDE.md calls the project something other than what
   the folder is called. The folder name is the identity — it is what a task's
   own note points at — so a title that only differs in capitals and hyphens
   is the same name twice and stays off screen. */
function differentTitle(title, name){
  const flat = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return !!title && flat(title) !== flat(name);
}

/* What the project is and when it was last touched, above everything else in
   the panel. Both come off disk with no upkeep: the description is the lead
   paragraph of the folder's own CLAUDE.md, and the date is the newest mtime
   in the folder — see project_about() and project_meta() in kanban/server.py.
   Nothing here is a field the owner has to remember to write. */
function projectAboutHTML(meta, name){
  const bits = [];
  if (meta.opened) bits.push('Opened ' + meta.opened);
  const edited = cvWhen(meta.modified);
  if (edited) bits.push('Edited ' + edited);
  return (differentTitle(meta.title, name)
            ? '<div class="projname">' + mdInline(meta.title) + '</div>' : '') +
    (meta.blurb
      ? '<p class="projblurb">' + mdInline(meta.blurb) + '</p>'
      : '<p class="projblurb none">Nothing describes this folder yet. A <code>CLAUDE.md</code> ' +
        'in it, opening with a heading and a sentence, is what this line reads.</p>') +
    (bits.length ? '<div class="projwhen">' + esc(bits.join(' · ')) + '</div>' : '');
}

/* What is in the folder, one level down and no further — the server decided
   that, see project_entries() in kanban/server.py. A sub-folder is one row
   carrying its own count rather than its contents, and clicking it hands the
   walk to the browser's directory listing, which is where a walk belongs.

   One fetch fills both halves of the panel: the description at the top and
   the file rows under the path. They come out of the same read of the same
   folder, so asking twice would be two reads for one answer. */
async function loadProjectFiles(name){
  const paint = (html, aboutHtml) => {
    // The drawer may have moved on to another project, or shut, while this
    // was in flight — every openProjectDrawer() call starts one of these.
    if (state.openProject !== name) return;
    const box = $('#projFiles');
    if (box) box.innerHTML = html;
    const top = $('#projAbout');
    if (top) top.innerHTML = aboutHtml || '';
  };
  let meta;
  try {
    const res = await fetch('/project.json?name=' + encodeURIComponent(name) + '&t=' + Date.now(),
                            { cache:'no-store' });
    if (res.status === 404) return paint('<span class="help">That folder is not on disk.</span>');
    if (!res.ok) {
      return paint('<span class="help">The board helper needs restarting — the copy running ' +
                   'does not list project files yet.</span>');
    }
    meta = await res.json();
  } catch (err) {
    return paint('<span class="help">Could not read the folder. ' + esc(String(err.message || err)) +
                 '</span>');
  }
  const about = projectAboutHTML(meta, name);
  const list = meta.entries || [];
  if (!list.length) return paint('<span class="help">The folder is empty.</span>', about);
  paint(projectFilesHTML(list, { base: projectBase(name), sub: '' }), about);
  const box = $('#projFiles');
  if (box && state.openProject === name) bindProjectFiles(box, name);
}

/* Which of the drawer's own sections — Description, Chats, Message
   suggestions, Prompt suggestions — are shut, remembered the same way the
   drawer's own width is: a preference about the drawer's shape, not about
   one task, so closing Chats once keeps it closed on every task after.
   Absent means open, so a fresh clone or a section invented after this
   shipped both default to shown. */
/* How tall the Description stands, remembered the same way and for the same
   reason: it is a preference about the drawer's shape, not about one task.
   One number covers both halves of the field — the rendering and the textarea
   are the same box in two states, and a note that changed height the moment
   you clicked into it would drag every field under it out from under the
   pointer.

   The default is short on purpose. Most notes are two lines, and a field
   sized for the long ones pushed Bucket, Column and the dates below the fold
   on every task that wasn't. The field's own corner drags it taller for the
   long ones. */
const NOTE_H_KEY = 'bench-note-height';
const NOTE_H_MIN = 120;
function noteHeight(){
  let n;
  try { n = parseInt(localStorage.getItem(NOTE_H_KEY), 10); } catch (e) { return NOTE_H_MIN; }
  return Number.isFinite(n) ? Math.max(NOTE_H_MIN, Math.min(n, 2000)) : NOTE_H_MIN;
}
function setNoteHeight(px){
  try { localStorage.setItem(NOTE_H_KEY, String(Math.round(px))); } catch (e) {}
}
/* The one watching the current field. openDrawer redraws the whole panel on
   every edit, so without disconnecting the last one there would be an
   observer per redraw, all of them still writing the same preference. */
let noteResizeObs = null;
/* The React root behind #f-body-mount. openDrawer rebuilds #dbody's whole
   innerHTML on every open, which throws away the mount's host node without
   ever telling React — see the note above mount()/unmount() in kanban/ui —
   so this is torn down explicitly before the next one is created. */
let bodyMountEl = null;
/* Same for the sub-task panel's own Note and its send-back message. */
let subNoteMountEl = null;
let sendbackMountEl = null;

const SECTION_KEY = 'bench-collapsed';
// Sections that start shut. Missing from storage means open for every other
// key, so these two states are stored explicitly: true shut, false open.
const DEFAULT_CLOSED = { details: true };
function sectionCollapsed(key){
  try {
    const v = (JSON.parse(localStorage.getItem(SECTION_KEY) || '{}') || {})[key];
    return v === undefined ? !!DEFAULT_CLOSED[key] : !!v;
  }
  catch (e) { return !!DEFAULT_CLOSED[key]; }
}
function setSectionCollapsed(key, collapsed){
  let all;
  try { all = JSON.parse(localStorage.getItem(SECTION_KEY) || '{}') || {}; } catch (e) { all = {}; }
  if (collapsed) all[key] = true; else if (DEFAULT_CLOSED[key]) all[key] = false; else delete all[key];
  try { localStorage.setItem(SECTION_KEY, JSON.stringify(all)); } catch (e) {}
}
/* Overview's own sections — Big rocks, This week, Quick wins — and the two
   Reports columns (`ov:` keys too) default open: an overview is meant to be skimmed in one
   glance, not clicked open section by section. Remembers which ones the owner has
   shut, per section, the same way the drawer's are. A separate key from the
   drawer's, so a section name the two happen to share cannot cross-wire
   their two different defaults. */
const OVSECTION_KEY = 'bench-overview-closed';
function overviewOpen(key){
  try { return !((JSON.parse(localStorage.getItem(OVSECTION_KEY) || '{}') || {})[key]); }
  catch (e) { return true; }
}
function setOverviewOpen(key, open){
  let all;
  try { all = JSON.parse(localStorage.getItem(OVSECTION_KEY) || '{}') || {}; } catch (e) { all = {}; }
  if (!open) all[key] = true; else delete all[key];
  try { localStorage.setItem(OVSECTION_KEY, JSON.stringify(all)); } catch (e) {}
}
/* A suggestion the owner does not want dismissed without touching the task itself —
   the whole point is that nothing about the task changes, so nothing here
   writes to todo.md. Keyed on the task id plus the sub-step's own line, since
   two sub-steps under one task share the task's id and would otherwise
   dismiss each other. Persisted the same way the collapsed sections are, so
   it survives a reload rather than resetting every time the board opens. */
const QUICK_DISMISS_KEY = 'bench-quick-dismissed';
function quickKey(it){ return it.id + (it.sub ? ':' + it.sub.line : ''); }
function quickDismissedSet(){
  try { return new Set(JSON.parse(localStorage.getItem(QUICK_DISMISS_KEY) || '[]')); }
  catch (e) { return new Set(); }
}
function setQuickDismissed(set){
  try { localStorage.setItem(QUICK_DISMISS_KEY, JSON.stringify([...set])); } catch (e) {}
}

/* A <details>'s own toggle event does not bubble in every browser, but the
   capture phase still sees it on the way down regardless of that — so one
   listener here, rather than one wired up inside openDrawer on every redraw,
   covers every collapsible section the drawer ever draws. */
document.addEventListener('toggle', e => {
  const ds = e.target.dataset || {};
  if (ds.collapse) setSectionCollapsed(ds.collapse, !e.target.open);
  // Overview's columns are drawn by Tenon's Column like every
  // other column rather than by a `.listcard` of their own — so the attribute
  // is the component's (data-column-collapse) while the keys are still
  // Overview's `ov:` ones, and a section the owner shut before the change stays shut
  // after it.
  else if (ds.columnCollapse) setOverviewOpen(ds.columnCollapse, e.target.open);
  else if (ds.tlcollapse) setSectionCollapsed(ds.tlcollapse, !e.target.open);
}, true);

/* Drag the panel's left edge to make it wider; the width is remembered. */
function drawerMax(){
  const w = window.innerWidth || document.documentElement.clientWidth || 1280;
  return Math.max(360, w - 120);
}
/* Apply fits the panel to the window; set records what the user actually wants,
   so a narrow window never quietly overwrites their chosen width. */
function applyDrawerWidth(){
  $('#drawer').style.width = Math.round(Math.min(Math.max(state.drawerWidth, 340), drawerMax())) + 'px';
}
function setDrawerWidth(px){
  state.drawerWidth = Math.round(Math.min(Math.max(px, 340), 1200));
  try { localStorage.setItem('bench-drawer', state.drawerWidth); } catch (e) {}
  applyDrawerWidth();
}
applyDrawerWidth();
(() => {
  const grip = $('#dgrip');
  grip.onpointerdown = e => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('active');
    document.body.classList.add('resizing');
    const move = ev => setDrawerWidth(window.innerWidth - ev.clientX);
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.classList.remove('active');
      document.body.classList.remove('resizing');
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up, { once:true });
    grip.addEventListener('pointercancel', up, { once:true });
  };
  grip.ondblclick = () => setDrawerWidth(400);
})();
window.addEventListener('resize', applyDrawerWidth);

$('#closeDrawer').onclick = closeDrawer;
$('#scrim').onclick = closeDrawer;
$('#closeSub').onclick = closeSubPanel;
$('#subscrim').onclick = closeSubPanel;

/* Project chips are drawn inside cards, and a card opens its task on click.
   Capture phase, on the document, so the chip answers first and the card behind
   it never hears about it — one handler covering the board, the lists and the
   panel's own Project button, none of which need to know this exists. */
document.addEventListener('click', e => {
  const chip = e.target.closest('[data-project]');
  if (!chip) return;
  e.preventDefault();
  e.stopPropagation();
  openProjectDrawer(chip.dataset.project);
}, true);

$('#del').onclick = () => {
  if (state.locked) return;
  const loc = state.openTask && locate(state.openTask);
  if (!loc) return;
  if (!confirm('Delete "' + loc.task.title + '"? This removes it from todo.md when you save.')) return;
  loc.tier.tasks.splice(loc.index, 1);
  closeDrawer(); markDirty(); refreshView();
};
$('#undo').onclick = undo;
document.addEventListener('keydown', e => {
  /* The sub-task panel sits over the task drawer, so Escape takes off only
     the top one. A selection with nothing else open is the next thing Escape
     can mean, ahead of falling through to closeDrawer() with no drawer to
     close. */
  if (e.key === 'Escape') {
    if (subPanelOpen()) closeSubPanel();
    else if (!state.openTask && !state.openProject && state.selectedIds.size) clearSelection();
    else closeDrawer();
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); }
  // Not while a field has focus — cmd/ctrl+Z there means "undo my last few
  // keystrokes", which the browser already does natively on that one field.
  // Hijacking it for a whole-document undo would be a surprise, not a fix.
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
    const tag = (document.activeElement || {}).tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') { e.preventDefault(); undo(); }
  }
});

/* =========================================================================
   Bulk card editing — state.selectedIds (02-state.js) is a Set of task ids,
   toggled by shift- or cmd/ctrl-click on a card (TaskCard.tsx's onOpen, wired
   in 18-timeline.js's renderBoard(); cardModel(), 09-columns.js, draws the
   same task's `selected` class wherever it renders). Everything here acts on
   the whole set at once — each action below is one markDirty() regardless of
   how many cards it touches, so undo (05-undo.js) puts every one of them
   back in a single step, not one step per card.
   ========================================================================= */

function toggleCardSelect(id){
  if (state.locked) return;
  if (state.selectedIds.has(id)) state.selectedIds.delete(id);
  else state.selectedIds.add(id);
  renderBoard();
  renderBulkBar();
}

function clearSelection(){
  if (!state.selectedIds.size) return;
  state.selectedIds.clear();
  renderBoard();
  renderBulkBar();
}

/* Every selected id resolved to where it actually is, dropping any that have
   gone since — closed by a save elsewhere, say. locate() is the one place
   that answers "where", so a bulk action never has to walk the buckets
   itself to find out. */
function selectedLocations(){
  return [...state.selectedIds].map(id => locate(id)).filter(Boolean);
}

/* The bar itself: a count and the three actions, drawn fresh from state.doc
   each time rather than diffed, since it is at most one row and only ever
   redrawn on a selection change or a view switch. Hidden by its own check on
   state.view — see renderView() (18-timeline.js) — rather than cleared by
   leaving the board, so the pick is still there if the owner switches back to it. */
function renderBulkBar(){
  const bar = $('#bulkBar');
  if (!bar) return;
  const n = state.selectedIds.size;
  const show = n > 0 && state.view === 'board' && !state.locked;
  bar.classList.toggle('hidden', !show);
  if (!show) return;
  bar.innerHTML =
    '<span class="bulkcount">' + n + ' card' + (n === 1 ? '' : 's') + ' selected</span>' +
    '<span class="spacer"></span>' +
    '<button class="btn small" id="bulkColBtn">Move to column</button>' +
    '<button class="btn small" id="bulkBucketBtn">Move to bucket</button>' +
    '<button class="btn small danger" id="bulkDelBtn">Delete</button>' +
    '<button class="btn small ghost" id="bulkClearBtn">Clear</button>';
  $('#bulkColBtn').onclick = openBulkColumnPicker;
  $('#bulkBucketBtn').onclick = openBulkBucketPicker;
  $('#bulkDelBtn').onclick = bulkDeleteSelected;
  $('#bulkClearBtn').onclick = clearSelection;
}

/* Same sheet shape as confirmDeleteHeading (08-buckets.js): a <select> read as
   it changes, since showModal takes the sheet down before Move runs and the
   select is gone by then. Every column is offered, Done included — a bulk
   move is a plain relocation, not a tick, so it carries none of moveCardTo()'s
   (04-tier-two-the-one-thing.js) guard against landing on or leaving Done. */
function openBulkColumnPicker(){
  const locs = selectedLocations();
  if (!locs.length) return;
  const options = tierOrder().concat([DONE_COL]);
  let dest = options[0];
  showModal('Move ' + locs.length + ' card' + (locs.length === 1 ? '' : 's') + ' to a column',
    'Each keeps its bucket and lands at the top of the column you pick, whatever column it is in now.',
    '<label class="field"><span>Column</span><select id="bulkColDest">' +
      options.map((name, i) => '<option value="' + i + '">' + esc(tierLabel(name)) + '</option>').join('') +
    '</select></label>',
    [{ label: 'Cancel' }, { label: 'Move', primary: true, run: () => bulkMoveToColumn(dest) }]);
  const sel = modalEl.querySelector('#bulkColDest');
  sel.onchange = () => { dest = options[+sel.value]; };
}

function openBulkBucketPicker(){
  const locs = selectedLocations();
  if (!locs.length || state.doc.buckets.length < 2) return;
  const options = state.doc.buckets;
  let dest = options[0];
  showModal('Move ' + locs.length + ' card' + (locs.length === 1 ? '' : 's') + ' to a bucket',
    'Each keeps its column, its text and its tags, and lands in the bucket you pick here.',
    '<label class="field"><span>Bucket</span><select id="bulkBucketDest">' +
      options.map((b, i) => '<option value="' + i + '">' + esc(b.name) + '</option>').join('') +
    '</select></label>',
    [{ label: 'Cancel' }, { label: 'Move', primary: true, run: () => bulkMoveToBucket(dest) }]);
  const sel = modalEl.querySelector('#bulkBucketDest');
  sel.onchange = () => { dest = options[+sel.value]; };
}

/* The Bucket field's own move (PICK_SPECS['f-bucket'] in openDrawer)
   looped once per selected task: splice out of where it is, ensureTier() the
   same column name in the new bucket, push it in. */
function bulkMoveToColumn(tierName){
  if (state.locked) return;
  let moved = 0;
  state.selectedIds.forEach(id => {
    const loc = locate(id);
    if (!loc || loc.tier.name === tierName) return;
    loc.tier.tasks.splice(loc.index, 1);
    ensureTier(loc.bucket, tierName).tasks.unshift(loc.task);
    // Into Done ticks the card, out of Done unticks it, the same as ticking
    // it by hand; `stay` because the card has already been placed.
    const inDone = tierName === DONE_COL;
    if (loc.task.done !== inDone) setDone(loc.task, inDone, { stay: true });
    moved++;
  });
  state.selectedIds.clear();
  if (moved) markDirty();
  refreshView();
  renderBulkBar();
}

function bulkMoveToBucket(bucket){
  if (state.locked) return;
  let moved = 0;
  state.selectedIds.forEach(id => {
    const loc = locate(id);
    if (!loc || loc.bucket === bucket) return;
    const target = ensureTier(bucket, loc.tier.name);
    loc.tier.tasks.splice(loc.index, 1);
    target.tasks.push(loc.task);
    moved++;
  });
  state.selectedIds.clear();
  if (moved) markDirty();
  refreshView();
  renderBulkBar();
}

/* One confirm(), naming the count and the first few titles, same as the
   drawer's own #del above — never one confirm() per card. Re-reads each
   task's index at delete time rather than trusting loc.index, since an
   earlier splice in this same pass can have shifted it. */
function bulkDeleteSelected(){
  if (state.locked) return;
  const locs = selectedLocations();
  if (!locs.length) return;
  const names = locs.slice(0, 3).map(l => '"' + l.task.title + '"').join(', ');
  const more = locs.length > 3 ? ' and ' + (locs.length - 3) + ' more' : '';
  if (!confirm('Delete ' + locs.length + ' task' + (locs.length === 1 ? '' : 's') + ' — ' + names + more +
    '? This removes them from todo.md when you save.')) return;
  if (state.openTask && state.selectedIds.has(state.openTask)) closeDrawer();
  locs.forEach(loc => {
    const i = loc.tier.tasks.indexOf(loc.task);
    if (i > -1) loc.tier.tasks.splice(i, 1);
  });
  state.selectedIds.clear();
  markDirty();
  refreshView();
  renderBulkBar();
}

