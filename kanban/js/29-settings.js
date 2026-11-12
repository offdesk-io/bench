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
   and so does the rest of the profile Settings offers (not the welcome): How to
   address you and the facts file as fields, then Setup, Writing, Meeting
   recorder and Working habits as one text box each, a box left as the template
   has it reading empty with the template as its hint. Signed in (state.who),
   the profile is the person's own, data/users/<hash>.profile.md, and the form
   is that profile alone, less the two parts that name a path on the server;
   the server's settings are not theirs to change, and the list's sharing is a
   button beside it.
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
const SETTINGS_AGENTS = [
  ['plan', 'Plan agent', 'Plans a task and waits for you to approve it.'],
  ['implement', 'Implement agent', 'Carries out a plan you approved.'],
];
/* The id the agents engine keys each agent's daily budget by in fences.json. */
const SETTINGS_BUDGET_IDS = { plan: 'plan-agent', implement: 'implement-agent' };
const SETTINGS_OTHER = [
  ['chat', 'Chat', 'The chat window.'],
  ['brief', 'Brief', 'Bucket briefs.'],
];
/* What a job runs on when nothing is chosen anywhere: briefs use Haiku
   (MODEL in agents/plan-agent/brief.py), everything else leaves the choice to
   Claude Code. */
const SETTINGS_OWN_MODEL = { brief: 'Haiku' };
const SETTINGS_CLAUDE_DEFAULT = 'Claude Code’s default';
const SETTINGS_STARTS = [
  ['scheduled', 'Wait for its scheduled hours'],
  ['now', 'Start straight away'],
];
/* Pre-selections for a first run; Settings opens on what is saved. */
const ONBOARD_MODELS = { default: 'sonnet', brief: 'haiku' };
/* The first list. Editable and removable; the description becomes the opening
   of each bucket's brief, which is what the generic planner reads. */
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
  if (key === 'planner') return 'Same as the Plan agent (' + settingsResolved('plan', models) + ')';
  return key === 'default'
    ? 'Not set: ' + settingsResolved(key, models)
    : 'Use default (' + settingsResolved(key, models) + ')';
}

function settingsModelField(key, name, help, draft, choices){
  return '<label class="field"><span>' + esc(name) + '</span>' +
    '<select data-model="' + key + '">' +
    '<option value="">' + esc(settingsEmptyLabel(key, draft.models)) + '</option>' +
    choices.map(m => '<option value="' + esc(m) + '"' + (draft.models[key] === m ? ' selected' : '') + '>' + esc(settingsCap(m)) + '</option>').join('') +
    '</select><span class="help">' + esc(help) + '</span></label>';
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
  return '<label class="field"><span>' + esc(f[1]) + '</span><input type="text" data-about="' + key + '" value="' + escAttr(draft.about[key]) + '" placeholder="Not set">' +
    '<span class="help">' + esc(f[2]) + '</span><span class="help fielderr" data-err="about-' + key + '" hidden></span></label>';
}

/* The sections the server sent, as text boxes. Open signed in, where they are
   most of the form. */
function settingsSectionsHTML(draft){
  const boxes = SETTINGS_SECTIONS.filter(([k]) => k in draft.sections).map(([k, name, help]) =>
    '<label class="field"><span>' + esc(name) + '</span>' +
    '<textarea rows="4" data-section="' + k + '" placeholder="' + escAttr(draft.hints[k] || '') + '">' + esc(draft.sections[k]) + '</textarea>' +
    '<span class="help">' + esc(help) + '</span><span class="help fielderr" data-err="section-' + k + '" hidden></span></label>').join('');
  if (!boxes) return '';
  return '<details class="agentopts" data-profile-sections' + (draft.signedIn ? ' open' : '') + '><summary>Your profile for the PA</summary>' +
    '<div class="agentopts__body">' + boxes + '</div></details>';
}

/* "This board": the open list's own memory folder, banners and agents, kept
   under boards.<list> in settings.json. Not offered in the welcome or signed in,
   where the server's settings are not the visitor's. */
