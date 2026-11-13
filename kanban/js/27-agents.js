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

/* ---- Is there an agent on this list yet? ----

   Someone who only uses the PA to keep their list has no use for the agent
   half of the board, so until the list has an agent set up the board leaves
   it out: no agents under Delegate to, and
   this tab shows the cards and the way to set one up instead of the hour
   tracks. The agent filter chip already hides itself while nothing is
   delegated.

   A list counts as set up when any of these holds:
     - a bucket's agent is ready to take a task (`ready` in
       /bucket-brief.json, core/bucket_agents.py's judgement);
     - a bucket's brief has a section the person wrote, rather than the
       template's own prose — a new list's wizard scaffolds every brief with a
       one-line summary and no marker, so `filled` alone would count every
       new list as set up;
     - a task, or one of its sub-tasks, is already delegated to an agent.
   Until the briefs have answered, or where there is no server to ask (the
   demo build), it counts as set up, so nothing is hidden on a guess. */
function agentsSetUp(){
  if (!agentsCanRun()) return false;
  if (state.agentsSetup !== false) return true;
  return listHasAgentWork();
}

function listHasAgentWork(){
  if (!state.doc) return false;
  return state.doc.buckets.some(b => b.tiers.some(ti => ti.tasks.some(t => delegatedToAgent(t))));
}

/* A brief with at least one section that is neither empty nor the template's
   own text for it. */
function briefWritten(brief){
  if (!brief || !brief.exists || !brief.filled) return false;
  const mine = parseBriefText(brief.text).sections;
  const tpl = parseBriefText(brief.template || '').sections;
  return BRIEF_SECTIONS.some(n => {
    const v = (mine[n] || '').trim();
    return !!v && v !== (tpl[n] || '').trim();
  });
}

let agentsSetupAsk = 0;
async function checkAgentsSetup(){
  if (!state.doc) return;
  const ask = ++agentsSetupAsk;
  const answers = await Promise.all(state.doc.buckets.map(b =>
    getJSON('/bucket-brief.json?bucket=' + encodeURIComponent(b.name)).catch(() => null)));
  if (ask !== agentsSetupAsk) return;
  const got = answers.filter(Boolean);
  const was = agentsSetUp();
  state.agentsSetup = got.length ? got.some(a => a.ready || briefWritten(a)) : null;
  if (agentsSetUp() !== was && state.doc) refreshView();
}

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

/* One card per agent. `highlight` names the card to mark, which is how the
   setup wizard ends on the agent it has just set up. */
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
  if (!agentsSetUp()) {
    /* Nothing to schedule yet, so the hour tracks wait until there is. */
    leaveAgentsView();
    lists.innerHTML = '<div class="agentsview">' + agentSetupIntroHTML() +
      '<div id="agentOptions"></div><div id="agentsCards">' + agentCardsHTML() + '</div><div id="refCardsRoot"></div></div>';
    wireAgentSetupButtons(lists);
    drawAgentOptions(lists.querySelector('#agentOptions'));
    drawRefCards();
    return;
  }
  let host = lists.querySelector('#agentsRoot');
  if (!host) {
    leaveAgentsView();
    lists.innerHTML = '<div class="agentsview"><div id="agentOptions"></div><div id="agentsRoot"></div>' +
      '<div id="agentsCards"></div><div id="agentsPlanners"></div><div id="refCardsRoot"></div></div>';
    host = lists.querySelector('#agentsRoot');
    agentsRoot = host;
  }
  drawAgentOptions(lists.querySelector('#agentOptions'));
  drawRefCards();
  lists.querySelector('#agentsCards').innerHTML = agentCardsHTML() +
    '<p class="agentsetup-more"><button type="button" class="btn small" data-agent-setup>' +
    'Set up an agent for another bucket</button></p>';
  wireAgentSetupButtons(lists);
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

/* What the tab says on a list with no agent yet. */
function agentSetupIntroHTML(){
  return '<section class="agentsetup">' +
    '<h1>Agents</h1>' +
    '<p>No agent is set up on this list yet. An agent can plan a task for you ' +
    'overnight, then carry out the plan once you approve it. Setting one up is ' +
    'four questions about one of your buckets.</p>' +
    '<button type="button" class="btn primary" data-agent-setup>Set up an agent</button>' +
    '</section>';
}

