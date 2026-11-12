'use strict';

/* =========================================================================
   4d. Memory — everything Bench keeps about the current board, on one page:
   the company, the team, each bucket's brief, its Context,
   and the owner's profile.

   Each of the first four is read as rendered text and has its own Edit button
   that swaps it for a form. One section is in edit at a time, since a second
   open form would be a second draft nobody is looking at. The sections reach
   the disk three different ways, on purpose:

     Company   PUT /about            (one file, replaced whole)
     Team      PUT /people           (one table in people.md)
     Buckets   PUT /bucket-brief     (the route the bucket editor already uses,
                                      with the section form it already has)
     Context   PUT /context          (context.md; a list that still keeps a
                                      `## Context` section in todo.md shows that
                                      until the first save, which moves it out
                                      through state.doc + autosave)

   The profile (facts file and its four sections) saves through
   PUT /profile-basics.json, the route Settings uses for the rest of it.

   Drawn as plain markup into #lists, like Agents and Backups, with one click
   handler on the host. Drafts live in the DOM while a form is open and are read
   at Save, so there is no second copy of the text to keep in step.
   ========================================================================= */

let memData = null;       // the last /memory.json answer, null until it arrives
let memError = '';
let memEditing = null;    // 'about' | 'people' | 'context' | 'bucket:<heading>' | null
let memFormError = '';    // the last save's message, shown inside the open form
let memPeopleDraft = null;
let memBucketParts = null;
let memObserver = null;   // the index's IntersectionObserver, dropped at every redraw
let memWatcher = null;    // notices #memView leaving the page, since the other views just overwrite #lists

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
  while (span.at > 0 && span.arr[span.at - 1].trim() === '' && end >= span.arr.length) span.at--;
  span.arr.splice(span.at, end - span.at);
  markDirty();
}

/* ---- Drawing ---- */

function memRender(md, isBrief){
  const clean = String(md || '').split('\n')
    .filter(l => l.trim() !== BRIEF_MARKER && !(isBrief && /^>/.test(l.trim()))).join('\n');
  return '<div class="repdoc memtext">' + mdBlocks(clean, { keepH1: false }) + '</div>';
}
/* The placeholder a section shows when it holds nothing: a quiet dashed box
   saying what goes there. The section, its index entry and its Edit button stay. */
function memEmpty(line){ return '<p class="memempty">' + esc(line) + '</p>'; }
function memEditBtn(which, hidden){
  const off = memEditing && memEditing !== which;
  return hidden ? '' : '<button class="btn small outline" data-mem-edit="' + esc(which) + '"' +
    (off ? ' disabled title="Save or cancel the open edit first"' : '') + '>Edit</button>';
}
function memFormButtons(which){
  return '<div class="memactions">' +
    '<button class="btn small primary" data-mem-save="' + esc(which) + '">Save</button>' +
    '<button class="btn small ghost" data-mem-cancel>Cancel</button>' +
    (memFormError ? '<span class="memerr" role="alert">' + esc(memFormError) + '</span>' : '') +
  '</div>';
}
/* A stable anchor id for the index: the same text always gives the same id. */
function memSlug(text){
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}
/* What each section is for, shown under its heading whether or not it has content. */
const MEM_DESC = {
  about: 'What this business does, in a few lines every agent reads first.',
  people: 'Who is who: role, team, who reports to whom, and the names that get confused.',
  buckets: 'One per bucket: what kind of work lands there and how it should be handled.',
  context: "What changes week to week: who is on leave, dates that can't move, and what is currently live with someone that you'd get wrong from their role alone.",
  profile: 'Facts about you that agents work from: how you work, write and want things done.'
};
function memDesc(id){ return MEM_DESC[id] ? '<p class="memdesc">' + esc(MEM_DESC[id]) + '</p>' : ''; }
let memIds = new Set();   // ids issued during this render, so two headings that slug alike stay apart
function memUniqueId(base){
  let id = base, n = 1;
  while (memIds.has(id)) id = base + '-' + (++n);
  memIds.add(id);
  return id;
}
function memSection(id, title, bodyHTML, edit, extra){
  return '<section class="memsec" id="' + esc(memUniqueId('mem-' + memSlug(id))) + '" data-mem="' + esc(id) + '">' +
    '<div class="memhead"><h3>' + esc(title) + '</h3>' + (edit || '') + '</div>' +
    memDesc(id) + (extra || '') + bodyHTML +
  '</section>';
}

