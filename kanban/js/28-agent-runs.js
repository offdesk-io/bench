'use strict';

/* =========================================================================
   Where an agent's run on a task stands, as one line on its card.

   A task handed over carries its agent's part as sub-tasks (handOver(),
   04-tier-two-the-one-thing.js), and those say whose move it is. They cannot
   say whether its agent has started, is stuck or failed: an agent never
   writes todo.md. The agents keep that in data/<dataset>/agent-runs.json
   (core/agent_runs.py), one record per sub-task, and the board reads it from
   /agent-runs.json.

   The line is "Personal family agent · waiting for you · 02:05": whose part the task is at,
   what it is doing, and when that last changed. Worked out from the sub-tasks
   first and the record second, so a task whose run the board has never heard of
   still reads "queued" rather than nothing.
   ========================================================================= */

/* The records, by sub-task id. Empty until the first read comes back. */
let agentRuns = {};
let agentRunsSig = '';

/* A run marked running for longer than this died without saying so. The
   bucket agents stop a task well inside it. */
const RUN_STALE_MS = 3 * 60 * 60 * 1000;

async function loadAgentRuns(){
  let got;
  try {
    const res = await fetch('/agent-runs.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    got = await res.json();
  } catch (err) { return; }
  const subs = got && typeof got.subs === 'object' && got.subs ? got.subs : {};
  const sig = JSON.stringify(subs);
  if (sig === agentRunsSig) return;
  agentRunsSig = sig;
  agentRuns = subs;
  if (state.doc && typeof refreshView === 'function') refreshView();
}

/* Read on load, when the tab comes back, and once a minute while it is up:
   a run started overnight lands while the tab sits open. */
loadAgentRuns();
setInterval(() => { if (!document.hidden) loadAgentRuns(); }, 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadAgentRuns(); });

/* "starts when assigned" or "starts in the board's hours". */
function bucketAgentStartWords(a){
  return a.start === 'scheduled' ? "starts in this board's hours" : 'starts when assigned';
}

function agentRunFor(sub){
  return (sub && sub.stableId && agentRuns[sub.stableId]) || null;
}

