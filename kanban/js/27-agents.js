'use strict';

/* =========================================================================
   4d. Agents — what each agent does, and the Bucket agents' switch, hours and
   run for each board, with each bucket's agent listed under them.

   The switches and hours are the agents dashboard's own page,
   PACKAGES/agents-engine/react, reached as BoardUI.AgentsApp, so this view and
   the standalone agents dashboard draw one hour track rather than two. It asks
   /agents-api/* (kanban/server.py), which runs agents-engine's routes over this
   repo's agents/ folder only, so the agents on it are the ones the board hands
   work to. Every change goes through the agent's own `apply` command; nothing
   here or in the server opens a schedule file.

   Under it, one card per agent from AGENT_CARDS (02-state.js): what it does,
   what it cannot do and what it needs from the person. Plain HTML beside the
   React root rather than inside it, since the component is shared with the
   dashboard and the cards are this board's own words.

   The component owns everything on screen, including its twenty-second poll of
   every agent's state. That poll is why leaving the view unmounts it: a root
   left behind on a node the next view has replaced keeps polling, and each
   poll runs both agents' state commands.
   ========================================================================= */

let agentsRoot = null;

/* ---- Can an agent run on this machine? ----

   The agents need the `claude` CLI and agents-engine. Without either, a run
   dies the moment it starts, so the board leaves out everything that would
   start one: agents under Delegate to, the
   Agent options on the Agents tab, and the Data menu's Spend and Run the bucket agents now.
   The Agents tab says what is missing instead. The rest of the board does not
   need them. */
function agentsCanRun(){ return state.agentsReady !== false; }

async function loadAgentsStatus(){
  let got;
  try { got = await getJSON('/agents-status.json'); } catch (err) { return; }
  const was = agentsCanRun();
  state.agentsReady = !!(got && got.ready);
  state.agentsMissing = got && !got.claude ? 'claude' : 'engine';
  syncFolderButton();
  if (agentsCanRun() !== was && state.doc) refreshView();
}

function agentsMissingHTML(){
  const why = state.agentsMissing === 'claude'
    ? 'Agents need Claude Code, and it is not installed on this machine. Install it, ' +
      'log in, then reload the board.'
    : 'Agents need the agents-engine package next to this folder, and it is not there. ' +
      'Add it, then restart the board.';
  return '<section class="agentsetup">' +
    '<h1>Agents</h1>' +
    '<p>' + esc(why) + '</p>' +
    '<p>Everything else on the board works without them.</p>' +
    '</section>';
}

/* What an agent does, cannot do and needs, as the facts under its section. */
function agentFactsHTML(card){
  return '<dl class="agentfacts" data-agent-card="' + esc(card.name) + '">' +
    '<div><dt>Cannot</dt><dd>' + esc(card.cannot) + '</dd></div>' +
    '<div><dt>Needs from you</dt><dd>' + esc(card.needs) + '</dd></div></dl>';
}

/* The page's sections, in order. Each field is drawn into its container once the
   data behind it has arrived: the settings by drawAgentOptions() (29-settings.js),
   the briefs by refreshBucketPlanners() below. The two React trees, the hours and
   the spend and schedule cards, sit in nodes made here, so they are never replaced
   by a redraw of the fields around them. */
function agentsSections(){
  const pa = AGENT_CARDS.find(c => c.name === 'PA'), bucket = AGENT_CARDS.find(c => c.name === 'Bucket agents');
  return [
    { id: 'models', title: 'Models', description: 'What each job runs on.', html: '<div id="agentModels"></div>' },
    { id: 'pa', title: 'PA', description: pa.does, html: agentFactsHTML(pa) },
    { id: 'buckets', title: 'Bucket agents', description: bucket.does, wide: true,
      html: agentFactsHTML(bucket) + '<div id="agentBoardSwitch"></div><div id="agentsPlanners"></div>' },
    { id: 'schedules', title: 'Schedules', description: 'When the bucket agents run, and what else runs on a clock.', wide: true,
      html: '<div id="agentsRoot"></div><div id="refSchedRoot"></div>' },
    { id: 'spending', title: 'Spending', description: 'What the agents may spend, and what they have.', wide: true,
      html: '<div id="agentSpendFields"></div><div id="refSpendRoot"></div>' },
  ];
}

