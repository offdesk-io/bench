'use strict';

/* =========================================================================
   Data sets — which private folder under data/ the board reads and writes.

   The dropdown lists every folder the server found; picking one asks the
   server to make it current, then reloads the page rather than trying to
   patch state in place. A switch changes the list, its backups, its Claude
   sessions and its Jira config all at once, so a full reload is the only way
   to be sure nothing from the old one lingers in this tab.

   Which list is loaded is on the button rather than only inside the panel it
   opens. Everything on the board — every count, every date, every name — is
   true of one data set and wrong of the other, and with the switcher buried
   in a menu there was nothing on the page saying which one you were reading.
   ========================================================================= */

/* The button reads "Work And Career ▾", with a plain "Data" label beside it in
   the page. The name is tidied for display only: data/.current, the folder and
   every request keep the raw name ("work-and-career"). Falls back to "Lists ▾"
   when there is no name, which is the board behaving as it did before lists
   existed. */
function prettyDataset(name){
  return String(name || '').replace(/[-_]+/g, ' ').trim()
    .replace(/(^|\s)(\S)/g, (m, sp, ch) => sp + ch.toUpperCase());
}
function setDataMenuLabel(name){
  $('#dataMenuBtn').textContent = (name ? prettyDataset(name) : 'Lists') + ' \u25BE';
}
/* Every list is a row of its own under a "Lists" heading, rather than a name
   inside a closed <select>. A picker that has to be opened to say what it
   holds is one more click on a menu that is already open, and it hid how many
   lists there even are — which for two or three rows is the whole of the
   information. The current one is ticked and does nothing when clicked.

   They are `dropdown-item`s, the same object as Undo and Backups above them,
   because picking a list is an action the menu performs like any other. */
function datasetItemHTML(name, current){
  return '<button class="dropdown-item dsitem' + (current ? ' current' : '') + '"' +
    ' role="menuitem" data-dataset="' + esc(name) + '"' +
    ' title="' + esc(name) + '"' +
    (current ? ' aria-current="true"' : '') + '>' +
    '<span class="dstick" aria-hidden="true">' + (current ? '\u2713' : '') + '</span>' +
    esc(prettyDataset(name)) + '</button>';
}

async function loadDatasets(){
  try {
    const data = await getJSON(DATASETS_URL);
    $('#datasetList').innerHTML =
      (data.datasets || []).map(name => datasetItemHTML(name, name === data.current)).join('') +
      '<button class="dropdown-item dsitem" role="menuitem" data-dataset="__new__">' +
        '<span class="dstick" aria-hidden="true"></span>+ New list…</button>';
    state.datasets = true;
    state.dataset = data.current || '';
    state.datasetNames = data.datasets || [];
    setDataMenuLabel(data.current);
    if (!state.locked) $('#datasetMenu').classList.remove('hidden');
  } catch (err) {
    // No /datasets.json — an older server, or none at all. One list, no
    // picker, exactly as the board behaved before this existed.
    state.datasets = false;
    setDataMenuLabel(listFolder ? listFolder.name : '');
    $('#datasetMenu').classList.add('hidden');
  }
  resolvePendingBoard();
}

/* A banner's link names its board: #!board=<name>!task=<key>. That segment is
   used once. It comes off the address first, so a reload does not switch again,
   and then either the board is switched through switchDataset (the dropdown's
   own path, which reloads onto the same hash minus the board) or, when the name
   is the current board, unknown or hidden from this person, the link carries on
   as if it had never named one. Returns true when it is switching. */
function followBoardLink(board, task, atBoot){
  /* Built from what the link said rather than read back off the address: the
     first render of the list being left rewrites the address to match itself,
     which loses the card, and it can land before this runs. */
  const hash = task ? '#!task=' + encodeTaskKey(task) : '#';
  history.replaceState(null, '', location.hash.replace(/!board=[^!]*/, '') || '#');
  if (board && board !== state.dataset && state.datasetNames.indexOf(board) > -1) {
    /* Until the person has touched the page, the only unsaved changes are the
       load's own tidy-ups (rolled dates, stamped ids), which the next load
       makes again; asking about them would put an alert in front of every
       banner click that lands mid-load. Once they have typed or clicked, the
       changes may be theirs, and it asks like the list menu does. */
    if (state.dirty && !(atBoot && !state.touched)) {
      alert('You have unsaved changes on this list.\n\nSave or discard them first, then open that link again.');
      return false;
    }
    /* Dropped on purpose, and cleared so the reload does not ask to leave. */
    state.dirty = false;
    switchDataset(board, hash);
    return true;
  }
  return false;
}
/* Boot: the board list is in, so the held-back card can be opened or the
   board switched. */
function resolvePendingBoard(){
  const board = state.pendingBoard, task = state.pendingBoardTask;
  if (!board) return;
  state.pendingBoard = state.pendingBoardTask = '';
  if (followBoardLink(board, task, true)) return;
  if (task) {
    state.pendingTask = task;
    if (state.doc) applyPendingTask();
  }
}

/* Whether the person has typed or clicked since the page loaded. */
['keydown', 'input', 'pointerdown'].forEach(type =>
  window.addEventListener(type, () => { state.touched = true; }, { capture: true, passive: true }));

const SWITCH_GRACE_MS = 3000;
function reloadPage(){ location.reload(); }