/* "02:05" today, "26 Sep" before. */
function runWhen(iso){
  if (!iso) return '';
  const d = new Date(String(iso).replace(' ', 'T'));
  if (isNaN(d)) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/* The four sub-tasks a handover lays out, those this task has, in order. */
const HANDOVER_KINDS = ['plan', 'plan-review', 'implement', 'work-review'];
function handoverSteps(t){
  if (!t || !t.stableId) return [];
  const steps = subSteps(t);
  return HANDOVER_KINDS.map(kind => ({ kind, step: steps.find(s => s.slug === t.stableId + '-' + kind) }))
    .filter(x => x.step);
}

/* A record's state, with a run left running for hours read as failed. */
function runState(rec){
  if (!rec) return '';
  if (rec.state === 'running') {
    const at = Date.parse(String(rec.started || rec.at || '').replace(' ', 'T'));
    if (at && Date.now() - at > RUN_STALE_MS) return 'stale';
  }
  return rec.state || '';
}

/* The line, as data: { text, tone, title, sub, failed }, or null for a task
   with no agent part left open. `tone` is one of running, queued, you, failed. */
function agentRunStatus(t){
  if (!t || t.done) return null;
  const hs = handoverSteps(t);
  if (!hs.some(x => x.kind === 'plan' || x.kind === 'implement')) return null;
  const at = hs.findIndex(x => !x.step.done);
  if (at < 0) return null;
  const cur = hs[at];
  const agentStep = cur.kind === 'plan' || cur.kind === 'implement';
  if (agentStep) {
    const who = agentOf(cur.step.to);
    // Taken back: the step is the owner's now, and "your move" already says so.
    if (!who) return null;
    const rec = agentRunFor(cur.step);
    const st = runState(rec);
    const base = { sub: cur.step.stableId, agent: who };
    if (st === 'running')
      return Object.assign(base, { tone: 'running', text: who + ' · working · since ' + runWhen(rec.started || rec.at),
        title: who + ' started on this at ' + runWhen(rec.started || rec.at) });
    if (st === 'failed' || st === 'stale')
      return Object.assign(base, { tone: 'failed', failed: true,
        text: who + ' · failed · ' + runWhen(rec.at),
        title: st === 'stale' ? 'It started and never finished.' : (rec.why || 'The run failed.') });
    const ba = bucketAgentNamed(who);
    if (ba && !ba.ready && st !== 'running')
      return Object.assign(base, { tone: 'failed', text: who + ' · not set up',
        title: 'Its brief still needs ' + (bucketAgentMissingText(ba) || 'filling in') + '.' });
    if (st === 'queued')
      return Object.assign(base, { tone: 'queued',
        text: who + ' · retrying' + (ba ? (ba.start === 'scheduled' ? " in this board's hours" : ' shortly') : ''),
        title: 'You asked for it to be tried again at ' + runWhen(rec.retry || rec.at) });
    if (st === 'done')
      return Object.assign(base, { tone: 'queued', text: who + ' · finished · ' + runWhen(rec.at),
        title: 'Finished. The board ticks the sub-task when it next drains what the agent asked for.' });
    if (ba) {
      const waits = ba.start === 'scheduled' && !bucketAgentInHours();
      return Object.assign(base, { tone: 'queued',
        text: who + ' · ' + (waits ? "outside this board's hours" : 'queued, ' + bucketAgentStartWords(ba)),
        title: waits ? 'Not started. It starts in the hours set for this board.'
          : 'Not started. ' + (ba.start === 'scheduled' ? 'It starts in the next of its hours.' : 'It starts as soon as a task is assigned to it.') });
    }
    /* A name no bucket of this list goes by, such as a handover from before
       bucket agents that the PA has not moved over yet: nothing will pick it up. */
    return Object.assign(base, { tone: 'queued', text: who + ' · queued',
      title: 'Not started. No bucket agent of this list goes by that name.' });
  }
  /* The owner's review. The agent named is the one whose work it is. */
  const prev = hs.slice(0, at).reverse().find(x => x.kind === 'plan' || x.kind === 'implement');
  const who = (prev && agentOf(prev.step.to)) || 'Its agent';
  const rec = prev && agentRunFor(prev.step);
  const when = rec ? runWhen(rec.at) : '';
  const decide = rec && rec.label === 'needs a decision';
  const waitFor = cur.kind === 'plan-review' ? 'waiting for you to review the plan' : 'waiting for you to review the work';
  return { sub: cur.step.stableId, agent: who, tone: 'you',
    text: who + ' · ' + (decide ? 'needs a decision from you' : waitFor) + (when ? ' · ' + when : ''),
    title: cur.kind === 'plan-review' ? 'The plan is written and waits for your review.'
      : 'The work is done and waits for your review.' };
}

/* =========================================================================
   A failed run, and the three ways out of it.

   A run that errors or gives up shows as "Personal family agent · failed · 02:05" on
   the card, and the companion puts up a banner for it (core/agent_runs.py
   fail(), failures only). Opening the task shows the same line with three
   buttons:

     Read the log   the run's own error output, in a sheet
     Retry          the same run again, when its bucket next starts work.
                    The runner folds the retry into the item's fingerprint, so a
                    run the shared runner had set aside after failing goes again.
     Take it back   the agent comes off every open step of the handover, and off
                    the task, so the task is the owner's again.
   ========================================================================= */

function runLineHTML(st){
  return '<div class="runline runline--' + esc(st.tone) + '"' + (st.title ? ' title="' + esc(st.title) + '"' : '') + '>' +
    esc(st.text) + '</div>';
}

function runBlockHTML(t, st){
  if (!st) return '';
  const ro = state.locked ? ' disabled' : '';
  const btns = !st.failed ? '' :
    '<div class="reviewbtns">' +
      '<button type="button" class="btn small" data-run="log">Read the log</button>' +
      '<button type="button" class="btn small" data-run="retry"' + ro + '>Retry</button>' +
      '<button type="button" class="btn small reject" data-run="takeback"' + ro + '>Take it back</button>' +
    '</div>' +
    '<span class="help">Retry asks its agent to try again. Take it back makes the task yours.</span>';
  return '<div class="field runblock"><span>Agent</span>' + runLineHTML(st) + btns + '</div>';
}

function wireRunBlock(box, t, st){
  if (!box || !st) return;
  box.querySelectorAll('[data-run]').forEach(b => {
    b.onclick = () => {
      if (b.dataset.run === 'log') openRunLog(st.sub, t.title);
      else if (b.dataset.run === 'retry') retryRun(st.sub, t);
      else if (b.dataset.run === 'takeback') takeBackTask(t);
    };
  });
}

/* The task drawer: the line at the top of its main column. */
function mountRunBlock(t){
  const old = document.querySelector('#dbody .runblock');
  if (old) old.remove();
  const st = agentRunStatus(t);
  const main = document.querySelector('#dbody .dcol-main');
  if (!st || !main) return;
  main.insertAdjacentHTML('afterbegin', runBlockHTML(t, st));
  wireRunBlock(main.querySelector('.runblock'), t, st);
}

function openRunLog(sub, title){
  const rec = agentRuns[sub] || {};
  const stale = runState(rec) === 'stale';
  const said = stale
    ? 'It started at ' + runWhen(rec.started || rec.at) + ' and never said it had finished. ' +
      'The agent\'s own log under data/runner/ has the rest.'
    : (rec.error || rec.why || 'The run left no output.');
  showModal('What the run said', esc((rec.agent || 'The agent') + ' on ' + (title || rec.title || 'this task') +
      (rec.at ? ', ' + runWhen(rec.at) : '')),
    '<pre class="runlog">' + esc(said) + '</pre>',
    [{ label: 'Close', primary: true }], { wide: true });
}

async function postAgentRuns(action, sub){
  const got = await postJSON('/agent-runs', { action, sub });
  if (got && got.subs && typeof got.subs === 'object') {
    agentRuns = got.subs;
    agentRunsSig = JSON.stringify(got.subs);
  }
  return got;
}

async function retryRun(sub, t){
  if (state.locked) return;
  try {
    await postAgentRuns('retry', sub);
  } catch (err) {
    showToast('Could not ask for a retry: ' + (err.message || err), 'bad');
    return;
  }
  const st = agentRunStatus(t);
  showToast('Its agent will try again.', 'good');
  refreshView();
  if (state.openTask) openDrawer(state.openTask);
}

/* The agent comes off every open step of the handover and off the task. The
   steps stay, now the owner's, so what was planned is still there to work from. */
function takeBackTask(t){
  if (state.locked) return;
  const subs = [];
  handoverSteps(t).forEach(({ step }) => {
    if (step.done || !agentOf(step.to)) return;
    const f = readSub(t, step.line);
    if (!f) return;
    f.to = OWNER_NAME;
    writeSub(t, step.line, f);
    subs.push(step.stableId);
  });
  if (agentOf(t.to)) { t.to = ''; t.dirty = true; }
  markDirty();
  refreshView();
  subs.filter(Boolean).forEach(sub => { postAgentRuns('clear', sub).catch(() => {}); });
  showToast('Taken back. The task is yours again.', 'good');
  if (state.openTask) openDrawer(state.openTask);
}

/* The sub-task's panel: the run block on the agent's own step, and the
   activity feed on every step of a handover. */
function mountSubRun(t, step){
  const box = document.querySelector('#sbody .dcol-main');
  if (!box) return;
  box.querySelectorAll('.runblock, .actfeed').forEach(el => el.remove());
  const title = box.querySelector('label.field');
  const put = html => { if (title) title.insertAdjacentHTML('afterend', html); else box.insertAdjacentHTML('afterbegin', html); };
  const kinds = handoverSteps(t);
  if (!kinds.some(x => x.step.stableId === step.stableId)) return;
  // At the foot of the panel, where a history reads top to bottom.
  box.insertAdjacentHTML('beforeend', activityFeedHTML(t));
  wireActivityFeed(box.querySelector('.actfeed'), t);
  const st = agentRunStatus(t);
  if (st && st.sub === step.stableId) {
    put(runBlockHTML(t, st));
    wireRunBlock(box.querySelector('.runblock'), t, st);
  }
}

/* =========================================================================
   The activity feed: the brief, the plan, the output, and a reply.

   On the panel of each sub-task a handover lays out. Read top to bottom it is
   the task's agent history: what the owner asked for, what its agent planned and
   when, each time the owner sent it back, what the work produced, and whether
   the owner approved each. What the work produced is drawn by kind
   (core/agent_runs.py, `output`):

     files     links that open the task's project folder in the drawer
     drafts    a `.draft.md` message shown in full, with Copy
     branch    its name, how many commits and the summary; merged through
               the agents-review skill, never from here
     figma     a link that opens the file in the desktop app

   The reply goes to whichever agent last touched the task, as a `feedback:`
   note on its step, the note the agents already read when they take a step
   up again. Where that step is ticked it is a send-back (sendBack(),
   04-tier-two-the-one-thing.js), so the agent's step opens again.
   ========================================================================= */

let actReplyMountEl = null;

/* A figma.com link as the desktop app's own, so it opens there rather than in
   a browser tab. A branch is a file of its own, so its key is the one to open. */
function figmaAppHref(url){
  const m = /^https:\/\/(?:www\.)?figma\.com\/(?:file|design|proto|board)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?(?:\/([^?#]*))?(\?[^#]*)?/.exec(String(url || ''));
  if (!m) return '';
  return 'figma://file/' + (m[2] || m[1]) + (m[3] ? '/' + m[3] : '') + (m[4] || '');
}

function feedbackNotes(t, step){
  return stepNoteText(t, step.line).split('\n')
    .map(l => (/^\s*-\s*feedback:\s*(.*)$/i.exec(l) || [])[1])
    .filter(Boolean);
}

/* The plan a record or the review's `Plan:` note names, relative to plans/. */
function planRelFor(t, planStep, reviewStep){
  const rec = planStep && agentRunFor(planStep);
  if (rec && /^[\w.-]+\.md$/.test(rec.plan || '')) return rec.plan;
  if (!reviewStep) return '';
  return (stepNoteText(t, reviewStep.line).match(/^-\s*Plan:\s*`?plans\/([^\s`]+\.md)/mi) || [])[1] || '';
}

/* The agent step the last thing happened on: the reply goes there. */
function lastAgentStep(t){
  const agents = handoverSteps(t).filter(x => x.kind === 'plan' || x.kind === 'implement');
  const touched = agents.slice().reverse().find(x => x.step.done || agentRunFor(x.step));
  const hit = touched || agents[0];
  return hit && agentOf(hit.step.to) ? hit : null;
}

function actItem(head, body, cls){
  return '<li class="act' + (cls ? ' ' + cls : '') + '"><div class="acthead">' + head + '</div>' +
    (body ? '<div class="actbody">' + body + '</div>' : '') + '</li>';
}

function outputHTML(out, t){
  if (!out) return '';
  const bits = [];
  const drafts = out.drafts || [];
  const draftNames = drafts.map(d => d.name);
  const files = (out.files || []).filter(f => draftNames.indexOf(f) < 0);
  const proj = out.project || taskProject(t) || '';
  if (files.length) {
    bits.push('<div class="actfiles">' + files.map(f =>
      '<button type="button" class="actfile" data-project="' + esc(proj) + '" title="Open ' + esc(proj || 'the project') + ' in the drawer">' +
        esc(f) + '</button>').join('') + '</div>');
  }
  drafts.forEach((d, i) => {
    bits.push('<div class="actdraft"><div class="actdraft-head"><span>' + esc(d.name) + '</span>' +
      '<button type="button" class="btn small" data-copy="' + i + '">Copy</button></div>' +
      '<pre>' + esc(d.text || '') + '</pre></div>');
  });
  const b = out.branch;
  if (b && b.name) {
    const n = Number(b.commits) || 0;
    bits.push('<div class="actbranch"><code>' + esc(b.name) + '</code>' +
      (n ? ' · ' + n + ' commit' + (n === 1 ? '' : 's') : '') +
      (b.repo ? ' · ' + esc(String(b.repo).split('/').pop()) : '') + '</div>' +
      (b.summary ? '<div>' + mdInline(b.summary) + '</div>' : '') +
      '<span class="help">A proposal on a branch. Merge it through the agents-review skill.</span>');
  }
  const app = figmaAppHref(out.figma);
  if (out.figma) {
    bits.push('<a class="actfigma" href="' + esc(app || out.figma) + '"' + (app ? '' : ' target="_blank" rel="noopener"') + '>' +
      'Open in Figma</a>');
  }
  return bits.join('');
}

function activityFeedHTML(t){
  const hs = handoverSteps(t);
  const by = k => (hs.find(x => x.kind === k) || {}).step;
  const plan = by('plan'), planRev = by('plan-review'), imp = by('implement'), workRev = by('work-review');
  const items = [];

  const notes = splitBody(t).notes;
  const brief = (Array.isArray(notes) ? notes.map(l => String(l).replace(/^\s{0,4}/, '')).join('\n') : String(notes || ''))
    .split('\n').filter(l => !/^-\s*(Plan|Project):/i.test(l.trim())).join('\n').trim();
  items.push(actItem('Brief', brief ? mdInline(brief.length > 600 ? brief.slice(0, 599) + '…' : brief).replace(/\n/g, '<br>')
    : '<span class="help">Nothing written on the task beyond its title.</span>'));

  const agentEntry = (step, verb) => {
    if (!step) return;
    const who = agentOf(step.to) || 'Its agent';
    const rec = agentRunFor(step);
    const st = runState(rec);
    const when = rec && rec.at ? ' · ' + esc(runWhen(rec.at)) : '';
    if (st === 'running') items.push(actItem(esc(who) + ' · working' + when, ''));
    else if (st === 'failed' || st === 'stale')
      items.push(actItem(esc(who) + ' · failed' + when, rec.why ? mdInline(rec.why) : '', 'act--failed'));
    else if (st === 'queued') items.push(actItem(esc(who) + ' · will try again' + when, ''));
    else if (rec || step.done) {
      let body = rec && rec.summary ? mdInline(rec.summary) : '';
      if (step === plan) {
        const rel = planRelFor(t, plan, planRev);
        if (rel) body += '<div class="reviewbtns"><button type="button" class="btn small" data-readplan="' + esc(rel) + '">Read the plan</button></div>';
      } else {
        body += outputHTML(rec && rec.output, t);
      }
      items.push(actItem(esc(who) + ' · ' + verb + when, body));
    }
    feedbackNotes(t, step).forEach(f => items.push(actItem('You sent it back', mdInline(f), 'act--you')));
  };
  const reviewEntry = (step, what) => {
    if (step && step.done) items.push(actItem('You approved the ' + what + (step.doneOn ? ' · ' + esc(step.doneOn) : ''), '', 'act--you'));
  };
  agentEntry(plan, 'wrote the plan');
  reviewEntry(planRev, 'plan');
  agentEntry(imp, 'finished the work');
  reviewEntry(workRev, 'work');

  const last = lastAgentStep(t);
  const ro = state.locked;
  const reply = !last ? '' :
    '<div class="actreply"><div id="act-reply-mount"></div>' +
      '<button type="button" class="btn small" id="act-send"' + (ro ? ' disabled' : '') + '>Send to ' +
        esc(agentOf(last.step.to)) + '</button></div>';
  return '<div class="field actfeed"><span>Activity</span><ol class="actlist">' + items.join('') + '</ol>' + reply + '</div>';
}

function wireActivityFeed(box, t){
  if (!box) return;
  box.querySelectorAll('[data-readplan]').forEach(b => { b.onclick = () => openPlanReader(b.dataset.readplan, t.title); });
  box.querySelectorAll('.actfile').forEach(b => {
    b.onclick = () => { if (b.dataset.project) openProjectDrawer(b.dataset.project); };
  });
  box.querySelectorAll('[data-copy]').forEach(b => {
    b.onclick = async () => {
      const pre = b.closest('.actdraft').querySelector('pre');
      try { await navigator.clipboard.writeText(pre.textContent); showToast('Copied.', 'good'); }
      catch (err) { showToast('Could not copy: ' + (err.message || err), 'bad'); }
    };
  });
  if (actReplyMountEl) BoardUI.unmount(actReplyMountEl);
  actReplyMountEl = box.querySelector('#act-reply-mount');
  const last = lastAgentStep(t);
  if (actReplyMountEl && last) {
    BoardUI.mountFlushed(actReplyMountEl, BoardUI.h(BoardUI.Textarea, {
      id: 'act-reply', disabled: state.locked,
      placeholder: 'A reply to the ' + agentOf(last.step.to) + '. It reads this when it takes the task up again.',
    }));
  }
  const send = box.querySelector('#act-send');
  if (send) send.onclick = () => {
    const ta = box.querySelector('#act-reply');
    if (replyToAgent(t, ta ? ta.value : '')) openDrawer(state.openTask);
  };
}

/* The reply, as a `feedback:` note on the agent's step. A step already ticked
   is sent back through the review behind it, so it opens again. */
function replyToAgent(t, text){
  const said = String(text || '').trim();
  const last = lastAgentStep(t);
  if (state.locked || !said || !last) return false;
  const step = subSteps(t).find(s => s.stableId === last.step.stableId);
  if (!step) return false;
  if (step.done) {
    const review = subSteps(t).find(s => (s.blockedBy || []).indexOf(step.slug) > -1);
    if (!review || !sendBack(t, review.line, said)) return false;
  } else {
    const now = stepNoteText(t, step.line);
    setStepNoteText(t, step.line, (now ? now + '\n' : '') + '- feedback: ' + said.replace(/\n+/g, ' '));
    markDirty();
  }
  refreshView();
  showToast('Sent to the ' + agentOf(step.to) + '.', 'good');
  return true;
}
