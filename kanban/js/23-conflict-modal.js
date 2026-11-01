'use strict';

/* =========================================================================
   Conflict modal
   ========================================================================= */

/* The open modal's outermost node (Tenon's .tenon-modal), or null. Callers
   query their own body through it straight after showModal() returns. */
let modalEl = null;
/* The node the React root lives on. The Modal portals to body beside it. */
let modalHost = null;
/* Set by a modal whose body is a React tree, so shutting it lets the tree go
   rather than leaving a root subscribed to a node that has left the page. */
let modalOnClose = null;

function closeModal(){
  if (modalHost) { BoardUI.unmountBoardModal(modalHost); modalHost.remove(); modalHost = null; }
  modalEl = null;
  if (modalOnClose) { const done = modalOnClose; modalOnClose = null; done(); }
}

/* buttons: [{ label, primary, danger, agree, reject, run }] — the first is the
   safe default, and takes focus. The × in the head, the scrim and Escape all
   close without running anything. ⌘↵ / Ctrl+↵ presses the primary button, but
   only from inside a text field, so a plain confirmation like offerReload()'s
   cannot be answered by a stray shortcut aimed at something else. Tenon's
   Modal does both; this function only says what the buttons run.
   opts: { wide, cls, onClose, required, keepOpen } — required takes the × away and
   makes Escape and the scrim do nothing (first-run setup); required and keepOpen
   both stop a button closing the modal for its run(), which closes it itself
   once it has what it needs; wide is the document-width variant a written
   report opens in, rather than the confirmation-sized default; cls is one more
   class on the box, for a modal with a body shape of its own (the plan
   reader); onClose runs once when the modal goes, whichever way it goes.
   The body is drawn into .mid, which callers query. */
function showModal(heading, sub, bodyHTML, buttons, opts){
  closeModal();
  modalOnClose = (opts && opts.onClose) || null;
  modalHost = document.createElement('div');
  document.body.appendChild(modalHost);
  modalEl = BoardUI.mountBoardModal(modalHost, {
    heading, subHTML: sub || '', bodyHTML, wide: !!(opts && opts.wide), cls: (opts && opts.cls) || '', required: !!(opts && opts.required),
    buttons: buttons.map(b => ({ label: b.label, primary: !!b.primary, danger: !!b.danger, agree: !!b.agree, reject: !!b.reject })),
    onPick: i => { const b = buttons[i]; if (!(opts && (opts.required || opts.keepOpen))) closeModal(); if (b.run) b.run(); },
    onClose: closeModal,
  });
}

/* Changes of the owner's own, as against the board's own tidy-up on load. Only the
   first kind is worth stopping for. */
function hasOwnChanges(){ return state.dirty && !state.migratedOnly; }

async function reload(){
  if (state.locked) return;
  if (!hasOwnChanges()) return loadFile();
  // Same collision as an outside edit, so it gets the same treatment: merged the
  // way a save or the watcher merges, and the box only when the same field changed
  // in both places or the file could not be read.
  let diskText = null;
  try {
    const res = await fetchList();
    if (res.ok) diskText = await res.text();
  } catch (err) { /* handled below by the null check */ }
  if (diskText === null) return offerReload(null, true);
  const mine = serializeDoc(state.doc);
  let got = null;
  try { got = mergeSaves(state.originalText, mine, diskText); }
  catch (err) { return offerReload(diskText, true); }
  if (!got || (got.text === null && !got.conflicts)) return offerReload(diskText, true);
  const v = await diskVersion();
  if (got.text === null) {
    offerMerge({ conflicts: got.conflicts, current: diskText, disk: v.stamp, hash: v.hash },
               state.originalText, mine);
    return;
  }
  const changes = reloadInPlace(got.text, diskText);
  state.diskStamp = v.stamp;
  state.diskHash = v.hash;
  const note = reloadNote(changes);
  if (state.dirty || state.migratedOnly) autoStatus(note); else markClean(note, true);
}

