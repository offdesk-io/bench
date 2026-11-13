'use strict';

/* =========================================================================
   4d. Memory — everything Bench keeps about the current board, on one page in
   the shared page layout (settingsPageLayoutHTML(), 29-settings.js): About you,
   Meeting recorder, Company and team, and Other context. The buckets' briefs are
   on the Agents page.

   Every field is always editable and the page's two Saves write whatever
   changed, each section through its own route and only when it differs from
   what was loaded. Drafts live in memDraft, filled from the DOM before any
   redraw, so adding a person never loses typing. The routes:

     Company   PUT /about            (one file, replaced whole)
     Team      PUT /people           (one table in people.md)
     Profile   PUT /profile-basics.json (the facts file, How to address you and
                                      the Working habits, Writing and Meeting
                                      recorder sections; only the keys changed)
     Context   PUT /context          (context.md; a list that still keeps a
                                      `## Context` section in todo.md shows that
                                      until the first save, which moves it out
                                      through state.doc + autosave)
   ========================================================================= */

let memData = null;       // the last /memory.json answer, null until it arrives
let memError = '';
let memPageError = '';    // the last page Save's message, shown under the title
let memDraft = null;      // what the page's fields hold, kept across redraws
let memBase = null;       // what was loaded, as JSON, to tell what changed

const MEM_PEOPLE_COLS = [
  { key: 'name', label: 'Name' }, { key: 'role', label: 'Role' }, { key: 'team', label: 'Team' },
  { key: 'reports_to', label: 'Reports to' }, { key: 'notes', label: 'Notes' }
];

/* The Memory tab of the Settings page is what is on screen. */
function memOnScreen(){ return state.view === 'settings' && settingsTab === 'memory'; }

/* ---- Context: context.md, or the old todo.md section until the first save ---- */

/* Where the `## Context` section sits: which of the document's two loose
   arrays (before the first bucket, after the last) holds it, and the line range
   of its body. */
