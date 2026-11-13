#!/usr/bin/env node
/* Timeline — the one section `renderSections('timeline')` draws: the lanes,
 * including an empty row for each undated task.
 *
 *   python3 kanban/server.py &          # or BOARD_PORT=... at one already up
 *   node kanban/test_timeline.mjs
 *
 * Written 14 Sep 2026, alongside the port of the view's shell to
 * kanban/ui/SectionsView.tsx, and grown on 25 Sep 2026 when the body went the
 * same way: the lanes, bars, scale and legend are TimelineBody
 * (kanban/ui/TimelineBody.tsx), drawn from the data timelineSection() returns,
 * with every drag handed to it as a prop.
 *
 * The drag checks drive every drag the view has, end to end: a row reorder, a
 * click and a drag on a bar, a handle resize, and a click on an empty track. They went in against the string-built lanes
 * first, and the React port passed them unchanged.
 */
import { spawn } from 'node:child_process'
import { CHROME_BIN } from './test_browser.mjs'

const PORT = Number(process.env.CDP_PORT) || 9459
const BOARD = process.env.BOARD_PORT || 8765
if (!process.env.BOARD_PORT) console.error('Note: this runs against the live board on 8765. For a throwaway copy: scripts/test-board.sh test_timeline.mjs')
const checks = []
const check = (name, pass, detail = '') => {
  checks.push(pass)
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const chrome = spawn(CHROME_BIN, [
  '--headless=new', '--mute-audio', `--remote-debugging-port=${PORT}`, '--no-first-run',
  `--user-data-dir=${process.env.CHROME_PROFILE || '/tmp/todo-timeline-test-profile'}`, '--window-size=1400,1000',
  `http://127.0.0.1:${BOARD}/kanban/index.html`
], { stdio: ['ignore', 'pipe', 'pipe'] })

async function page () {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const t = (await r.json()).find(t => t.type === 'page' && t.url.includes('index.html'))
      if (t?.webSocketDebuggerUrl) return t.webSocketDebuggerUrl
    } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error('no page')
}

const ws = new WebSocket(await page())
await new Promise(r => (ws.onopen = r))
let id = 0
const pending = new Map()
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
const send = (method, params) => new Promise(res => {
  const n = ++id
  pending.set(n, res)
  ws.send(JSON.stringify({ id: n, method, params }))
})
async function evalJS (expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500))
  return r.result?.result?.value
}

