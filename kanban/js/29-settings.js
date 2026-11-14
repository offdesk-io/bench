'use strict';

/* =========================================================================
   Settings and first-run setup. One form, two doors: Data > Settings opens it
   any time, and a checkout with no profile (or a profile whose Name is still
   the template's placeholder) gets it on load, as a welcome that cannot be
   dismissed: no ×, no Skip, Escape does nothing. Step 1 is Name and Country
   (both required) and the agent options; step 2 is the first list, shown after
   step 1 when the checkout has no list yet, and on its own when the profile is
   set but no list exists.

   Name, Country and Region live in data/profile.md, behind /profile-basics.json,
   and so does How to address you, which Settings offers beside them (not the
   welcome). The facts file and the profile's four sections, Setup, Writing,
   Meeting recorder and Working habits, are edited on the Memory page and go
   through the same route. Signed in (state.who), the profile is the person's
   own, data/users/<hash>.profile.md, and the form is that profile's name and
   address alone; the server's settings are not theirs to change, and the
   list's sharing is a button beside it.
   The model per job, when each agent starts, the memory folder and each list's
   projects folder live in data/settings.json, behind /settings.json. The
   folders are offered in Settings only, not the welcome, the projects folder
   for the open list alone, and each is sent only when it changed, so a folder
   that has since gone missing does not stop the rest saving. The daily
   budgets, one per agent and one for all of them together, go through /settings.json too, but the server writes them to
   the agents engine's fences file (data/agents/fences.json), where the engine
   reads them. The server keeps no state for any of it, so a save is two PUTs
   and nothing else. The list is made by POST /datasets, the same route the
   Lists menu's "New list" uses.
   ========================================================================= */
/* The bucket agents' two jobs, each on a model of its own. How each bucket's
   agent works and when it starts are in that bucket's brief, not here. */
const SETTINGS_AGENTS = [
  ['plan', 'Model for plans', 'What a plan-first bucket’s agent writes its plan on.'],
  ['implement', 'Model for the work', 'What a bucket’s agent does the work on, with a plan or without.'],
];
/* The id the agents engine keys a daily budget by in fences.json. */
const SETTINGS_BUDGET_IDS = { bucket: 'bucket-agent' };
const SETTINGS_OTHER = [
  ['chat', 'Chat', 'The chat window.'],
  ['brief', 'Brief', 'Bucket briefs.'],
];
/* What a job runs on when nothing is chosen anywhere: briefs use Haiku
   (MODEL in agents/bucket-agent/brief.py), everything else leaves the choice to
   Claude Code. */
const SETTINGS_OWN_MODEL = { brief: 'Haiku' };
const SETTINGS_CLAUDE_DEFAULT = 'Claude Code’s default';
/* Pre-selections for a first run; Settings opens on what is saved. */
const ONBOARD_MODELS = { default: 'sonnet', brief: 'haiku' };
/* The first list. Editable and removable; the description becomes the opening
   of each bucket's brief, which defines that bucket's agent. */
const ONBOARD_LIST = 'Work';
const ONBOARD_BUCKETS = [
  { name: 'Making', about: 'Designing, writing or building something new. Ends in a file, a draft or a prototype.' },
  { name: 'People', about: 'Feedback, one-to-ones, hiring and conversations. Ends in a decision, a message sent or notes shared.' },
  { name: 'Admin', about: 'Email, forms, bills and bookings. Ends in something sent, paid or booked.' },
  { name: 'Learning', about: 'Courses, reading and experiments. Ends in notes, or a skill tried on real work.' },
];

/* The profile's About lines beyond Name, Country and Region. */
const SETTINGS_ABOUT = [
  ['addressing', 'How to address you', 'How a message to you opens, e.g. “Hey Sam”. Empty means none.'],
  ['facts_file', 'Facts file', 'A file about you that agents read when it is set. Empty means none.'],
];
/* The profile's other sections, one text box each, in the template's order. */
const SETTINGS_SECTIONS = [
  ['setup', 'Setup', 'Where this repo is, and the folders the agents may read beyond it.'],
  ['writing', 'Writing', 'Your spelling, how a message to a person opens, and your writing rules or a path to them.'],
  ['recorder', 'Meeting recorder', 'The recorder the PA reads action items from, and the name it uses for you.'],
  ['habits', 'Working habits', 'How you work, so the PA can weigh tasks against it. One bullet each.'],
];

const settingsCap = m => m.charAt(0).toUpperCase() + m.slice(1);

function settingsRegionOptions(draft){
  return '<option value="">Whole country</option>' + draft.regions.map(r =>
    '<option value="' + escAttr(r.code) + '"' + (draft.region === r.code ? ' selected' : '') + '>' + esc(r.name) + '</option>').join('');
}

/* What the empty option of a model select resolves to right now. */
function settingsResolved(key, models){
  if (key === 'default') return SETTINGS_CLAUDE_DEFAULT + ' (' + SETTINGS_OWN_MODEL.brief + ' for briefs)';
  if (models.default) return settingsCap(models.default);
  return SETTINGS_OWN_MODEL[key] || SETTINGS_CLAUDE_DEFAULT;
}
function settingsEmptyLabel(key, models){
  return key === 'default'
    ? 'Not set: ' + settingsResolved(key, models)
    : 'Use default (' + settingsResolved(key, models) + ')';
}

function settingsModelField(key, name, help, draft, choices){
  return tenonFieldHTML({ label: name, kind: 'select', attrs: 'data-model="' + key + '"', readonly: state.locked,
    options: '<option value="">' + esc(settingsEmptyLabel(key, draft.models)) + '</option>' +
      choices.map(m => '<option value="' + esc(m) + '"' + (draft.models[key] === m ? ' selected' : '') + '>' + esc(settingsCap(m)) + '</option>').join(''),
    hint: help });
}

