'use strict';

/* =========================================================================
   4b2b. The bucket agents' run, and the Spend and Schedules panels.

   This file was 13-plans.js, the Plans view. Plans stopped
   being a board of its own when an agent's part of a task became sub-tasks on the
   task's own card: a plan is read from the review sub-task behind it
   (openPlanReader() in 19-drawer.js), and where it stands is the state of those
   sub-tasks. What survives here is the two things that were only ever reached
   from that view and are not about plans: the tabs with Token Session and the
   jobs that run on a clock, and the button that starts the bucket agents now.

   The tabs are on the Settings page; the button is in the Data menu. Nothing
   here touches todo.md.
   ========================================================================= */

/* The last read of /bucket-agent.json, kept for the run-cost fold in the sheet.
   It used to be polled while Plans was on screen; now it is read when the sheet
   opens, which is when anything shows it. */
let lastNightAgent = null;

async function readNightAgent(){
  try {
    lastNightAgent = await getJSON('/bucket-agent.json');
    renderRunResults(lastNightAgent);
  } catch (err) { /* the fold stays as it was; the rest of the sheet does not need it */ }
}

/* What the last run actually cost — sits in Token Session rather than anywhere
   else, because it is a cost figure like everything else on that card. Folded
   shut, with the date and the total on the fold's own summary line. */
function renderRunResults(n){
  let label = 'Latest run costs';
  if (n.done.length) {
    const spent = n.done.reduce((a, d) => a + d.cost, 0);
    // The date the batch started, not the date of any one task within it —
    // a run that crosses midnight still reads as one night's work.
    const when = n.started || (n.done[0] || {}).at;
    const date = when
      ? new Date(when.replace(' ', 'T')).toLocaleDateString(undefined, { day:'numeric', month:'short' })
      : '';
    label += (date ? ' — ' + date : '') + ' · $' + spent.toFixed(2);
  }
  setRunResults({ label, done: n.done, failed: n.failed });
}

/* Spending money is a deliberate press and then a second one. The confirm says
   what it will cost and what it will do, because "run the agents" does not
   convey either. It starts the Bucket agents' run for the open board, the one
   the Agents tab's own Run now starts. */
function confirmNightAgentRun(){
  showModal('Run the bucket agents now?', 'Scheduled buckets normally wait for the board’s hours',
    '<div class="repdoc">' +
      '<p>It works through every task on <strong>' + esc(state.dataset || 'this board') + '</strong> with an open ' +
      'step assigned to one of its bucket agents, in the order they sit on the board, ' +
      'and leaves a plan or the work behind a review for each.</p>' +
      '<p>It stays inside the daily spending caps, ignores the clock and the usage window, ' +
      'so it will spend in whatever window is open now, including the one you are working in.</p>' +
      '<p>Nothing is sent, merged or pushed. A plan-first bucket waits for you to approve its plan, ' +
      'and you always review the work.</p>' +
    '</div>',
    [{ label:'Run it', primary:true, run: startNightAgentRun },
     { label:'Cancel' }]);
}

async function startNightAgentRun(){
  try {
    await postJSON('/agents-api/run', { agent: 'bucket-agent', action: 'run', target: state.dataset });
    watchRunStartedHere();
    showToast('The bucket agents are running.', 'good');
  } catch (err) {
    showToast('Could not start them: ' + (err.message || err), 'bad');
  }
}

/* Token Session and the clock card, both reference rather than decision — the
   chart is a glance at spend, the clock card only changes when the plist does —
   so they are two panels under the Agents tab of the Settings page.

   The body is one React tree, painted by paintRefCards(). Each renderer keeps
   its own slice of what it shows and paints only if the page is open, so a
   fetch that lands after it has gone costs nothing. */
/* True while the panels' React tree is mounted; the board view hides #lists
   without emptying it, so the host can outlive the tree. */
let refCardsDrawn = false;

function drawRefCards(){
  /* Two React trees on the Agents page, #refSpendRoot (Token Session) and
     #refSchedRoot (the clock card), drawn by paintRefCards() in 14-schedule.js. */
  if (refCardsDrawn || !$('#refSpendRoot')) return;
  refCardsDrawn = true;
  paintRefCards();
  renderSched();
  renderUsage();
  if (lastNightAgent) renderRunResults(lastNightAgent);
  readNightAgent();
}

function leaveRefCards(){
  refCardsDrawn = false;
  ['#refSpendRoot', '#refSchedRoot'].forEach(sel => { const host = $(sel); if (host) BoardUI.unmount(host); });
}

$('#runAgentBtn').textContent = 'Run the bucket agents now';
$('#runAgentBtn').onclick = () => { closeDataMenu(); confirmNightAgentRun(); };