/* The modal both Reload and the outside-edit watcher land in when there is
   something here it would overwrite. diskText may be null if the file could
   not be read, in which case discarding is not offered. */
function offerReload(diskText, manual){
  const mine = describeChanges(state.originalText, serializeDoc(state.doc));
  const theirs = diskText === null ? null : describeChanges(state.originalText, diskText);

  const sub = '<strong>todo.md changed on disk</strong> while you had unsaved changes here. ' +
    'Nothing has been overwritten either way — pick which version wins.';

  const body =
    changesHTML('Your unsaved changes', mine, 'Nothing — your tab matches the file.') +
    (diskText === null
      ? '<div class="changes"><h3>Changed on disk</h3><div class="none">Could not read the file to compare.</div></div>'
      : changesHTML('Changed on disk', theirs, 'Nothing found — the file may only have been re-saved.'));

  const buttons = [{ label:'Keep my changes', primary:true }];
  buttons.push({ label:'Download my copy first', run: () => downloadText(serializeDoc(state.doc), state.fileName) });
  if (diskText !== null) {
    buttons.push({ label:'Discard mine, use the file', danger:true, run: () => {
      try { load(diskText, 'todo.md'); rememberStamp(); closeDrawer(); markClean('reloaded from disk'); }
      catch (err) { alert('Could not read the file on disk: ' + (err.message || err)); }
    }});
  }
  showModal('Two versions of this list', sub, body, buttons);
}


/* What a merge could not decide, by task and field, as the merge names them
   (mergeSaves() in core/todo.js). */
const MERGE_FIELD_NAMES = {
  title:'title', bold:'bold', done:'tick', impact:'impact', effort:'effort', due:'due date',
  start:'start date', doneOn:'done date', to:'who it is with', theme:'theme', urgent:'urgent',
  week:'this week', doing:'doing', slug:'slug', blockedBy:'blocked by', rank:'queue position',
  tlrank:'timeline position', headline:'headline', chat:'chats', repeat:'repeat', stableId:'id',
  cancelled:'cancelled', archived:'archived', extra:'other tags', column:'column', notes:'notes',
  deleted:'deleted in one place, edited in the other'
};

/* A save the server could not merge, because the same field of the same task
   was changed here and in the file. Everything else already merges, so the
   box names only those, and one answer settles them all. It has to be
   answered: closing it would only bring it back with the next autosave.

   info: { conflicts, current, disk, hash } as do_PUT's 409 sends them, with
   `current` the file as it stands. base and mine are what the save was built
   on and what it carried. */
function offerMerge(info, base, mine){
  const rows = info.conflicts.map(c => {
    const where = c.task ? esc(c.task) + (c.step ? ' › ' + esc(c.step) : '') : 'The list';
    return '<li><strong>' + where + '</strong>: ' + esc(MERGE_FIELD_NAMES[c.field] || c.field) + '</li>';
  });
  const sub = 'Someone else saved this list while you were changing it. Everything else is merged; ' +
    'these were changed in both places.';
  const body = '<div class="changes"><h3>Changed in both places</h3><ul>' + rows.join('') + '</ul></div>';
  const settle = prefer => () => {
    closeModal();
    const got = mergeSaves(base, mine, info.current, { prefer });
    // Nothing can be typed while the box is up, but a tab is not a promise.
    const now = serializeDoc(state.doc);
    const text = now === mine ? got.text : (mergeSaves(mine, now, got.text, { prefer:'mine' }).text);
    reloadInPlace(text, info.current);
    if (info.disk) state.diskStamp = info.disk;
    if (info.hash) state.diskHash = info.hash;
    if (text !== info.current) { markDirty(); saveFile(true); }
    else markClean('kept the other version', true);
  };
  showModal('Changed in two places', sub, body, [
    { label:'Keep mine', primary:true, run: settle('mine') },
    { label:'Download my copy first', run: () => downloadText(mine, state.fileName) },
    { label:'Use theirs', danger:true, run: settle('theirs') }
  ], { required:true });
}
