'use strict';

/* =========================================================================
   The focus prompt

   A hold puts one thing in focus (hold.ts: a board or timeline card, a drawer
   sub-task or a drawer section), and while it lasts a prompt floats at the
   bottom centre of the page to ask the PA about it. FocusPrompt.tsx draws it;
   this is everything around it: when it shows, what its chip says, the message
   that goes out, the run, and what the reply changes. It took the place of the
   PA bar docked in the bottom-right corner on 13 Oct 2026.

   The PA is the same one the bar talked to. A message goes under PA_KEY,
   wrapped by paPreface() the first time, with paBeforeSend() saving anything
   unsaved first and paAfterReply() reading todo.md back and applying the
   reply's pa-changes block (10-reference-sections.js). What is new is that it
   runs with no window: claudeRunLines() reads the run's stream here, so the
   doing: line can show while the reply is still coming.

   One conversation per focus. Nothing is filed until a message goes, so a hold
   ended with Esc leaves no session behind; a second message in the same focus
   carries the same session on. A run outlives its focus: if the focus ends
   while the PA is working, the prompt stays to show Working and then Done, and
   the changes still land. A new focus takes the prompt over, and a run still
   going for the old one finishes unseen.
   ========================================================================= */

const FOCUS_DONE_MS = 4000;    // how long Done, or an error, stays before fading
const FOCUS_FADE_MS = 300;

let fpNode = null;
let fpSeq = 0;
/* The conversation on screen, or null. */
let fp = null;

function fpFadeMs(){
  const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  return still ? 0 : FOCUS_FADE_MS;
}

/* A task by something that survives todo.md being read back: ids are a
   counter, rebuilt on every parse. */
function fpTaskKey(t){ return t.stableId || t.title; }
function fpFindTask(key){
  if (!state.doc) return null;
  for (const b of state.doc.buckets) for (const ti of b.tiers) for (const t of ti.tasks) if (fpTaskKey(t) === key) return t;
  return null;
}
function fpStepKey(s){ return s.stableId || s.clean; }