const BOARD_MEMORY_MODES = [['inherit', 'Same as main memory folder'], ['none', 'None, keep everything in Bench'], ['own', 'Its own folder']];

function boardSwitchHTML(attr, on, name, help){
  return '<label class="field"><span>' + esc(name) + '</span>' +
    '<button type="button" role="switch" class="tenon-switch' + (on ? ' tenon-switch--on' : '') + '" ' + attr + ' aria-checked="' + on + '"></button>' +
    '<span class="help">' + esc(help) + '</span></label>';
}

function boardGroupHTML(draft, first){
  if (first || draft.signedIn || !draft.list) return '';
  const b = draft.board;
  return '<div class="agentopts__group" data-board-group><h4>This board</h4>' +
    '<label class="field"><span>Memory folder</span><select data-board-memory-mode>' +
    BOARD_MEMORY_MODES.map(([v, l]) => '<option value="' + v + '"' + (b.mode === v ? ' selected' : '') + '>' + esc(l) + '</option>').join('') +
    '</select>' +
    '<input type="text" data-board-memory value="' + escAttr(b.path) + '" placeholder="/absolute/path/to/folder"' + (b.mode === 'own' ? '' : ' hidden') + '>' +
    '<span class="help">Where facts about you and this list’s people are kept. Same as main uses the memory folder above, None keeps everything in data/' + esc(draft.list) + '/.</span>' +
    '<span class="help fielderr" data-err="board-memory" hidden></span></label>' +
    boardSwitchHTML('data-board-banners', b.banners, 'Desktop banners', 'A banner when a task on this board is due. Off, it sends none.') +
    boardSwitchHTML('data-board-agents', b.agents, 'Agents', 'Lets the Plan and Implement agents work on this board. Off, they leave it alone.') +
    '</div>';
}

