'use strict';

/* =========================================================================
   4d. Memory — everything Bench keeps about the current board, on one page:
   the company, the team, each bucket's brief, the Context section of the list,
   and the owner's profile.

   Each of the first four is read as rendered text and has its own Edit button
   that swaps it for a form. One section is in edit at a time, since a second
   open form would be a second draft nobody is looking at. The sections reach
   the disk three different ways, on purpose:

     Company   PUT /about            (one file, replaced whole)
     Team      PUT /people           (one table in people.md)
     Buckets   PUT /bucket-brief     (the route the bucket editor already uses,
                                      with the section form it already has)
     Context   state.doc + autosave  (it is part of todo.md, so it goes through
                                      the board's own save and never a route of
                                      its own)

   The profile is read-only here. It already has a form, in Settings, and a
   second one would be a second writer.

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

const MEM_PEOPLE_COLS = [
  { key: 'name', label: 'Name' }, { key: 'role', label: 'Role' }, { key: 'team', label: 'Team' },
  { key: 'reports_to', label: 'Reports to' }, { key: 'notes', label: 'Notes' }
];

/* ---- Context, read and written through the document ---- */

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
  const span = memContextSpan();
  return span ? span.arr.slice(span.at + 1, span.end).join('\n').trim() : '';
}
function memSetContext(text){
  const body = String(text || '').replace(/\s+$/, '').split('\n');
  const span = memContextSpan();
  if (span) {
    const more = span.end < span.arr.length;
    const lines = [''].concat(body, more ? [''] : []);
    span.arr.splice(span.at + 1, span.end - span.at - 1, ...lines);
  } else {
    const post = state.doc.post;
    if (post.length && post[post.length - 1].trim() !== '') post.push('');
    post.push('## Context', '', ...body, '');
  }
  markDirty();
}

/* ---- Drawing ---- */

function memRender(md, isBrief){
  const clean = String(md || '').split('\n')
    .filter(l => l.trim() !== BRIEF_MARKER && !(isBrief && /^>/.test(l.trim()))).join('\n');
  return '<div class="repdoc memtext">' + mdBlocks(clean, { keepH1: false }) + '</div>';
}
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
function memSection(id, title, bodyHTML, edit, extra){
  return '<section class="memsec" data-mem="' + esc(id) + '">' +
    '<div class="memhead"><h3>' + esc(title) + '</h3>' + (edit || '') + '</div>' +
    (extra || '') + bodyHTML +
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
    a.text.trim() ? memRender(a.text) : memEmpty('No company description yet.'), memEditBtn('about'));
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
  if (!people.length) return memSection('people', 'Team', memEmpty('No team yet.'), memEditBtn('people'));
  const table = '<div class="memscroll"><table class="memtable"><thead><tr>' +
    MEM_PEOPLE_COLS.map(c => '<th>' + esc(c.label) + '</th>').join('') + '</tr></thead><tbody>' +
    people.map(p => '<tr>' + MEM_PEOPLE_COLS.map(c =>
      '<td data-label="' + esc(c.label) + '">' + esc(p[c.key] || '') + '</td>').join('') + '</tr>').join('') +
    '</tbody></table></div>';
  return memSection('people', 'Team', table, memEditBtn('people'));
}

function memBucketsHTML(){
  const list = memData.buckets;
  if (!list.length) return '<section class="memsec" data-mem="buckets"><div class="memhead"><h3>Buckets</h3></div>' +
    memEmpty('No buckets yet.') + '</section>';
  return '<section class="memsec" data-mem="buckets"><div class="memhead"><h3>Buckets</h3></div>' +
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
      return '<article class="membucket" data-mem-bucket="' + esc(b.heading) + '">' +
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
    return memSection('context', 'Context', text ? memRender(text) : memEmpty('No context yet.'), '',
      '<p class="help">This tab is read-only.</p>');
  }
  return memSection('context', 'Context', text ? memRender(text) : memEmpty('No context yet.'), memEditBtn('context'));
}

function memProfileHTML(){
  const p = memData.profile || {};
  const about = Object.entries(p.about || {}).filter(([, v]) => String(v || '').trim());
  const sections = Object.entries(p.sections || {}).filter(([, v]) => String(v || '').trim());
  const edit = '<button class="btn small outline" data-mem-profile>Edit in Settings</button>';
  if (!(p.name || '').trim() && !about.length && !sections.length) {
    return memSection('profile', 'Your profile', memEmpty('No profile yet.'), edit);
  }
  const body =
    ((p.name || '').trim() ? '<p><strong>' + esc(p.name) + '</strong></p>' : '') +
    (about.length ? '<dl class="memdl">' + about.map(([k, v]) =>
      '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>').join('') + '</dl>' : '') +
    sections.map(([k, v]) => '<h4>' + esc(k) + '</h4>' + mdBlocks(String(v))).join('');
  return memSection('profile', 'Your profile', '<div class="repdoc memtext">' + body + '</div>', edit);
}

function memDraw(){
  const lists = $('#lists');
  if (!lists) return;
  if (memError) {
    lists.innerHTML = '<div class="memview"><p class="memerr" role="alert">' + esc(memError) + '</p></div>';
    return;
  }
  if (!memData) { lists.innerHTML = '<div class="memview"><p class="memempty">Reading what Bench keeps…</p></div>'; return; }
  lists.innerHTML = '<div class="memview" id="memView">' +
    memAboutHTML() + memPeopleHTML() + memBucketsHTML() + memContextHTML() + memProfileHTML() +
  '</div>';
  const host = lists.querySelector('#memView');
  host.onclick = memClick;
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
    } else if (which === 'context') {
      const box = document.querySelector('#memView [data-mem-context]');
      memSetContext(box.value);
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
    if (state.view === 'memory') memDraw();
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
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.memEdit) { memStartEdit(t.dataset.memEdit); return; }
  if (t.hasAttribute('data-mem-cancel')) { memEditing = null; memFormError = ''; memDraw(); return; }
  if (t.dataset.memSave) { memSave(t.dataset.memSave); return; }
  if (t.hasAttribute('data-mem-add')) { memPeopleDraft = memReadPeople(); memPeopleDraft.push({}); memDraw(); return; }
  if (t.dataset.memRemove !== undefined) {
    memPeopleDraft = memReadPeople(); memPeopleDraft.splice(+t.dataset.memRemove, 1); memDraw(); return;
  }
  if (t.hasAttribute('data-mem-profile')) { openSettings(false); }
}

async function memLoad(){
  try {
    memData = await getJSON('/memory.json');
    memError = '';
  } catch (err) {
    memError = 'Could not read what Bench keeps. The board helper may need restarting. ' + (err.message || err);
  }
  if (state.view === 'memory') memDraw();
}

function renderMemoryView(){
  memEditing = null; memFormError = '';
  memDraw();
  memLoad();
}