function fpClock(){
  return new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/* What the board knows about a focus that has just started, or null for one
   the prompt has nothing to say about. */
function fpStart(d){
  const loc = d && d.taskId && state.doc && locate(d.taskId);
  if (!loc) return null;
  const t = loc.task;
  const c = {
    id: ++fpSeq, kind: d.kind, el: d.el, key: fpTaskKey(t), section: d.section || '',
    stepKey: '', focusOn: true, session: '', title: '',
    phase: 'idle', line: '', time: '', fading: false, leaving: false, timer: 0,
  };
  if (d.kind === 'subtask') {
    const line = Number(d.el && d.el.dataset ? d.el.dataset.line : NaN);
    const steps = subSteps(t);
    const st = steps.find(s => s.line === line) || steps[d.subIndex];
    if (!st) return null;
    c.stepKey = fpStepKey(st);
    c.chip = { label: 'Subtask', title: st.clean };
    c.placeholder = 'Start the draft';
  } else if (d.kind === 'section') {
    c.chip = { label: c.section || 'Section', title: t.title };
    c.placeholder = 'Add context';
  } else {
    c.chip = { label: 'Task', title: t.title };
    c.placeholder = 'Move to Doing';
  }
  return c;
}

/* The held card's id and title, for the server's second check: a change to
   the card the person is holding counts as one they named. */
function fpFocusRefs(c){
  const t = fpFindTask(c.key);
  return t ? [t.stableId, t.title].filter(Boolean) : [];
}

/* The line ahead of the owner's words that says what is held, readable and
   easy to pick apart: what it is, then what it holds now. */
function fpReference(c){
  const t = fpFindTask(c.key);
  if (!t) return '(Focused element: ' + c.chip.label.toLowerCase() + ' "' + c.chip.title + '".)';
  const task = 'task ' + (t.stableId ? t.stableId + ' ' : '') + JSON.stringify(t.title);
  let what, content;
  if (c.kind === 'subtask') {
    const steps = subSteps(t);
    const i = steps.findIndex(s => fpStepKey(s) === c.stepKey);
    const st = steps[i];
    what = 'subtask ' + (i + 1) + ' of ' + task + ': ' + JSON.stringify(st ? st.clean : c.chip.title);
    content = st ? t.body[st.line].trim() : c.chip.title;
  } else if (c.kind === 'section') {
    what = 'the ' + JSON.stringify(c.section) + ' section of ' + task;
    content = c.el && c.el.isConnected ? c.el.innerText : '';
  } else {
    what = task;
    content = serializeTask(t).join('\n');
  }
  content = String(content || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (content.length > 1500) content = content.slice(0, 1500).trimEnd() + '…';
  return '(Focused element: ' + what + '. Its current content: ' + (content || '(empty)') + '.)';
}

function fpRender(){
  if (typeof BoardUI === 'undefined') return;
  if (!fpNode) {
    // Its own node, never #lists, and kept: a sibling of everything the
    // spotlight dims, so it carries data-focus-keep itself.
    fpNode = document.createElement('div');
    fpNode.id = 'focusPrompt';
    fpNode.setAttribute('data-focus-keep', '');
    document.body.appendChild(fpNode);
  }
  const c = fp;
  document.body.classList.toggle('focus-prompting', !!c);
  if (!c) { BoardUI.mount(fpNode, null); return; }
  BoardUI.mount(fpNode, BoardUI.h(BoardUI.FocusPrompt, {
    focusId: c.id, chip: c.chip, placeholder: c.placeholder,
    phase: c.phase, line: c.line, time: c.time, fading: c.fading, leaving: c.leaving,
    onSend: fpSend,
  }));
}

function fpHide(c){
  if (fp !== c || c.leaving) return;
  c.leaving = true;
  fpRender();
  setTimeout(() => { if (fp === c) { fp = null; fpRender(); } }, fpFadeMs());
}

function fpSend(text){
  const c = fp;
  const words = String(text || '').trim();
  if (!c || c.phase !== 'idle' || !words || !claudeOn()) return;
  const ask = fpReference(c) + '\n\n' + words;
  const prompt = c.session ? ask + '\n\n' + PA_STATUS_AGAIN : paPreface(ask);
  if (!c.title) c.title = words.replace(/\s+/g, ' ').slice(0, 60) + (words.length > 60 ? '…' : '');
  clearTimeout(c.timer);
  Object.assign(c, { phase: 'working', line: 'Working on it…', time: fpClock(), fading: false });
  fpRender();
  paBeforeSend();
  fpRun(c, prompt, ask, words);
}

async function fpRun(c, prompt, ask, words){
  let reply = '', err = '';
  const seen = new Set();
  try {
    for await (const line of claudeRunLines({ prompt, mode: 'ask', session: c.session, owner: PA_KEY, title: c.title, words: words || '', focus: fpFocusRefs(c) })) {
      let d;
      try { d = JSON.parse(line); } catch (e) { continue; }
      if (d.type === 'board_error') err = d.text || 'the run failed';
      else if (d.type === 'system' && d.subtype === 'init' && d.session_id) c.session = d.session_id;
      else if (d.type === 'assistant' && d.message) {
        // The engine's own rule: blocks of one message share an id, and an id
        // can come round again, so both together say a block is new.
        for (const b of d.message.content || []) {
          if (!b || b.type !== 'text' || !b.text) continue;
          const k = (d.message.id || '') + '|' + b.text;
          if (seen.has(k)) continue;
          seen.add(k);
          reply += (reply ? '\n\n' : '') + b.text;
        }
        const doing = paStatusLines(reply).doing;
        if (doing && c.phase === 'working') {
          c.line = /[.…!?]$/.test(doing) ? doing : doing + '…';
          if (fp === c) fpRender();
        }
      } else if (d.type === 'result') {
        if (typeof d.result === 'string' && d.result.trim()) reply = d.result;
        if (d.session_id) c.session = d.session_id;
        if (d.is_error && !err) err = 'ended in an error (' + (d.subtype || 'unknown') + ')';
      }
    }
  } catch (e) {
    err = (e && e.message) || String(e);
  }
  if (err) { playChime('error'); fpSettleLater(c, 'error', err, []); return; }

  const before = fpSnapshot();
  try { await paAfterReply(null, { ask, session: c.session }, reply); } catch (e) { /* the status line has it */ }
  /* A redraw that took the held element away (the drawer is rebuilt whole)
     ends the focus: there is nothing left on the page for it to be on. */
  const held = typeof BoardUI !== 'undefined' && BoardUI.focusedElement();
  if (held && !held.isConnected) BoardUI.endFocus();
  playChime('done');
  fpSettleLater(c, 'done', paStatusLines(reply).done || 'Done', fpChanges(before));
}

/* Done or an error: shown for FOCUS_DONE_MS, with whatever changed outlined,
   then the card and the outlines fade, and the prompt is back to Idle for
   another message, or gone with the focus. */
function fpSettleLater(c, phase, line, changes){
  Object.assign(c, { phase, line, fading: false });
  if (fp === c) fpRender();
  fpMark(c, changes);
  clearTimeout(c.timer);
  c.timer = setTimeout(() => {
    c.fading = true;
    if (fp === c) fpRender();
    document.querySelectorAll('[data-pa-changed="' + c.id + '"]').forEach(el => el.setAttribute('data-pa-fading', ''));
    c.timer = setTimeout(() => {
      document.querySelectorAll('[data-pa-changed="' + c.id + '"]').forEach(el => { el.removeAttribute('data-pa-changed'); el.removeAttribute('data-pa-fading'); });
      c.fading = false;
      if (fp !== c) return;
      if (c.focusOn) { Object.assign(c, { phase: 'idle', line: '' }); fpRender(); }
      else fpHide(c);
    }, fpFadeMs());
  }, FOCUS_DONE_MS);
}

/* ---- What the reply changed ----
   Every task before and after, by its durable key: where it sits, its own
   fields, its notes and each sub-task's line. */
function fpEntry(t, b, ti){
  const steps = new Map();
  subSteps(t).forEach(s => steps.set(fpStepKey(s), t.body[s.line]));
  return {
    where: b.name + '\n' + ti.name,
    title: t.title,
    head: [t.done, t.impact, t.effort, t.due, t.start, t.to, t.theme, t.urgent, t.week].join('|'),
    notes: bodyParts(t).notes.join('\n'),
    steps,
  };
}

function fpSnapshot(){
  const m = new Map();
  if (!state.doc) return m;
  for (const b of state.doc.buckets) for (const ti of b.tiers) for (const t of ti.tasks) m.set(fpTaskKey(t), fpEntry(t, b, ti));
  return m;
}

function fpChanges(before){
  const out = [];
  if (!state.doc) return out;
  for (const b of state.doc.buckets) for (const ti of b.tiers) for (const t of ti.tasks) {
    const was = before.get(fpTaskKey(t)), now = fpEntry(t, b, ti);
    if (!was) { out.push({ t, fresh: true, title: false, head: false, notes: false, steps: [...now.steps.keys()] }); continue; }
    const steps = [...now.steps.keys()].filter(k => was.steps.get(k) !== now.steps.get(k));
    const gone = [...was.steps.keys()].some(k => !now.steps.has(k));
    const ch = { t, fresh: false, title: was.title !== now.title, head: was.head !== now.head || was.where !== now.where, notes: was.notes !== now.notes, steps };
    if (ch.title || ch.head || ch.notes || steps.length || gone) out.push(ch);
  }
  return out;
}

/* A green outline on what changed, found again in the page as it is now: the
   card wherever it is drawn, and in the drawer, if it is open on the task,
   the new or changed sub-task rows, and the section the change sits in. */
function fpMark(c, changes){
  const mark = el => { if (el) el.setAttribute('data-pa-changed', String(c.id)); };
  const drawer = $('#drawer').classList.contains('open') && state.openTask ? locate(state.openTask) : null;
  for (const ch of changes) {
    document.querySelectorAll('.tenon-card[data-id="' + CSS.escape(String(ch.t.id)) + '"]').forEach(mark);
    if (!drawer || drawer.task !== ch.t) continue;
    const body = $('#dbody');
    const steps = subSteps(ch.t);
    ch.steps.forEach(k => {
      const st = steps.find(s => fpStepKey(s) === k);
      if (st) mark(body.querySelector('.sub[data-line="' + st.line + '"]'));
    });
    if (ch.title) mark(body.querySelector('#f-title') && body.querySelector('#f-title').closest('.field'));
    if (ch.notes) mark(body.querySelector('details[data-collapse="notes"]'));
    if (ch.head) mark(body.querySelector('.dcol > details[data-collapse="details"]'));
    if (c.kind === 'section' && fpTaskKey(ch.t) === c.key) mark(drawerSections().find(el => drawerSectionLabel(el) === c.section));
  }
}

/* ---- The focus, as hold.ts reports it ---- */
window.addEventListener('board:focus', e => {
  if (!state.doc || !claudeOn() || typeof BoardUI === 'undefined') return;
  const c = fpStart(e.detail);
  if (!c) return;
  fp = c;
  fpRender();
});

window.addEventListener('board:unfocus', e => {
  const c = fp;
  if (!c || !e.detail || e.detail.el !== c.el) return;
  c.focusOn = false;
  // Nothing sent, or back at Idle after a Done: nothing left to show.
  if (c.phase === 'idle') fpHide(c);
});