function wireAgentSetupButtons(root){
  root.querySelectorAll('[data-agent-setup]').forEach(btn => {
    btn.onclick = () => openAgentSetup();
  });
}

/* ---- Setting up an agent: four questions about one bucket ----

   Someone new to agents is asked four things about one of their buckets: what
   the agent should be like, what tasks it does there, whether there is
   documentation on how those tasks are run, and what the output looks like
   and in what form. The answers are written into that bucket's brief,
   `data/<dataset>/buckets/<stream>/<stream>.md`, the file that defines the
   bucket's agent. So what the person tells it stays in their own data folder,
   out of git, and the tracked agents/bucket-agent/ stays as shipped.

   Where the answers land in the brief's four sections (BRIEF_SECTIONS,
   08-buckets.js), so the bucket's own brief editor opens on them unchanged:
     tasks          -> The processes I run in this bucket
     documentation  -> What already does it
     like, output   -> What good looks like here
   A section still holding the template's guidance is replaced; one someone
   already wrote keeps its text, and the answer goes under it.

   One sheet per step, since showModal() closes the sheet before running a
   button: the answers live in agentWizard and each field writes to it as it
   is typed, the way openBucketBrief() keeps its fields. */
const AGENT_QUESTIONS = [
  { key: 'like', label: 'What should this agent be like?',
    hint: 'How it works with you. Should it ask before it starts, or get on with it? How much detail do you want back? Anything it should never do?' },
  { key: 'tasks', label: 'What tasks should it do in this bucket?', required: true,
    hint: 'The kinds of work that land here and come back again. For each, what starts it and what it produces.' },
  { key: 'docs', label: 'Is there documentation on how those tasks are run?',
    hint: 'A process doc, a template, a checklist, an example of a good one. Say where it lives. Leave this empty if there is none.' },
  { key: 'output', label: 'What should the output look like, and in what form?',
    hint: 'A document, a message, a deck, a spreadsheet. What would you accept without changes, and what always gets sent back?' }
];

let agentWizard = null;

function openAgentSetup(){
  if (!state.doc || !state.doc.buckets.length) return;
  agentWizard = { step: 0, bucket: '', answers: { like: '', tasks: '', docs: '', output: '' }, missing: false };
  agentSetupStep();
}

function agentSetupStep(){
  const w = agentWizard;
  if (!w) return;
  if (w.step === 0) {
    if (!w.bucket) w.bucket = state.doc.buckets[0].name;
    const opts = state.doc.buckets.map(b =>
      '<option value="' + esc(b.name) + '"' + (b.name === w.bucket ? ' selected' : '') + '>' + esc(b.name) + '</option>').join('');
    showModal('Set up an agent',
      'An agent works one bucket of your list at a time. Pick the bucket, then answer four questions ' +
      'about the work in it. Your answers become that bucket’s brief, which the agents read before ' +
      'they plan or do anything there.',
      '<label class="field"><span>Which bucket?</span>' +
        '<select id="agentSetupBucket" aria-label="Which bucket">' + opts + '</select></label>',
      [{ label: 'Cancel', run: () => { agentWizard = null; } },
       { label: 'Next', primary: true, run: () => { w.step = 1; agentSetupStep(); } }]);
    const sel = modalEl && modalEl.querySelector('#agentSetupBucket');
    if (sel) sel.onchange = () => { w.bucket = sel.value; };
    return;
  }
  if (w.step <= AGENT_QUESTIONS.length) {
    const q = AGENT_QUESTIONS[w.step - 1];
    const last = w.step === AGENT_QUESTIONS.length;
    showModal(q.label,
      'Question ' + w.step + ' of ' + AGENT_QUESTIONS.length + ', for <strong>' + esc(w.bucket) + '</strong>. ' +
      esc(q.hint),
      (w.missing ? '<p class="agentsetup-missing">This one is needed: the agent has nothing to work from without it.</p>' : '') +
      '<label class="field"><span>' + (q.required ? 'Your answer' : 'Your answer (optional)') + '</span>' +
        '<textarea id="agentSetupAnswer" rows="6" aria-label="' + esc(q.label) + '">' +
        esc(w.answers[q.key]) + '</textarea></label>',
      [{ label: 'Back', run: () => { w.missing = false; w.step -= 1; agentSetupStep(); } },
       { label: last ? 'Set up the agent' : 'Next', primary: true, run: () => {
          if (q.required && !w.answers[q.key].trim()) { w.missing = true; agentSetupStep(); return; }
          w.missing = false;
          if (last) { saveAgentSetup(); return; }
          w.step += 1; agentSetupStep();
        } }],
      { onClose: null });
    const box = modalEl && modalEl.querySelector('#agentSetupAnswer');
    if (box) { box.oninput = () => { w.answers[q.key] = box.value; }; box.focus(); }
    return;
  }
}