function settingsFormHTML(draft, choices, first){
  const agents = SETTINGS_AGENTS.map(([key, name, help]) =>
    '<div class="agentopts__group"><h4>' + agentAvatarHTML(name, 18) + esc(name) + '</h4>' +
    settingsModelField(key, 'Model', help, draft, choices) +
    '<label class="field"><span>When you hand it a task</span><select data-start="' + key + '">' +
    SETTINGS_STARTS.map(([v, l]) => '<option value="' + v + '"' + (draft.agents[key].start === v ? ' selected' : '') + '>' + esc(l) + '</option>').join('') +
    '</select></label>' +
    '<label class="field"><span>Daily budget ($)</span><input type="text" inputmode="decimal" data-agent-budget="' + key + '" value="' + escAttr(draft.agentBudgets[key]) + '" placeholder="No limit">' +
    '<span class="help">Its scheduled runs stop for the day once this is spent. Empty means no limit.</span>' +
    '<span class="help fielderr" data-err="budget-' + key + '" hidden></span></label></div>').join('');
  const other = SETTINGS_OTHER.map(([key, name, help]) => settingsModelField(key, name, help, draft, choices)).join('');
  return '<div class="setupform">' +
    '<label class="field"><span>Name</span><input type="text" data-name value="' + escAttr(draft.name) + '" placeholder="First name">' +
    '<span class="help">' + (draft.signedIn ? 'What the PA calls you.' : 'Who the review sub-tasks are assigned to.') + '</span>' +
    '<span class="help fielderr" data-err="name" hidden></span></label>' +
    (first ? '' : settingsAboutField(draft, 'addressing')) +
    '<label class="field"><span>Country</span><select data-country>' + settingsCountryOptions(draft, first) + '</select>' +
    '<span class="help">Its public holidays count as days off.</span>' +
    '<span class="help" data-nolist hidden>No public holiday list available for this country, so only weekends count as days off.</span>' +
    '<span class="help fielderr" data-err="country" hidden></span></label>' +
    '<label class="field" data-region-field' + (draft.regions.length ? '' : ' hidden') + '><span>Region</span>' +
    '<select data-region>' + settingsRegionOptions(draft) + '</select></label>' +
    (first ? '' : settingsAboutField(draft, 'facts_file')) +
    (first ? '' : settingsSectionsHTML(draft)) +
    (draft.signedIn ? (draft.list ? '<div><button type="button" class="btn ghost small" data-sharing>Who sees ' + esc(prettyDataset(draft.list)) + '</button></div>' : '') + '</div>' :
    (first ? '' : '<label class="field"><span>Memory folder</span><input type="text" data-memory value="' + escAttr(draft.memoryRoot) + '" placeholder="Not set">' +
      '<span class="help">A folder outside Bench that keeps facts about you for other agents to share. Set, your profile and each list’s people are read from there first, and Bench lists its boards in boards.md inside it. Empty means none.</span></label>') +
    (first || !draft.list ? '' : '<label class="field"><span>Projects folder for ' + esc(draft.list) + '</span><input type="text" data-projects value="' + escAttr(draft.projectsRoot) + '" placeholder="Not set">' +
      '<span class="help">A folder of this list’s own, one folder per project inside it, which no other list may use. Set, a project is looked for there first and new ones are made there. Empty keeps them in data/' + esc(draft.list) + '/projects/.</span></label>') +
    boardGroupHTML(draft, first) +
    '<label class="field"><span>Reply chime</span>' +
    '<button type="button" role="switch" class="tenon-switch' + (draft.chime ? ' tenon-switch--on' : '') + '" data-chime aria-checked="' + draft.chime + '"></button>' +
    '<span class="help">A short sound when a reply finishes in any chat: two rising notes for done, one low note for an error or a stop.</span></label>' +
    (agentsCanRun() ?
    '<details class="agentopts" data-agent-options><summary>Agent options</summary>' +
    '<div class="agentopts__body">' +
    settingsModelField('default', 'Default model', 'Used by any model below that is left on Use default.', draft, choices) +
    agents +
    '<div class="agentopts__group"><h4>' + plannerAvatarHTML('var(--tenon-text-secondary, #8a8a8a)', 18) + 'Bucket planners</h4>' +
    settingsModelField('planner', 'Model', 'The planner each bucket runs its tasks against. They start with the Plan agent and spend from its daily budget, so they have no budget of their own.', draft, choices) +
    '</div>' +
    '<div class="agentopts__group"><h4>Other</h4>' + other + '</div>' +
    '<div class="agentopts__group"><h4>Spending</h4>' +
    '<label class="field"><span>All agents together, daily budget ($)</span><input type="text" inputmode="decimal" data-budget value="' + escAttr(draft.budget) + '" placeholder="No limit">' +
    '<span class="help">Every agent’s scheduled runs stop for the day once this is spent, whatever its own budget. Empty means no limit.</span>' +
    '<span class="help fielderr" data-err="budget" hidden></span></label></div>' +
    '</div></details>' +
    '<p class="help agentopts__note">Set each agent’s hours later in the board’s Agents tab.</p>'
    : '<p class="help agentopts__note">Agents are off on this machine. The Agents tab says why.</p>') +
    '</div>');
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
  if (first) for (const k in ONBOARD_MODELS) if (!models[k]) models[k] = ONBOARD_MODELS[k];
  const agents = { plan: { start: 'scheduled' }, implement: { start: 'scheduled' } };
  for (const k in agents) if (set.agents && set.agents[k] && set.agents[k].start) agents[k].start = set.agents[k].start;
  const dollars = v => v == null ? '' : String(v);
  const agentBudgets = {};
  for (const k in SETTINGS_BUDGET_IDS) agentBudgets[k] = dollars((set.agent_budgets || {})[SETTINGS_BUDGET_IDS[k]]);
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
    was: { country, region, memoryRoot, projectsRoot },
    touched: {},
    countries: places.countries || [], regions: legacy.length ? [] : ((places.regions || {})[prof.country] || []),
    chime: set.chime !== false,
    models, agents, budget: dollars(set.daily_budget), agentBudgets } };
}

