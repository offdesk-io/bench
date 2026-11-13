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

/* One card per agent. `highlight` names the card to mark. */
function agentCardsHTML(highlight){
  const row = (label, text) =>
    '<div class="agentcard-row"><dt>' + esc(label) + '</dt><dd>' + esc(text) + '</dd></div>';
  return '<section class="agentcards" aria-label="What each agent does">' +
    '<h2>What each agent does</h2>' +
    '<div class="agentcards-grid">' +
    AGENT_CARDS.map(c =>
      '<article class="agentcard' + (c.name === highlight ? ' on' : '') + '" data-agent-card="' + esc(c.name) + '">' +
        '<header><span class="avatar" aria-hidden="true">' + avatarSvg(c.name, 28) + '</span>' +
        '<h3>' + esc(c.name) + '</h3></header>' +
        '<dl>' + row('Does', c.does) + row('Cannot', c.cannot) + row('Needs from you', c.needs) + '</dl>' +
      '</article>').join('') +
    '</div></section>';
}

function renderAgentsView(){
  const lists = $('#lists');
  if (!lists) return;
  if (!agentsCanRun()) {
    leaveAgentsView();
    lists.innerHTML = '<div class="agentsview">' + agentsMissingHTML() + '</div>';
    return;
  }
  let host = lists.querySelector('#agentsRoot');
  if (!host) {
    leaveAgentsView();
    lists.innerHTML = '<div class="agentsview"><div class="agentscols">' +
      '<div class="agentscol" id="agentsCards"></div><div class="agentscol" id="agentOptions"></div>' +
      '<div class="agentscol" id="agentsPlanners"></div></div><div id="agentsRoot"></div><div id="refCardsRoot"></div></div>';
    host = lists.querySelector('#agentsRoot');
    agentsRoot = host;
  }
  drawAgentOptions(lists.querySelector('#agentOptions'));
  drawRefCards();
  lists.querySelector('#agentsCards').innerHTML = agentCardsHTML();
  refreshBucketPlanners();
  BoardUI.mount(host, BoardUI.h(BoardUI.AgentsApp, {
    base: '/agents-api',
    title: 'Agents',
    // Its own names in localStorage, so which reading and order the owner last had on
    // the dashboard does not decide this one, or the other way round.
    storagePrefix: 'board-agents.',
    embedded: true,
  }));
}

/* ---- The bucket agents of this list ----

   Under the board's switch and hours (the AgentsApp above, one target per
   board) comes each bucket of the open list with its agent: the name a
   sub-task carries in `[to::]`, how it works, when it starts, and what is
   missing where its brief is not ready. Read through bucketAgentsNow()
   (04-tier-two-the-one-thing.js), which a brief save reloads, so a badge
   changes without reloading the list. Each is a card that opens to show the brief's fields, with a Brief button
   that edits it. */
/* The brief's fields in the order a card shows them, under the headings the
   brief file carries. The first six are required; the last two show only when
   written. The keys are core/bucket_agents.py's FIELDS. */
const BUCKET_CARD_FIELDS = [
  ['purpose', 'What this agent is for', true],
  ['processes', 'The processes I run in this bucket', true],
  ['guidelines', 'Guidelines it follows', true],
  ['may_touch', 'What it may touch', true],
  ['never_touch', 'What it must never touch', true],
  ['good', 'What good looks like here', true],
  ['already_does_it', 'What already does it', false],
  ['involved', 'Who is involved', false],
];
/* Which cards are open, so a redraw (every refreshView) does not shut them. */
const bucketCardsOpen = new Set();

function bucketCardBodyHTML(a){
  const sec = a.sections || {};
  return BUCKET_CARD_FIELDS.filter(([k, , req]) => req || String(sec[k] || '').trim()).map(([k, heading]) => {
    const text = String(sec[k] || '').trim();
    return '<div class="bagent__field" data-field="' + k + '"><dt>' + esc(heading) + '</dt>' +
      (text ? '<dd>' + esc(text) + '</dd>' : '<dd class="bagent__empty">Not filled in yet</dd>') + '</div>';
  }).join('');
}

function bucketAgentRowHTML(a, i){
  const cols = bucketAgentsNow().columns;
  const col = Object.keys(cols).find(k => cols[k] === a.bucket) || a.bucket;
  const bi = state.doc ? state.doc.buckets.findIndex(b => b.name === col) : -1;
  const how = a.mode === 'free-rein' ? 'free rein' : 'plan first';
  const when = a.start === 'scheduled' ? 'scheduled' : 'starts when assigned';
  const detail = a.ready
    ? esc(how) + ' · ' + esc(when)
    : 'not set up: ' + esc(bucketAgentMissingText(a) || 'its brief');
  return '<li data-bucket-agent="' + esc(a.name) + '" class="' + (a.ready ? 'ready' : 'notready') + '">' +
    '<details class="bagent"' + (bucketCardsOpen.has(a.name) ? ' open' : '') + '><summary>' +
    '<span class="planner-bucket">' + plannerAvatarHTML(bucketColor(col, bi), 16).replace('class="avatar"', 'class="avatar" style="margin-right:6px"') +
      esc(a.name) + '</span>' +
    '<span class="planner-name">' + detail + '</span>' +
    '<button type="button" class="btn small" data-bucket-brief="' + esc(col) + '">Brief</button></summary>' +
    '<dl class="bagent__body">' + bucketCardBodyHTML(a) + '</dl></details></li>';
}

async function refreshBucketPlanners(){
  const host = $('#agentsPlanners');
  if (!host) return;
  await bucketAgentsLoaded();
  const again = $('#agentsPlanners');
  if (!again) return;
  const rows = bucketAgentsNow().buckets;
  if (!rows.length) { again.innerHTML = ''; return; }
  again.innerHTML = '<section class="planners" aria-label="This list’s bucket agents">' +
    '<h2>Bucket agents on ' + esc(state.dataset || 'this list') + '</h2><ul>' +
    rows.map(bucketAgentRowHTML).join('') + '</ul></section>';
  again.querySelectorAll('[data-bucket-brief]').forEach(btn => {
    /* The button sits in the summary, so a click on it must not also toggle the card. */
    btn.onclick = e => { e.preventDefault(); e.stopPropagation(); openBucketBrief(btn.dataset.bucketBrief); };
  });
  again.querySelectorAll('li[data-bucket-agent] details').forEach(d => {
    d.addEventListener('toggle', () => {
      const name = d.closest('li').dataset.bucketAgent;
      if (d.open) bucketCardsOpen.add(name); else bucketCardsOpen.delete(name);
    });
  });
}

/* A brief save reloads the data behind the rows, then draws them again. */
async function reloadBucketAgentsPanel(){
  await loadBucketAgents();
  if ($('#agentsPlanners')) refreshBucketPlanners();
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