try {
// Poll for the page rather than sleeping: a fixed wait fails when the machine is busy.
for (let i = 0; i < 120 && !(await evalJS(`document.readyState === 'complete' && typeof state !== 'undefined' && !!state.doc`).catch(() => false)); i++) await new Promise(r => setTimeout(r, 250))
await new Promise(r => setTimeout(r, 400))
check('the board loaded', await evalJS(`typeof timelineSection === 'function'`))

// Not locked — a locked tab gets no drag handlers at all, which is exactly what this suite needs to see happen. The fetch
// guard below is what keeps that safe, the same exception test_notes.mjs
// makes for the one thing it actually has to unlock the tab to test.
await evalJS(`(() => {
  const real = window.fetch;
  window.__blocked = [];
  // Held off, since the fetch stub below would only log the save and the
  // drags run past autosave's four seconds.
  lastSaveAt = Date.now() + 10 * 60 * 1000;
  window.fetch = (u, o) => {
    const m = (o && o.method) || 'GET';
    if (m !== 'GET') { if (m !== 'HEAD') window.__blocked.push(m + ' ' + u); return Promise.resolve(new Response('{}', { status: 200 })) }
    return real(u, o);
  };

  load([
    '# To-do', '', '## 1. Tasks', '',
    '### To do', '',
    '- [ ] Dated one \`id:tl0001\` [bucket:: People] [impact:: high] [effort:: S] \`start:2026-09-10\` \`due:2026-09-12\`',
    '- [ ] Dated two \`id:tl0003\` [bucket:: People] [impact:: low] [effort:: S] \`start:2026-09-15\` \`due:2026-09-17\`',
    // Both kept last so the reorder drag below, worked out against the
    // lane's first two rows, still lands on the two dated ones untouched by
    // either one's arrival. Two undated ones, the second gets clicked on its own row's track.
    '- [ ] Undated one \`id:tl0002\` [bucket:: People] [impact:: med] [effort:: S]',
    '- [ ] Undated two \`id:tl0004\` [bucket:: People] [impact:: med] [effort:: S]',
    ''
  ].join('\\n'), 'demo.md', {});
})()`)

/* No setTimeout before this read — mountFlushed() is what makes that safe. */
await evalJS(`state.view = 'timeline'; renderView()`)

/* ---- the shell ---- */

check('the Timeline column is drawn', await evalJS(`
  document.querySelector('.lists.tview .tenon-column h3')?.textContent
`) === 'Timeline')
check('a hint with two tags renders both as code', await evalJS(`
  [...document.querySelectorAll('.lists.tview .tenon-column__desc code')].map(c => c.textContent).join('|')
`) === 'start:|due:|due:|start:', await evalJS(`document.querySelector('.lists.tview .tenon-column__desc')?.innerHTML`))

check('the dated task draws a lane', await evalJS(`!!document.querySelector('.tlscroll .tlbody')`))
/* The legend sits under the scale — four swatches, and the
   bucket one striped from the colours actually on screen rather than picking
   a lane's. */
check('the legend is drawn below the scale', await evalJS(`(() => {
  const leg = document.querySelector('.tllegend');
  if (!leg) return false;
  const scroll = document.querySelector('.tlscroll');
  const after = scroll.compareDocumentPosition(leg) & Node.DOCUMENT_POSITION_FOLLOWING;
  return !!after && leg.querySelectorAll('.tlswatch').length === 4;
})()`))
check('and its bucket swatch is striped from the lane colours', await evalJS(`
  document.querySelector('.tllegend .tlswatch').style.background.includes('linear-gradient')
`))

/* ---- the drag handlers are on the painted nodes ----
   Read off React's own props on the element, since a handler passed as a prop
   is never an on* property of the node. */

await evalJS(`window.__handler = (el, name) => {
  const k = el && Object.keys(el).find(k => k.startsWith('__reactProps'));
  return !!k && typeof el[k][name] === 'function';
}`)
/* ---- switching away and back re-wires cleanly, not twice ---- */

await evalJS(`state.view = 'board'; renderView(); state.view = 'timeline'; renderView()`)
check('a second visit still finds a lane', await evalJS(`!!document.querySelector('.tlscroll .tlbody')`))
check('and no tray', await evalJS(`!document.querySelector('.tltray, .tltraycard')`))

/* ---- the drags themselves ----
   Added 25 Sep 2026, before the lanes and bars moved from one HTML
   string to React components, so that port had something to hold it to.
   The checks drive each drag the way a person would and read the result off
   the document, never off how a handler happens to be attached: a bar drag is
   real mouse input through CDP (setPointerCapture wants a live pointer), and
   the two HTML5 drags are dispatched DragEvents sharing one DataTransfer, the
   same way test_timeline_reorder.mjs drives them. */

/* The board renumbers ids on load, so a row is found by its title. */
const ID = await evalJS(`(() => {
  const items = allItems().filter(i => !i.sub);
  return Object.fromEntries([['one','Dated one'],['un','Undated one'],['two','Dated two'],['un2','Undated two']]
    .map(([k, t]) => [k, items.find(i => i.title === t).id]));
})()`)
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
})
const taskDates = id => evalJS(`(() => { const t = locate('${id}').task; return { start: t.start || null, due: t.due || null, tlrank: t.tlrank ?? null } })()`)
const rowOrder = () => evalJS(`[...document.querySelector('.tllanegroup').querySelectorAll(':scope > .tlrow[data-tlreorder]')].map(e => e.dataset.tlreorder).join(',')`)
/* Where a day sits on screen, for one row's track: its left edge plus a
   quarter of a day in, clear of the half-day rounding in the drag's own sums. */
const dayX = (id, day) => evalJS(`(() => {
  const track = document.querySelector('.tlrow[data-tlreorder="${id}"] .tltrack');
  track.scrollIntoView({ block: 'center', inline: 'nearest' });
  document.querySelector('.tlscroll').scrollLeft = 0;
  const r = track.getBoundingClientRect();
  return { x: r.left + (${day} + 0.25) * TL_DAY_PX, y: r.top + r.height / 2 };
})()`)
const offsetOf = date => evalJS(`tlOffset(timelineScale(timelineTasks().dated), '${date}')`)
const dateAt = n => evalJS(`ymd(addDays(timelineScale(timelineTasks().dated).min, ${n}))`)

await evalJS(`(() => {
  window.__dt = new DataTransfer();
  window.__fire = (type, el, x, y) => el.dispatchEvent(new DragEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: window.__dt
  }));
})()`)

/* Row reorder: Dated one's label onto Dated two's lower half. Both undated
   ones also have rows now, third and fourth in the lane (see the fixture),
   untouched by a drag between the first two. */
