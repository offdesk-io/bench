'use strict';

/* =========================================================================
   Auto-save and watching the file

   Two jobs that share one fact: what the file on disk looked like the last time
   this tab agreed with it. state.originalText is that version whole, and is
   what a save is merged from; the stamp and hash are how the watcher notices
   it has moved.
   ========================================================================= */

/* No toggle and no button any more — a change on a card, in the sidebar or on
   the board, saves to disk on its own within a few seconds. That is the one
   behaviour now, not an option someone could switch off and forget. */
const AUTOSAVE_MS = 4 * 1000;
/* Every three seconds while the tab is on screen, so somebody else's change on
   a shared list shows up about as fast as one's own saves; every fifteen while
   it is hidden, which is all a tab nobody is looking at needs. */
const WATCH_MS = 3 * 1000;
const WATCH_HIDDEN_MS = 15 * 1000;
let lastWatchAt = 0;

/* Somebody typing on the board right now: a field in a card, the drawer or the
   sub-task panel has focus. Redrawing from the file would take the field away
   mid-word, so catching up waits for it to be left. A tick box is not typing. */
function editingNow(){
  const a = document.activeElement;
  if (!a || !a.closest || !a.closest('#drawer, #subpanel, #lists')) return false;
  if (a.tagName === 'INPUT' && /^(checkbox|radio|button|submit)$/i.test(a.type)) return false;
  return a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
}

/* The board redrawn from `text`, where `disk` is the version of the file it
   now stands on; the two differ when this tab still has changes of its own
   on top, which then wait to be saved. The open task stays open, found again
   by its id, since every card gets a fresh one from the parse. `quiet` skips
   the glow on what changed. */
function reloadInPlace(text, disk, named, quiet){
  const open = state.openTask != null ? locate(state.openTask) : null;
  const key = open ? taskKey(open.task) : null;
  const changes = describeChanges(state.originalText, disk);
  const before = cardPlaces();
  closeDrawer();
  load(text, 'todo.md');
  state.originalText = disk;
  if (!quiet) settleChanges(before, changes, named || null);
  if (key) { const t = findTaskByKey(key); if (t) openDrawer(t.id); }
  if (text !== disk) markDirty();
  return changes;
}

/* The status line for a reload that brought the file in: the watcher's, and
   Reload's when it merged. */
function reloadNote(changes){
  const n = changes ? changes.length : 0;
  return 'reloaded — the file changed on disk' +
    (n ? ' (' + n + ' task' + (n > 1 ? 's' : '') + ')' : '');
}

/* One HEAD, both answers: the timestamp and the content hash the server sends
   with every read of todo.md. Returns nulls rather than throwing when the
   helper is down, which is the shape every caller here already copes with. */
async function diskVersion(){
  try {
    const res = await fetchList('HEAD');
    if (!res.ok) return { stamp:null, hash:null };
    return { stamp: res.headers.get('Last-Modified') || null,
             hash:  res.headers.get('X-Todo-Hash') || null };
  } catch (err) { return { stamp:null, hash:null }; }
}
async function diskStamp(){ return (await diskVersion()).stamp; }
async function rememberStamp(){
  const v = await diskVersion();
  state.diskStamp = v.stamp;
  state.diskHash = v.hash;
}

/* Saves only when there is something to save, so an idle tab never touches the
   file and never triggers a backup for no reason. The clock runs from the last
   save, so a manual save (⌘S) also resets the four seconds.

   Checked twice a second rather than on the save interval itself, so a change
   made just after a tick still lands within roughly one interval rather than
   waiting out a second one. Runs regardless of what has focus — a title or
   notes field mid-edit already holds its new value in state.doc, so saving
   under it is safe, and holding off until the field is blurred is exactly the
   wait the owner asked to remove. */
let lastSaveAt = Date.now();
async function autosaveTick(){
  if (state.locked || !state.doc || !state.dirty || modalEl) return;
  if (Date.now() - lastSaveAt < AUTOSAVE_MS) return;
  await saveFile(true);
}