function settingsCountryOptions(draft, first){
  let none = '';
  if (first) none = '<option value="">Choose a country</option>';
  else if (draft.legacy.length) none = '<option value="">Keep current (' + esc(draft.legacy.map(r => r === 'PT' ? 'Portugal' : r).join(' and ')) + ')</option>';
  else if (!draft.country) none = '<option value="">Not set (UK and Portugal)</option>';
  return none + draft.countries.map(c => '<option value="' + escAttr(c.code) + '"' + (draft.country === c.code ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('');
}

function settingsAboutField(draft, key){
  const f = SETTINGS_ABOUT.find(a => a[0] === key);
  if (!f || !(key in draft.about)) return '';
  return tenonFieldHTML({ label: f[1], attrs: 'data-about="' + key + '"', value: draft.about[key], placeholder: 'Not set', hint: f[2], err: 'data-err="about-' + key + '"' });
}

/* "This board": the open list's own memory folder, banners and agents, kept
   under boards.<list> in settings.json. Not offered in the welcome or signed in,
   where the server's settings are not the visitor's. */
const BOARD_MEMORY_MODES = [['inherit', 'Same as main memory folder'], ['none', 'None, keep everything in Bench'], ['own', 'Its own folder']];

function boardSwitchHTML(attr, on, name, help){
  return tenonFieldHTML({ label: name, kind: 'switch', attrs: attr, on, hint: help });
}

/* The board's own memory folder: the choice, and the path it asks for when it
   is "Its own folder". Shared by the pop-up's This board group and the page's
   Folders section. */
function boardMemoryFieldHTML(draft, label){
  const b = draft.board;
  return tenonFieldHTML({ label: label || 'Memory folder', kind: 'select', attrs: 'data-board-memory-mode',
    options: BOARD_MEMORY_MODES.map(([v, l]) => '<option value="' + v + '"' + (b.mode === v ? ' selected' : '') + '>' + esc(l) + '</option>').join(''),
    hint: 'Where facts about you and this list’s people are kept. Same as main uses the memory folder above, None keeps everything in data/' + draft.list + '/.' }) +
    tenonFieldHTML({ label: 'Folder path', attrs: 'data-board-memory' + (b.mode === 'own' ? '' : ' hidden'), value: b.path, placeholder: '/absolute/path/to/folder',
      wrap: 'data-board-memory-field' + (b.mode === 'own' ? '' : ' hidden'), err: 'data-err="board-memory"' });
}

function boardGroupHTML(draft, first){
  if (first || draft.signedIn || !draft.list) return '';
  const b = draft.board;
  return '<div class="agentopts__group" data-board-group><h4>This board</h4>' +
    boardMemoryFieldHTML(draft) +
    boardSwitchHTML('data-board-banners', b.banners, 'Desktop banners', 'A banner when a task on this board is due. Off, it sends none.') +
    boardSwitchHTML('data-board-agents', b.agents, 'Agents', 'Lets this board’s bucket agents work. Off, they leave it alone.') +
    '</div>';
}

function settingsNameFields(draft){
  return tenonFieldHTML({ label: 'Name', attrs: 'data-name', value: draft.name, placeholder: 'First name',
    hint: draft.signedIn ? 'What the PA calls you.' : 'Who the review sub-tasks are assigned to.', err: 'data-err="name"' });
}

function settingsPlaceFields(draft, first){
  return tenonFieldHTML({ label: 'Country', kind: 'select', attrs: 'data-country', options: settingsCountryOptions(draft, first),
    hint: 'Its public holidays count as days off.',
    notes: tenonFieldNote('data-nolist', 'No public holiday list available for this country, so only weekends count as days off.'),
    err: 'data-err="country"' }) +
    tenonFieldHTML({ label: 'Region', kind: 'select', attrs: 'data-region', options: settingsRegionOptions(draft),
      wrap: 'data-region-field' + (draft.regions.length ? '' : ' hidden') });
}

function settingsMemoryFolderField(draft){
  return tenonFieldHTML({ label: 'Memory folder', attrs: 'data-memory', value: draft.memoryRoot, placeholder: 'Not set',
    hint: 'A folder outside Bench that keeps facts about you for other agents to share. Set, your profile and each board’s people, company text and Context are read from there first, and Bench lists its boards in boards.md inside it. A board can use a different folder, or none, under “This board”. Empty means none.' });
}

function settingsProjectsField(draft){
  return tenonFieldHTML({ label: 'Projects folder for ' + draft.list, attrs: 'data-projects', value: draft.projectsRoot, placeholder: 'Not set',
    hint: 'A folder of this list’s own, one folder per project inside it, which no other list may use. Set, a project is looked for there first and new ones are made there. Empty keeps them in data/' + draft.list + '/projects/.' });
}

function settingsChimeField(draft, help){
  return tenonFieldHTML({ label: 'Reply chime', kind: 'switch', attrs: 'data-chime', on: draft.chime,
    hint: help || 'A short sound when a reply finishes in any chat: two rising notes for done, one low note for an error or a stop.' });
}

function settingsFormHTML(draft, choices, first){
  const you = settingsNameFields(draft) + (first ? '' : settingsAboutField(draft, 'addressing')) + settingsPlaceFields(draft, first);
  if (draft.signedIn) {
    const sharing = draft.list ? '<div><button type="button" class="btn ghost small" data-sharing>Who sees ' + esc(prettyDataset(draft.list)) + '</button></div>' : '';
    return '<div class="setupform">' + you + sharing + '</div>';
  }
  return '<div class="setupform">' + you +
    (first ? '' : settingsMemoryFolderField(draft)) +
    (first || !draft.list ? '' : settingsProjectsField(draft)) +
    boardGroupHTML(draft, first) + settingsChimeField(draft) + '</div>';
}

/* ---- The page layout every tab of the Settings page shares ----

   A title row with a Save on its right and a divider under it, then one row per
   section: its title on the left, its fields on the right, 3:9. A second Save
   closes the content. `sections` is [{ id, title, description, html, wide }], description being a line under the title that says what the group is for, wide letting the fields use the whole
   right-hand column. `opts.save` false
   leaves both Saves out (Backups); `opts.saveAttr` is the data attribute the
   caller wires its handler to. Under 900px each section stacks, title first. */
function settingsPageLayoutHTML(title, sections, opts){
  opts = opts || {};
  const save = opts.save === false ? '' :
    '<button type="button" class="btn primary" ' + (opts.saveAttr || 'data-settings-save') + '>Save</button>';
  return '<div class="spage">' +
    '<div class="spage__head"><h1 class="spage__title">' + esc(title) + '</h1>' + save + '</div>' +
    sections.map(sec =>
      '<section class="spage__section" data-section="' + escAttr(sec.id || sec.title) + '">' +
        '<div class="spage__side"><h2 class="spage__label">' + esc(sec.title) + '</h2>' +
          (sec.description ? '<p class="spage__desc"' + (sec.descAttrs ? ' ' + sec.descAttrs : '') + '>' + esc(sec.description) + '</p>' : '') + '</div>' +
        '<div class="spage__fields' + (sec.wide ? ' spage__fields--wide' : '') + '">' + sec.html + '</div></section>').join('') +
    (save ? '<div class="spage__foot">' + save + '</div>' : '') +
    '</div>';
}

/* ---- Tenon's Field, drawn as a string ----

   Settings and Memory are HTML strings, so Field.tsx's markup is written out
   here once (tenon/src/components/Field): a .tenon-field block holding the
   label tied to its control by for/id, the control, the hint under it, and an
   error line that shows in place when there is one. Nothing on those pages
   styles a field itself; every labelled text box, number, dropdown and textarea
   comes through this. o: label, kind ('input' | 'textarea' | 'select' |
   'switch'), attrs (data-* and the like, as a string), value, type,
   placeholder, rows, options (a select's <option>s, as HTML), hint, hintAttrs,
   notes (extra lines under the hint, as HTML), err (the data attribute naming
   the error line, e.g. 'data-err="name"'), required, readonly (disabled on a select or a switch, which have no read-only), on (a switch),
   wrap (attributes on the block, e.g. 'data-region-field hidden'). */
/* True when a write must not go out: a locked tab (the example list, a backup
   preview) saves nothing, and a tab whose list the server has moved off, from
   another tab, goes over to that list through the board's own prompt rather
   than writing into it. Every save on the Settings, Memory and Agents pages asks. */
/* The welcome (first run) opens over the example list, which is locked, and has
   to save: its two steps are exempt from the lock. */
let settingsWelcome = false;
/* Only while the welcome's modal is on screen, and cleared on every way it ends. */
const settingsLocked = () => state.locked && !(settingsWelcome && !!modalEl);
function writeBlocked(){
  if (settingsLocked()) return true;
  if (state.boardMoved) { boardMoved(state.boardMoved, true); return true; }
  return false;
}

let tenonFieldSeq = 0;
const TENON_CHEVRON = '<svg class="tenon-select__chevron" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function tenonFieldHTML(o){
  const id = 'tf-' + (++tenonFieldSeq), hintId = id + '-note', errId = id + '-err';
  const kind = o.kind || 'input';
  const hasHint = o.hint !== undefined && o.hint !== null && o.hint !== '';
  const ro = o.readonly || settingsLocked();
  const common = ' id="' + id + '"' + (hasHint ? ' aria-describedby="' + hintId + '"' : '') + (o.required ? ' required' : '') +
    (ro ? (kind === 'select' || kind === 'switch' ? ' disabled' : ' readonly') : '') + (o.attrs ? ' ' + o.attrs : '');
  let control;
  if (kind === 'select') {
    control = '<span class="tenon-field__select"><select class="tenon-field__control"' + common + '>' + (o.options || '') + '</select>' + TENON_CHEVRON + '</span>';
  } else if (kind === 'textarea') {
    control = '<textarea class="tenon-field__control" rows="' + (o.rows || 5) + '"' + common + ' placeholder="' + escAttr(o.placeholder || '') + '" spellcheck="true">' + esc(o.value || '') + '</textarea>';
  } else if (kind === 'switch') {
    control = '<button type="button" role="switch" class="tenon-switch' + (o.on ? ' tenon-switch--on' : '') + '" aria-checked="' + !!o.on + '"' + common + '></button>';
  } else {
    control = '<input class="tenon-field__control" type="' + (o.type || 'text') + '"' + common + ' value="' + escAttr(o.value || '') + '"' + (o.placeholder ? ' placeholder="' + escAttr(o.placeholder) + '"' : '') + '>';
  }
  return '<div class="tenon-field"' + (o.wrap ? ' ' + o.wrap : '') + '>' +
    '<label class="tenon-field__label" for="' + id + '">' + esc(o.label) +
      (o.required ? '<span class="tenon-field__required" aria-hidden="true">*</span>' : '') + '</label>' +
    control +
    (hasHint ? '<span id="' + hintId + '" class="tenon-field__note"' + (o.hintAttrs ? ' ' + o.hintAttrs : '') + '>' + esc(o.hint) + '</span>' : '') +
    (o.notes || '') +
    (o.err ? '<span id="' + errId + '" class="tenon-field__note tenon-field__note--error" ' + o.err + ' hidden></span>' : '') +
    '</div>';
}
/* A line under a field that shows only when it applies, as Field's own note. */
function tenonFieldNote(attrs, text){
  return '<span class="tenon-field__note" ' + attrs + ' hidden>' + esc(text) + '</span>';
}
/* Shows or clears the error line of a field drawn by tenonFieldHTML, as Field
   does for an error: the block goes invalid, the control says so, and the
   error describes the control as well as the hint. A line outside such a field
   is only shown or hidden. */
function tenonFieldError(el, msg){
  el.textContent = msg || '';
  el.hidden = !msg;
  const field = el.closest('.tenon-field');
  const control = field && field.querySelector('.tenon-field__control');
  if (!field || !control) return;
  field.classList.toggle('tenon-field--invalid', !!msg);
  if (msg) control.setAttribute('aria-invalid', 'true'); else control.removeAttribute('aria-invalid');
  const ids = (control.getAttribute('aria-describedby') || '').split(/\s+/).filter(x => x && x !== el.id);
  if (msg) ids.push(el.id);
  if (ids.length) control.setAttribute('aria-describedby', ids.join(' ')); else control.removeAttribute('aria-describedby');
}

/* The Settings tab's sections. Signed in, the profile is the visitor's own and
   the server's settings are not theirs, so only You is offered, with How to
   address you, which has no other home for them. */
function settingsPageSections(draft){
  const sections = [{ id: 'you', title: 'You',
    html: settingsNameFields(draft) + (draft.signedIn ? settingsAboutField(draft, 'addressing') : '') + settingsPlaceFields(draft, false) +
      (draft.signedIn && draft.list ? '<div><button type="button" class="btn ghost small" data-sharing>Who sees ' + esc(prettyDataset(draft.list)) + '</button></div>' : '') }];
  if (draft.signedIn) return sections;
  sections.push({ id: 'folders', title: 'Folders',
    html: settingsMemoryFolderField(draft) + (draft.list ? settingsProjectsField(draft) + boardMemoryFieldHTML(draft, 'This board’s memory folder') : '') });
  if ('setup' in draft.sections) {
    const [, name, help] = SETTINGS_SECTIONS.find(x => x[0] === 'setup');
    sections.push({ id: 'setup', title: name,
      html: tenonFieldHTML({ label: name, kind: 'textarea', attrs: 'data-setup', value: draft.sections.setup,
        placeholder: draft.hints.setup || '', hint: help, err: 'data-err="setup"' }) });
  }
  sections.push({ id: 'notifications', title: 'Notifications',
    html: (draft.list ? boardSwitchHTML('data-board-banners', draft.board.banners, 'Desktop banners', 'A banner when a task on this board is due, on this board only. Off, it sends none.') : '') +
      settingsChimeField(draft, 'A short sound when a reply finishes in any chat, on every board: two rising notes for done, one low note for an error or a stop.') });
  return sections;
}

async function loadSettingsDraft(first){
  const signedIn = !!state.who;
  const [prof, set, places] = await Promise.all([
    fetch('/profile-basics.json').then(r => r.json()),
    /* Signed in, the server's settings are not the visitor's to change. */
    signedIn ? Promise.resolve({}) : fetch('/settings.json').then(r => r.json()),
    fetch('/holiday-countries.json').then(r => r.json()),
  ]);
  const models = Object.assign({ default: null, plan: null, implement: null, chat: null, brief: null }, set.models);
  /* Plans used to have a model of their own for the bucket planners; nothing reads it now. */
  delete models.planner;
  if (first) for (const k in ONBOARD_MODELS) if (!models[k]) models[k] = ONBOARD_MODELS[k];
  /* A profile that still has the old Holidays: line has no country of its own:
     the select reads "Keep current" until the owner picks one, and saving anything
     else leaves the line as it is. */
  const legacy = prof.legacy_holidays || [];
  const country = legacy.length ? '' : (prof.country || '');
  const region = legacy.length ? '' : (prof.region || '');
  const memoryRoot = set.memory_root || '';
  const list = state.dataset || '';
  const projectsRoot = (set.projects_roots || {})[list] || '';
  const own = (set.boards || {})[list] || {};
  const board = {
    mode: !('memory_root' in own) ? 'inherit' : (own.memory_root === null ? 'none' : 'own'),
    path: typeof own.memory_root === 'string' ? own.memory_root : '',
    banners: own.banners !== false, agents: own.agents !== false };
  return { setup: prof.needs_setup, set, draft: {
    board, boardWas: Object.assign({}, board),
    name: prof.name || '', country, region, legacy, memoryRoot, list, projectsRoot, signedIn,
    about: Object.assign({}, prof.about), sections: Object.assign({}, prof.sections), hints: prof.hints || {},
    was: { country, region, memoryRoot, projectsRoot, setup: (prof.sections || {}).setup || '' },
    touched: {},
    countries: places.countries || [], regions: legacy.length ? [] : ((places.regions || {})[prof.country] || []),
    chime: set.chime !== false,
    models } };
}

function settingsErrors(draft, first){
  const err = {};
  if (!draft.name.trim()) err.name = 'Add your name.';
  if (first && !draft.country) err.country = 'Choose a country.';
  if (/[<>`]/.test(draft.about.addressing || '')) err['about-addressing'] = 'Leave out < > and backticks.';
  if (/^##?(\s|$)/m.test(draft.sections.setup || '')) err.setup = 'A # or ## heading would split the profile. Use ### or none.';
  if (!draft.signedIn && draft.board && draft.board.mode === 'own' && !draft.board.path.trim()) err['board-memory'] = 'Enter the folder’s full path.';
  return err;
}

/* The budget fields of Agent options, which sits on the Agents tab. */
function agentOptionErrors(draft){
  const err = {};
  const badDollars = v => v.trim() && !(Number(v) >= 0);
  if (badDollars(draft.budget)) err.budget = 'Enter an amount in dollars, or leave it empty.';
  for (const k in draft.agentBudgets) if (badDollars(draft.agentBudgets[k])) err['budget-' + k] = 'Enter an amount in dollars, or leave it empty.';
  return err;
}

/* The Save button follows the form: off while anything required is missing,
   and the message under a field shows once the owner has been in it. */
function paintSetupErrors(draft, first, attempted){
  const root = settingsRoot();
  if (!root) return;
  const err = settingsErrors(draft, first);
  root.querySelectorAll('[data-err]').forEach(el => {
    const k = el.dataset.err;
    tenonFieldError(el, !!err[k] && (draft.touched[k] || attempted) ? err[k] : '');
  });
  root.querySelectorAll('button[data-i="0"], [data-settings-save]').forEach(save => { save.disabled = Object.keys(err).length > 0; });
}

/* A country Nager.Date has no public holidays for is still saved; the note says
   what that means. */
function paintCountryNote(draft){
  const root = settingsRoot();
  const note = root && root.querySelector('[data-nolist]');
  if (!note) return;
  const c = draft.countries.find(x => x.code === draft.country);
  note.hidden = !(c && c.holidays === false);
}

/* Keeps the empty option of every "Use default" select naming the model it
   resolves to, so changing Default relabels them straight away. */
function paintModelLabels(draft, root){
  if (!root) return;
  root.querySelectorAll('[data-model]').forEach(sel => {
    const empty = sel.querySelector('option[value=""]');
    if (empty) empty.textContent = settingsEmptyLabel(sel.dataset.model, draft.models);
  });
}

/* Updates `draft` from the open form as it changes. */
function trackSettingsForm(draft, first){
  const root = settingsRoot();
  if (!root) return;
  const sync = e => {
    const n = root.querySelector('[data-name]');
    if (n) draft.name = n.value;
    root.querySelectorAll('[data-about]').forEach(i => {
      draft.about[i.dataset.about] = i.value;
      if (e && e.target === i) draft.touched['about-' + i.dataset.about] = true;
    });
    const c = root.querySelector('[data-country]');
    const r = root.querySelector('[data-region]');
    if (c) draft.country = c.value;
    if (r) draft.region = r.value;
    const m = root.querySelector('[data-memory]');
    if (m) draft.memoryRoot = m.value;
    const ch = root.querySelector('[data-chime]');
    if (ch) draft.chime = ch.getAttribute('aria-checked') === 'true';
    const bm = root.querySelector('[data-board-memory-mode]');
    if (bm) {
      draft.board.mode = bm.value;
      const bp = root.querySelector('[data-board-memory]');
      bp.hidden = bm.value !== 'own';
      bp.closest('.tenon-field').hidden = bp.hidden;
      draft.board.path = bp.value;
      if (e && e.target === bp) draft.touched['board-memory'] = true;
    }
    const bb = root.querySelector('[data-board-banners]');
    if (bb) draft.board.banners = bb.getAttribute('aria-checked') === 'true';
    const ba = root.querySelector('[data-board-agents]');
    if (ba) draft.board.agents = ba.getAttribute('aria-checked') === 'true';
    const su = root.querySelector('[data-setup]');
    if (su) { draft.sections.setup = su.value; if (e && e.target === su) draft.touched.setup = true; }
    const pr = root.querySelector('[data-projects]');
    if (pr) draft.projectsRoot = pr.value;
    if (e && e.target && e.target.matches('[data-name]')) draft.touched.name = true;
    if (e && e.target && e.target.matches('[data-country]')) draft.touched.country = true;
    paintCountryNote(draft);
    paintSetupErrors(draft, first);
  };
  root.addEventListener('input', sync);
  root.addEventListener('change', sync);
  /* A switch is a button, so it reports a click rather than a change. */
  root.addEventListener('click', e => {
    if (e.target.closest('[data-sharing]')) { openSharing(); return; }
    const sw = e.target.closest('[data-chime], [data-board-banners], [data-board-agents]');
    if (!sw) return;
    const on = sw.getAttribute('aria-checked') !== 'true';
    sw.setAttribute('aria-checked', String(on));
    sw.classList.toggle('tenon-switch--on', on);
    sync();
  });
  root.addEventListener('focusout', e => {
    if (e.target.matches('[data-name]')) draft.touched.name = true;
    if (e.target.matches('[data-country]')) draft.touched.country = true;
    paintSetupErrors(draft, first);
  });
  /* A new country has its own regions: fetch them and refill the Region select. */
  root.addEventListener('change', async e => {
    if (!e.target.matches('[data-country]')) return;
    const code = e.target.value;
    draft.region = '';
    draft.regions = [];
    if (code) {
      try { draft.regions = await fetch('/holiday-regions.json?country=' + encodeURIComponent(code)).then(r => r.json()); }
      catch (err) { draft.regions = []; }
      if (!Array.isArray(draft.regions)) draft.regions = [];
    }
    const field = root.querySelector('[data-region-field]');
    const sel = root.querySelector('[data-region]');
    if (sel) sel.innerHTML = settingsRegionOptions(draft);
    if (field) field.hidden = !draft.regions.length;
  });
  paintCountryNote(draft);
  paintSetupErrors(draft, first);
}

async function saveSettingsDraft(draft, first){
  if (settingsLocked()) throw new Error('This tab is read-only.');
  const put = (url, body) => sendJSON('PUT', url, body);
  const basics = { name: draft.name };
  /* Every field and box the server sent, so the welcome, which shows none,
     sends none. */
  const root = settingsRoot();
  if (!first && 'addressing' in draft.about && root && root.querySelector('[data-about="addressing"]')) basics.about = { addressing: draft.about.addressing };
  if (!first && !draft.signedIn && 'setup' in draft.sections && draft.sections.setup !== draft.was.setup) basics.sections = { setup: draft.sections.setup };
  /* Holidays are sent only when the owner changed them: saving a name alone must not
     rewrite a profile that still has the old Holidays: line. */
  if (draft.country && (draft.country !== draft.was.country || draft.region !== draft.was.region)) {
    basics.country = draft.country;
    basics.region = draft.region;
  }
  await put('/profile-basics.json', basics);
  if (draft.signedIn) return;
  /* The models and budgets are Agent options, saved from the Agents tab; the
     welcome keeps the first run's two starting models. */
  const body = { chime: draft.chime };
  if (first) body.models = draft.models;
  if (draft.memoryRoot.trim() !== draft.was.memoryRoot) body.memory_root = draft.memoryRoot.trim() || null;
  if (draft.list && draft.projectsRoot.trim() !== draft.was.projectsRoot)
    body.projects_roots = { [draft.list]: draft.projectsRoot.trim() || null };
  await put('/settings.json', body);
  /* Its own request, so a folder the server refuses does not stop the rest saving. */
  const mine = boardChanges(draft);
  if (mine) await put('/settings.json', { boards: { [draft.list]: mine } });
}

/* Only the keys of "This board" that changed, or null when none did. */
function boardChanges(draft){
  if (!draft.list || !draft.board) return null;
  const b = draft.board, was = draft.boardWas, out = {};
  if (b.mode !== was.mode || (b.mode === 'own' && b.path.trim() !== was.path))
    out.memory_root = b.mode === 'inherit' ? 'inherit' : b.mode === 'none' ? null : b.path.trim();
  if (b.banners !== was.banners) out.banners = b.banners;
  if (b.agents !== was.agents) out.agents = b.agents;
  return Object.keys(out).length ? out : null;
}

/* Reads the owner's name again from /owner.js, for a save that does not reload
   the page, so what the board writes in `[to::]` and compares against follows it. */
async function refreshOwnerName(){
  try {
    const text = await fetch('/owner.js', { cache: 'no-store' }).then(r => r.text());
    const m = /OWNER_NAME\s*=\s*("(?:[^"\\]|\\.)*")/.exec(text);
    if (m) OWNER_NAME = JSON.parse(m[1]) || 'Me';
  } catch (err) { /* keeps the name it has */ }
}

/* Checks the form and saves it, from the welcome's button or the page's. */
async function runSettingsSave(draft, first, needsList, opts){
  if (writeBlocked()) return false;
  if (Object.keys(settingsErrors(draft, first)).length) { paintSetupErrors(draft, first, true); return false; }
  try { await saveSettingsDraft(draft, first); }
  catch (err) { showToast('Could not save: ' + (err.message || err)); return false; }
  if (first && needsList) { openFirstList(); return true; }
  /* Signed in, the name on the page is the sign-in's, so nothing to reload. */
  if (draft.signedIn) { if (!settingsHostEl) closeModal(); showToast('Saved.', 'good'); return true; }
  /* A save made on the way to somewhere else carries on to it instead of reloading. */
  if (opts && opts.noReload) { await refreshOwnerName(); showToast('Saved.', 'good'); return true; }
  /* The owner's name is read once, from /owner.js, as the page loads. The
     page is saved by now, so the browser has nothing to warn about. */
  settingsDiscarded = true;
  location.reload();
  return true;
}

/* first: the welcome. needsList: step 2 follows step 1 (no list on disk). The
   welcome is the one place this form is still a pop-up; Data > Settings opens
   the same form as a tab of the Settings page (drawSettingsTab). */
async function openSettings(first, needsList){
  settingsWelcome = false;
  let loaded;
  try { loaded = await loadSettingsDraft(first); }
  catch (err) { settingsWelcome = false; showToast('Could not read settings: ' + (err.message || err)); return; }
  const { draft, set } = loaded;
  const choices = (set.choices && set.choices.models) || [];
  settingsHostEl = null;
  const save = { label: 'Save', primary: true, run: () => runSettingsSave(draft, first, needsList) };
  const buttons = first ? [save] : [save, { label: 'Cancel', run: closeModal }];
  const note = first
    ? '<p class="help" style="margin-top:14px">Next, run <code>scripts/install.sh</code> to link the skills and set up the hourly wake.</p>'
    : '';
  showModal(first ? 'Welcome to Bench' : (draft.signedIn ? 'Your profile' : 'Settings'),
    first ? (needsList ? 'Step 1 of 2: about you. You can change these later under Data, Settings.'
                       : 'Two things to set up. You can change them later under Data, Settings.') : '',
    settingsFormHTML(draft, choices, first) + note, buttons,
    first ? { required: true } : { keepOpen: true });
  settingsWelcome = !!first;
  trackSettingsForm(draft, first);
  if (first) { const n = modalEl && modalEl.querySelector('[data-name]'); if (n) n.focus(); }
}

/* ---- Step 2: the first list -------------------------------------------- */

const listSlug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function listErrors(list){
  const err = { rows: list.buckets.map(() => ({})) };
  let bad = false;
  if (!listSlug(list.name)) { err.name = 'Name the list.'; bad = true; }
  if (!list.buckets.length) { err.buckets = 'Add at least one bucket.'; bad = true; }
  const seen = {};
  list.buckets.forEach((b, i) => {
    if (!listSlug(b.name)) { err.rows[i].name = 'Name this bucket.'; bad = true; }
    else if (seen[listSlug(b.name)]) { err.rows[i].name = 'Two buckets share this name.'; bad = true; }
    seen[listSlug(b.name)] = true;
    if (!b.about.trim()) { err.rows[i].about = 'Say what kind of work goes in it and what it ends in.'; bad = true; }
  });
  err.bad = bad;
  return err;
}

function bucketRowsHTML(list){
  return list.buckets.map((b, i) =>
    '<div class="bucketrow" data-row="' + i + '">' +
    '<input type="text" data-b-name value="' + escAttr(b.name) + '" placeholder="Bucket name" aria-label="Bucket name">' +
    '<button type="button" class="btn ghost small" data-b-remove aria-label="Remove ' + escAttr(b.name || 'this bucket') + '"' +
      (list.buckets.length < 2 ? ' disabled' : '') + '>Remove</button>' +
    '<textarea rows="2" data-b-about placeholder="What kind of work goes here, and what it ends in" aria-label="What goes in this bucket">' + esc(b.about) + '</textarea>' +
    '<span class="help fielderr" data-b-err hidden></span>' +
    '</div>').join('');
}

function listFormHTML(list){
  return '<div class="setupform">' +
    '<label class="field"><span>List name</span><input type="text" data-list-name value="' + escAttr(list.name) + '" placeholder="Work">' +
    '<span class="help">Your first list. It becomes a folder under <code>data/</code> and the name on the Lists menu.</span>' +
    '<span class="help fielderr" data-list-err hidden></span></label>' +
    '<div class="field"><span>Buckets</span>' +
    '<span class="help">The groups your tasks sort into. Say what goes in each and what it ends in; each bucket\u2019s agent reads this before it works on anything there.</span></div>' +
    '<div class="bucketrows" data-rows>' + bucketRowsHTML(list) + '</div>' +
    '<span class="help fielderr" data-buckets-err hidden></span>' +
    '<div><button type="button" class="btn dashed small" data-b-add>+ Add a bucket</button></div>' +
    '</div>';
}

function paintListErrors(list, attempted){
  if (!modalEl) return;
  const err = listErrors(list);
  const show = (el, msg, touched) => { if (!el) return; const on = !!msg && (touched || attempted); el.textContent = on ? msg : ''; el.hidden = !on; };
  show(modalEl.querySelector('[data-list-err]'), err.name, list.touched.name);
  show(modalEl.querySelector('[data-buckets-err]'), err.buckets, true);
  modalEl.querySelectorAll('[data-row]').forEach(row => {
    const i = Number(row.dataset.row);
    const t = list.buckets[i].touched || {};
    const msg = (t.name && err.rows[i].name) || (t.about && err.rows[i].about) || (attempted && (err.rows[i].name || err.rows[i].about)) || '';
    show(row.querySelector('[data-b-err]'), msg, true);
  });
  const save = modalEl.querySelector('button[data-i="0"]');
  if (save) save.disabled = err.bad;
}

function repaintRows(list, focusLast){
  const host = modalEl && modalEl.querySelector('[data-rows]');
  if (!host) return;
  host.innerHTML = bucketRowsHTML(list);
  if (focusLast) { const n = host.querySelectorAll('[data-b-name]'); if (n.length) n[n.length - 1].focus(); }
  paintListErrors(list);
}

function trackListForm(list){
  if (!modalEl) return;
  modalEl.addEventListener('input', e => {
    if (e.target.matches('[data-list-name]')) { list.name = e.target.value; list.touched.name = true; }
    const row = e.target.closest && e.target.closest('[data-row]');
    if (row) {
      const b = list.buckets[Number(row.dataset.row)];
      b.touched = b.touched || {};
      if (e.target.matches('[data-b-name]')) { b.name = e.target.value; b.touched.name = true; }
      if (e.target.matches('[data-b-about]')) { b.about = e.target.value.replace(/\s+/g, ' '); b.touched.about = true; }
    }
    paintListErrors(list);
  });
  modalEl.addEventListener('click', e => {
    if (e.target.closest('[data-b-add]')) {
      list.buckets.push({ name: '', about: '', touched: {} });
      repaintRows(list, true);
      return;
    }
    const rm = e.target.closest('[data-b-remove]');
    if (rm && list.buckets.length > 1) {
      list.buckets.splice(Number(rm.closest('[data-row]').dataset.row), 1);
      repaintRows(list);
    }
  });
  paintListErrors(list);
}

/* Step 2 of 2. The profile is saved by now, so this one reloads the board once
   the list exists. */
function openFirstList(){
  const list = { name: ONBOARD_LIST, buckets: ONBOARD_BUCKETS.map(b => Object.assign({ touched: {} }, b)), touched: {} };
  const make = { label: 'Create list', primary: true, run: async () => {
    if (listErrors(list).bad) { paintListErrors(list, true); return; }
    const body = { name: list.name.trim(), buckets: list.buckets.map(b => ({ name: b.name.trim(), about: b.about.trim() })) };
    try { await postJSON('/datasets', body); }
    catch (err) { showToast('Could not create that list: ' + (err.message || err), 'bad'); return; }
    settingsWelcome = false;
    location.reload();
  } };
  showModal('Welcome to Bench', 'Step 2 of 2: your first list. You can add more under Lists, New list.',
    listFormHTML(list), [make], { required: true });
  settingsWelcome = true;
  trackListForm(list);
  const n = modalEl && modalEl.querySelector('[data-list-name]');
  if (n) { n.focus(); n.select(); }
}

/* First run: no profile (or a placeholder Name) gets step 1; a profile with no
   list on disk gets step 2. Neither can be dismissed. */
async function maybeOnboard(){
  try {
    const [prof, ds] = await Promise.all([
      fetch('/profile-basics.json').then(r => r.ok ? r.json() : null),
      fetch('/datasets.json').then(r => r.ok ? r.json() : null),
    ]);
    const needsList = !!ds && !(ds.datasets || []).length;
    if (prof && prof.needs_setup) openSettings(true, needsList);
    else if (needsList) openFirstList();
  } catch (err) { /* no server, no setup */ }
}

/* Who sees the list on screen, from the button in a signed-in person's
   Settings. Only the owner can change it. */
async function openSharing(){
  let acc;
  try { acc = await getJSON('/dataset/access.json'); }
  catch (err) { showToast('Could not read who sees this list: ' + (err.message || err), 'bad'); return; }
  const title = 'Who sees ' + prettyDataset(acc.board);
  if (!acc.mine) {
    const shared = acc.teams.concat(acc.people);
    showModal(title, '', '<div class="repdoc"><p>' +
      (acc.owner ? esc(acc.owner) + ' owns this list' : 'Nobody owns this list yet') +
      (shared.length ? ', shared with ' + esc(shared.join(', ')) + '.' : '.') +
      ' Only the owner can change who sees it.</p></div>', [{ label: 'Close' }]);
    return;
  }
  const sh = { kind: acc.teams.length || acc.people.length ? 'shared' : 'personal',
               teams: acc.teams.slice(), people: acc.people.join('\n') };
  const teams = (state.who.teams || []).concat(acc.teams.filter(t => (state.who.teams || []).indexOf(t) < 0));
  showModal(title, 'You own this list.', sharingFormHTML(sh, teams), [
    { label: 'Save', primary: true, run: async () => {
      const got = sharingBody(sh);
      if (got.error) { showToast(got.error, 'bad'); return; }
      if (state.locked) { showToast('This tab is read-only.', 'bad'); return; }
      try { await postJSON('/dataset/access', { name: acc.board, teams: got.body.teams, people: got.body.people }); }
      catch (err) { showToast('Could not save: ' + (err.message || err), 'bad'); return; }
      closeModal();
      showToast('Saved.', 'good');
    } },
    { label: 'Cancel', run: closeModal }], { keepOpen: true });
  trackSharing(sh);
}

/* ---- The Settings page ------------------------------------------------------
   Data > Settings opens one page in the board's own area, with four tabs drawn
   in the bucket bar while it is up: Settings (this form), Memory (31-memory.js),
   Agents (27-agents.js, with Spend and Schedules, the two cards of 14-schedule.js,
   as panels under it), Backups (15-backups.js).
   The URL is #settings/<tab>; an old #memory, #agents or #backups link opens its tab. */
const SETTINGS_TABS = [
  ['settings', 'Settings', 'you, your folders, setup and notifications'],
  ['memory', 'Memory', 'what Bench keeps about this board and you'],
  ['agents', 'Agents', 'when each agent runs, what it does, what it has spent and what runs on a clock'],
  ['backups', 'Backups', 'every copy of this list the board has kept'],
];
let settingsTab = 'settings';
/* The page's form, when it is drawn there rather than in the pop-up. */
let settingsHostEl = null;
const settingsRoot = () => settingsHostEl || modalEl;

/* The tabs on offer: the shared board has no Agents tab, and a folder opened
   from disk has no backups. */
function settingsTabs(){
  return SETTINGS_TABS.filter(([k]) =>
    !(k === 'agents' && state.who) && !(k === 'backups' && listFolder));
}

/* Spend and Schedules were tabs of their own; they are two panels of Agents now,
   so a link or a call that names either lands there. */
function settingsTabName(tab){
  return tab === 'spend' || tab === 'schedules' ? 'agents' : tab;
}

/* A hash or a stray state.view that names the page, or one of the views that
   became its tabs. True when it did, with settingsTab and state.view set. */
function adoptSettingsRoute(h){
  let tab = null;
  if (h.view === 'settings') tab = SETTINGS_TABS.some(t => t[0] === settingsTabName(h.bucketSlug)) ? settingsTabName(h.bucketSlug) : settingsTab;
  else if (h.view === 'memory' || h.view === 'agents' || h.view === 'backups') tab = h.view;
  if (!tab) return false;
  settingsTab = tab;
  state.view = 'settings';
  return true;
}

function openSettingsPage(tab){
  const go = () => {
    if (tab) settingsTab = settingsTabName(tab);
    state.view = 'settings';
    syncHash(true);
    renderView();
  };
  if (tab && state.view === 'settings' && settingsTabName(tab) !== settingsTab) settingsPageAsk(go);
  else go();
}

/* ---- Unsaved changes ----

   The Settings tab and the Memory tab hold typing until Save. Leaving either
   for another tab, a board view or another list asks first, in the board's own
   modal: Stay, Discard or Save. The browser's own warning covers closing or
   reloading the tab. `settingsDiscarded` says the typing has been given up (or
   saved on the way out), so nothing asks again before the page is drawn anew. */
let settingsLiveDraft = null;
let settingsSnapshot = '';
let settingsDiscarded = false;

function settingsDraftSnapshot(d){
  return JSON.stringify([d.name, d.country, d.region, d.memoryRoot, d.projectsRoot, (d.sections || {}).setup,
    d.chime, d.board && [d.board.mode, d.board.path, d.board.banners, d.board.agents], (d.about || {}).addressing]);
}

/* True when the page on screen holds changes that are not saved. */
function settingsPageDirty(){
  if (settingsDiscarded || state.locked) return false;
  if (settingsTab === 'settings') {
    return !!(settingsLiveDraft && settingsHostEl && settingsHostEl.isConnected && settingsDraftSnapshot(settingsLiveDraft) !== settingsSnapshot);
  }
  if (settingsTab === 'memory') return typeof memIsDirty === 'function' && memIsDirty();
  if (settingsTab === 'agents') return typeof agentsIsDirty === 'function' && agentsIsDirty();
  return false;
}

/* Saves the page on screen, true when it went through. */
async function settingsPageSave(){
  if (settingsTab === 'memory') return memSaveAll();
  if (settingsTab === 'agents') return agentsSaveAll();
  if (settingsTab === 'settings' && settingsLiveDraft) return runSettingsSave(settingsLiveDraft, false, false, { noReload: true });
  return true;
}

/* Resolves true when the move may go on: nothing was unsaved, or the person
   chose Discard, or chose Save and it worked. */
function settingsPageGate(){
  return new Promise(resolve => {
    if (!settingsPageDirty()) { resolve(true); return; }
    let settled = false;
    const finish = ok => { if (settled) return; settled = true; if (ok) settingsDiscarded = true; resolve(ok); closeModal(); };
    showModal('Unsaved changes', 'This page has changes that are not saved yet.', '', [
      { label: 'Stay', run: () => finish(false) },
      { label: 'Discard', danger: true, run: () => finish(true) },
      { label: 'Save', primary: true, run: async () => { finish(await settingsPageSave()); } },
    ], { keepOpen: true, onClose: () => { if (!settled) { settled = true; resolve(false); } } });
  });
}
function settingsPageAsk(proceed){ settingsPageGate().then(ok => { if (ok) proceed(); }); }

window.addEventListener('beforeunload', e => {
  if (!settingsPageDirty()) return;
  e.preventDefault(); e.returnValue = '';
});

/* The bucket bar, while the page is up: the five tabs where the bucket tabs
   were, and none of the bucket bar's other controls. */
function renderSettingsTabs(){
  const bar = $('#bucketBar'), wrap = $('#bucketFilters');
  if (!bar || !wrap) return;
  const tabs = settingsTabs();
  if (!tabs.some(t => t[0] === settingsTab)) settingsTab = 'settings';
  bar.classList.remove('hidden');
  bar.classList.add('bucketbar--page');
  wrap.classList.remove('hidden');
  $('#themeBar').classList.add('hidden');
  BoardUI.mountFlushed(wrap, BoardUI.h(BoardUI.FilterTabs, {
    tabs: tabs.map(([key, label, title]) => ({ key, label, on: settingsTab === key, title })),
    label: 'Settings sections',
    onToggle: key => { if (key !== settingsTab) settingsPageAsk(() => { settingsTab = key; syncHash(true); renderSettingsPage(); }); }
  }));
  renderPhoneChrome();
}

/* The page is being left for a board view: the bucket tabs come back (the view
   being drawn calls renderTabs), and what the tabs mounted goes. */
function leaveSettingsPage(){
  leaveRefCards();
  settingsHostEl = null;
  const bar = $('#bucketBar');
  if (bar) {
    bar.classList.remove('bucketbar--page');
    if (!state.doc) bar.classList.add('hidden');
  }
}

function renderSettingsPage(){
  settingsDiscarded = false;
  renderSettingsTabs();
  if (settingsTab !== 'agents') leaveAgentsView();
  settingsHostEl = null;
  syncHash();
  const tab = settingsTab;
  if (tab === 'memory') renderMemoryView();
  else if (tab === 'backups') renderBackupsView();
  else if (tab === 'agents') renderAgentsView();
  else drawSettingsTab();
}

/* What refreshView() does while the page is up: the tabs that show the list or
   its files follow it, and the form is never redrawn under the person typing. */
function refreshSettingsPage(){
  if (settingsTab === 'memory') memDraw();
  else if (settingsTab === 'agents') renderAgentsView();
  else if (settingsTab === 'backups') renderBackupsView();
}

/* The Settings tab, drawn in the shared page layout. */
async function drawSettingsTab(){
  const lists = $('#lists');
  const shell = body => '<div class="lists pview settingsview" style="--pcols:1"><div class="settingspage" id="settingsPage">' + body + '</div></div>';
  lists.innerHTML = shell('<p class="memempty">Reading settings…</p>');
  let loaded;
  try { loaded = await loadSettingsDraft(false); }
  catch (err) {
    if (state.view === 'settings' && settingsTab === 'settings')
      lists.innerHTML = shell('<p class="memerr" role="alert">Could not read settings: ' + esc(err.message || err) + '</p>');
    return;
  }
  if (state.view !== 'settings' || settingsTab !== 'settings') return;
  const { draft } = loaded;
  const host = $('#settingsPage');
  host.innerHTML = settingsPageLayoutHTML(draft.signedIn ? 'Your profile' : 'Settings', settingsPageSections(draft), { save: !state.locked });
  settingsHostEl = host;
  settingsLiveDraft = draft;
  settingsSnapshot = settingsDraftSnapshot(draft);
  trackSettingsForm(draft, false);
  host.querySelectorAll('[data-settings-save]').forEach(btn => { btn.onclick = () => runSettingsSave(draft, false, false); });
}

/* ---- The Agents page's settings ----

   The models each job runs on, the board's Agents switch and the daily budgets,
   drawn into the Agents page (27-agents.js) as Tenon Fields. They save to the
   same keys through the same PUT /settings.json as before, from the page's one
   Save, which also writes any bucket brief that changed (agentsSaveAll()). */
const AGENT_MODEL_FIELDS = (draft, choices) =>
  settingsModelField('default', 'Default model', 'Used by any model below that is left on Use default.', draft, choices) +
  SETTINGS_AGENTS.concat(SETTINGS_OTHER).map(([key, name, help]) => settingsModelField(key, name, help, draft, choices)).join('');

function agentSpendFieldsHTML(draft){
  const num = o => tenonFieldHTML(Object.assign({ type: 'number', placeholder: 'No limit', readonly: state.locked }, o));
  return num({ label: 'Daily budget, all agents together ($)', attrs: 'data-budget min="0" step="any" inputmode="decimal"', value: draft.budget,
      hint: 'Every agent’s scheduled runs stop for the day once this is spent, whatever its own budget. Empty means no limit.', err: 'data-err="budget"' }) +
    num({ label: 'Daily budget, bucket agents ($)', attrs: 'data-agent-budget="bucket" min="0" step="any" inputmode="decimal"', value: draft.agentBudgets.bucket,
      hint: 'Every bucket’s agent on every board spends from this. Its runs stop for the day once it is spent. Empty means no limit.', err: 'data-err="budget-bucket"' });
}

function paintAgentOptionErrors(draft, host, attempted){
  const err = agentOptionErrors(draft);
  host.querySelectorAll('[data-err]').forEach(el => {
    tenonFieldError(el, !!err[el.dataset.err] && (draft.touched[el.dataset.err] || attempted) ? err[el.dataset.err] : '');
  });
  host.querySelectorAll('[data-agents-save]').forEach(save => { save.disabled = Object.keys(err).length > 0; });
}

function trackAgentOptions(draft, host){
  const sync = e => {
    host.querySelectorAll('[data-model]').forEach(sel => { draft.models[sel.dataset.model] = sel.value || null; });
    const b = host.querySelector('[data-budget]');
    if (b) { draft.budget = b.value; if (e && e.target === b) draft.touched.budget = true; }
    host.querySelectorAll('[data-agent-budget]').forEach(i => {
      draft.agentBudgets[i.dataset.agentBudget] = i.value;
      if (e && e.target === i) draft.touched['budget-' + i.dataset.agentBudget] = true;
    });
    paintModelLabels(draft, host);
    paintAgentOptionErrors(draft, host);
  };
  host.addEventListener('input', sync);
  host.addEventListener('change', sync);
  host.addEventListener('click', e => {
    const sw = e.target.closest('[data-board-agents]');
    if (!sw || sw.disabled) return;
    const on = sw.getAttribute('aria-checked') !== 'true';
    sw.setAttribute('aria-checked', String(on));
    sw.classList.toggle('tenon-switch--on', on);
    draft.agentsOn = on;
  });
  paintAgentOptionErrors(draft, host);
}

/* What the page's settings hold, to tell whether Save has anything to write. */
const agentOptsSnapshot = d => JSON.stringify([d.models, d.budget, d.agentBudgets, d.agentsOn]);
/* The open Agents page's settings draft and what it was loaded as; null before they arrive. */
let agentsOpts = null;

/* Writes the settings the page holds when they changed. True when it went through. */
async function saveAgentOptions(draft){
  if (state.locked) return false;
  const dollars = v => v.trim() === '' ? null : Number(v);
  const agentBudgets = {};
  for (const k in draft.agentBudgets) agentBudgets[SETTINGS_BUDGET_IDS[k]] = dollars(draft.agentBudgets[k]);
  try {
    await sendJSON('PUT', '/settings.json', { models: draft.models,
      daily_budget: dollars(draft.budget), agent_budgets: agentBudgets });
    /* Its own request, as in the Settings page, so one refusal does not stop the other. */
    if (draft.list && draft.agentsOn !== draft.agentsWas) {
      await sendJSON('PUT', '/settings.json', { boards: { [draft.list]: { agents: draft.agentsOn } } });
      draft.agentsWas = draft.agentsOn;
    }
  } catch (err) { showToast('Could not save: ' + (err.message || err)); return false; }
  return true;
}

/* Fills the Agents page's models, board switch and budgets once; a redraw of the
   tab leaves them alone, so nothing typed in them is lost. `page` is #agentsPage. */
async function drawAgentOptions(page){
  if (!page || page.dataset.opts || state.who) return;
  page.dataset.opts = 'loading';
  let set;
  try { set = await fetch('/settings.json').then(r => r.json()); }
  catch (err) {
    delete page.dataset.opts;
    const box = page.querySelector('#agentModels');
    if (box && page.isConnected && !box.firstChild) box.innerHTML = '<p class="memerr" role="alert">Could not read settings: ' + esc(err.message || err) + '</p>';
    return;
  }
  if (!page.isConnected) return;
  const models = Object.assign({ default: null, plan: null, implement: null, chat: null, brief: null }, set.models);
  delete models.planner;
  const dollars = v => v == null ? '' : String(v);
  const agentBudgets = {};
  for (const k in SETTINGS_BUDGET_IDS) agentBudgets[k] = dollars((set.agent_budgets || {})[SETTINGS_BUDGET_IDS[k]]);
  const list = state.dataset || '';
  const agentsOn = ((set.boards || {})[list] || {}).agents !== false;
  const draft = { models, budget: dollars(set.daily_budget), agentBudgets, touched: {}, list, agentsOn, agentsWas: agentsOn };
  page.querySelector('#agentModels').innerHTML = AGENT_MODEL_FIELDS(draft, (set.choices && set.choices.models) || []);
  page.querySelector('#agentBoardSwitch').innerHTML = draft.list
    ? tenonFieldHTML({ label: 'Agents', kind: 'switch', attrs: 'data-board-agents', on: draft.agentsOn, readonly: state.locked,
        hint: 'Lets this board’s bucket agents work. Off, they leave it alone.' }) : '';
  page.querySelector('#agentSpendFields').innerHTML = agentSpendFieldsHTML(draft);
  page.dataset.opts = 'ready';
  agentsOpts = { draft, base: agentOptsSnapshot(draft) };
  trackAgentOptions(draft, page);
}

$('#settingsBtn').onclick = () => { closeDataMenu(); openSettingsPage('settings'); };

