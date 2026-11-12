'use strict';

/* =========================================================================
   4b2b. The Plan agent's run, and the Spend and Schedules panels.

   This file was 13-plans.js, the Plans view. Plans stopped
   being a board of its own when an agent's part of a task became sub-tasks on the
   task's own card: a plan is read from the review sub-task behind it
   (openPlanReader() in 19-drawer.js), and where it stands is the state of those
   sub-tasks. What survives here is the two things that were only ever reached
   from that view and are not about plans: the tabs with Token Session and the
   jobs that run on a clock, and the button that starts the Plan agent now.

   The tabs are on the Settings page; the button is in the Data menu. Nothing
   here touches todo.md.
   ========================================================================= */

/* The last read of /planning-agent.json, kept for the run-cost fold in the sheet.
   It used to be polled while Plans was on screen; now it is read when the sheet
   opens, which is when anything shows it. */
let lastNightAgent = null;

async function readNightAgent(){
  try {
    lastNightAgent = await getJSON('/planning-agent.json');
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
   what it will cost and what it will do, because "run the agent" does not
   convey either — and the one thing worth being clear about is that it plans
   and never executes, which is true of the agent whatever hour it runs at. */
function confirmNightAgentRun(){
  showModal('Run the Plan agent now?', 'It normally waits for the small hours',
    '<div class="repdoc">' +
      '<p>It will work through every task with an open Plan sub-task assigned to it, ' +
      'in the order they sit on the board, one agent each, and leave a plan for each ' +
      'behind its review.</p>' +
      '<p>Up to <strong>$12</strong> across the batch and <strong>$2</strong> a task, ' +
      'stopping early if either runs out. It ignores the clock and the usage window, ' +
      'so it will spend in whatever window is open now — including the one you are ' +
      'working in.</p>' +
      '<p>Nothing it writes is carried out. Every plan waits for you.</p>' +
    '</div>',
    [{ label:'Run it', primary:true, run: startNightAgentRun },
     { label:'Cancel' }]);
}

async function startNightAgentRun(){
  try {
    await postJSON('/planning_agent/run');
    watchRunStartedHere();
    showToast('The agent is running.', 'good');
  } catch (err) {
    showToast('Could not start it: ' + (err.message || err), 'bad');
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
  /* One React tree in the Agents tab's #refCardsRoot, drawn by paintRefCards()
     in 14-schedule.js: Token Session and the clock card, two panels. */
  if (refCardsDrawn || !$('#refCardsRoot')) return;
  refCardsDrawn = true;
  refCardsShow = undefined;
  paintRefCards();
  renderSched();
  renderUsage();
  if (lastNightAgent) renderRunResults(lastNightAgent);
  readNightAgent();
}

function leaveRefCards(){
  refCardsDrawn = false;
  const host = $('#refCardsRoot');
  if (host) BoardUI.unmount(host);
}

$('#runAgentBtn').onclick = () => { closeDataMenu(); confirmNightAgentRun(); };