function memAboutHTML(){
  const a = memData.about;
  if (memEditing === 'about') {
    return memSection('about', 'Company',
      '<textarea class="memarea" data-mem-about aria-label="Company description" spellcheck="true">' + esc(a.text) + '</textarea>' +
      memFormButtons('about'));
  }
  return memSection('about', 'Company',
    a.text.trim() ? memRender(a.text) : memEmpty('No company description yet. Say here what the company does.'), memEditBtn('about'));
}

function memPeopleHTML(){
  const people = memData.people;
  if (memEditing === 'people') {
    const rows = memPeopleDraft.map((p, i) =>
      '<div class="memrow" data-mem-row="' + i + '">' +
        MEM_PEOPLE_COLS.map(c =>
          '<label class="field"><span>' + esc(c.label) + '</span>' +
          '<input type="text" data-mem-person="' + c.key + '" value="' + esc(p[c.key] || '') + '" aria-label="' + esc(c.label + ', person ' + (i + 1)) + '"></label>'
        ).join('') +
        '<button class="btn small ghost danger" data-mem-remove="' + i + '" aria-label="Remove ' + esc(p.name || 'this person') + '">Remove</button>' +
      '</div>').join('');
    return memSection('people', 'Team',
      '<div class="memrows">' + rows + '</div>' +
      '<div class="memactions"><button class="btn small outline" data-mem-add>Add a person</button></div>' +
      memFormButtons('people'));
  }
  if (!people.length) return memSection('people', 'Team', memEmpty('No team yet. Add the people you work with.'), memEditBtn('people'));
  const table = '<div class="memscroll"><table class="memtable"><thead><tr>' +
    MEM_PEOPLE_COLS.map(c => '<th>' + esc(c.label) + '</th>').join('') + '</tr></thead><tbody>' +
    people.map(p => '<tr>' + MEM_PEOPLE_COLS.map(c =>
      '<td data-label="' + esc(c.label) + '">' + esc(p[c.key] || '') + '</td>').join('') + '</tr>').join('') +
    '</tbody></table></div>';
  return memSection('people', 'Team', table, memEditBtn('people'));
}

function memBucketsHTML(){
  const list = memData.buckets;
  if (!list.length) return '<section class="memsec" id="mem-buckets" data-mem="buckets"><div class="memhead"><h3>Buckets</h3></div>' + memDesc('buckets') +
    memEmpty('No buckets yet. Each bucket of the board gets its brief here.') + '</section>';
  return '<section class="memsec" id="mem-buckets" data-mem="buckets"><div class="memhead"><h3>Buckets</h3></div>' + memDesc('buckets') +
    list.map(b => {
      const which = 'bucket:' + b.heading;
      let body;
      if (memEditing === which) {
        body = '<label class="field"><span>One line: what kind of work lands here</span>' +
          '<input type="text" data-mem-brief-summary value="' + esc(memBucketParts.summary) + '" aria-label="What kind of work lands in this bucket"></label>' +
          BRIEF_SECTIONS.map((name, i) =>
            '<label class="field briefsection"><span>' + esc(name) + '</span>' +
            '<textarea data-brief-section="' + i + '" spellcheck="false" aria-label="' + esc(name) + '">' +
            esc(memBucketParts.sections[name] || '') + '</textarea></label>').join('') +
          memFormButtons(which);
      } else if (!b.exists) body = memEmpty('No brief yet.');
      else if (!b.filled) body = memEmpty('The brief is still the empty template.');
      else body = memRender(b.text, true);
      return '<article class="membucket" id="' + esc(memUniqueId('mem-bucket-' + memSlug(b.heading))) + '" data-mem-bucket="' + esc(b.heading) + '">' +
        '<div class="memhead"><h4>' + esc(b.name) + '</h4>' + memEditBtn(which, memEditing === which) + '</div>' + body +
      '</article>';
    }).join('') +
  '</section>';
}