/* The brief with the answers written in, from the text on disk (or the
   template, for a bucket with no brief yet). Pure, so the suite can check the
   mapping without a server. */
function briefWithAnswers(brief, bucket, answers){
  const parts = parseBriefText(brief.text || brief.template || '');
  const tpl = parseBriefText(brief.template || '').sections;
  if (!parts.title || /^<.*>$/.test(parts.title)) parts.title = bucket;
  if (/^<.*>$/.test(parts.summary)) parts.summary = '';
  const put = (section, text) => {
    text = String(text || '').trim();
    if (!text) return;
    const cur = (parts.sections[section] || '').trim();
    parts.sections[section] = !cur || cur === (tpl[section] || '').trim() ? text : cur + '\n\n' + text;
  };
  const a = answers;
  put(BRIEF_SECTIONS[0], a.tasks);
  put(BRIEF_SECTIONS[1], a.docs);
  const good = [
    a.like && a.like.trim() ? 'How the agent should work: ' + a.like.trim() : '',
    a.output && a.output.trim() ? 'What the output looks like: ' + a.output.trim() : ''
  ].filter(Boolean).join('\n\n');
  put(BRIEF_SECTIONS[3], good);
  return serializeBriefText(parts, false);
}

async function saveAgentSetup(){
  const w = agentWizard;
  if (!w) return;
  let res;
  try {
    const brief = await getJSON('/bucket-brief.json?bucket=' + encodeURIComponent(w.bucket));
    res = await putJSON('/bucket-brief', { bucket: w.bucket, text: briefWithAnswers(brief, w.bucket, w.answers) });
  } catch (err) {
    showToast('Could not write the brief for ' + w.bucket + ': ' + (err.message || err), 'bad');
    return;
  }
  /* Written by construction: the tasks answer is required, and it replaces
     the template's guidance. So no second round of asking, and any ask still
     in flight from before the write is dropped rather than let overrule it. */
  agentsSetupAsk++;
  state.agentsSetup = true;
  refreshView();
  agentSetupDone(res);
}

/* The last sheet: what was written, the bucket agents' card, and the one thing
   to do next. */
function agentSetupDone(){
  const w = agentWizard;
  agentWizard = null;
  showModal('Your agent is set up for ' + w.bucket,
    'Your answers are in the ' + esc(w.bucket) + ' bucket’s brief. You can change them any time ' +
    'from Edit buckets, under Brief.',
    '<div class="agentsetup-done">' + agentCardsHTML('Bucket agents') + '</div>' +
    '<p class="agentsetup-next"><strong>Next:</strong> open a task in ' + esc(w.bucket) +
    ' and choose its agent under Delegate to. It works the task and leaves the result on the card for you.</p>',
    [{ label: 'Done', primary: true }],
    { wide: true });
}

/* ---- The bucket agents of this list ----

   Under the board's switch and hours (the AgentsApp above, one target per
   board) comes each bucket of the open list with its agent: the name a
   sub-task carries in `[to::]`, how it works, when it starts, and what is
   missing where its brief is not ready. Read through bucketAgentsNow()
   (04-tier-two-the-one-thing.js), which a brief save reloads, so a badge
   changes without reloading the list. Each row opens that bucket's brief. */
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
    '<span class="planner-bucket">' + plannerAvatarHTML(bucketColor(col, bi), 16).replace('class="avatar"', 'class="avatar" style="margin-right:6px"') +
      esc(a.name) + '</span>' +
    '<span class="planner-name">' + detail + '</span>' +
    '<button type="button" class="btn small" data-bucket-brief="' + esc(col) + '">Brief</button></li>';
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
    btn.onclick = () => openBucketBrief(btn.dataset.bucketBrief);
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