/* Picks up edits made outside the board — somebody else on a shared list,
   Claude working through it, or the file being changed in an editor. With
   nothing of the owner's unsaved here, reloading is free, so it happens quietly
   and says so afterwards rather than asking first. With unsaved work here, the
   work is saved and the server merges the two; only the same thing changed in
   both places turns it into a question.

   Held while pa says it is mid-edit (see "pa at work" below), so its edit
   arrives as one change rather than one per line it touched. One tick at a
   time: the pa watcher calls this the moment pa finishes, and two at once
   would both reload. */
let watchBusy = false;
async function watchTick(){
  checkRunStartedHere();                           // no-op unless this tab started a run
  if (state.locked || !state.doc || modalEl || paWorking || watchBusy) return;
  if (document.hidden && Date.now() - lastWatchAt < WATCH_HIDDEN_MS) return;
  lastWatchAt = Date.now();
  watchBusy = true;
  try { await watchOnce(); } finally { watchBusy = false; }
}
async function watchOnce(){
  const named = paFinished;                        // only the first tick after pa finished
  paFinished = null;
  const { stamp, hash } = await diskVersion();
  if (!stamp) return;                              // helper stopped; saveFile reports that
  if (!state.diskStamp) { state.diskStamp = stamp; state.diskHash = hash; return; }
  /* The hash is the better question where both sides have one — it answers
     "did the bytes change" rather than "did the second change" — and the stamp
     is the fallback for a server from before X-Todo-Hash existed. */
  const moved = (hash && state.diskHash) ? hash !== state.diskHash : stamp !== state.diskStamp;
  if (!moved) { state.diskStamp = stamp; state.diskHash = hash; return; }
  // Asked again on the next tick, once the field is left.
  if (editingNow()) return;

  /* Unsaved work here as well: saved now, which merges it with the file on
     the server and brings this tab up to what was written. Only the same
     thing changed in both places stops to ask (offerMerge). */
  if (hasOwnChanges()) { await saveFile(true); return; }

  try {
    const res = await fetchList();
    if (!res.ok) return;
    const text = await res.text();
    if (text === state.originalText) { state.diskStamp = stamp; state.diskHash = hash; return; }
    const changes = reloadInPlace(text, text, named);
    state.diskStamp = stamp;
    state.diskHash = hash;
    const note = reloadNote(changes);
    // The fresh parse may have re-run the load-time tidy-up, which is a real
    // pending save. Say what happened without clearing it.
    if (state.migratedOnly) autoStatus(note); else markClean(note, true);
    loadActivity();                                // and whose it was, on a shared list
  } catch (err) { /* try again on the next tick */ }
}


/* -------------------------------------------------------------------------
   pa at work

   The pa skill names the tasks it is about to change in pa-working.json,
   beside todo.md, before its first edit, and deletes the file after its last
   (agents/pa_agent/skills/pa/scripts/pa_working.py). While the file is there
   the cards it named glow and watchTick() holds its reload. Once it goes, the
   reload happens straight away rather than up to fifteen seconds later, every
   card slides from where it was to where it is now, and the ones that changed
   glow once more and fade.

   Polled on a clock of its own, since the file usually lives for seconds and
   the fifteen-second one would mostly miss it. A file older than ten minutes
   is a session that stopped halfway, and is ignored. Only pa writes it: an
   agent's tick reaches the board through tick-queue.json and is applied by
   the board itself, so nothing here lights for one.

   The glow is a style sheet of its own naming cards by data-id, rather than a
   class on each card, so a React redraw of the board while pa works cannot
   take it off. How it looks is board.css, under the same heading. */
const PA_WATCH_MS = 2 * 1000;
const PA_STALE_S = 10 * 60;
const PA_SETTLE_MS = 2400;
const PA_SLIDE_MS = 450;
let paWorking = null;     // what pa named, by titleKey, for as long as it works
let paFinished = null;    // the same, kept for the one reload that follows
let paWatchOff = false;   // nothing behind the route: a static host, or a helper from before it