check('four rows, board order to start',
  await rowOrder() === ID.one + ',' + ID.two + ',' + ID.un + ',' + ID.un2, await rowOrder())
await evalJS(`(async () => {
  const rows = [...document.querySelector('.tllanegroup').querySelectorAll(':scope > .tlrow[data-tlreorder]')];
  const grip = rows[0].querySelector('.tllabel');
  const g = grip.getBoundingClientRect(), r = rows[1].getBoundingClientRect();
  __fire('dragstart', grip, g.left + 10, g.top + 5);
  await new Promise(res => setTimeout(res, 20));
  __fire('dragover', rows[1], r.left + 20, r.bottom - 2);
  __fire('drop', rows[1], r.left + 20, r.bottom - 2);
  __fire('dragend', grip, r.left + 20, r.bottom - 2);
})()`)
check('dragging a row label below the next row reorders the lane',
  await rowOrder() === ID.two + ',' + ID.one + ',' + ID.un + ',' + ID.un2, await rowOrder())
{
  const one = await taskDates(ID.one), two = await taskDates(ID.two)
  check('and writes tlrank 0.. in the new order, leaving both dates alone',
    two.tlrank === 0 && one.tlrank === 1 && one.start === '2026-09-10' && one.due === '2026-09-12' &&
    two.start === '2026-09-15' && two.due === '2026-09-17', JSON.stringify({ one, two }))
}

/* A press on a bar that never moves is a click: it opens the drawer and
   writes nothing. */
{
  const s = await offsetOf('2026-09-10')
  const p = await dayX(ID.one, s + 1)
  await mouse('mousePressed', p.x, p.y)
  await mouse('mouseReleased', p.x, p.y)
  await new Promise(r => setTimeout(r, 50))
  const d = await taskDates(ID.one)
  check('a press on a bar without moving opens its drawer and moves nothing',
    await evalJS(`state.openTask`) === ID.one && d.start === '2026-09-10' && d.due === '2026-09-12',
    JSON.stringify({ open: await evalJS(`state.openTask`), d }))
  await evalJS(`closeDrawer()`)
}

/* A bar dragged three days right moves start and due together. */
{
  const s = await offsetOf('2026-09-10')
  const p = await dayX(ID.one, s + 1)
  check('the press lands on the bar itself', await evalJS(`document.elementFromPoint(${p.x}, ${p.y})?.dataset.tldrag`) === 'move')
  await mouse('mousePressed', p.x, p.y)
  await mouse('mouseMoved', p.x + 10, p.y)
  await mouse('mouseMoved', p.x + 3 * 28, p.y)
  check('the date popover follows a bar drag', await evalJS(`!!document.querySelector('.tlpopover.on')`))
  await mouse('mouseReleased', p.x + 3 * 28, p.y)
  await new Promise(r => setTimeout(r, 50))
  const d = await taskDates(ID.one)
  check('dragging a bar three days right moves both its dates three days',
    d.start === '2026-09-13' && d.due === '2026-09-15', JSON.stringify(d))
  check('and the bar is redrawn at its new place', await evalJS(`(() => {
    const bar = document.querySelector('.tlbar[data-tlrow="${ID.one}"]');
    return bar && parseInt(bar.style.left) === tlOffset(timelineScale(timelineTasks().dated), '2026-09-13') * TL_DAY_PX;
  })()`))
  check('and the release after a real drag does not open the drawer', await evalJS(`state.openTask`) == null, String(await evalJS(`state.openTask`)))
  check('and the popover is gone', await evalJS(`!document.querySelector('.tlpopover.on')`))
}