async function switchDataset(name, hashAfter){
  const from = state.dataset;
  state.switching = true;
  try {
    await postJSON('/dataset/select', { name });
    /* A render while the request was out will have rewritten the address to
       match the list being left, which has no such card. */
    if (hashAfter) history.replaceState(null, '', hashAfter);
    reloadPage();
    /* A page still here a moment later may only be a slow reload, which must
       be left alone: the server is on the new list, and so is the page about
       to load. Only a reload the leave-site prompt was raised for can have
       been cancelled (the beforeunload handler in 25-archiving.js says so). In
       that case point the server back at the list this tab holds and let saves
       resume on it. */
    setTimeout(async () => {
      if (!state.switching || !state.leavePrompted) return;
      try { if (from) await postJSON('/dataset/select', { name: from }); } catch (err) { /* nothing more to do */ }
      state.switching = false;
      state.leavePrompted = false;
      $('#status').textContent = 'staying on this list; the switch was cancelled';
    }, SWITCH_GRACE_MS);
  } catch (err) {
    state.switching = false;
    alert('Could not switch lists.\n\n' + (err.message || err));
    loadDatasets();
  }
}

/* ---- Who is signed in ----------------------------------------------------
   Only on the shared board, behind nginx's sign-in (BENCH_AUTH=header in
   kanban/server.py). The Mac board answers /whoami with a 404, state.who stays
   null and nothing here changes the page.

   Signed in, the header says who you are and offers Sign out, which nginx's
   /auth/ route answers rather than this server. The parts that only work on
   the owner's Mac go: the server refuses them, and body.signed-in hides their
   buttons (board.css) so nothing on the page offers what will fail. The
   Agents tab goes through viewDefs(), which is why the view is drawn again. */
async function loadWhoami(){
  let who;
  try { who = await getJSON('/whoami'); } catch (err) { return; }
  if (!who || !who.email) return;
  state.who = who;
  document.body.classList.add('signed-in');
  $('#whoName').textContent = personName(who.email);
  $('#whoName').title = who.email;
  $('#whoami').classList.remove('hidden');
  if (state.doc) renderView();
  loadBoardPeople();
}

/* ---- Who did what ----------------------------------------------------------
   On the shared board the server writes who wrote each task and who last
   changed it (`created-by:` and `edited-by:`, by email, stamp_authors() in
   core/todo.py) and logs every change in the list's activity.jsonl. Here the
   emails become names, from /activity.json, and the latest change by somebody
   else goes in the status line. A Mac list carries neither tag and its log
   only ever names its owner, so none of this shows there. */
/* The name a person signed in with, cleaned, or '' when nobody has said
   one. For the avatar's initials; what is shown in words is personName(). */
function personFullName(email){
  if (!email) return '';
  const who = state.who;
  const own = who && who.email === email && who.name !== email.split('@')[0] ? who.name : '';
  const known = (state.boardPeople || []).find(p => p.email === email);
  return cleanPersonName(own || (known && known.name) || state.authorNames[email] || '');
}
/* First name and last initial, "Jérôme D.", the way the owner's own notes
   write a person; a one-word name as it is. */
function shortName(full){
  const words = cleanPersonName(full).split(' ').filter(Boolean);
  if (words.length < 2) return words[0] || '';
  return words[0] + ' ' + words[words.length - 1].charAt(0).toUpperCase() + '.';
}
/* How a person shows in words, anywhere: their short name, or the part of
   their email before the @ when they have none. Two people the board knows
   who come out the same get that part of the email in brackets as well, so
   "Ana S. (ana)" and "Ana S. (ana.sousa)" stay two people. Something that is
   not an email (an agent, pa, the Mac owner in the log) is its own name. */
function personName(email){
  if (!email) return '';
  if (!isPersonEmail(email)) return cleanPersonName(state.authorNames[email]) || email;
  const local = email.split('@')[0];
  const short = shortName(personFullName(email)) || local;
  const others = new Set((state.boardPeople || []).map(p => p.email)
    .concat(Object.keys(state.authorNames || {}), state.who ? [state.who.email] : []));
  others.delete(email);
  for (const e of others)
    if (isPersonEmail(e) && (shortName(personFullName(e)) || e.split('@')[0]) === short) return short + ' (' + local + ')';
  return short;
}
/* What `[to:: ]` shows as: an agent or a people.md name as written, a person
   given a task on a shared board (their email) as their name. */
function assigneeLabel(to){
  const v = String(to || '').trim();
  return isPersonEmail(v) ? personName(v.toLowerCase()) : v;
}
/* The face beside `[to:: ]`, wherever one is drawn: an agent's, a person's
   for an email, and none for a people.md name, which has no face to give. */
function assigneeAvatarHTML(to, size){
  const v = String(to || '').trim();
  return agentAvatarHTML(v, size) ||
    (isPersonEmail(v) ? personAvatarHTML(v.toLowerCase(), personFullName(v.toLowerCase()), size) : '');
}
/* The board's people, for Delegate to. Signed in only, and asked again when
   the list on screen changes, since each board has its own. */
async function loadBoardPeople(){
  if (!state.who) { state.boardPeople = []; return; }
  try {
    const got = await getJSON('/board-people.json');
    state.boardPeople = got && Array.isArray(got.people) ? got.people : [];
  } catch (err) { state.boardPeople = []; }
  if (state.doc) refreshView();
}
/* The card's short form, "by Jerome" or "edited by Ana", and the long one
   for the task panel and the card's tooltip. '' with neither tag. */
