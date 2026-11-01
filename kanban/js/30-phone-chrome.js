/* =========================================================================
   The phone's top bar, filter row and tab bar
   =========================================================================
   Below 640px the header and the bucket bar are put away by board.css and
   these take their place (BoardUI.PhoneChrome, kanban/ui/HeaderBars.tsx).
   This file only reads the board and answers back, and it answers by clicking
   the control the desktop bars already own, so a handler there changes both:
   the views through the strip's own buttons, the buckets through the bucket
   toggles, the account sheet through Undo, Download, Backups and the rest of
   the Data menu. Those controls stay in the page, hidden, for exactly that.

   Drawn at every width and hidden by CSS above 640px, like the column strip,
   so there is no width check here to keep in step with the stylesheet. */

function phoneClick(sel){
  const el = document.querySelector(sel);
  if (el && !el.disabled) el.click();
  renderPhoneChrome();
}

/* The bucket strip as the desktop drew it, so the counts and colours are the
   ones already worked out rather than a second tally. */
function phoneBuckets(){
  return [...document.querySelectorAll('#bucketFilters .tenon-toggle-group__option')].map(b => {
    const countEl = b.querySelector('.tenon-toggle-group__count');
    const colour = b.style.getPropertyValue('--tenon-toggle-colour');
    return {
      key: b.dataset.value,
      label: [...b.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim(),
      on: b.getAttribute('aria-pressed') === 'true',
      count: countEl ? Number(countEl.textContent) : undefined,
      colour: colour || undefined
    };
  });
}

function phoneToggles(){
  const out = [];
  const mine = document.querySelector('#mineChip');
  if (mine && state.who) {
    const on = mine.getAttribute('aria-pressed') === 'true';
    out.push({ id: 'mine', label: on ? mine.textContent : (mine.hidden ? 'Nothing is yours' : mine.textContent),
               on, disabled: mine.hidden && !on, onClick: () => phoneClick('#mineChip') });
  }
  return out;
}

function phoneActions(){
  const actions = [];
  const add = (id, label, sel) => {
    const el = document.querySelector(sel);
    if (!el || el.classList.contains('hidden')) return;
    actions.push({ id, label, disabled: !!el.disabled, run: () => phoneClick(sel) });
  };
  add('undo', 'Undo', '#undo');
  add('download', 'Download copy', '#download');
  add('backups', 'Backups', '#backupsBtn');
  add('settings', 'Settings', '#settingsBtn');
  add('spend', 'Spend and schedules', '#refCardsBtn');
  add('run-agent', 'Run the Plan agent now', '#runAgentBtn');
  add('archive', 'Archive old done tasks', '#archiveBtn');
  if (state.who) {
    actions.push({ id: 'sign-out', label: 'Sign out', danger: true,
                   run: () => { const f = document.querySelector('#whoami form'); if (f) f.submit(); } });
  }
  return actions;
}

function phoneBoards(){
  return [...document.querySelectorAll('#datasetList [data-dataset]')].map(b => ({
    id: b.dataset.dataset,
    label: b.dataset.dataset === '__new__' ? 'New list…' : prettyDataset(b.dataset.dataset),
    current: b.classList.contains('current')
  }));
}

function renderPhoneChrome(){
  const host = $('#phoneChrome');
  if (!host || typeof BoardUI === 'undefined' || !BoardUI.PhoneChrome) return;
  const who = state.who;
  const board = state.dataset ? prettyDataset(state.dataset) : (listFolder ? listFolder.name : '');
  const filterable = !!state.doc && !$('#bucketFilters').classList.contains('hidden');
  BoardUI.mount(host, BoardUI.h(BoardUI.PhoneChrome, {
    hidden: !state.doc,
    board,
    boards: phoneBoards,
    onBoard: id => phoneClick('#datasetList [data-dataset="' + id + '"]'),
    avatarHTML: who ? personAvatarHTML(who.email, personFullName(who.email), 28) : undefined,
    accountName: who ? personName(who.email) : '',
    actions: phoneActions,
    status: () => $('#status').textContent,
    views: viewDefs().filter(d => !d.sep),
    view: state.view,
    onView: id => phoneClick('#viewToggle [data-view="' + id + '"]'),
    showFilters: filterable,
    query: state.query || '',
    onSearch: q => { const el = $('#q'); el.value = q; el.dispatchEvent(new Event('input', { bubbles: true })); renderPhoneChrome(); },
    buckets: phoneBuckets,
    onBucket: key => phoneClick('#bucketFilters [data-value="' + key + '"]'),
    toggles: phoneToggles,
    onEditBuckets: document.querySelector('#editBuckets') && !$('#editBuckets').classList.contains('hidden')
      ? () => phoneClick('#editBuckets') : null
  }));
}