function eachTopTask(fn){
  if (!state.doc) return;
  state.doc.buckets.forEach(b => b.tiers.forEach(tier => tier.tasks.forEach(fn)));
}

/* Named by `id:`, `#slug` or title, the same three findTaskByKey() takes. */
function paNamed(t, keys){
  return !!keys && (keys.has(titleKey(t.title)) ||
    (t.stableId && keys.has(t.stableId)) || (t.slug && keys.has(t.slug.toLowerCase())));
}

function cardEls(){
  const out = new Map();
  document.querySelectorAll('.tenon-card[data-id]').forEach(el => {
    if (!out.has(el.dataset.id)) out.set(el.dataset.id, el);
  });
  return out;
}

function paSheet(id, ids, rule){
  let el = document.getElementById(id);
  if (!el) { el = document.createElement('style'); el.id = id; document.head.appendChild(el); }
  el.textContent = ids.length
    ? '.tenon-card.tenon-card:is(' + ids.map(i => '[data-id="' + CSS.escape(String(i)) + '"]').join(',') + '){' + rule + '}'
    : '';
}

function paintPaWorking(){
  const ids = [];
  if (paWorking) eachTopTask(t => { if (paNamed(t, paWorking)) ids.push(t.id); });
  paSheet('paWorkingSheet', ids, 'box-shadow:var(--pa-glow); animation:var(--pa-working-anim)');
}

async function paWorkingTick(){
  if (paWatchOff || listFolder || document.hidden || state.locked || !state.doc) return;
  let got;
  try {
    const res = await fetch('/pa-working.json?t=' + Date.now(), { cache:'no-store' });
    if (res.status === 404) { paWatchOff = true; return; }
    if (!res.ok) return;
    got = await res.json();
  } catch (err) { return; }                        // helper stopped; try again next tick
  const was = paWorking;
  paWorking = got && got.working && !(got.age > PA_STALE_S)
    ? new Set((got.tasks || []).map(titleKey).filter(Boolean))
    : null;
  paintPaWorking();
  if (was && !paWorking) { paFinished = was; watchTick(); }
}

/* Where every card is on screen, by taskKey(), which survives the parse that
   the reload is about to do where t.id does not. */
function cardPlaces(){
  const at = new Map();
  const els = cardEls();
  eachTopTask(t => {
    const el = els.get(String(t.id));
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width && r.height) at.set(taskKey(t), r);
  });
  return at;
}

/* After the reload: each card slides from its old place to its new one (a
   FLIP animation: it is drawn where it now is, then started from where it
   was), and the cards that changed or that pa named glow and fade. With
   reduced motion asked for nothing slides, and the glow holds still for the
   same time before it goes. */
let paSettleTimer = null;
function settleChanges(before, changes, named){
  const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const changed = changedTitles(changes);
  const els = cardEls();
  const lit = [];
  eachTopTask(t => {
    if (changed.has(titleKey(t.title)) || paNamed(t, named)) lit.push(t.id);
    const was = before.get(taskKey(t));
    const el = els.get(String(t.id));
    if (still || !was || !el || !el.animate) return;
    const now = el.getBoundingClientRect();
    const dx = was.left - now.left, dy = was.top - now.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    el.animate([{ transform:'translate(' + dx + 'px,' + dy + 'px)' }, { transform:'none' }],
               { duration:PA_SLIDE_MS, easing:'cubic-bezier(.2,.8,.2,1)' });
  });
  paSheet('paSettledSheet', lit, 'animation:var(--pa-settled-anim)');
  clearTimeout(paSettleTimer);
  paSettleTimer = setTimeout(() => paSheet('paSettledSheet', [], ''), PA_SETTLE_MS);
}

setInterval(paWorkingTick, PA_WATCH_MS);