function authorShort(t){
  if (t.editedBy && t.editedBy !== t.createdBy) return 'edited by ' + personName(t.editedBy);
  return t.createdBy ? 'by ' + personName(t.createdBy) : '';
}
function authorLong(t){
  const parts = [];
  if (t.createdBy) parts.push('Created by ' + personName(t.createdBy));
  if (t.editedBy) parts.push((parts.length ? 'last edited by ' : 'Last edited by ') + personName(t.editedBy));
  return parts.join(' · ');
}
/* Whether `[to:: ]` names whoever is signed in, by their email and nothing
   else: a name or first name is not unique on a shared board, and matching
   one would hand someone else's task to whoever shares it. The Mac board has
   nobody signed in, so this is never true there, and "your move" keeps
   matching the owner's name (yourMove()). */
function namesMe(to){
  const who = state.who, v = String(to || '').trim().toLowerCase();
  return !!(who && v && v === String(who.email).toLowerCase());
}
function forMe(t){ return namesMe(t.to) || subSteps(t).some(s => namesMe(s.to)); }

/* Names, and "Jerome edited 2 min ago" for the newest change by somebody
   other than whoever is asking. Called when the list loads, when the watcher
   brings in a change, and after a save the server merged. */
async function loadActivity(){
  if (state.demo || listFolder) return;
  let got;
  try { got = await getJSON('/activity.json'); } catch (err) { return; }
  if (!got || !Array.isArray(got.entries)) return;
  const names = got.names || {};
  const fresh = JSON.stringify(names) !== JSON.stringify(state.authorNames);
  state.authorNames = names;
  if (fresh && state.doc) refreshView();
  const other = got.me ? got.entries.find(e => e.who && e.who !== got.me) : null;
  if (!other || state.dirty) return;
  const at = Date.parse(other.at);
  const name = isPersonEmail(other.who) ? personName(other.who) : (cleanPersonName(other.name) || other.who);
  if (!isNaN(at)) autoStatusAt(name + ' edited', at);
}

/* ---- Who sees a list -----------------------------------------------------
   Signed in, every list is someone's: personal (only its owner) or shared
   with teams the owner is in, or people by email. The server keeps it in the
   list's access.json and shows a list to nobody else. The same form is the
   wizard's last step and, for the owner, Settings on the shared board
   (openSharing() in 29-settings.js). `sh` is {kind, teams, people}, with
   people as the textarea's text; trackSharing() keeps it in step with the
   form, since a modal's buttons run after it has closed. */
function sharingFormHTML(sh, teams){
  const radio = (kind, label) =>
    '<label class="sharekind"><input type="radio" name="shKind" value="' + kind + '"' +
      (sh.kind === kind ? ' checked' : '') + '> ' + esc(label) + '</label>';
  return '<div class="repdoc sharing">' +
    radio('personal', 'Only me') +
    radio('shared', 'Shared') +
    '<div class="sharewith"' + (sh.kind === 'shared' ? '' : ' hidden') + '>' +
      (teams.length
        ? '<p>Everyone in these teams:</p>' + teams.map(t =>
            '<label class="shareteam"><input type="checkbox" data-team="' + escAttr(t) + '"' +
              (sh.teams.indexOf(t) >= 0 ? ' checked' : '') + '> ' + esc(t) + '</label>').join('')
        : '') +
      '<p>And these people, one email a line:</p>' +
      '<textarea id="shPeople" class="redowhy" rows="3" placeholder="name@example.com">' +
        esc(sh.people) + '</textarea>' +
    '</div>' +
  '</div>';
}

function trackSharing(sh){
  if (!modalEl) return;
  const sync = () => {
    const kind = modalEl.querySelector('input[name="shKind"]:checked');
    if (!kind) return;
    sh.kind = kind.value;
    sh.teams = Array.from(modalEl.querySelectorAll('[data-team]')).filter(c => c.checked).map(c => c.dataset.team);
    const ppl = modalEl.querySelector('#shPeople');
    if (ppl) sh.people = ppl.value;
    const box = modalEl.querySelector('.sharewith');
    if (box) box.hidden = sh.kind !== 'shared';
  };
  modalEl.addEventListener('input', sync);
  modalEl.addEventListener('change', sync);
}

/* What the server is sent, or a sentence saying what is missing. */
function sharingBody(sh){
  if (sh.kind !== 'shared') return { body: { kind: 'personal', teams: [], people: [] } };
  const people = sh.people.split(/[\s,;]+/).map(p => p.trim()).filter(Boolean);
  if (!sh.teams.length && !people.length) return { error: 'Pick a team or add someone to share it with.' };
  return { body: { kind: 'shared', teams: sh.teams.slice(), people } };
}

/* ---- Making a list ------------------------------------------------------
   A list needs more than a todo.md: a brief per bucket, and the README saying
   which buckets the list has, or every task in it plans against the fallback
   agent with nothing to read.

   So it is a wizard: the name, then the buckets, then a line about each saying
   what kind of work lands in it. That last one is the part worth collecting —
   it becomes the opening of the bucket's own brief rather than boilerplate
   under a "not filled in yet" marker, which is the difference between a brief
   an agent is pointed at and one it is not. Everything else is scaffolded from
   it by create_dataset() in kanban/server.py. Signed in, one more step says
   who sees it. */