/* The right-hand handle moves only the due date. It sits inside the bar,
   whose own handler must not take the drag over. */
{
  const due = await offsetOf('2026-09-15')
  const h = await evalJS(`(() => {
    const el = document.querySelector('.tlbar[data-tlrow="${ID.one}"] .tlhandle-r');
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    document.querySelector('.tlscroll').scrollLeft = 0;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)
  // A handle takes the day under the pointer, not a delta from where it was
  // picked up, so the release point is day (due + 2) itself.
  const to = await dayX(ID.one, due + 2)
  check('the press lands on the right handle', await evalJS(`document.elementFromPoint(${h.x}, ${h.y})?.classList.contains('tlhandle-r')`) === true)
  await mouse('mousePressed', h.x, h.y)
  await mouse('mouseMoved', h.x + 10, h.y)
  await mouse('mouseMoved', to.x, h.y)
  await mouse('mouseReleased', to.x, h.y)
  await new Promise(r => setTimeout(r, 50))
  const d = await taskDates(ID.one)
  check('dragging the right handle two days moves the due date alone',
    d.start === '2026-09-13' && d.due === '2026-09-17', JSON.stringify(d))
}

/* A click on a row's empty track, clear of its bar, sets the due date to the
   day clicked. */
{
  const p = await dayX(ID.two, await offsetOf('2026-09-22'))
  check('the click lands on the empty track', await evalJS(`document.elementFromPoint(${p.x}, ${p.y})?.classList.contains('tltrack')`) === true)
  await mouse('mousePressed', p.x, p.y)
  await mouse('mouseReleased', p.x, p.y)
  await new Promise(r => setTimeout(r, 50))
  const d = await taskDates(ID.two)
  check('clicking the empty track sets the due date to that day', d.start === '2026-09-15' && d.due === '2026-09-22', JSON.stringify(d))
  await evalJS(`closeDrawer()`)
}

/* An undated task gets a row of its own now too (the point of this change) —
   empty track, no bar or diamond — and clicking that track sets its due date
   exactly the way a dated row’s already did just above. */
{
  check('an undated task still gets a lane row, with an empty track', await evalJS(`(() => {
    const track = document.querySelector('.tlrow[data-tlreorder="${ID.un2}"] .tltrack');
    return !!track && !track.querySelector('.tlbar') && !track.querySelector('.tlmilestone');
  })()`))
  const target = await dateAt(12)
  const p = await dayX(ID.un2, 12)
  check('the click lands on its own empty track', await evalJS(`document.elementFromPoint(${p.x}, ${p.y})?.classList.contains('tltrack')`) === true)
  await mouse('mousePressed', p.x, p.y)
  await mouse('mouseReleased', p.x, p.y)
  await new Promise(r => setTimeout(r, 50))
  const d = await taskDates(ID.un2)
  check('clicking an undated row’s track sets its due date, same as a dated row’s',
    d.due === target && d.start === null, JSON.stringify({ d, target }))
  await evalJS(`closeDrawer()`)
}

/* The other undated task is dated from its empty row on day 10, which the
   diamond checks below rely on. */
{
  const target = await dateAt(10)
  const p = await dayX(ID.un, 10)
  await mouse('mousePressed', p.x, p.y)
  await mouse('mouseReleased', p.x, p.y)
  await new Promise(r => setTimeout(r, 50))
  const d = await taskDates(ID.un)
  check('clicking the first undated row on day 10 gives it that due date',
    d.due === target && d.start === null, JSON.stringify({ d, target }))
  check('and it draws a diamond in its lane', await evalJS(`
    !!document.querySelector('.tlrow[data-tlreorder="${ID.un}"] .tlmilestone')
  `))
  await evalJS(`closeDrawer()`)
}

/* A start with no due draws a diamond on its start, past or still to come,
   rather than a bar out to today. Dragging it moves the start and it settles
   there; its right edge sets the due date it is missing, which turns it into
   an ordinary bar. */
{
  const startOnly = `.tlmilestone.tlstartonly[data-tlrow="${ID.two}"]`
  const leftOf = () => evalJS(`parseInt(document.querySelector('${startOnly}')?.style.left)`)
  const centre = () => evalJS(`(() => {
    const el = document.querySelector('${startOnly}');
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    document.querySelector('.tlscroll').scrollLeft = 0;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)
  await evalJS(`(() => { const t = locate('${ID.two}').task; t.due = null; refreshView(); })()`)
  const s = await offsetOf('2026-09-15')
  check('a start in the past with no due draws a diamond on its start', await leftOf() === s * 28, String(await leftOf()))
  check('and no bar', await evalJS(`!document.querySelector('.tlbar[data-tlrow="${ID.two}"]')`))
  check('with a handle at each edge', await evalJS(`
    !!document.querySelector('.tlmhandle.tlhandle-l[data-tlrow="${ID.two}"]') &&
    !!document.querySelector('.tlmhandle.tlhandle-r[data-tlrow="${ID.two}"]')
  `))

  const ahead = await evalJS(`ymd(addDays(today(), 5))`)
  await evalJS(`(() => { const t = locate('${ID.two}').task; t.start = '${ahead}'; refreshView(); })()`)
  check('a start still to come draws the same diamond on its start', await leftOf() === (await offsetOf(ahead)) * 28,
    JSON.stringify({ left: await leftOf(), want: (await offsetOf(ahead)) * 28 }))
  check('and no bar back to today', await evalJS(`!document.querySelector('.tlbar[data-tlrow="${ID.two}"]')`))
  await evalJS(`(() => { const t = locate('${ID.two}').task; t.start = '2026-09-15'; refreshView(); })()`)

  {
    const p = await centre()
    check('the press lands on the start-only diamond', await evalJS(`document.elementFromPoint(${p.x}, ${p.y})?.dataset.tldrag`) === 'start')
    await mouse('mousePressed', p.x, p.y)
    await mouse('mouseMoved', p.x + 10, p.y)
    await mouse('mouseMoved', p.x + 2 * 28, p.y)
    check('the diamond follows the drag', await leftOf() === (s + 2) * 28, String(await leftOf()))
    check('with no ghost bar, since it still has one date', await evalJS(`!document.querySelector('.tlghostbar')`))
    await mouse('mouseReleased', p.x + 2 * 28, p.y)
    await new Promise(r => setTimeout(r, 50))
    const d = await taskDates(ID.two)
    check('dragging a start-only diamond two days moves its start and adds no due',
      d.start === '2026-09-17' && d.due === null, JSON.stringify(d))
    check('and it settles as a diamond on the new start', await leftOf() === (await offsetOf('2026-09-17')) * 28, String(await leftOf()))
    check('and the release does not open the drawer', await evalJS(`state.openTask`) == null, String(await evalJS(`state.openTask`)))
  }

  const h = await evalJS(`(() => {
    const el = document.querySelector('.tlmhandle.tlhandle-r[data-tlrow="${ID.two}"]');
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    document.querySelector('.tlscroll').scrollLeft = 0;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)
  const sOff = await offsetOf('2026-09-17')
  const to = await dayX(ID.two, sOff + 3)
  check('the press lands on the start-only diamond’s right handle', await evalJS(`document.elementFromPoint(${h.x}, ${h.y})?.classList.contains('tlhandle-r')`) === true)
  await mouse('mousePressed', h.x, h.y)
  await mouse('mouseMoved', h.x + 10, h.y)
  await mouse('mouseMoved', to.x, h.y)
  check('a ghost bar shows the range being drawn out', await evalJS(`!!document.querySelector('.tlghostbar')`))
  await mouse('mouseReleased', to.x, h.y)
  await new Promise(r => setTimeout(r, 50))
  const d = await taskDates(ID.two)
  const want = await dateAt(sOff + 3)
  check('dragging its right edge sets the due date and keeps its start',
    d.start === '2026-09-17' && d.due === want, JSON.stringify({ d, want }))
  check('and it is drawn as an ordinary bar', await evalJS(`
    !!document.querySelector('.tlbar[data-tlrow="${ID.two}"]') && !document.querySelector('${startOnly}') && !document.querySelector('.tlghostbar')
  `))
}

/* A diamond's left edge draws out the start date it is missing. */
{
  const due = await evalJS(`locate('${ID.un}').task.due`)
  const dOff = await offsetOf(due)
  const h = await evalJS(`(() => {
    const el = document.querySelector('.tlmhandle.tlhandle-l[data-tlrow="${ID.un}"]');
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    document.querySelector('.tlscroll').scrollLeft = 0;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)
  const to = await dayX(ID.un, dOff - 3)
  check('the press lands on the diamond’s left handle', await evalJS(`document.elementFromPoint(${h.x}, ${h.y})?.classList.contains('tlmhandle')`) === true)
  await mouse('mousePressed', h.x, h.y)
  await mouse('mouseMoved', h.x - 10, h.y)
  await mouse('mouseMoved', to.x, h.y)
  check('a ghost bar shows the range being drawn', await evalJS(`!!document.querySelector('.tlghostbar')`))
  await mouse('mouseReleased', to.x, h.y)
  await new Promise(r => setTimeout(r, 50))
  const d = await taskDates(ID.un)
  const want = await dateAt(dOff - 3)
  check('dragging a diamond’s left edge sets its start and keeps its due',
    d.start === want && d.due === due, JSON.stringify({ d, want }))
  check('and it becomes a bar, the ghost gone', await evalJS(`
    !!document.querySelector('.tlbar[data-tlrow="${ID.un}"]') && !document.querySelector('.tlghostbar')
  `))
}

/* ---- sub-tasks ----

   A sub-task is drawn under its task from the start, and drags, resizes and
   opens the way a task does, writing its own line. One with no date of its
   own shows the task's due; one with no id of its own stays still. */
await evalJS(`(() => {
  load([
    '# To-do', '', '## 1. Tasks', '',
    '### To do', '',
    '- [ ] Parent \`id:tlpar1\` [bucket:: People] [impact:: high] [effort:: S] \`start:2026-09-10\` \`due:2026-09-20\`',
    '  - [ ] Own dates \`id:sb0001\` \`start:2026-09-12\` [due:: 2026-09-14]',
    '  - [ ] Inherits \`id:sb0002\`',
    '  - [ ] No id [due:: 2026-09-16]',
    ''
  ].join('\\n'), 'demo.md', {});
  state.view = 'timeline'; renderView();
})()`)
const subCount = () => evalJS(`document.querySelectorAll('.tlrow.tlsub').length`)
const settle = ms => new Promise(r => setTimeout(r, ms))
check('a task with sub-tasks starts folded', await subCount() === 0, await subCount())
await evalJS(`document.querySelector('.tlchevron[data-tltoggle]').click()`)
await settle(50)
check('the chevron opens that one task', await subCount() === 3, await subCount())
await evalJS(`document.querySelector('.tlchevron[data-tltoggle]').click()`)
await settle(50)
check('the header button offers to show all sub-tasks', await evalJS(`document.querySelector('[data-tltoggleall]').title`) === 'Show all sub-tasks')
await evalJS(`document.querySelector('[data-tltoggleall]').click()`)
await settle(50)
check('the header button opens every task', await subCount() === 3, await subCount())
check('and then offers to hide them', await evalJS(`document.querySelector('[data-tltoggleall]').title`) === 'Hide all sub-tasks')
await evalJS(`document.querySelector('[data-tltoggleall]').click()`)
await settle(50)
check('pressed again it folds every task', await subCount() === 0, await subCount())
await evalJS(`document.querySelector('[data-tltoggleall]').click()`)
await settle(50)
check('sub-tasks are drawn under their task once opened', await subCount() === 3, await subCount())
check("one with no date of its own shows the task's due", await evalJS(`(() => {
  const r = timelineTasks().dated[0].steps.find(s => s.id === 'sb0002');
  return !!r && r.due === '2026-09-20';
})()`))
check('one with an id takes drags, one without does not', await evalJS(`
  !!document.querySelector('.tlsub [data-tlrow="sb0001"][data-tldrag]') &&
  !!document.querySelector('.tlsub [data-tlrow="sb0002"][data-tldrag]') &&
  !document.querySelector('.tlsub [data-tldrag]:not([data-tlrow^="sb"])')
`))
check('a sub-task bar is filled with its bucket colour', await evalJS(`(() => {
  const b = document.querySelector('.tlsub .tlbar[data-tlrow="sb0001"]');
  return !!b && !!getComputedStyle(b).getPropertyValue('--bc').trim();
})()`))
{
  const bar = () => evalJS(`(() => {
    const b = document.querySelector('.tlsub .tlbar[data-tlrow="sb0001"]');
    b.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)
  const p = await bar()
  await mouse('mousePressed', p.x, p.y)
  for (let i = 1; i <= 4; i++) await mouse('mouseMoved', p.x + i * 0.5 * await evalJS(`TL_DAY_PX`), p.y)
  await mouse('mouseReleased', p.x + 2 * await evalJS(`TL_DAY_PX`), p.y)
  await new Promise(r => setTimeout(r, 80))
  const line = await evalJS(`locateSub('sb0001') && readSub(locateSub('sb0001').loc.task, locateSub('sb0001').step.line)`)
  check("dragging a sub-task's bar moves both of its own dates by two days",
    line && line.start === '2026-09-14' && line.due === '2026-09-16', JSON.stringify(line))
  const parent = await evalJS(`(() => { const t = allItems().find(i => i.title === 'Parent' && !i.sub).task; return t.start + ' ' + t.due })()`)
  check("and leaves its task's dates alone", parent === '2026-09-10 2026-09-20', parent)
}
await evalJS(`tlTarget('sb0002').write(null, '2026-09-18')`)
check('a drag on an inheriting sub-task writes a due of its own', await evalJS(`
  readSub(locateSub('sb0002').loc.task, locateSub('sb0002').step.line).due === '2026-09-18'`))
await evalJS(`document.querySelector('.tlchevron').click()`)
await new Promise(r => setTimeout(r, 50))
check('the chevron folds them away', await evalJS(`document.querySelectorAll('.tlrow.tlsub').length`) === 0)
await evalJS(`document.querySelector('.tlchevron').click()`)
await new Promise(r => setTimeout(r, 50))
await evalJS(`document.querySelector('.tlsub .tllabeltext[data-open="sb0001"]').click()`)
await new Promise(r => setTimeout(r, 80))
check("clicking a sub-task's title opens its own panel", await evalJS(`state.openTask === 'sb0001' && subPanelOpen()`))
await evalJS(`closeDrawer && closeDrawer()`)

/* ---- a task with no dates of its own, drawn from its sub-tasks ----

   The span runs from the earliest to the latest step date (a step with one
   date gives that one), only while the task has neither date itself. Dragging
   it writes the task's own start and due, both, and never a step. */
const spanFixture = () => evalJS(`(() => {
  load([
    '# To-do', '', '## 1. Tasks', '',
    '### To do', '',
    '- [ ] Span parent \`id:tlspn1\` [bucket:: People] [impact:: high] [effort:: S]',
    '  - [ ] Both dates \`id:sp0001\` \`start:2026-09-12\` [due:: 2026-09-14]',
    '  - [ ] Due only \`id:sp0002\` [due:: 2026-09-18]',
    '  - [ ] Start only \`id:sp0003\` \`start:2026-09-10\`',
    '  - [ ] No dates \`id:sp0004\`',
    '- [ ] Has a due \`id:tlspn2\` [bucket:: People] [impact:: high] [effort:: S] [due:: 2026-09-25]',
    '  - [ ] Dated step \`id:sp0005\` [due:: 2026-09-20]',
    ''
  ].join('\\n'), 'demo.md', {});
  state.view = 'timeline'; renderView();
})()`)
const spanIds = () => evalJS(`(() => {
  const items = allItems().filter(i => !i.sub);
  return { span: items.find(i => i.title === 'Span parent').id, due: items.find(i => i.title === 'Has a due').id };
})()`)
const stepDates = id => evalJS(`splitBody(locate('${id}').task).steps.map(s => (s.start || '') + '/' + (s.due || '')).join(' ')`)
await spanFixture()
{
  const S = await spanIds()
  const before = await stepDates(S.span)
  check('a dateless task with dated sub-tasks draws a span from the earliest to the latest step date', await evalJS(`(() => {
    const bar = document.querySelector('.tlbar.tlspan[data-tlrow="${S.span}"]');
    const sc = timelineScale(timelineTasks().dated);
    return !!bar && parseInt(bar.style.left) === tlOffset(sc, '2026-09-10') * TL_DAY_PX &&
      parseInt(bar.style.width) === (tlOffset(sc, '2026-09-18') - tlOffset(sc, '2026-09-10') + 1) * TL_DAY_PX;
  })()`))
  check('a task with a due date of its own draws no span', await evalJS(`
    !document.querySelector('.tlspan[data-tlrow="${S.due}"]') && !!document.querySelector('.tlmilestone[data-tlrow="${S.due}"]')`))
  check('and the span is the only one', await evalJS(`document.querySelectorAll('.tlspan').length`) === 1)
  const s0 = await offsetOf('2026-09-10')
  const p = await dayX(S.span, s0 + 1)
  check('the press lands on the span itself', await evalJS(`document.elementFromPoint(${p.x}, ${p.y})?.dataset.tldrag`) === 'move')
  await mouse('mousePressed', p.x, p.y)
  await mouse('mouseMoved', p.x + 10, p.y)
  await mouse('mouseMoved', p.x + 3 * 28, p.y)
  await mouse('mouseReleased', p.x + 3 * 28, p.y)
  await new Promise(r => setTimeout(r, 50))
  const d = await taskDates(S.span)
  check('dragging the span three days right writes both dates onto the task',
    d.start === '2026-09-13' && d.due === '2026-09-21', JSON.stringify(d))
  check('and leaves every sub-task date alone', await stepDates(S.span) === before, await stepDates(S.span))
  check('and it now draws as a plain bar', await evalJS(`
    !document.querySelector('.tlspan[data-tlrow="${S.span}"]') && !!document.querySelector('.tlbar[data-tlrow="${S.span}"]')`))
}
await spanFixture()
{
  const S = await spanIds()
  const before = await stepDates(S.span)
  const h = await evalJS(`(() => {
    const el = document.querySelector('.tlbar.tlspan[data-tlrow="${S.span}"] .tlhandle-r');
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    document.querySelector('.tlscroll').scrollLeft = 0;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)
  const to = await dayX(S.span, await offsetOf('2026-09-20'))
  await mouse('mousePressed', h.x, h.y)
  await mouse('mouseMoved', h.x + 10, h.y)
  await mouse('mouseMoved', to.x, h.y)
  await mouse('mouseReleased', to.x, h.y)
  await new Promise(r => setTimeout(r, 50))
  const d = await taskDates(S.span)
  check('dragging the right handle writes both dates onto the task, the far edge moved',
    d.start === '2026-09-10' && d.due === '2026-09-20', JSON.stringify(d))
  check('and leaves every sub-task date alone', await stepDates(S.span) === before)
}
await spanFixture()
{
  const S = await spanIds()
  const p = await dayX(S.span, await offsetOf('2026-09-10') + 1)
  await mouse('mousePressed', p.x, p.y)
  await mouse('mouseReleased', p.x, p.y)
  await new Promise(r => setTimeout(r, 50))
  const d = await taskDates(S.span)
  check('a click on the span opens the task and writes nothing',
    await evalJS(`state.openTask`) === S.span && d.start === null && d.due === null, JSON.stringify(d))
  await evalJS(`closeDrawer()`)
}

/* ---- an undated sub-task, under an undated parent ----

   Neither carries a date anywhere. Both still get a row (goal 2), and
   clicking the sub-task's own track dates the sub-task, not its parent — a
   fresh fixture, so the fold/click checks above stay about the one task they
   were written against. */
await evalJS(`(() => {
  load([
    '# To-do', '', '## 1. Tasks', '',
    '### To do', '',
    '- [ ] Undated parent \`id:tlpar2\` [bucket:: People] [impact:: med] [effort:: S]',
    '  - [ ] Own row \`id:sb0003\`',
    ''
  ].join('\\n'), 'demo.md', {});
  state.view = 'timeline'; renderView();
})()`)
const parentId2 = await evalJS(`allItems().find(i => i.title === 'Undated parent' && !i.sub).id`)
await evalJS(`document.querySelector('.tlchevron[data-tltoggle="${parentId2}"]').click()`)
await settle(50)
check('the undated parent gets a lane row, with an empty track', await evalJS(`(() => {
  const track = document.querySelector('.tlrow[data-tlreorder="${parentId2}"] .tltrack');
  return !!track && !track.querySelector('.tlbar') && !track.querySelector('.tlmilestone');
})()`))
check('its undated sub-task is drawn under it, also with an empty track', await evalJS(`(() => {
  const row = document.querySelector('.tlsub [data-open="sb0003"]')?.closest('.tlrow');
  const track = row && row.querySelector('.tltrack');
  return !!track && !track.querySelector('.tlbar') && !track.querySelector('.tlmilestone');
})()`))
{
  const target = await dateAt(9)
  const p = await evalJS(`(() => {
    const track = document.querySelector('.tlsub [data-open="sb0003"]').closest('.tlrow').querySelector('.tltrack');
    track.scrollIntoView({ block: 'center', inline: 'nearest' });
    document.querySelector('.tlscroll').scrollLeft = 0;
    const r = track.getBoundingClientRect();
    return { x: r.left + 9.25 * TL_DAY_PX, y: r.top + r.height / 2 };
  })()`)
  check('the click lands on the sub-task’s own track', await evalJS(`document.elementFromPoint(${p.x}, ${p.y})?.classList.contains('tltrack')`) === true)
  await mouse('mousePressed', p.x, p.y)
  await mouse('mouseReleased', p.x, p.y)
  await new Promise(r => setTimeout(r, 50))
  const line = await evalJS(`readSub(locateSub('sb0003').loc.task, locateSub('sb0003').step.line)`)
  check('clicking it writes the sub-task’s own due date', line && line.due === target, JSON.stringify({ line, target }))
  const parent = await evalJS(`(() => { const t = allItems().find(i => i.id === '${parentId2}' && !i.sub).task; return t.start + ' ' + t.due; })()`)
  check('and leaves the parent task undated', parent === ' ', parent)
}

/* ---- nothing dated at all still draws a scale (goal 3) ---- */
await evalJS(`(() => {
  load([
    '# To-do', '', '## 1. Tasks', '',
    '### To do', '',
    '- [ ] Only undated \`id:tlonly1\` [bucket:: People] [impact:: med] [effort:: S]',
    ''
  ].join('\\n'), 'demo.md', {});
  state.view = 'timeline'; renderView();
})()`)
check('with nothing dated at all, timelineSection still returns a scale',
  await evalJS(`!!timelineSection().model.scale`))
check('and the scale is drawn — a lane with an empty track',
  await evalJS(`!!document.querySelector('.tlscroll .tlbody .tltrack')`))
/* ---- the point of the guard ---- */

check('the timeline wrote nothing, which is all it should ever do',
  await evalJS(`window.__blocked.length === 0`), await evalJS(`window.__blocked.join(' | ')`))

} finally {
  ws.close()
  chrome.kill()
}
const failed = checks.filter(c => !c).length
console.log(failed ? `\n${failed} failed` : `\nall ${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