function memContextHTML(){
  const text = memContextText();
  if (memEditing === 'context' && !state.locked) {
    return memSection('context', 'Context',
      '<textarea class="memarea" data-mem-context aria-label="Context" spellcheck="true">' + esc(text) + '</textarea>' +
      memFormButtons('context'));
  }
  if (state.locked) {
    return memSection('context', 'Context', text ? memRender(text) : memEmpty('No context yet. Note who is away and what is live this week.'), '',
      '<p class="help">This tab is read-only.</p>');
  }
  return memSection('context', 'Context', text ? memRender(text) : memEmpty('No context yet. Note who is away and what is live this week.'), memEditBtn('context'));
}

/* The profile's editable parts: the facts file and the four sections, the same
   fields Settings used to hold, saved through PUT /profile-basics.json. Name,
   address and holidays stay in Settings. */
function memProfileFields(p){
  const about = SETTINGS_ABOUT.filter(([k]) => k === 'facts_file' && k in (p.about || {}));
  const sections = SETTINGS_SECTIONS.filter(([k]) => k in (p.sections || {}));
  return { about, sections };
}

function memProfileForm(p){
  const f = memProfileFields(p);
  return f.about.map(([k, name, help]) =>
    '<label class="field"><span>' + esc(name) + '</span><input type="text" data-mem-profile-about="' + k + '" value="' + escAttr((p.about || {})[k] || '') + '" placeholder="Not set">' +
    '<span class="help">' + esc(help) + '</span></label>').join('') +
    f.sections.map(([k, name, help]) =>
    '<label class="field"><span>' + esc(name) + '</span>' +
    '<textarea class="memarea" rows="4" data-mem-profile-section="' + k + '" placeholder="' + escAttr((p.hints || {})[k] || '') + '" spellcheck="true">' + esc(p.sections[k]) + '</textarea>' +
    '<span class="help">' + esc(help) + '</span></label>').join('') +
    memFormButtons('profile');
}

function memProfileHTML(){
  const p = memData.profile || {};
  const about = Object.entries(p.about || {}).filter(([, v]) => String(v || '').trim());
  const sections = Object.entries(p.sections || {}).filter(([, v]) => String(v || '').trim());
  const f = memProfileFields(p);
  const editable = f.about.length + f.sections.length > 0;
  if (memEditing === 'profile' && editable) return memSection('profile', 'Your profile', memProfileForm(p));
  const edit = memEditBtn('profile', !editable);
  if (!(p.name || '').trim() && !about.length && !sections.length) {
    return memSection('profile', 'Your profile', memEmpty('No profile yet. Edit it here, or set your name in Settings.'), edit);
  }
  const body =
    ((p.name || '').trim() ? '<p><strong>' + esc(p.name) + '</strong></p>' : '') +
    (about.length ? '<dl class="memdl">' + about.map(([k, v]) =>
      '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>').join('') + '</dl>' : '') +
    sections.map(([k, v]) => '<h4 id="' + esc(memUniqueId('mem-profile-' + memSlug(k))) + '" data-mem-sub>' + esc(k) + '</h4>' + mdBlocks(String(v))).join('');
  return memSection('profile', 'Your profile', '<div class="repdoc memtext">' + body + '</div>', edit);
}

/* What the open profile form holds, or an error message. The same two rules
   the server holds: no < > or backticks in a field, no # or ## heading in a box. */