const WIZARD_BUCKETS = ['People', 'Work oversight', 'Design System', 'Strategic'];

let wizard = null;

/* The sharing step, last, and only when someone is signed in. */
function wizardSharingStep(){ return !!state.who && wizard.step === wizardSteps() - 1; }

function wizardHTML(){
  if (wizardSharingStep()) {
    return '<p>Who sees <strong>' + esc(wizard.name) + '</strong>? You can change this later in Settings.</p>' +
      sharingFormHTML(wizard.sharing, state.who.teams || []);
  }
  if (wizard.step === 0) {
    return '<div class="repdoc">' +
      '<p>What is this list called? It becomes a folder under <code>data/</code>, ' +
      'and the name on the switcher.</p>' +
      '<input id="wizName" class="field" type="text" placeholder="Personal" ' +
        'value="' + esc(wizard.name) + '">' +
    '</div>';
  }
  if (wizard.step === 1) {
    return '<div class="repdoc">' +
      '<p>Which buckets? One per line, in the order they should read on the board. ' +
      'Each gets its own folder, its own brief and its own planner.</p>' +
      '<textarea id="wizBuckets" class="redowhy" rows="6" ' +
        'placeholder="' + esc(WIZARD_BUCKETS.join('\n')) + '">' +
        esc(wizard.buckets.map(b => b.name).join('\n')) + '</textarea>' +
    '</div>';
  }
  const b = wizard.buckets[wizard.step - 2];
  return '<div class="repdoc">' +
    '<p>What kind of work lands in <strong>' + esc(b.name) + '</strong>? One line. ' +
    'It opens the bucket\u2019s brief, which is what the planning agent reads ' +
    'before it plans anything in here.</p>' +
    '<textarea id="wizAbout" class="redowhy" rows="3" ' +
      'placeholder="Annual reviews, performance, hiring, objectives, growth conversations.">' +
      esc(b.about || '') + '</textarea>' +
    '<p class="qwhy">You can leave it blank and write the brief later \u2014 while it is ' +
    'empty, no agent is pointed at it.</p>' +
  '</div>';
}

function wizardRead(){
  if (wizardSharingStep()) return !sharingBody(wizard.sharing).error;
  if (wizard.step === 0) {
    const el = $('#wizName');
    if (el) wizard.name = el.value.trim();
    return !!wizard.name;
  }
  if (wizard.step === 1) {
    const el = $('#wizBuckets');
    const was = wizard.buckets;
    if (el) {
      const names = el.value.split('\n').map(n => n.trim()).filter(Boolean);
      // Keep a description already typed against a bucket whose name has not
      // changed, so stepping back and forward does not lose it.
      wizard.buckets = names.map(name => ({
        name, about: (was.find(b => b.name === name) || {}).about || ''
      }));
    }
    return wizard.buckets.length > 0;
  }
  const el = $('#wizAbout');
  if (el) wizard.buckets[wizard.step - 2].about = el.value.trim();
  return true;
}

function wizardSteps(){ return 2 + wizard.buckets.length + (state.who ? 1 : 0); }

function showWizard(){
  const last = wizard.step === wizardSteps() - 1;
  const buttons = [];
  if (wizard.step > 0) buttons.push({ label:'Back', run: () => { wizard.step--; showWizard(); } });
  buttons.push({ label: last ? 'Make the list' : 'Next', primary:true, run: () => {
    if (!wizardRead()) {
      showToast(wizardSharingStep() ? sharingBody(wizard.sharing).error
        : wizard.step === 0 ? 'A list needs a name.' : 'A list needs at least one bucket.', 'bad');
      showWizard();
      return;
    }
    // Read again after the buckets step, since the count it just set is what
    // says how many steps there are.
    if (wizard.step >= wizardSteps() - 1) { finishWizard(); return; }
    wizard.step++;
    showWizard();
  } });
  buttons.push({ label:'Cancel', run: () => { wizard = null; closeModal(); loadDatasets(); } });
  const sub = wizard.step === 0 ? 'Step 1 of 2, at least'
    : 'Step ' + (wizard.step + 1) + ' of ' + wizardSteps();
  /* keepOpen, because each button reads the step's fields before it moves on,
     and a modal that closed first would leave nothing to read. */
  showModal('A new list', esc(sub), wizardHTML(), buttons, { cls:'wizard', keepOpen:true });
  if (wizardSharingStep()) trackSharing(wizard.sharing);
  const first = $('#wizName') || $('#wizBuckets') || $('#wizAbout');
  if (first) { first.focus(); if (first.select) first.select(); }
}

async function finishWizard(){
  const body = { name: wizard.name, buckets: wizard.buckets };
  if (state.who) body.sharing = sharingBody(wizard.sharing).body;
  wizard = null;
  closeModal();
  try {
    await postJSON('/datasets', body);
    location.reload();
  } catch (err) {
    alert('Could not create that list.\n\n' + (err.message || err));
    loadDatasets();
  }
}

function createDataset(){
  wizard = { step: 0, name: '', buckets: WIZARD_BUCKETS.map(name => ({ name, about: '' })),
             sharing: { kind: 'personal', teams: [], people: '' } };
  showWizard();
}