function memContextSpan(){
  if (!state.doc) return null;
  for (const arr of [state.doc.pre, state.doc.post]) {
    const at = arr.findIndex(l => /^##\s+context\s*$/i.test(l));
    if (at < 0) continue;
    let end = arr.length;
    for (let i = at + 1; i < arr.length; i++) if (/^##\s/.test(arr[i])) { end = i; break; }
    return { arr, at, end };
  }
  return null;
}
function memContextText(){
  if (memData && memData.context && memData.context.exists) return String(memData.context.text || '').trim();
  const span = memContextSpan();
  return span ? span.arr.slice(span.at + 1, span.end).join('\n').trim() : '';
}
/* Drops the old section, body and heading, from the document. */
function memRemoveContextSection(){
  const span = memContextSpan();
  if (!span) return;
  let end = span.end;
  /* Before the first bucket the section's own trailing blank is the one that
     separates what is left from the bucket heading, so it stays. In the array
     after the last bucket nothing follows it, so the blanks before it go too. */
  const before = span.arr === state.doc.pre;
  if (!before) while (span.at > 0 && span.arr[span.at - 1].trim() === '' && end >= span.arr.length) span.at--;
  span.arr.splice(span.at, end - span.at);
  if (before && span.arr.length && span.arr[span.arr.length - 1].trim() !== '') span.arr.push('');
  markDirty();
}

/* ---- Drawing ---- */

/* The placeholder a section shows when it holds nothing: a quiet dashed box
   saying what goes there. */
function memEmpty(line){ return '<p class="memempty">' + esc(line) + '</p>'; }
/* What each section is for, shown under its heading whether or not it has content. */
const MEM_DESC = {
  about: 'What this business does, in a few lines every agent reads first.',
  people: 'Who is who: role, team, who reports to whom, and the names that get confused.',
  context: "What changes week to week: who is on leave, dates that can't move, and what is currently live with someone that you'd get wrong from their role alone.",
  profile: 'Facts about you that agents work from: how you work, write and want things done.'
};
/* A group's description goes under its title, in the layout's label column. */
const memDesc = id => ({ description: MEM_DESC[id] || '', descAttrs: 'data-mem-desc="' + id + '"' });
/* ---- The page's drafts ---- */

/* The profile fields the page offers, each only when the server sent it. */
const MEM_PROFILE_ABOUT = ['facts_file', 'addressing'];
const MEM_PROFILE_SECTIONS = ['habits', 'writing', 'recorder'];

function memDraftFrom(data){
  const p = data.profile || {};
  const d = { about: (data.about || {}).text || '', people: (data.people || []).map(x => Object.assign({}, x)),
    context: memContextText(), pabout: {}, psections: {} };
  MEM_PROFILE_ABOUT.forEach(k => { if (k in (p.about || {})) d.pabout[k] = p.about[k] || ''; });
  MEM_PROFILE_SECTIONS.forEach(k => { if (k in (p.sections || {})) d.psections[k] = p.sections[k] || ''; });
  return d;
}
/* The people as saved: rows with nothing in them are not people. */
const memKeptPeople = list => list.filter(p => MEM_PEOPLE_COLS.some(c => (p[c.key] || '').trim()));
function memSnapshot(d){
  return JSON.stringify({ about: d.about, people: memKeptPeople(d.people).map(p => MEM_PEOPLE_COLS.map(c => (p[c.key] || '').trim())),
    context: d.context, pabout: d.pabout, psections: d.psections });
}
function memResetDraft(){
  memDraft = memDraftFrom(memData || {});
  memBase = memSnapshot(memDraft);
  memBaseDraft = JSON.parse(JSON.stringify(memDraft));
}
let memBaseDraft = null;

/* What changed since the load, as the pieces each route takes. */
function memChanges(){
  const d = memDraft, b = memBaseDraft;
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const pabout = {}, psections = {};
  for (const k in d.pabout) if (d.pabout[k] !== b.pabout[k]) pabout[k] = d.pabout[k];
  for (const k in d.psections) if (d.psections[k] !== b.psections[k]) psections[k] = d.psections[k];
  return {
    about: d.about !== b.about,
    people: !same(memSnapshotPeople(d), memSnapshotPeople(b)),
    context: d.context !== b.context,
    pabout, psections,
    profile: !!Object.keys(pabout).length || !!Object.keys(psections).length
  };
}
const memSnapshotPeople = d => memKeptPeople(d.people).map(p => MEM_PEOPLE_COLS.map(c => (p[c.key] || '').trim()));

/* Copies what the fields on screen hold into memDraft. */
function memReadPage(){
  const host = document.querySelector('#memView');
  if (!host || !memDraft) return;
  const val = sel => { const el = host.querySelector(sel); return el ? el.value : null; };
  const about = val('[data-mem-about]'); if (about !== null) memDraft.about = about;
  const ctx = val('[data-mem-context]'); if (ctx !== null && !state.locked) memDraft.context = ctx;
  if (host.querySelector('[data-mem-people-rows]')) {
    memDraft.people = [...host.querySelectorAll('[data-mem-row]')].map(row => {
      const p = {};
      row.querySelectorAll('[data-mem-person]').forEach(inp => { p[inp.dataset.memPerson] = inp.value; });
      return p;
    });
  }
  host.querySelectorAll('[data-mem-profile-about]').forEach(el => { memDraft.pabout[el.dataset.memProfileAbout] = el.value; });
  host.querySelectorAll('[data-mem-profile-section]').forEach(el => { memDraft.psections[el.dataset.memProfileSection] = el.value; });
}
/* True when the fields on screen differ from what was loaded. */
function memIsDirty(){
  if (state.locked || !memDraft || !document.querySelector('#memView')) return false;
  memReadPage();
  return memSnapshot(memDraft) !== memBase;
}

/* ---- Sections ---- */

/* Every labelled control on the page is Tenon's Field, through tenonFieldHTML()
   (29-settings.js), the same as on the Settings tab. A locked tab (the example
   list, a backup preview) shows each one readonly and saves none. */
const memField = o => tenonFieldHTML(Object.assign({ readonly: state.locked }, o));
/* The text under a section's fields, or under its one field as that field's hint. */
const memDescText = id => MEM_DESC[id] || '';

function memAboutYouHTML(){
  const p = memData.profile || {}, d = memDraft;
  const sec = (k, name) => memField({ label: name, kind: 'textarea', attrs: 'data-mem-profile-section="' + k + '"', value: d.psections[k],
    placeholder: (p.hints || {})[k] || '', hint: SETTINGS_SECTIONS.find(x => x[0] === k)[2] });
  const abt = k => { const f = SETTINGS_ABOUT.find(x => x[0] === k); return memField({ label: f[1], attrs: 'data-mem-profile-about="' + k + '"',
    value: d.pabout[k], placeholder: 'Not set', hint: f[2] }); };
  const html = ('facts_file' in d.pabout ? abt('facts_file') : '') +
    ('habits' in d.psections ? sec('habits', 'Working habits') : '') +
    ('writing' in d.psections ? sec('writing', 'Writing rules') : '') +
    ('addressing' in d.pabout ? abt('addressing') : '');
  return Object.assign({ id: 'profile', title: 'About you', html: html || memEmpty('No profile yet. Set your name in Settings.') }, memDesc('profile'));
}

function memRecorderHTML(){
  const p = memData.profile || {}, d = memDraft;
  const f = SETTINGS_SECTIONS.find(x => x[0] === 'recorder');
  const html = 'recorder' in d.psections
    ? memField({ label: f[1], kind: 'textarea', attrs: 'data-mem-profile-section="recorder"', value: d.psections.recorder, placeholder: (p.hints || {}).recorder || '', hint: f[2] })
    : memEmpty('No profile yet. Set your name in Settings.');
  return { id: 'recorder', title: 'Meeting recorder', html };
}

function memCompanyTeamHTML(){
  const rows = memDraft.people.map((p, i) =>
    '<div class="memrow" data-mem-row="' + i + '">' +
      MEM_PEOPLE_COLS.map(c => memField({ label: c.label, attrs: 'data-mem-person="' + c.key + '"', value: p[c.key] || '' })).join('') +
      (state.locked ? '' : '<button type="button" class="btn small ghost danger" data-mem-remove="' + i + '" aria-label="Remove ' + esc(p.name || 'this person') + '">Remove</button>') +
    '</div>').join('');
  return Object.assign({ id: 'company', title: 'Company and team', wide: true, html:
    memField({ label: 'Company description', kind: 'textarea', attrs: 'data-mem-about', value: memDraft.about, placeholder: 'Say here what the company does.',
      hint: memDescText('about'), hintAttrs: 'data-mem-desc="about"' }) +
    (memDraft.people.length ? '' : memEmpty('No team yet. Add the people you work with.')) +
    '<div class="memrows" data-mem-people-rows>' + rows + '</div>' +
    (state.locked ? '' : '<div class="memactions"><button type="button" class="btn small outline" data-mem-add>Add a person</button></div>') }, memDesc('people'));
}

function memContextHTML(){
  return { id: 'context', title: 'Other context', html:
    memField({ label: 'Context', kind: 'textarea', attrs: 'data-mem-context', value: memDraft.context, placeholder: 'No context yet. Note who is away and what is live this week.',
      hint: memDescText('context'), hintAttrs: 'data-mem-desc="context"' }) };
}

/* Every field of the page, in order. A redraw builds the same fields again, so
   a field's place in this list names it afterwards. */
const memFields = () => [...document.querySelectorAll('#memView textarea, #memView input')];

/* Drawn from memDraft. A redraw while fields hold unsaved typing is skipped
   unless `force` says the page's own structure changed (a row added) or fresh
   text arrived. A forced redraw reads the typing into the drafts first and puts
   the cursor back. */
function memDraw(force, fresh){
  const lists = $('#lists');
  if (!lists) return;
  if (memError) {
    lists.innerHTML = '<div class="lists pview memview settingsview" style="--pcols:1"><p class="memerr" role="alert">' + esc(memError) + '</p></div>';
    return;
  }
  if (!memData) { lists.innerHTML = '<div class="lists pview memview settingsview" style="--pcols:1"><p class="memempty">Reading what Bench keeps…</p></div>'; return; }
  if (!force && memIsDirty()) return;
  if (force && !fresh) memReadPage();
  if (!memDraft) memResetDraft();
  const at = memFields().indexOf(document.activeElement);
  const sel = at < 0 ? null : { start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd };
  lists.innerHTML = '<div class="lists pview memview settingsview" id="memView" style="--pcols:1">' +
    (memPageError ? '<p class="memerr" role="alert">' + esc(memPageError) + '</p>' : '') +
    (state.locked ? '<p class="help memlocked">This tab is read-only.</p>' : '') +
    settingsPageLayoutHTML('Memory', [memAboutYouHTML(), memRecorderHTML(), memCompanyTeamHTML(), memContextHTML()], { saveAttr: 'data-mem-save-all', save: !state.locked }) +
  '</div>';
  lists.querySelector('#memView').onclick = memClick;
  const el = at < 0 ? null : memFields()[at];
  if (el) {
    el.focus();
    try { el.setSelectionRange(sel.start, sel.end); } catch (e) { /* not a text field */ }
  }
}

/* Test hook and reload path: take the draft from memData and draw it. */
function memReset(){ memResetDraft(); memDraw(true, true); }

/* ---- Saving ---- */

/* One request per section that changed, in the order of the page. A refusal
   stops the rest and names what was refused; what already went through is
   kept as saved. */
/* True when it went through (or there was nothing to write). */
async function memSaveAll(){
  if (state.locked) return false;
  memReadPage();
  memPageError = '';
  const ch = memChanges();
  for (const k in ch.pabout) if (/[<>`]/.test(ch.pabout[k])) { memPageError = 'Leave out < > and backticks in ' + (k === 'addressing' ? 'How to address you' : 'the facts file') + '.'; memDraw(true); return false; }
  for (const k in ch.psections) if (/^##?(\s|$)/m.test(ch.psections[k])) { memPageError = 'A # or ## heading would split the profile. Use ### or none.'; memDraw(true); return false; }
  const done = [];
  try {
    if (ch.about) { await putJSON('/about', { text: memDraft.about }); done.push('about'); }
    if (ch.people) { await putJSON('/people', { people: memKeptPeople(memDraft.people).map(p => Object.fromEntries(MEM_PEOPLE_COLS.map(c => [c.key, (p[c.key] || '').trim()]))) }); done.push('people'); }
    if (ch.profile) { await putJSON('/profile-basics.json', { about: ch.pabout, sections: ch.psections }); done.push('profile'); }
    if (ch.context && !state.locked) {
      await putJSON('/context', { text: memDraft.context });
      if (!memData) memData = {};
      memData.context = { text: memDraft.context, exists: true };
      memRemoveContextSection();
      done.push('context');
    }
  } catch (err) {
    memPageError = String(err.message || err);
    memDraw(true);
    return false;
  }
  if (!done.length) { showToast('Nothing to save.'); return true; }
  await memLoad(true);
  showToast('Saved.', 'good');
  return true;
}

function memClick(e){
  const t = e.target.closest('button');
  if (!t) return;
  if (t.hasAttribute('data-mem-save-all')) { memSaveAll(); return; }
  if (t.hasAttribute('data-mem-add')) { memReadPage(); memDraft.people.push({}); memDraw(true, true); return; }
  if (t.dataset.memRemove !== undefined) {
    memReadPage(); memDraft.people.splice(+t.dataset.memRemove, 1); memDraw(true, true); return;
  }
}

/* Reads what Bench keeps again. Unsaved typing survives it (a watch-tick reload
   or a late answer) unless `fresh` says the page was just saved and starts from
   what was read. */
async function memLoad(fresh){
  let typing = false;
  try {
    memData = await getJSON('/memory.json');
    memError = '';
    typing = !fresh && !!document.querySelector('#memView') && memIsDirty();
    if (!typing) memResetDraft();
  } catch (err) {
    memError = 'Could not read what Bench keeps. The board helper may need restarting. ' + (err.message || err);
  }
  if (memOnScreen()) memDraw(true, !typing);
}

/* Drawn again for the same page (a reload of todo.md, a refresh of the view)
   keeps the typing. Arriving from anywhere else, where
   #memView is not on screen, starts clean. */
function renderMemoryView(){
  const same = !!document.querySelector('#memView');
  if (!same) { memPageError = ''; if (memData) memResetDraft(); }
  memDraw(true, !same);
  memLoad();
}