function renderAgentsView(){
  const lists = $('#lists');
  if (!lists) return;
  if (!agentsCanRun()) {
    leaveAgentsView();
    lists.innerHTML = '<div class="agentsview">' + agentsMissingHTML() + '</div>';
    return;
  }
  let page = lists.querySelector('#agentsPage');
  /* A tab that locked or unlocked since it was drawn is drawn again, fields and all. */
  if (page && page.dataset.locked !== String(!!state.locked)) { leaveAgentsView(); page = null; }
  if (!page) {
    leaveAgentsView();
    agentsOpts = null; agBriefs = {}; agBriefsStale = true;
    lists.innerHTML = '<div class="lists pview settingsview agentsview" style="--pcols:1"><div id="agentsPage" data-locked="' + !!state.locked + '">' +
      settingsPageLayoutHTML('Agents', agentsSections(), { saveAttr: 'data-agents-save', save: !state.locked }) + '</div></div>';
    page = lists.querySelector('#agentsPage');
    page.querySelectorAll('[data-agents-save]').forEach(btn => { btn.onclick = () => agentsSaveAll(); });
  }
  /* The board view hides #lists without emptying it, so the page can outlive its trees. */
  agentsRoot = page.querySelector('#agentsRoot');
  drawAgentOptions(page);
  drawRefCards();
  refreshBucketPlanners();
  BoardUI.mount(agentsRoot, BoardUI.h(BoardUI.AgentsApp, {
    base: '/agents-api',
    title: 'Agents',
    // Its own names in localStorage, so which reading and order the owner last had on
    // the dashboard does not decide this one, or the other way round.
    storagePrefix: 'board-agents.',
    embedded: true,
  }));
}

/* ---- The bucket agents of this list ----

   One card per bucket of the open list with its agent: the name a sub-task
   carries in `[to::]`, how it works, when it starts, and what is missing where
   its brief is not ready. Read through bucketAgentsNow()
   (04-tier-two-the-one-thing.js), which a brief save reloads. A card opens to
   the brief's fields, each a Tenon Field and always editable, the same as the
   Memory page's: how it works, when it starts, the one line and the eight
   sections. What is typed is kept in agBriefs across any redraw, and the page's
   one Save writes the briefs that changed through PUT /bucket-brief, the route
   the board's own bucket editor uses. A locked tab shows them readonly and
   writes nothing. */
/* Which cards are open, so a redraw (every refreshView) does not shut them. */
const bucketCardsOpen = new Set();
/* column name -> { parts, wasEmpty, base, brief }: the brief as loaded, what was
   typed since in `parts`, and `base` to tell the two apart. */
let agBriefs = {};
let agBriefsKey = '';     // the columns agBriefs was loaded for; another list or a new bucket loads again
let agBriefsStale = true; // a save or a reload of the bucket agents asks for a fresh read

const agBriefSnap = p => JSON.stringify([p.mode || '', p.start || 'on-assign', p.summary || '', BRIEF_ALL.map(n => (p.sections || {})[n] || '')]);
const agColumn = a => {
  const cols = bucketAgentsNow().columns;
  return Object.keys(cols).find(k => cols[k] === a.bucket) || a.bucket;
};