/* Nothing to switch into is a fresh clone, and the welcome in 29-settings.js
   covers it (maybeOnboard): step 2 makes the first list, and cannot be skipped. */

$('#datasetList').onclick = e => {
  const btn = e.target.closest('[data-dataset]');
  if (!btn) return;
  const name = btn.dataset.dataset;
  if (name === '__new__') { createDataset(); return; }
  // The list already being read. Nothing to switch to, and reloading the page
  // onto the same folder would only look like a fault.
  if (btn.classList.contains('current')) return;
  if (state.dirty) {
    alert('You have unsaved changes on this list.\n\nSave or discard them first, then switch lists.');
    return;
  }
  switchDataset(name);
};

/* Stand an example list in for a missing todo.md, and say plainly that is what
   happened. Two situations reach here: a host serving this page as static files,
   where there is no data/ folder at all because git never had one, and the local
   board opened before the launcher is running.

   It reuses the Backup Preview lock rather than adding a mode of its own. The
   reason is the same one: invented tasks must never be able to reach disk as the
   live list. Locking is what already guarantees that everywhere — every write
   path checks it — so the example data gets it for free rather than needing a
   second set of guards that could fall out of step with the first.

   Returns false rather than throwing when there is no example file either, so
   loadFile can fall through to its real error. */
async function loadDemo(){
  try {
    const res = await fetch(DEMO_URL + '?t=' + Date.now(), { cache:'no-store' });
    if (!res.ok) return false;
    const text = await res.text();
    if (!parseDoc(text).buckets.length) return false;
    closeDrawer();
    load(text, 'demo.md', { readOnly:true });
    state.diskStamp = null;
    state.diskHash = null;
    state.demo = true;
    state.locked = true;
    state.lockedLabel = 'an example list, not yours';
    updateLockUI();
    markClean('');
    renderView();
    applyPendingTask();
    syncFolderButton();
    reopenRememberedFolder();
    return true;
  } catch (err) {
    return false;
  }
}

/* ---- A folder on this computer ------------------------------------------
   The hosted copy (Vercel) serves static files and nothing else, so on its own
   it can only ever show demo.md. In Chrome and Edge the page can instead be
   pointed at a list folder on the person's own disk through the File System
   Access API, and read and write todo.md there itself with no helper running.
   Where the browser has no showDirectoryPicker the demo stays exactly as it
   was: read-only, with nothing new on the lock bar.

   Only reached from the demo. The local board served by kanban/server.py
   never gets here, because loadFile() reads /data/todo.md first and a real
   list always wins, so nothing below changes how the local board behaves.

   The folder is one list, the same shape as data/<dataset>/: todo.md at its
   root, and backups/ beside it. What the page does with it:
     - reads and writes todo.md, with the same change-on-disk check the server
       makes (a hash of what this tab last read, compared before every write);
     - writes one backup of the file as it found it into backups/ before the
       first save of each visit, named the way the server names its own;
     - keeps a crash copy of unsaved work in localStorage, dropped after every
       good save and offered back the next time the folder is opened.
   Everything else the board asks the server for stays unanswered, exactly as
   on the demo: /plans.json, /reports.json, /backups.json, /projects.json,
   /schedule.json and /queue.json are plain file reads and could be answered
   from the folder in a later pass; the terminal, the planning agent, the
   companion and the Claude chat need a process and never can be.

   The page's code is fetched from a public URL on every visit, so a real list
   opened here is only as safe as that copy of the code. The dialog before the
   picker says so. */

let listFolder = null;          // FileSystemDirectoryHandle while a folder is open
let folderBackedUp = false;     // one backup per visit, before the first save
let rememberedFolder = null;    // a handle from last visit, waiting for a click

function folderSupported(){ return typeof window.showDirectoryPicker === 'function'; }