function memReadProfile(){
  const about = {}, sections = {};
  for (const el of document.querySelectorAll('#memView [data-mem-profile-about]')) {
    if (/[<>`]/.test(el.value)) return { error: 'Leave out < > and backticks in the facts file.' };
    about[el.dataset.memProfileAbout] = el.value.trim();
  }
  for (const el of document.querySelectorAll('#memView [data-mem-profile-section]')) {
    if (/^##?(\s|$)/m.test(el.value)) return { error: 'A # or ## heading would split the profile. Use ### or none.' };
    sections[el.dataset.memProfileSection] = el.value;
  }
  return { about, sections };
}

/* ---- The index: one link per section, one nested per subsection ---- */

function memIndexHTML(host){
  const link = (el, title, sub) => '<li' + (sub ? ' class="sub"' : '') + '><a href="#' + esc(el.id) + '" data-mem-jump="' + esc(el.id) + '">' + esc(title) + '</a>';
  let out = '';
  host.querySelectorAll('.memsec').forEach(sec => {
    const h = sec.querySelector(':scope > .memhead h3');
    const subs = [...sec.querySelectorAll('.membucket[id], h4[data-mem-sub]')];
    out += link(sec, h ? h.textContent : sec.dataset.mem, false);
    if (subs.length) {
      out += '<ul>' + subs.map(el => {
        const h4 = el.matches('h4') ? el : el.querySelector('.memhead h4');
        return link(el, h4 ? h4.textContent : el.id, true) + '</li>';
      }).join('') + '</ul>';
    }
    out += '</li>';
  });
  return '<nav class="memindex" aria-label="On this page"><ul>' + out + '</ul></nav>';
}

/* The index sticks just under the header, whose height changes (it wraps, and a
   backup preview adds a bar above it), so the offset is measured, not fixed. */
function memPlaceIndex(){
  const host = document.getElementById('memView');
  const hdr = document.getElementById('hdr');
  if (!host) return;
  const cs = hdr && getComputedStyle(hdr);
  const top = cs && cs.position === 'sticky' && hdr.offsetHeight ? (parseFloat(cs.top) || 0) + hdr.offsetHeight : 0;
  host.style.setProperty('--mem-top', (top + 12) + 'px');
}
let memResizeBound = false;

function memStopObserving(){
  if (memObserver) { memObserver.disconnect(); memObserver = null; }
  if (memWatcher) { memWatcher.disconnect(); memWatcher = null; }
}

/* Marks the first visible target in page order, plus its section when it is a
   subsection. IntersectionObserver reports changes only, so the visible set is
   kept here between callbacks. */
function memObserve(host){
  memStopObserving();
  if (typeof IntersectionObserver === 'undefined') return;
  const targets = [...host.querySelectorAll('.memsec[id], .membucket[id], h4[data-mem-sub]')];
  const seen = new Set();
  let current = null;
  const mark = id => {
    current = id;
    const nav = host.querySelector('.memindex');
    if (!nav) return;
    const el = id && document.getElementById(id);
    const sec = el && el.closest('.memsec');
    nav.querySelectorAll('a').forEach(a => {
      const on = a.dataset.memJump === id || (sec && a.dataset.memJump === sec.id);
      if (on) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
    });
  };
  memObserver = new IntersectionObserver(entries => {
    if (!host.isConnected || host.offsetParent === null) { memStopObserving(); return; }
    entries.forEach(en => { if (en.isIntersecting) seen.add(en.target.id); else seen.delete(en.target.id); });
    const first = targets.find(t => seen.has(t.id));
    if (first) mark(first.id);
    else if (!current && targets.length) mark(targets[0].id);
  }, { rootMargin: '0px 0px -60% 0px' });
  targets.forEach(t => memObserver.observe(t));
  // The board tab only hides #lists and the others overwrite it; either way the view is gone.
  memWatcher = new MutationObserver(() => { if (!host.isConnected || host.offsetParent === null) memStopObserving(); });
  memWatcher.observe(host.parentNode, { childList: true, attributes: true, attributeFilter: ['class'] });
  mark(targets.length ? targets[0].id : null);
}

function memDraw(){
  const lists = $('#lists');
  memStopObserving();
  if (!lists) return;
  if (memError) {
    lists.innerHTML = '<div class="memview"><p class="memerr" role="alert">' + esc(memError) + '</p></div>';
    return;
  }
  if (!memData) { lists.innerHTML = '<div class="memview"><p class="memempty">Reading what Bench keeps…</p></div>'; return; }
  memIds = new Set();
  lists.innerHTML = '<div class="memview" id="memView"><div class="memcontent">' +
    memAboutHTML() + memPeopleHTML() + memBucketsHTML() + memContextHTML() + memProfileHTML() +
  '</div></div>';
  const host = lists.querySelector('#memView');
  host.insertAdjacentHTML('afterbegin', memIndexHTML(host));
  host.onclick = memClick;
  memPlaceIndex();
  if (!memResizeBound) { memResizeBound = true; window.addEventListener('resize', memPlaceIndex); }
  memObserve(host);
}

/* ---- Reading what is on screen into a draft ---- */

function memReadPeople(){
  const out = [];
  document.querySelectorAll('#memView [data-mem-row]').forEach(row => {
    const p = {};
    row.querySelectorAll('[data-mem-person]').forEach(inp => { p[inp.dataset.memPerson] = inp.value.trim(); });
    out.push(p);
  });
  return out;
}

async function memSave(which){
  memFormError = '';
  try {
    if (which === 'about') {
      const box = document.querySelector('#memView [data-mem-about]');
      await putJSON('/about', { text: box.value });
    } else if (which === 'people') {
      const people = memReadPeople().filter(p => MEM_PEOPLE_COLS.some(c => p[c.key]));
      await putJSON('/people', { people });
    } else if (which === 'profile') {
      const got = memReadProfile();
      if (got.error) throw new Error(got.error);
      await putJSON('/profile-basics.json', { about: got.about, sections: got.sections });
    } else if (which === 'context') {
      const box = document.querySelector('#memView [data-mem-context]');
      await putJSON('/context', { text: box.value });
      if (!memData) memData = {};
      memData.context = { text: box.value, exists: true };
      memRemoveContextSection();
    } else if (which.indexOf('bucket:') === 0) {
      const heading = which.slice(7);
      const b = memData.buckets.find(x => x.heading === heading);
      const box = document.querySelector('#memView [data-mem-brief-summary]');
      memBucketParts.summary = box.value;
      document.querySelectorAll('#memView [data-brief-section]').forEach(t => {
        memBucketParts.sections[BRIEF_SECTIONS[+t.dataset.briefSection]] = t.value;
      });
      const wasEmpty = !b.exists || !b.filled;
      const text = serializeBriefText(memBucketParts, keepBriefMarker(wasEmpty, memBucketParts));
      await putJSON('/bucket-brief', { bucket: heading, text });
      checkAgentsSetup();
    }
  } catch (err) {
    memFormError = String(err.message || err);
    if (memOnScreen()) memDraw();
    return;
  }
  memEditing = null; memPeopleDraft = null; memBucketParts = null;
  if (which === 'context') { memDraw(); return; }
  await memLoad();
}

function memStartEdit(which){
  memFormError = '';
  memEditing = which;
  if (which === 'people') memPeopleDraft = memData.people.map(p => Object.assign({}, p));
  if (which.indexOf('bucket:') === 0) {
    const b = memData.buckets.find(x => x.heading === which.slice(7));
    memBucketParts = parseBriefText(b.text);
    if (!b.exists) memBucketParts.title = b.name;
  }
  memDraw();
  const first = document.querySelector('#memView [data-mem="' + which.split(':')[0] + '"] textarea, #memView .membucket[data-mem-bucket="' +
    (which.indexOf('bucket:') === 0 ? which.slice(7).replace(/"/g, '\\"') : '') + '"] input, #memView [data-mem="people"] input');
  if (first) first.focus();
}

function memClick(e){
  const jump = e.target.closest('a[data-mem-jump]');
  if (jump) {
    // scrollIntoView, not a real hash jump: the board's own routing lives in location.hash
    e.preventDefault();
    const to = document.getElementById(jump.dataset.memJump);
    const calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (to) to.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
    return;
  }
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.memEdit) { memStartEdit(t.dataset.memEdit); return; }
  if (t.hasAttribute('data-mem-cancel')) { memEditing = null; memFormError = ''; memDraw(); return; }
  if (t.dataset.memSave) { memSave(t.dataset.memSave); return; }
  if (t.hasAttribute('data-mem-add')) { memPeopleDraft = memReadPeople(); memPeopleDraft.push({}); memDraw(); return; }
  if (t.dataset.memRemove !== undefined) {
    memPeopleDraft = memReadPeople(); memPeopleDraft.splice(+t.dataset.memRemove, 1); memDraw(); return;
  }
}

async function memLoad(){
  try {
    memData = await getJSON('/memory.json');
    memError = '';
  } catch (err) {
    memError = 'Could not read what Bench keeps. The board helper may need restarting. ' + (err.message || err);
  }
  if (memOnScreen()) memDraw();
}

function renderMemoryView(){
  memEditing = null; memFormError = '';
  memDraw();
  memLoad();
}