function bucketAgentRowHTML(a){
  const col = agColumn(a);
  const bi = state.doc ? state.doc.buckets.findIndex(b => b.name === col) : -1;
  const how = a.mode === 'free-rein' ? 'free rein' : 'plan first';
  const when = a.start === 'scheduled' ? 'scheduled' : 'starts when assigned';
  const detail = a.ready
    ? esc(how) + ' · ' + esc(when)
    : 'not set up: ' + esc(bucketAgentMissingText(a) || 'its brief');
  const b = agBriefs[col];
  const fields = !b ? '<p class="memempty">Reading the brief…</p>' :
    tenonFieldHTML({ label: 'How the agent works', kind: 'select', attrs: 'data-ag-mode', readonly: state.locked,
      options: '<option value=""' + (b.parts.mode ? '' : ' selected') + '>Choose how it works</option>' +
        BRIEF_MODES.map(m => '<option value="' + esc(m[0]) + '"' + (m[0] === b.parts.mode ? ' selected' : '') + '>' + esc(m[1]) + '</option>').join(''),
      hint: 'Plan first waits for your approval before the work. Free rein goes straight to it.' }) +
    tenonFieldHTML({ label: 'When it starts', kind: 'select', attrs: 'data-ag-start', readonly: state.locked,
      options: BRIEF_STARTS.map(m => '<option value="' + esc(m[0]) + '"' + (m[0] === (b.parts.start || 'on-assign') ? ' selected' : '') + '>' + esc(m[1]) + '</option>').join(''),
      hint: 'On assignment starts within a minute of a handover. Scheduled runs in the board’s hours.' }) +
    tenonFieldHTML({ label: 'One line: what kind of work lands here', attrs: 'data-ag-summary', readonly: state.locked, value: b.parts.summary,
      hint: 'Shown at the top of the brief.' }) +
    BRIEF_ALL.map((name, i) => tenonFieldHTML({ label: name, kind: 'textarea', attrs: 'data-ag-section="' + i + '"', readonly: state.locked,
      value: b.parts.sections[name] || '', hint: BRIEF_DESCRIPTIONS[name] })).join('');
  return '<li data-bucket-agent="' + esc(a.name) + '" data-bucket-col="' + esc(col) + '" class="' + (a.ready ? 'ready' : 'notready') + '">' +
    '<details class="bagent"' + (bucketCardsOpen.has(a.name) ? ' open' : '') + '><summary>' +
    '<span class="planner-bucket">' + plannerAvatarHTML(bucketColor(col, bi), 16).replace('class="avatar"', 'class="avatar" style="margin-right:6px"') +
      esc(a.name) + '</span>' +
    '<span class="planner-name">' + detail + '</span></summary>' +
    '<div class="bagent__body">' + fields + '</div></details></li>';
}

/* What the cards' fields on screen hold, copied into agBriefs. */
function agReadBriefs(){
  document.querySelectorAll('#agentsPlanners li[data-bucket-col]').forEach(li => {
    const b = agBriefs[li.dataset.bucketCol];
    if (!b || !li.querySelector('[data-ag-summary]')) return;
    const p = b.parts;
    p.mode = li.querySelector('[data-ag-mode]').value;
    p.start = li.querySelector('[data-ag-start]').value;
    p.summary = li.querySelector('[data-ag-summary]').value;
    li.querySelectorAll('[data-ag-section]').forEach(t => { p.sections[BRIEF_ALL[+t.dataset.agSection]] = t.value; });
  });
}

/* Reads every bucket's brief, keeping what was typed into any that has unsaved changes. */
async function agLoadBriefs(){
  await bucketAgentsLoaded();
  const rows = bucketAgentsNow().buckets;
  const cols = rows.map(agColumn);
  const key = state.dataset + '|' + cols.join('|');
  if (!agBriefsStale && key === agBriefsKey) return;
  const got = await Promise.all(cols.map(col => getJSON('/bucket-brief.json?bucket=' + encodeURIComponent(col)).then(b => [col, b], () => [col, null])));
  agReadBriefs();
  if (key !== agBriefsKey) agBriefs = {};
  const kept = {};
  for (const [col, brief] of got) {
    if (!brief) continue;
    const had = agBriefs[col];
    if (had && agBriefSnap(had.parts) !== had.base) { had.brief = brief; kept[col] = had; continue; }
    const parts = parseBriefText(brief.text);
    kept[col] = { parts, brief, wasEmpty: !brief.exists || !brief.filled, base: agBriefSnap(parts) };
  }
  agBriefs = kept;
  agBriefsKey = key;
  agBriefsStale = false;
}