/* Handles survive a reload only in IndexedDB — localStorage holds strings. */
function folderDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('todo-board-folder', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('handles');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function folderStore(mode, fn){
  try {
    const db = await folderDB();
    return await new Promise(resolve => {
      const tx = db.transaction('handles', mode);
      const req = fn(tx.objectStore('handles'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => resolve(null);
    });
  } catch (err) { return null; }
}
const rememberFolder = h => folderStore('readwrite', s => s.put(h, 'list'));
const forgetFolder = () => folderStore('readwrite', s => s.delete('list'));
const recallFolder = () => folderStore('readonly', s => s.get('list'));

/* Stands in for the server's X-Todo-Hash. Only ever compared with itself, so
   it does not have to match the server's digest, only to change when the
   bytes do. FNV-1a, 32 bits. */
function textHash(text){
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0') + ':' + text.length;
}

async function folderRead(){
  const file = await (await listFolder.getFileHandle('todo.md')).getFile();
  const text = await file.text();
  return { text, stamp: new Date(file.lastModified).toUTCString(), hash: textHash(text) };
}

/* Every read of the list goes through here, so loadFile, reload and the
   watcher do not need to know which of the two places it came from. With no
   folder open it is the same fetch they always made. In folder mode the
   answer is shaped like the server's, headers and all. */
async function fetchList(method){
  if (!listFolder) {
    return method === 'HEAD'
      ? fetch(FILE_URL, { method:'HEAD', cache:'no-store' })
      : fetch(FILE_URL + '?t=' + Date.now(), { cache:'no-store' });
  }
  try {
    const v = await folderRead();
    return new Response(method === 'HEAD' ? null : v.text,
      { headers: { 'Last-Modified': v.stamp, 'X-Todo-Hash': v.hash } });
  } catch (err) {
    return new Response(null, { status: 404 });
  }
}

const crashKey = () => 'bench-crash:' + (listFolder ? listFolder.name : '');
function keepCrashCopy(text){ try { localStorage.setItem(crashKey(), text); } catch (err) {} }
function dropCrashCopy(){ try { localStorage.removeItem(crashKey()); } catch (err) {} }

function backupStamp(){
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '-' +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
async function folderBackup(text){
  const dir = await listFolder.getDirectoryHandle('backups', { create:true });
  const name = 'todo-backup-' + backupStamp() + '.md';
  const w = await (await dir.getFileHandle(name, { create:true })).createWritable();
  await w.write(text);
  await w.close();
  return name;
}

/* saveFile() hands over here when a folder is open. Same order as the
   server's do_PUT: refuse a write built on a version that has moved, back up,
   then write. */
async function saveToFolder(auto){
  const text = serializeDoc(state.doc);
  keepCrashCopy(text);
  try {
    const disk = await folderRead();
    /* Moved under this tab: merged here, the way the server merges a save. */
    let out = text;
    if (disk.text !== state.originalText) {
      const got = mergeSaves(state.originalText, text, disk.text);
      if (got.text === null) {
        markDirty();
        autoStatus('not saved yet — the same thing was changed in two places');
        offerMerge({ conflicts: got.conflicts, current: disk.text, disk: disk.stamp, hash: disk.hash },
                   state.originalText, text);
        return;
      }
      out = got.text;
    }
    let backup = '';
    if (!folderBackedUp) { backup = await folderBackup(disk.text); folderBackedUp = true; }
    const w = await (await listFolder.getFileHandle('todo.md')).createWritable();
    await w.write(out);
    await w.close();
    dropCrashCopy();
    if (out !== text) reloadInPlace(out, out);
    state.originalText = out;
    lastSaveAt = Date.now();
    markClean((auto ? 'auto-saved' : 'saved ' + new Date().toLocaleTimeString()) +
      (backup ? ' · backup: backups/' + backup : '') + ' · ' + listFolder.name + '/todo.md', auto);
    await rememberStamp();
  } catch (err) {
    markDirty();
    if (auto) {
      autoStatus('auto-save failed at ' + new Date().toLocaleTimeString() + ' — your changes are still here');
      $('#status').classList.add('dirty');
      return;
    }
    alert('Could not save todo.md in ' + listFolder.name + ': ' + (err.message || err) +
          '\n\nNothing was written. Your changes are also kept in this browser and are offered back ' +
          'the next time you open this folder. Use “Download copy” if you need them out now.');
  }
}

/* The lock bar's button. Shown on the demo only, and only where the browser
   can open a folder at all. */
function syncFolderButton(){
  const btn = $('#openFolder');
  if (!btn) return;
  btn.classList.toggle('hidden', !(state.demo && folderSupported()));
  btn.textContent = rememberedFolder ? 'Reopen ' + rememberedFolder.name : 'Open a folder…';
  /* In folder mode the Data menu is open for the first time on this page, and
     three of its items only talk to the helper. Off rather than failing. */
  ['#closeFolder'].forEach(id => $(id) && $(id).classList.toggle('hidden', !listFolder));
  $('#backupsBtn') && $('#backupsBtn').classList.toggle('hidden', !!listFolder);
  /* Spend and the Plan agent's run are about agents, so they go too where no
     agent can run (state.agentsReady, 27-agents.js). */
  ['#refCardsBtn', '#runAgentBtn'].forEach(id => $(id) && $(id).classList.toggle('hidden', !!listFolder || state.agentsReady === false));
}

/* Last visit's folder. Opened straight away if the browser still grants it;
   otherwise the button offers it by name, because asking again needs a click. */
async function reopenRememberedFolder(){
  if (!folderSupported() || listFolder) return;
  const h = await recallFolder();
  if (!h) return;
  rememberedFolder = h;
  syncFolderButton();
  try {
    if (await h.queryPermission({ mode:'readwrite' }) === 'granted') await openFolder(h);
  } catch (err) { /* stays on the button */ }
}

function askForFolder(){
  if (rememberedFolder) {
    const h = rememberedFolder;
    h.requestPermission({ mode:'readwrite' })
      .then(p => p === 'granted' ? openFolder(h) : null)
      .catch(err => alert('Could not open ' + h.name + '.\n\n' + (err.message || err)));
    return;
  }
  showModal('Open a list folder', 'On this computer, in this browser',
    '<div class="repdoc">' +
      '<p>Pick the folder that holds your <code>todo.md</code>. The board reads and saves it ' +
      'there, and keeps a copy of the file as it found it in <code>backups/</code> before ' +
      'the first save.</p>' +
      '<p>Nothing is uploaded: the list stays on this computer. This page’s code is ' +
      'fetched from <strong>' + esc(location.host) + '</strong> each time you open it, so the ' +
      'list is only as safe as that copy of the code.</p>' +
      '<p class="qwhy">Plans, reports, agents and chat need the board helper on your own ' +
      'machine, so they stay off here.</p>' +
    '</div>',
    [{ label:'Choose folder', primary:true, run: async () => {
        let h;
        try { h = await window.showDirectoryPicker({ id:'todo-list', mode:'readwrite' }); }
        catch (err) { return; }   // cancelled
        openFolder(h);
      } },
     { label:'Cancel' }], {});
}

async function openFolder(handle){
  try {
    await (await handle.getFileHandle('todo.md')).getFile();
  } catch (err) {
    alert('There is no todo.md in ' + handle.name + '.\n\nPick the folder that holds the list itself.');
    return;
  }
  listFolder = handle;
  folderBackedUp = false;
  rememberedFolder = null;
  rememberFolder(handle);
  closeDrawer();
  await loadFile();
  if (!listFolder) return;   // loadFile could not read it and fell back
  setDataMenuLabel(handle.name);
  syncFolderButton();
  offerCrashCopy();
}

async function closeFolder(){
  if (state.dirty) {
    alert('You have unsaved changes on this list.\n\nSave or discard them first, then close the folder.');
    return;
  }
  listFolder = null;
  // Awaited, or the demo would find the handle still stored and reopen it.
  await forgetFolder();
  setDataMenuLabel('');
  loadDemo();
}

/* Changes that never reached the file last time, because the tab or the
   browser closed first. Only offered when they differ from what is on disk. */
function offerCrashCopy(){
  let copy = null;
  try { copy = localStorage.getItem(crashKey()); } catch (err) {}
  if (!copy || copy === state.originalText) { dropCrashCopy(); return; }
  showModal('Unsaved changes from last time', esc(listFolder.name + '/todo.md'),
    changesHTML('Not saved last time', describeChanges(state.originalText, copy),
      'Nothing found that differs from the file.'),
    [{ label:'Put them back', primary:true, run: () => {
        const disk = state.originalText;
        load(copy, 'todo.md');
        state.originalText = disk;   // the file is still the old version
        markDirty();
      } },
     { label:'Download them', run: () => downloadText(copy, 'todo-unsaved.md') },
     { label:'Throw them away', danger:true, run: () => dropCrashCopy() }]);
}

if ($('#openFolder')) $('#openFolder').onclick = askForFolder;
if ($('#closeFolder')) $('#closeFolder').onclick = closeFolder;

/* auto: this save was the timer's idea, not the owner's, so a failure must not throw a
   dialog in front of whatever the owner is doing. It shows in the status line instead,
   and the changes stay in the tab either way. */
async function saveFile(auto, forceBackup){
  // The one guard that actually matters: state.doc can hold an old backup while
  // locked, and this must never let that overwrite the live todo.md.
  // And never while the server is being pointed at another list: the text here
  // belongs to the one being left, and would be written into the new one.
  if (state.switching && state.doc && state.dirty) {
    $('#status').textContent = 'not saved yet: switching lists';
    return;
  }
  if (state.locked || !state.doc || !state.dirty) return;
  // A folder opened on the hosted page: written by the page itself.
  if (listFolder) return saveToFolder(auto);
  // The server has moved to another list since this one was read. Saving would
  // only be refused again; asked once, and again on a save the owner asks for.
  if (state.boardMoved) {
    if (!auto) boardMoved(state.boardMoved, true);
    else autoStatus('not saved — the board is on another list now');
    return;
  }
  const text = serializeDoc(state.doc);
  /* The version this document was built on, sent whole. A save arriving after
     somebody else's is merged with theirs on the server (do_PUT), and the
     version is what it merges from. */
  const base = state.originalText;
  try {
    /* The stamp and hash this tab last agreed with still travel, for a server
       from before merging, which refuses a write built on a version that has
       moved. Absent on the very first save of a session, before any HEAD has
       run. */
    const headers = { 'Content-Type':'application/json' };
    if (state.diskStamp) headers['If-Unmodified-Since'] = state.diskStamp;
    if (state.diskHash) headers['If-Match'] = state.diskHash;
    const res = await fetch(FILE_URL + (forceBackup ? '?backup=force' : ''), {
      method: 'PUT', headers,
      /* The list this was read from, so it cannot land on another one. */
      body: JSON.stringify(state.docBoard ? { text, base, board: state.docBoard } : { text, base })
    });
    const info = await res.json().catch(() => ({}));
    /* 409 is the same thing changed here and in the file, a migration holding
       the list, or a server from before merging. Handled here rather than
       thrown, because the catch below calls markDirty() and the autosave
       would come straight back in four seconds and get the same answer,
       forever. */
    if (res.status === 409) {
      if (info.wrongBoard) {
        /* Still dirty: nothing was written. Not markDirty(), which would
           count the load's own tidy-ups as the owner's changes. */
        boardMoved(info.board || '', true);
        return;
      }
      if (info.conflicts && typeof info.current === 'string') {
        markDirty();
        autoStatus('not saved yet — the same thing was changed in two places');
        offerMerge(info, base, text);
        return;
      }
      if (info.disk) state.diskStamp = info.disk;
      if (info.hash) state.diskHash = info.hash;
      if (info.migrating) {
        markDirty();
        autoStatus('not saved — a migration is running on this list. Your changes are still here.');
        return;
      }
      markDirty();
      autoStatus('not saved — todo.md changed on disk since this tab read it');
      await reload();
      return;
    }
    /* A task given by name to somebody the shared board cannot place: nobody,
       or more than one person. Said in the status line, and in a box when
       the owner asked to save, since the next autosave gets the same answer
       until the name is changed. */
    if (res.status === 422 && info.assignees) {
      autoStatus(info.error);
      $('#status').classList.add('dirty');
      if (!auto) alert(info.error);
      return;
    }
    if (!res.ok) throw new Error(info.error || ('the server answered ' + res.status));
    lastSaveAt = Date.now();
    const note = (auto ? 'auto-saved' : 'saved ' + new Date().toLocaleTimeString()) +
      (info.merged ? ' with changes made elsewhere' : '') +
      (info.backup ? ' · backup: data/backups/' + info.backup : '') +
      (info.weekly ? ' · weekly: data/backups/' + info.weekly : '') + ' · todo.md';
    /* Merged with somebody else's save: the file now holds both, and this tab
       is brought up to it. When that cannot happen yet (a field is being
       typed in) the version is left as it was, so the watcher sees the file
       as moved and catches up once the field is left. */
    const written = typeof info.text === 'string' && info.text !== text;
    const caughtUp = written ? settleMerged(text, info, note, auto) : true;
    if (!written) {
      state.originalText = text;
      // The relative stamp is the timestamp on an auto-save, so the clock time
      // would only repeat it. A manual save keeps the clock.
      if (serializeDoc(state.doc) === text) markClean(note, auto); else markDirty();
    }
    // Our own write moved the file, so record it — otherwise the watcher would
    // read the new timestamp as somebody else's edit. The server says which
    // version it wrote; a server from before that is asked.
    if (caughtUp) {
      if (info.hash && info.disk) { state.diskStamp = info.disk; state.diskHash = info.hash; }
      else await rememberStamp();
    }
    // Somebody else's change came in with this save: say whose.
    if (info.merged) loadActivity();
    // A hand-over or an approval that asked for its agent to start now.
    flushAgentStarts();
  } catch (err) {
    markDirty();
    if (auto) {
      // markDirty has just written "unsaved changes" over the line; this replaces
      // it, and keeps the clock as well as the stamp because a failure is worth
      // being able to pin to a moment.
      autoStatus('auto-save failed at ' + new Date().toLocaleTimeString() + ' — your changes are still here');
      $('#status').classList.add('dirty');
      return;
    }
    // A failed fetch means the local helper is not answering, not a bad file.
    const helperGone = err instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(String(err.message || err));
    if (helperGone) {
      $('#status').textContent = 'not saved — the board helper has stopped';
      alert('Nothing was saved, because the board helper is not running.\n\n' +
            'Your changes are still here in this tab, so do not close it.\n\n' +
            'Open Bench.app again, or double-click run.command in the bench folder. It saves on ' +
            'its own every few seconds once it can reach the file again.\n\n' +
            'If you cannot restart it, use “Download copy” to get the changes out.');
    } else {
      alert('Could not save todo.md: ' + (err.message || err) +
            '\n\nNothing was written. Use “Download copy” if you need the changes out of the browser.');
    }
  }
}

/* The server is on another list than the one this tab read: switched from
   another tab's dropdown, or by a banner link. Nothing here can be saved to
   it, so the tab goes over to that list. With nothing of the owner's unsaved
   that is a plain reload; with changes it asks first, and offers to put the
   board back on this tab's list so they can be saved where they belong. */
function boardMoved(now, ask){
  if (state.switching) return;
  state.boardMoved = now || '?';
  if (!hasOwnChanges()) {
    state.dirty = false;
    reloadPage();
    return;
  }
  autoStatus('not saved — the board is on another list now');
  if (!ask || modalEl) return;
  const mine = state.docBoard;
  const sub = 'This tab holds <strong>' + esc(prettyDataset(mine)) + '</strong>, but the board was switched to <strong>' +
    esc(prettyDataset(now)) + '</strong> elsewhere, so your changes were not saved.';
  showModal('This list is no longer the one on screen', sub, '', [
    { label:'Switch back and save', primary:true, run: async () => {
      try {
        await postJSON('/dataset/select', { name: mine });
        state.boardMoved = '';
        await saveFile(false);
      } catch (err) { alert('Could not switch back.\n\n' + (err.message || err)); }
    } },
    { label:'Download my copy', run: () => downloadText(serializeDoc(state.doc), state.fileName) },
    { label:'Discard mine, open ' + prettyDataset(now), danger:true, run: () => { state.dirty = false; reloadPage(); } },
  ]);
}

/* After a save the server wrote other than as sent: merged with somebody
   else's, or carrying who wrote and changed each task. `sent` is what this
   tab sent, info.text what was written. Anything typed while the save was out
   is merged on top, so it is not lost to the redraw. Returns false when the
   tab was left on `sent`, because a field is being typed in or the typing
   since touched what the other side changed; the next save or watcher tick
   does the rest. */
function settleMerged(sent, info, note, auto){
  const now = serializeDoc(state.doc);
  const local = editingNow() ? null : mergeSaves(sent, now, info.text);
  if (!local || local.text === null) {
    state.originalText = sent;
    if (now === sent) markClean(note, auto); else markDirty();
    return false;
  }
  /* Only the author tags changed: nobody else's work came in, so no card
     glows for it. */
  reloadInPlace(local.text, info.text, null, !info.merged);
  if (!state.dirty) markClean(note, auto);
  return true;
}

function downloadText(text, name){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type:'text/markdown' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