function settingsErrors(draft, first){
  const err = {};
  if (!draft.name.trim()) err.name = 'Add your name.';
  if (first && !draft.country) err.country = 'Choose a country.';
  for (const k in draft.about) if (/[<>`]/.test(draft.about[k])) err['about-' + k] = 'Leave out < > and backticks.';
  for (const k in draft.sections) if (/^##?(\s|$)/m.test(draft.sections[k])) err['section-' + k] = 'A # or ## heading would split the profile. Use ### or none.';
  if (!draft.signedIn && draft.board && draft.board.mode === 'own' && !draft.board.path.trim()) err['board-memory'] = 'Enter the folder’s full path.';
  const badDollars = v => v.trim() && !(Number(v) >= 0);
  if (badDollars(draft.budget)) err.budget = 'Enter an amount in dollars, or leave it empty.';
  for (const k in draft.agentBudgets) if (badDollars(draft.agentBudgets[k])) err['budget-' + k] = 'Enter an amount in dollars, or leave it empty.';
  return err;
}

/* The Save button follows the form: off while anything required is missing,
   and the message under a field shows once the owner has been in it. */
function paintSetupErrors(draft, first, attempted){
  if (!modalEl) return;
  const err = settingsErrors(draft, first);
  modalEl.querySelectorAll('[data-err]').forEach(el => {
    const k = el.dataset.err;
    const show = !!err[k] && (draft.touched[k] || attempted);
    el.textContent = show ? err[k] : '';
    el.hidden = !show;
  });
  const save = modalEl.querySelector('button[data-i="0"]');
  if (save) save.disabled = Object.keys(err).length > 0;
}

/* A country Nager.Date has no public holidays for is still saved; the note says
   what that means. */
function paintCountryNote(draft){
  const note = modalEl && modalEl.querySelector('[data-nolist]');
  if (!note) return;
  const c = draft.countries.find(x => x.code === draft.country);
  note.hidden = !(c && c.holidays === false);
}

/* Keeps the empty option of every "Use default" select naming the model it
   resolves to, so changing Default relabels them straight away. */
function paintModelLabels(draft){
  if (!modalEl) return;
  modalEl.querySelectorAll('[data-model]').forEach(sel => {
    const empty = sel.querySelector('option[value=""]');
    if (empty) empty.textContent = settingsEmptyLabel(sel.dataset.model, draft.models);
  });
}

/* Updates `draft` from the open form as it changes. */
function trackSettingsForm(draft, first){
  if (!modalEl) return;
  const sync = e => {
    const n = modalEl.querySelector('[data-name]');
    if (n) draft.name = n.value;
    modalEl.querySelectorAll('[data-about]').forEach(i => {
      draft.about[i.dataset.about] = i.value;
      if (e && e.target === i) draft.touched['about-' + i.dataset.about] = true;
    });
    modalEl.querySelectorAll('[data-section]').forEach(t => {
      draft.sections[t.dataset.section] = t.value;
      if (e && e.target === t) draft.touched['section-' + t.dataset.section] = true;
    });
    const c = modalEl.querySelector('[data-country]');
    const r = modalEl.querySelector('[data-region]');
    if (c) draft.country = c.value;
    if (r) draft.region = r.value;
    const m = modalEl.querySelector('[data-memory]');
    if (m) draft.memoryRoot = m.value;
    const ch = modalEl.querySelector('[data-chime]');
    if (ch) draft.chime = ch.getAttribute('aria-checked') === 'true';
    const bm = modalEl.querySelector('[data-board-memory-mode]');
    if (bm) {
      draft.board.mode = bm.value;
      const bp = modalEl.querySelector('[data-board-memory]');
      bp.hidden = bm.value !== 'own';
      draft.board.path = bp.value;
      if (e && e.target === bp) draft.touched['board-memory'] = true;
    }
    const bb = modalEl.querySelector('[data-board-banners]');
    if (bb) draft.board.banners = bb.getAttribute('aria-checked') === 'true';
    const ba = modalEl.querySelector('[data-board-agents]');
    if (ba) draft.board.agents = ba.getAttribute('aria-checked') === 'true';
    const pr = modalEl.querySelector('[data-projects]');
    if (pr) draft.projectsRoot = pr.value;
    modalEl.querySelectorAll('[data-model]').forEach(s => { draft.models[s.dataset.model] = s.value || null; });
    modalEl.querySelectorAll('[data-start]').forEach(s => { draft.agents[s.dataset.start].start = s.value; });
    if (e && e.target && e.target.matches('[data-name]')) draft.touched.name = true;
    if (e && e.target && e.target.matches('[data-country]')) draft.touched.country = true;
    const b = modalEl.querySelector('[data-budget]');
    if (b) { draft.budget = b.value; if (e && e.target === b) draft.touched.budget = true; }
    modalEl.querySelectorAll('[data-agent-budget]').forEach(i => {
      draft.agentBudgets[i.dataset.agentBudget] = i.value;
      if (e && e.target === i) draft.touched['budget-' + i.dataset.agentBudget] = true;
    });
    paintModelLabels(draft);
    paintCountryNote(draft);
    paintSetupErrors(draft, first);
  };
  modalEl.addEventListener('input', sync);
  modalEl.addEventListener('change', sync);
  /* A switch is a button, so it reports a click rather than a change. */
  modalEl.addEventListener('click', e => {
    if (e.target.closest('[data-sharing]')) { openSharing(); return; }
    const sw = e.target.closest('[data-chime], [data-board-banners], [data-board-agents]');
    if (!sw) return;
    const on = sw.getAttribute('aria-checked') !== 'true';
    sw.setAttribute('aria-checked', String(on));
    sw.classList.toggle('tenon-switch--on', on);
    sync();
  });
  modalEl.addEventListener('focusout', e => {
    if (e.target.matches('[data-name]')) draft.touched.name = true;
    if (e.target.matches('[data-country]')) draft.touched.country = true;
    paintSetupErrors(draft, first);
  });
  /* A new country has its own regions: fetch them and refill the Region select. */
  modalEl.addEventListener('change', async e => {
    if (!e.target.matches('[data-country]')) return;
    const code = e.target.value;
    draft.region = '';
    draft.regions = [];
    if (code) {
      try { draft.regions = await fetch('/holiday-regions.json?country=' + encodeURIComponent(code)).then(r => r.json()); }
      catch (err) { draft.regions = []; }
      if (!Array.isArray(draft.regions)) draft.regions = [];
    }
    const field = modalEl.querySelector('[data-region-field]');
    const sel = modalEl.querySelector('[data-region]');
    if (sel) sel.innerHTML = settingsRegionOptions(draft);
    if (field) field.hidden = !draft.regions.length;
  });
  paintCountryNote(draft);
  paintSetupErrors(draft, first);
}

async function saveSettingsDraft(draft, first){
  const put = (url, body) => sendJSON('PUT', url, body);
  const basics = { name: draft.name };
  /* Every field and box the server sent, so the welcome, which shows none,
     sends none. */
  if (!first) { basics.about = draft.about; basics.sections = draft.sections; }
  /* Holidays are sent only when the owner changed them: saving a name alone must not
     rewrite a profile that still has the old Holidays: line. */
  if (draft.country && (draft.country !== draft.was.country || draft.region !== draft.was.region)) {
    basics.country = draft.country;
    basics.region = draft.region;
  }
  await put('/profile-basics.json', basics);
  if (draft.signedIn) return;
  const dollars = v => v.trim() === '' ? null : Number(v);
  const agentBudgets = {};
  for (const k in draft.agentBudgets) agentBudgets[SETTINGS_BUDGET_IDS[k]] = dollars(draft.agentBudgets[k]);
  const body = { models: draft.models, agents: draft.agents, chime: draft.chime,
    daily_budget: dollars(draft.budget), agent_budgets: agentBudgets };
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

/* first: the welcome. needsList: step 2 follows step 1 (no list on disk). */
async function openSettings(first, needsList){
  let loaded;
  try { loaded = await loadSettingsDraft(first); }
  catch (err) { showToast('Could not read settings: ' + (err.message || err)); return; }
  const { draft, set } = loaded;
  const choices = (set.choices && set.choices.models) || [];
  const save = { label: 'Save', primary: true, run: async () => {
    if (Object.keys(settingsErrors(draft, first)).length) { paintSetupErrors(draft, first, true); return; }
    try { await saveSettingsDraft(draft, first); }
    catch (err) { showToast('Could not save: ' + (err.message || err)); return; }
    if (first && needsList) { openFirstList(); return; }
    /* Signed in, the name on the page is the sign-in's, so nothing to reload. */
    if (draft.signedIn) { closeModal(); showToast('Saved.', 'good'); return; }
    /* The owner's name is read once, from /owner.js, as the page loads. */
    location.reload();
  } };
  const buttons = first ? [save] : [save, { label: 'Cancel', run: closeModal }];
  const note = first
    ? '<p class="help" style="margin-top:14px">Next, run <code>scripts/install.sh</code> to link the skills and set up the hourly wake.</p>'
    : '';
  showModal(first ? 'Welcome to Bench' : (draft.signedIn ? 'Your profile' : 'Settings'),
    first ? (needsList ? 'Step 1 of 2: about you. You can change these later under Data, Settings.'
                       : 'Two things to set up. You can change them later under Data, Settings.') : '',
    settingsFormHTML(draft, choices, first) + note, buttons,
    first ? { required: true } : { keepOpen: true });
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
    '<span class="help">The groups your tasks sort into. Say what goes in each and what it ends in; the planning agent reads this before it plans anything there.</span></div>' +
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
    location.reload();
  } };
  showModal('Welcome to Bench', 'Step 2 of 2: your first list. You can add more under Lists, New list.',
    listFormHTML(list), [make], { required: true });
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
      try { await postJSON('/dataset/access', { name: acc.board, teams: got.body.teams, people: got.body.people }); }
      catch (err) { showToast('Could not save: ' + (err.message || err), 'bad'); return; }
      closeModal();
      showToast('Saved.', 'good');
    } },
    { label: 'Cancel', run: closeModal }], { keepOpen: true });
  trackSharing(sh);
}

$('#settingsBtn').onclick = () => openSettings(false);

/* ---- Starting an agent straight away ------------------------------------
   Settings > Agent options says, per agent, whether a task handed to it waits
   for its hours or starts at once. "At once" is the run the board already
   offers (Run the Plan agent now; the Agents tab's Run now), pressed for the owner.
   The agents read todo.md from disk, so a hand-over or approval only asks for a
   start here, and the start goes out after the save that carries it. */
const pendingAgentStarts = new Set();
function queueAgentStart(agent){ pendingAgentStarts.add(agent); }

async function flushAgentStarts(){
  if (!pendingAgentStarts.size) return;
  if (!agentsCanRun()) { pendingAgentStarts.clear(); return; }
  const want = Array.from(pendingAgentStarts);
  pendingAgentStarts.clear();
  let set;
  try { set = await getJSON('/settings.json'); } catch (err) { return; }
  /* A board with its agents switched off starts none. */
  if (((set.boards || {})[state.dataset] || {}).agents === false) return;
  for (const agent of want) {
    if (!set.agents || !set.agents[agent] || set.agents[agent].start !== 'now') continue;
    try {
      if (agent === 'plan') {
        await postJSON('/planning_agent/run');
        if (typeof watchRunStartedHere === 'function') watchRunStartedHere();
        showToast('The Plan agent is running.', 'good');
      } else {
        await postJSON('/agents-api/run', { agent: 'implement-agent', action: 'run', target: state.dataset });
        showToast('The Implement agent is running.', 'good');
      }
    } catch (err) {
      showToast('Could not start the ' + (agent === 'plan' ? 'Plan' : 'Implement') + ' agent: ' + (err.message || err), 'bad');
    }
  }
}