/* The open page's briefs, or settings, differ from what was loaded. */
function agentsIsDirty(){
  if (state.locked || !document.querySelector('#agentsPage')) return false;
  if (agentsOpts && agentOptsSnapshot(agentsOpts.draft) !== agentsOpts.base) return true;
  agReadBriefs();
  return Object.values(agBriefs).some(b => agBriefSnap(b.parts) !== b.base);
}

/* The page's one Save: the settings, then each brief that changed, one request
   each. A refusal stops the rest and names what was refused. True when it went
   through. A locked tab writes nothing. */
async function agentsSaveAll(){
  if (writeBlocked()) return false;
  const page = document.querySelector('#agentsPage');
  const opts = agentsOpts && agentsOpts.draft;
  if (opts && Object.keys(agentOptionErrors(opts)).length) { if (page) paintAgentOptionErrors(opts, page, true); return false; }
  agReadBriefs();
  let wrote = false;
  if (opts && agentOptsSnapshot(opts) !== agentsOpts.base) {
    if (!(await saveAgentOptions(opts))) return false;
    agentsOpts.base = agentOptsSnapshot(opts);
    wrote = true;
  }
  let briefs = false;
  for (const col in agBriefs) {
    const b = agBriefs[col];
    if (agBriefSnap(b.parts) === b.base) continue;
    try {
      await putJSON('/bucket-brief', { bucket: col, text: serializeBriefText(b.parts, keepBriefMarker(b.wasEmpty, b.parts)) });
      b.base = agBriefSnap(b.parts);
      briefs = wrote = true;
    } catch (err) {
      showToast('Could not save the brief for ' + col + ': ' + (err.message || err), 'bad');
      if (briefs) { agBriefsStale = true; reloadBucketAgentsPanel(); }
      return false;
    }
  }
  if (briefs) { agBriefsStale = true; await reloadBucketAgentsPanel(); }
  showToast(wrote ? 'Saved.' : 'Nothing to save.', wrote ? 'good' : '');
  return true;
}

/* Draws the cards from agBriefs, reading what is typed first and putting the
   cursor back, so a redraw never costs typing. */
async function refreshBucketPlanners(){
  if (!$('#agentsPlanners')) return;
  await agLoadBriefs();
  const host = $('#agentsPlanners');
  if (!host) return;
  const rows = bucketAgentsNow().buckets;
  agReadBriefs();
  const fields = () => [...host.querySelectorAll('textarea, input, select')];
  const at = fields().indexOf(document.activeElement);
  const sel = at < 0 ? null : { start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd };
  host.innerHTML = rows.length
    ? '<ul class="agentbuckets">' + rows.map(bucketAgentRowHTML).join('') + '</ul>'
    : '<p class="memempty">No buckets yet. Each bucket of the board gets its agent here.</p>';
  host.querySelectorAll('li[data-bucket-agent] details').forEach(d => {
    d.addEventListener('toggle', () => {
      const name = d.closest('li').dataset.bucketAgent;
      if (d.open) bucketCardsOpen.add(name); else bucketCardsOpen.delete(name);
    });
  });
  const el = at < 0 ? null : fields()[at];
  if (el) {
    el.focus();
    try { el.setSelectionRange(sel.start, sel.end); } catch (e) { /* not a text field */ }
  }
}

/* A brief save elsewhere (the board's bucket editor) reloads the data behind the cards, then draws them again. */
async function reloadBucketAgentsPanel(){
  await loadBucketAgents();
  agBriefsStale = true;
  if ($('#agentsPlanners')) await refreshBucketPlanners();
}

/* Called by renderView() for every view but this one. */
function leaveAgentsView(){
  leaveRefCards();
  if (!agentsRoot) return;
  BoardUI.unmount(agentsRoot);
  agentsRoot = null;
  // A run started from here reports done on this page, not on the board, so
  // anything it queued is picked up on the way back to the cards.
  drainTickQueue();
}
