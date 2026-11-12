#!/usr/bin/env node
/* The Board view — the columns and the cards in them, as `BoardView` and
 * `TaskCard` (kanban/ui/) draw them from `renderBoard()`.
 *
 *   python3 kanban/server.py &          # or BOARD_PORT=... at one already up
 *   node kanban/test_board.mjs
 *
 * Written 19 Sep 2026, alongside the port of the view. Until then the board was
 * one string assigned to `#board`, and the only things that drew a card were
 * the suites that happened to open one; nothing here dragged a card, sorted a
 * column, or added a task. What it pins is what the port replaced by hand:
 *
 *   - every handler is a prop now, so a card opens, drags and drops through
 *     React's own events rather than through `onclick` assigned after a paint;
 *   - the drop line and the highlight under a dragged card are state inside
 *     `BoardView`, so it must appear where the pointer is and go when it leaves;
 *   - a task card drawn by React matches a shape pinned from `cardHTML()`'s
 *     own output, captured while it still existed (it and `cardModel()` were
 *     deleted from 09-columns.js on 25 Sep 2026, with no caller left but this
 *     check and kanban/ui/test_primitives.mjs), element for element, once the
 *     one wrapper the title sits in is stepped over.
 *

 * The tab is not locked, because the point is to drag and add. What keeps that
 * safe is the fetch guard: every non-GET is torn out of `fetch` and recorded,
 * so nothing here can reach `todo.md`, which the last assertion checks.
 */
import { spawn } from 'node:child_process'
import { CHROME_BIN } from './test_browser.mjs'

const PORT = Number(process.env.CDP_PORT) || 9460
const BOARD = process.env.BOARD_PORT || 8765
if (!process.env.BOARD_PORT) console.error('Note: this runs against the live board on 8765. For a throwaway copy: scripts/test-board.sh test_board.mjs')
const checks = []
const check = (name, pass, detail = '') => {
  checks.push(pass)
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const chrome = spawn(CHROME_BIN, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  `--user-data-dir=${process.env.CHROME_PROFILE || '/tmp/todo-board-test-profile'}`, '--window-size=1500,1000',
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
const wait = ms => new Promise(r => setTimeout(r, ms))

// Poll for the page rather than sleeping: a fixed wait fails when the machine is busy.
for (let i = 0; i < 120 && !(await evalJS(`document.readyState === 'complete' && typeof state !== 'undefined' && !!state.doc`).catch(() => false)); i++) await new Promise(r => setTimeout(r, 250))
await new Promise(r => setTimeout(r, 400))
check('the board loaded', await evalJS(`typeof renderBoard === 'function' && typeof BoardUI.BoardView === 'function'`))

await evalJS(`(() => {
  const real = window.fetch;
  window.__blocked = [];
  window.fetch = (u, o) => {
    const m = (o && o.method) || 'GET';
    if (m !== 'GET') { window.__blocked.push(m + ' ' + u); return Promise.resolve(new Response('{}', { status: 200 })) }
    return real(u, o);
  };
  window.__drag = (type, el, y) => el.dispatchEvent(new DragEvent(type, {
    bubbles: true, cancelable: true, clientY: y, dataTransfer: window.__dt || (window.__dt = new DataTransfer())
  }));
  window.__titles = tier => [...document.querySelectorAll('#board .tenon-column[data-tier="' + tier + '"] .tenon-card__title')]
    .map(e => e.textContent).join(',');
  window.__order = tier => state.doc.buckets[0].tiers.find(t => t.name === tier).tasks.map(t => t.title).join(',');
  state.view = 'board';
  load([
    '# To-do', '', '## 1. People', '',
    '### Reviewing', '',
    '### To do', '',
    '- [ ] Alpha \`id:bd0001\` [impact:: high] [effort:: S]',
    '  - [x] first step',
    '  - [ ] second step',
    '- [ ] Beta \`id:bd0002\` [impact:: low] [effort:: L] [due:: 2026-09-12]',
    '- [ ] Gamma \`id:bd0003\` [impact:: med] [effort:: M]',
    '',
    '### Doing', '',
    '- [ ] Delta \`id:bd0004\` [impact:: high] [effort:: S] [to:: Plan agent]',
    ''
  ].join('\\n'), 'demo.md', {});
  state.locked = false;
  /* The file's own \`id:\` tokens are not honoured at load, so name the four
     tasks here rather than lean on the ones minted for them. */
  const ids = { Alpha: 'bd0001', Beta: 'bd0002', Gamma: 'bd0003', Delta: 'bd0004' };
  state.doc.buckets.forEach(b => b.tiers.forEach(t => t.tasks.forEach(k => { if (ids[k.title]) k.id = ids[k.title]; })));
  renderView();
})()`)

/* ---- the columns ---- */

const tiers = await evalJS(`[...document.querySelector('#board').children].map(c => c.dataset.tier).join('|')`)
check('the board draws its columns straight into #board, Done last', /(^|\|)To do\|/.test(tiers) && tiers.endsWith('|Done'), tiers)
check('a column says how many cards it holds', await evalJS(`
  document.querySelector('#board .tenon-column[data-tier="To do"] .tenon-column__count').textContent
`) === '3')
check('its cards are in the file order', await evalJS(`__titles('To do')`) === 'Alpha,Beta,Gamma')
check('an empty column says so', await evalJS(`
  !!document.querySelector('#board .tenon-column[data-tier="Reviewing"] .tenon-column-empty')
`))
check('there is no column for an agent, only the states', tiers === 'Doing|To do|Reviewing|Done', tiers)
check('a task an agent holds stays in its own column', await evalJS(`__titles('Doing')`) === 'Delta')
check('each column is a drop target and says which tier it is', await evalJS(`
  [...document.querySelectorAll('#board > .tenon-column')].every(c =>
    c.dataset.tier && c.querySelector('.tenon-column__body.drop'))
`))

/* ---- what a card says ---- */

check('a card carries its own id and is reachable from the keyboard', await evalJS(`(() => {
  const c = document.querySelector('#board .tenon-card[data-id="bd0001"]');
  return c.getAttribute('tabindex') === '0' && c.getAttribute('role') === 'button' &&
         c.getAttribute('draggable') === 'true';
})()`))
check('impact and effort are chips', await evalJS(`(() => {
  const c = document.querySelector('#board .tenon-card[data-id="bd0001"]');
  const tags = [...c.querySelectorAll('.tenon-tag--neutral')];
  return tags.some(t => t.textContent === '\u{1f525}') && tags.some(t => t.textContent === 'S');
})()`))
check('a due date is a chip in its own corner', await evalJS(`
  !!document.querySelector('#board .tenon-card[data-id="bd0002"] .meta-when .tenon-tag')
`))
check('steps show as a progress line', await evalJS(`
  document.querySelector('#board .tenon-card[data-id="bd0001"] .prog span').textContent
`) === '1/2 steps')

/* ---- opening a card ---- */

await evalJS(`document.querySelector('#board .tenon-card[data-id="bd0002"]').click()`)
check('a click opens the drawer on that task', await evalJS(`state.openTask === 'bd0002'`))
await evalJS(`closeDrawer(); document.querySelector('#board .tenon-card[data-id="bd0003"]')
  .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`)
check('Enter opens it too', await evalJS(`state.openTask === 'bd0003'`))
await evalJS(`closeDrawer()`)

/* ---- dragging ---- */

await evalJS(`__drag('dragstart', document.querySelector('#board .tenon-card[data-id="bd0003"]'), 0)`)
await wait(150)
check('a dragged card is remembered by the board and faded', await evalJS(`
  dragId === 'bd0003' && document.querySelector('#board .tenon-card[data-id="bd0003"]').classList.contains('dragging')
`))
await evalJS(`(() => {
  const first = document.querySelector('#board .tenon-column[data-tier="To do"] .tenon-card[data-id="bd0001"]');
  __drag('dragover', first, first.getBoundingClientRect().top + 2);
})()`)
await wait(100)
check('the column lights up under the pointer', await evalJS(`
  document.querySelector('#board .tenon-column[data-tier="To do"] .tenon-column__body').classList.contains('over')
`))
check('and the drop line sits above the first card', await evalJS(`
  document.querySelector('#board .tenon-column[data-tier="To do"] .tenon-column__body').firstElementChild.className
`) === 'tenon-dropline')
await evalJS(`(() => {
  const first = document.querySelector('#board .tenon-column[data-tier="To do"] .tenon-card[data-id="bd0001"]');
  __drag('dragover', first, first.getBoundingClientRect().bottom - 2);
})()`)
await wait(100)
check('moving down moves the line under it', await evalJS(`
  document.querySelector('#board .tenon-column[data-tier="To do"] .tenon-card[data-id="bd0001"]').nextElementSibling.className
`) === 'tenon-dropline')
check('there is only ever one line', await evalJS(`document.querySelectorAll('#board .tenon-dropline').length`) === 1)
await evalJS(`__drag('dragleave', document.querySelector('#board .tenon-column[data-tier="To do"] .tenon-column__body'), 0)`)
await wait(100)
check('leaving the column clears the line and the highlight', await evalJS(`
  !document.querySelector('#board .tenon-dropline') && !document.querySelector('#board .drop.over')
`))

/* Dropped at the top of To do: Gamma goes first. */
await evalJS(`(() => {
  const first = document.querySelector('#board .tenon-column[data-tier="To do"] .tenon-card[data-id="bd0001"]');
  const y = first.getBoundingClientRect().top + 2;
  __drag('dragover', first, y);
  __drag('drop', first, y);
  __drag('dragend', document.querySelector('#board .tenon-card[data-id="bd0003"]'), 0);
})()`)
await wait(150)
check('a drop reorders the tasks in the file', await evalJS(`__order('To do')`) === 'Gamma,Alpha,Beta', await evalJS(`__order('To do')`))
check('and the board shows the new order', await evalJS(`__titles('To do')`) === 'Gamma,Alpha,Beta')
check('the line and the fade are gone afterwards', await evalJS(`
  !document.querySelector('#board .tenon-dropline') && !document.querySelector('#board .tenon-card.dragging') && dragId === null
`))
check('and the tab knows it has something to save', await evalJS(`state.dirty === true`))

/* Into another column. */
await evalJS(`(() => {
  __drag('dragstart', document.querySelector('#board .tenon-card[data-id="bd0004"]'), 0);
  const col = document.querySelector('#board .tenon-column[data-tier="To do"]');
  const last = col.querySelector('.tenon-card[data-id="bd0002"]');
  const y = last.getBoundingClientRect().bottom - 2;
  __drag('dragover', last, y);
  __drag('drop', last, y);
  __drag('dragend', document.querySelector('#board .tenon-card[data-id="bd0004"]'), 0);
})()`)
await wait(150)
check('a card dropped in another column moves there', await evalJS(`__order('To do')`) === 'Gamma,Alpha,Beta,Delta', await evalJS(`__order('To do')`))
check('and it left the column it came from', await evalJS(`__titles('Doing')`) === '')
check('a column says the state of a card, so the drop left its assignee alone', await evalJS(`
  locate('bd0004').task.to`) === 'Plan agent')
check('both counts follow', await evalJS(`
  ['To do', 'Doing'].map(n =>
    document.querySelector('#board .tenon-column[data-tier="' + n + '"] .tenon-column__count').textContent).join('/')
`) === '4/0')

/* Done is the tick, not a section. */
await evalJS(`(() => {
  __drag('dragstart', document.querySelector('#board .tenon-card[data-id="bd0002"]'), 0);
  const done = document.querySelector('#board .tenon-column[data-tier="Done"]');
  __drag('dragover', done.querySelector('.tenon-column__body'), 0);
  __drag('drop', done.querySelector('.tenon-column__body'), 0);
  __drag('dragend', document.querySelector('#board .tenon-card[data-id="bd0002"]'), 0);
})()`)
await wait(150)
check('a card dropped on Done is ticked', await evalJS(`
  !!document.querySelector('#board .tenon-column[data-tier="Done"] .tenon-card.done[data-id="bd0002"]')
`))
check('and it now sits under the bucket\'s Done heading, at the top', await evalJS(`__order('Done')`) === 'Beta', await evalJS(`__order('Done')`))
check('Done is the first heading in the bucket', await evalJS(`state.doc.buckets[0].tiers[0].name`) === 'Done')
check('and it left the heading it was ticked under', await evalJS(`__order('To do')`) === 'Gamma,Alpha,Delta', await evalJS(`__order('To do')`))
check('unticking a card in Done sends it to the top of To do', await evalJS(`(() => {
  setDone(locate('bd0002').task, false);
  return __order('To do') + ' / done=' + __order('Done');
})()`) === 'Beta,Gamma,Alpha,Delta / done=', await evalJS(`__order('To do') + ' / done=' + __order('Done')`))
await evalJS(`setDone(locate('bd0002').task, true); refreshView()`)

/* ---- sorting ---- */

await evalJS(`document.querySelector('#board .tenon-column[data-tier="To do"] .sortbtn').click()`)
await wait(100)
check('the sort button says it is on', await evalJS(`
  document.querySelector('#board .tenon-column[data-tier="To do"] .sortbtn').textContent
`) === 'by priority')
check('the column is marked sorted', await evalJS(`
  document.querySelector('#board .tenon-column[data-tier="To do"]').classList.contains('sorted')
`))
check('and orders by impact against effort', await evalJS(`__titles('To do')`) === 'Alpha,Delta,Gamma', await evalJS(`__titles('To do')`))
await evalJS(`(() => {
  __drag('dragstart', document.querySelector('#board .tenon-card[data-id="bd0003"]'), 0);
  const first = document.querySelector('#board .tenon-column[data-tier="To do"] .tenon-card');
  __drag('dragover', first, first.getBoundingClientRect().top + 2);
})()`)
await wait(100)
check('a sorted column takes drops but draws no line', await evalJS(`
  document.querySelector('#board .tenon-column[data-tier="To do"] .tenon-column__body').classList.contains('over') &&
  !document.querySelector('#board .tenon-dropline')
`))
await evalJS(`__drag('dragend', document.querySelector('#board .tenon-card[data-id="bd0003"]'), 0);
  document.querySelector('#board .tenon-column[data-tier="To do"] .sortbtn').click()`)
await wait(100)

/* ---- adding, and the pencil ---- */

await evalJS(`document.querySelector('#board .tenon-column[data-tier="To do"] .addbtn').click()`)
await wait(150)
check('+ Add task puts a new card in that column', await evalJS(`__titles('To do')`).then(t => t.includes('New task')))
await evalJS(`closeDrawer()`)
check('the head carries a pencil for the tier editor', await evalJS(`
  !!document.querySelector('#board .tenon-column[data-tier="To do"] .coledit[data-editcol="To do"]')
`))
check('Done carries neither the pencil nor the add button', await evalJS(`(() => {
  const c = document.querySelector('#board .tenon-column[data-tier="Done"]');
  return c && !c.querySelector('.coledit') && !c.querySelector('.addbtn');
})()`))
check('no column on the board is dashed, running or geared', await evalJS(`
  !document.querySelector('#board .tenon-column--dashed, #board .tenon-column--running, #board .colgear')
`))

/* ---- locked ---- */

await evalJS(`state.locked = true; renderBoard()`)
check('a locked board draws no add button and no pencil', await evalJS(`
  !document.querySelector('#board .addbtn') && !document.querySelector('#board .coledit')
`))
check('its cards are not draggable', await evalJS(`
  [...document.querySelectorAll('#board .tenon-card')].every(c => c.getAttribute('draggable') !== 'true')
`))
check('and a column does not take a drop', await evalJS(`(() => {
  const body = document.querySelector('#board .tenon-column[data-tier="To do"] .tenon-column__body');
  const e = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
  body.dispatchEvent(e);
  return e.defaultPrevented === false && !body.classList.contains('over');
})()`))
await evalJS(`state.locked = false; renderBoard()`)

/* ---- pinned card shapes ----
   cardHTML() and cardModel() are gone from kanban/js/09-columns.js as of
   25 Sep 2026 — every view is React now, so what used to be compared against
   a live string builder is compared against markup captured from it while it
   still existed, the same way kanban/ui/test_primitives.mjs pins Column and
   Card. Three shapes, chosen to cover what the rest of this suite's own
   fixture (Alpha/Beta/Gamma/Delta) actually varies: a progress bar, a bare
   card and a delegated chip, the last one now carrying Plan agent's own
   avatar (agentAvatarHTML()/avatarSvg(), core/avatar.js — 26 Sep 2026).
   Beta is left out here — its due chip's "Nd late"
   note is relative to today, so pinning its full markup would go stale on a
   clock rather than on a real change; its own structural check ("a due date
   is a chip in its own corner") stays further up this file instead. */
await evalJS(`(() => {
  state.locked = false;
  state.view = 'board';
  renderView();
})()`)
await wait(200)
const CARD_PARITY = {
  bd0001: '<article class="tenon-card tenon-card--flat tenon-card--accent tenon-card--draggable todo" draggable="true" tabindex="0" role="button" data-id="bd0001" style="--tenon-card-accent:var(--tenon-chart-1)"><div class="tenon-card__head"><div class="tenon-card__title">Alpha</div></div><div class="tenon-card__tags"><span class="tenon-tag tenon-tag--neutral" title="high impact">\u{1f525}</span><span class="tenon-tag tenon-tag--neutral">S</span></div><div class="tenon-card__body"><div class="prog"><span>1/2 steps</span><span class="bar"><i style="width:50%"></i></span></div></div></article>',
  bd0003: '<article class="tenon-card tenon-card--flat tenon-card--accent tenon-card--draggable todo" draggable="true" tabindex="0" role="button" data-id="bd0003" style="--tenon-card-accent:var(--tenon-chart-1)"><div class="tenon-card__head"><div class="tenon-card__title">Gamma</div></div><div class="tenon-card__tags"><span class="tenon-tag tenon-tag--neutral" title="med impact">\u{1f324}️</span><span class="tenon-tag tenon-tag--neutral">M</span></div></article>',
  bd0004: '<article class="tenon-card tenon-card--flat tenon-card--accent tenon-card--draggable todo" draggable="true" tabindex="0" role="button" data-id="bd0004" style="--tenon-card-accent:var(--tenon-chart-1)"><div class="tenon-card__head"><div class="tenon-card__title">Delta</div></div><div class="tenon-card__tags"><span class="tenon-tag tenon-tag--neutral" title="high impact">\u{1f525}</span><span class="tenon-tag tenon-tag--neutral">S</span><span class="tenon-tag tenon-tag--accent" title="Delegated to Plan agent"><span class="avatar" role="img" aria-label="Delegated to Plan agent"><svg viewBox="0 0 128 128" width="16" height="16" aria-hidden="true" focusable="false"><path d="M0 8C0 3.58172 3.58172 0 8 0H120C124.418 0 128 3.58172 128 8V120C128 124.418 124.418 128 120 128H8C3.58172 128 0 124.418 0 120V8Z" fill="white"></path><path d="M64 18.1194L107.749 49.822L91.0381 101.118H36.9619L20.2514 49.822L64 18.1194Z" fill="#F0B355"></path></svg></span></span></div></article>',
}
const pinCheck = await evalJS(`(() => {
  const canon = el => {
    if (el.nodeType === 3) return el.textContent;
    if (el.tagName === 'SPAN' && el.parentNode.classList && el.parentNode.classList.contains('tenon-card__title') &&
        el.parentNode.children.length === 1 && el.classList.contains('mdinline')) {
      return [...el.childNodes].map(canon).join('');
    }
    const attrs = [...el.attributes].map(a => a.name + '="' +
      (a.name === 'style' ? a.value.replace(/[\\s;]/g, '') : a.value) + '"').sort().join(' ');
    return '<' + el.tagName.toLowerCase() + ' ' + attrs + '>' + [...el.childNodes].map(canon).join('') + '</>';
  };
  const expect = ${JSON.stringify(CARD_PARITY)};
  const bad = [];
  Object.entries(expect).forEach(([id, html]) => {
    const card = document.querySelector('#board .tenon-card[data-id="' + id + '"]');
    if (!card) { bad.push(id + ': not on the board'); return; }
    const holder = document.createElement('div');
    holder.innerHTML = html;
    const want = canon(holder.firstElementChild);
    const got = canon(card);
    if (want !== got) bad.push(id + '\\n  want ' + want.slice(0, 400) + '\\n  got  ' + got.slice(0, 400));
  });
  return bad;
})()`)
check(`the pinned cards (${Object.keys(CARD_PARITY).length} of them) match what the board actually draws`,
  pinCheck.length === 0, pinCheck.slice(0, 3).join('\n'))

/* The project, theme and start-date chips are Tenon's outlined `Pill`, and
   your move is the one chip still drawn as the board's own `.tag`. Gamma is
   dressed up in state only and put back, so nothing is saved. */
const pillCheck = await evalJS(`(() => {
  const t = state.doc.buckets.flatMap(b => b.tiers.flatMap(x => x.tasks)).find(x => x.id === 'bd0003');
  const saved = { theme: t.theme, start: t.start, body: t.body };
  const soon = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  t.theme = 'Tokens'; t.start = soon; t.body = [...t.body, '  - Project: data/projects/demo'];
  renderView();
  const c = document.querySelector('#board .tenon-card[data-id="bd0003"]');
  const out = {
    proj: c.querySelector('.tenon-pill.tenon-pill--neutral.proj[data-project="demo"]')?.textContent,
    theme: c.querySelector('.tenon-pill.tenon-pill--neutral[title="Theme: Tokens"]')?.textContent,
    start: !!c.querySelector('.tenon-pill.tenon-pill--neutral.startdate'),
    tags: c.querySelectorAll('.tag').length,
  };
  Object.assign(t, saved);
  renderView();
  return out;
})()`)
check('theme and start date are outlined Tenon Pills, none is a .tag, and the card carries no project chip',
  pillCheck.proj === undefined && pillCheck.theme === 'Tokens' && pillCheck.start && pillCheck.tags === 0,
  JSON.stringify(pillCheck))

/* ---- defaultAddBucket() reads the bucket filter ---- */

/* A second bucket, added to state directly rather than through the fixture,
   so the pinned card/column checks above stay against the one-bucket load
   they were captured from. Nothing here renders. */
const addBucketCheck = await evalJS(`(() => {
  const second = { name: 'Design System', color: '#000', tiers: state.doc.buckets[0].tiers.map(t => ({ name: t.name, tasks: [] })) };
  state.doc.buckets.push(second);
  const bad = [];
  const want = (label, expected) => { const got = defaultAddBucket().name; if (got !== expected) bad.push(label + ': want ' + expected + ', got ' + got); };

  state.bucketFilter = new Set();
  want('none toggled falls back to the first bucket in the file', 'People');

  state.bucketFilter = new Set(['Design System']);
  want('one bucket toggled on is that bucket', 'Design System');

  state.bucketFilter = new Set(['Design System', 'People']);
  want('several toggled on use the leftmost in file order, not Set order', 'People');

  state.doc.buckets.pop();
  state.bucketFilter = new Set();
  return bad;
})()`)
check('defaultAddBucket() guesses the bucket from the filter', addBucketCheck.length === 0, addBucketCheck.join(' | '))

/* ---- the view tabs, Tenon's SegmentedControl since 26 Sep 2026 ---- */

await evalJS(`state.view = 'board'; renderView()`)
await new Promise(r => setTimeout(r, 150))
check('the view tabs are one radiogroup with the board checked', await evalJS(`(() => {
  const g = document.querySelector('#viewToggle [role=radiogroup].tenon-segmented')
  const on = g && g.querySelector('[role=radio][aria-checked=true]')
  return !!on && on.dataset.value === 'board' && on.tabIndex === 0 &&
    g.querySelectorAll('[role=radio]').length === 5 &&
    [...g.querySelectorAll('[role=radio]')].map(r => r.dataset.value).join() === 'overview,reports,board,timeline,matrix' &&
    g.querySelectorAll('.sepbefore').length === 1
})()`))
await evalJS(`document.querySelector('#viewToggle [data-value=matrix]').click()`)
await new Promise(r => setTimeout(r, 150))
check('picking a tab switches the view and the URL', await evalJS(`
  state.view === 'matrix' && location.hash.startsWith('#matrix') &&
  document.querySelector('#viewToggle [data-value=matrix]').getAttribute('aria-checked') === 'true'
`))
await evalJS(`document.querySelector('#viewToggle [data-value=matrix]').dispatchEvent(
  new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))`)
await new Promise(r => setTimeout(r, 150))
check('the arrow keys move between views', await evalJS(`state.view === 'timeline'`))
check('Projects has no tab, but a #projects link still draws its list', await evalJS(`(() => {
  const none = !document.querySelector('#viewToggle [data-value=projects]');
  state.view = 'projects'; renderView();
  const drawn = state.view === 'projects' && !!document.querySelector('#projectsRoot');
  return none && drawn && isKnownView('projects');
})()`))
await evalJS(`state.view = 'board'; renderView()`)
await new Promise(r => setTimeout(r, 150))

/* ---- bulk move ticks and unticks ---- */

check('bulk moving cards into Done ticks them, and out of Done unticks them', await evalJS(`(() => {
  const all = [];
  state.doc.buckets.forEach(b => b.tiers.forEach(t => t.tasks.forEach(k => all.push({ k, tier: t.name }))));
  const pick = all.find(x => !x.k.done && x.k.id && x.tier !== DONE_COL);
  if (!pick) return false;
  const t = pick.k;
  state.selectedIds.clear(); state.selectedIds.add(t.id);
  bulkMoveToColumn(DONE_COL);
  const ticked = t.done === true && locate(t.id).tier.name === DONE_COL;
  state.selectedIds.add(t.id);
  bulkMoveToColumn(TODO_TIER);
  return ticked && t.done === false && locate(t.id).tier.name === TODO_TIER;
})()`))

/* ---- specialists called in show in the task's history ---- */

check('a call to a bucket planner reads as the owner asking the specialist', await evalJS(`(() => {
  const ev = { at: '2026-09-27T02:14:09', about: 'task:ab12cd', by: 'Plan agent', kind: 'call',
               called: 'work-people-agent', did: 'work' };
  return specialistName('work-people-agent') === 'Work people agent' &&
    historyLine(ev) === 'Plan agent asked the Work people agent to do part of the work' &&
    historyLine(Object.assign({}, ev, { did: 'view' })).endsWith('for a view') &&
    historyLine(Object.assign({}, ev, { kind: 'moved' })) === '';
})()`))

check('the drawer has a History section', await evalJS(`(() => {
  const all = [];
  state.doc.buckets.forEach(b => b.tiers.forEach(t => t.tasks.forEach(k => all.push(k))));
  const t = all.find(k => k.id);
  if (!t) return false;
  openDrawer(t.id);
  const ok = !!document.querySelector('#f-history') &&
    !!document.querySelector('details[data-collapse="sugg:history"]');
  closeDrawer();
  return ok;
})()`))

/* ---- press and hold ---- */

await evalJS(`closeDrawer(); window.__holds = [];
  onCardHoldStart = (id) => window.__holds.push('start:' + id);
  onCardHoldEnd = (id) => window.__holds.push('end:' + id);
  window.__ptr = (type, el, x, y) => (type === 'pointerdown' ? el : window).dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerType: 'mouse', button: 0, clientX: x, clientY: y }));
  renderBoard();`)
const holdCard = `document.querySelector('#board .tenon-card[data-id="bd0002"]')`
check('at rest the stripe sits at the card edge over a clear left border', await evalJS(
  `(() => { const el = ${holdCard}, cs = getComputedStyle(el), b = getComputedStyle(el, '::before');
    return cs.borderLeftColor === 'rgba(0, 0, 0, 0)' && parseFloat(cs.borderLeftWidth) > 0 &&
      parseFloat(b.left) === -parseFloat(cs.borderLeftWidth) && parseFloat(cs.borderTopWidth) === 1; })()`))
await evalJS(`window.__fev = []; ['board:focus', 'board:unfocus'].forEach(n => window.addEventListener(n, e => __fev.push(n + ':' + e.detail.kind + ':' + e.detail.taskId + ':' + (e.detail.el === ${holdCard}))))`)
await evalJS(`(() => { const el = ${holdCard}; const r = el.getBoundingClientRect(); window.__pt = [r.x + 20, r.y + 20];
  __ptr('pointerdown', el, ...__pt); })()`)
check('pressing a card stops text selection', await evalJS(`document.body.classList.contains('card-pressing')`))
await evalJS(`new Promise(r => setTimeout(r, 900))`)
check('a 600ms hold adds the held class and calls the hold hook', await evalJS(
  `${holdCard}.classList.contains('is-held') && __holds.join() === 'start:bd0002'`))
check('the held ring is the card plus 2px each way, over the bucket stripe', await evalJS(
  `(() => { const el = ${holdCard}; const c = el.getBoundingClientRect();
    const a = getComputedStyle(el, '::after'), b = getComputedStyle(el, '::before');
    const pad = a.boxSizing === 'border-box' ? 0 : 2;
    const w = parseFloat(a.width) + pad, h = parseFloat(a.height) + pad;
    return Math.abs(w - (c.width + 2)) < 1.5 && Math.abs(h - (c.height + 2)) < 1.5 &&
      a.backgroundImage.includes('linear-gradient') && parseFloat(b.width) > 0 &&
      getComputedStyle(el).borderLeftColor === 'rgba(0, 0, 0, 0)' &&
      Math.abs(parseFloat(a.left) + parseFloat(getComputedStyle(el).borderLeftWidth) + 1) < 0.5 &&
      parseFloat(b.left) === -parseFloat(getComputedStyle(el).borderLeftWidth) && getComputedStyle(el).outlineStyle === 'none'; })()`))
await evalJS(`window.__eff = el => { let o = 1; for (; el; el = el.parentElement) o *= +getComputedStyle(el).opacity; return o }`)
check('the rest of the page dims while a card is held, and the held card does not', await evalJS(
  `(() => { const other = document.querySelector('#board .tenon-card[data-id="bd0001"]');
    return __eff(other) < 0.35 && __eff(document.querySelector('#headline')) <= 0.35 &&
      __eff(${holdCard}) === +getComputedStyle(${holdCard}).opacity &&
      __eff(${holdCard}.closest('.tenon-column')) === +getComputedStyle(${holdCard}.closest('.tenon-column')).opacity &&
      !${holdCard}.closest('.tenon-column').classList.contains('spot-dim'); })()`))
const otherCard = `document.querySelector('#board .tenon-card[data-id="bd0001"]')`
const oc = await evalJS(`(() => { const r = ${otherCard}.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: oc[0], y: oc[1] })
await wait(300)
check('while held, another card gets no hover and the pointer is not over it', await evalJS(
  `!${otherCard}.matches(':hover') && document.elementFromPoint(${oc[0]}, ${oc[1]}) !== ${otherCard} &&
   getComputedStyle(${otherCard}).pointerEvents === 'none'`))
check('the held card keeps its hover look with the pointer moved off', await evalJS(
  `!${holdCard}.matches(':hover') && +getComputedStyle(${holdCard}).opacity === 1 && state.openTask !== 'bd0002'`))
await evalJS(`__ptr('pointerup', null, ...__pt); ${holdCard}.click()`)
await evalJS(`new Promise(r => setTimeout(r, 300))`)
check('releasing keeps the card held and the page dimmed', await evalJS(
  `${holdCard}.classList.contains('is-held') && ${holdCard}.classList.contains('spot-on') &&
   document.body.classList.contains('spotlit') && __holds.join() === 'start:bd0002' &&
   !document.body.classList.contains('card-pressing')`), await evalJS(`[${holdCard}.className, document.body.className, __holds.join()].join(' | ')`))
check('the click after a hold does not open the drawer', await evalJS(`state.openTask !== 'bd0002'`))
await evalJS(`__ptr('pointerdown', ${holdCard}, ...__pt); __ptr('pointerup', null, ...__pt)`)
check('a press inside the held card does not end the focus', await evalJS(`${holdCard}.classList.contains('is-held')`))
await evalJS(`document.body.insertAdjacentHTML('beforeend', '<div data-focus-keep id="__keep"><button>x</button></div>')`)
await evalJS(`__ptr('pointerdown', document.querySelector('#__keep button'), 5, 5); __ptr('pointerup', null, 5, 5)`)
check('a press inside a [data-focus-keep] element does not end the focus', await evalJS(
  `${holdCard}.classList.contains('is-held') && !document.querySelector('#__keep').classList.contains('spot-dim') &&
   getComputedStyle(document.querySelector('#__keep')).pointerEvents === 'auto'`))
await evalJS(`__ptr('pointerdown', document.body, 5, 5)`)
check('a press outside ends it, with the release fade, and calls the end hook', await evalJS(
  `!${holdCard}.classList.contains('is-held') && ${holdCard}.classList.contains('is-releasing') &&
   __holds.join() === 'start:bd0002,end:bd0002'`))
await evalJS(`window.__clicked = 0; document.addEventListener('click', () => __clicked++); ${otherCard}.click()`)
check('the click after that press is swallowed', await evalJS(`__clicked === 0 && state.openTask !== 'bd0001'`))
await evalJS(`__ptr('pointerup', null, 5, 5)`)
await evalJS(`new Promise(r => setTimeout(r, 250))`)
check('after the focus ends the dim is gone and the card is back to rest', await evalJS(
  `document.querySelectorAll('.spot-dim, .spot-undim, .is-releasing, .is-held').length === 0 &&
   !document.body.classList.contains('spotlit') &&
   __eff(document.querySelector('#board .tenon-card[data-id="bd0001"]')) ===
     +getComputedStyle(document.querySelector('#board .tenon-card[data-id="bd0001"]')).opacity &&
   ['none', 'normal'].includes(getComputedStyle(${holdCard}, '::after').content)`))
check('board:focus and board:unfocus fire with the card', await evalJS(
  `__fev.join() === 'board:focus:task:bd0002:true,board:unfocus:task:bd0002:true'`), await evalJS(`__fev.join()`))
/* Esc, and Esc beating the drawer's own. */
await evalJS(`closeDrawer(); openDrawer('bd0001'); __fev.length = 0; (() => { const el = ${holdCard}; __ptr('pointerdown', el, ...__pt); })()`)
await evalJS(`new Promise(r => setTimeout(r, 900))`)
await evalJS(`__ptr('pointerup', null, ...__pt)`)
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
check('Esc ends the focus and leaves the drawer open', await evalJS(
  `!${holdCard}.classList.contains('is-held') && state.openTask === 'bd0001' && !document.body.classList.contains('spotlit')`))
await evalJS(`new Promise(r => setTimeout(r, 250))`)
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
check('with no focus Esc still closes the drawer', await evalJS(`state.openTask === null`))
check('endFocus() ends a focus from code', await evalJS(`(async () => {
  const el = ${holdCard}; __ptr('pointerdown', el, ...__pt); await new Promise(r => setTimeout(r, 900));
  __ptr('pointerup', null, ...__pt);
  const on = el.classList.contains('is-held') && BoardUI.focusedElement() === el;
  BoardUI.endFocus(); await new Promise(r => setTimeout(r, 50));
  return on && !el.classList.contains('is-held') && BoardUI.focusedElement() === null; })()`))
await evalJS(`document.querySelector('#__keep').remove(); new Promise(r => setTimeout(r, 250))`)
check('dragging a focused card ends the focus so drop zones can be reached', await evalJS(`(async () => {
  const el = ${holdCard}; __ptr('pointerdown', el, ...__pt); await new Promise(r => setTimeout(r, 900));
  __ptr('pointerup', null, ...__pt);
  const on = document.body.classList.contains('spotlit');
  const e = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
  el.dispatchEvent(e); await new Promise(r => setTimeout(r, 50));
  return on && !document.body.classList.contains('spotlit') && !el.classList.contains('is-held'); })()`))
await evalJS(`dragId = null; closeDrawer(); renderBoard()`)
check('the press that ends a focus starts no hold on the card it lands on', await evalJS(`(async () => {
  const el = ${holdCard}, other = ${otherCard}; __ptr('pointerdown', el, ...__pt); await new Promise(r => setTimeout(r, 900));
  __ptr('pointerup', null, ...__pt);
  __holds.length = 0;
  __ptr('pointerdown', other, 5, 5); await new Promise(r => setTimeout(r, 900));
  const ok = !document.body.classList.contains('spotlit') && !other.classList.contains('is-held') &&
    !document.body.classList.contains('card-pressing') && __holds.join() === 'end:bd0002';
  __ptr('pointerup', null, 5, 5); return ok; })()`))
await wait(300)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: oc[0] + 1, y: oc[1] + 1 })
await wait(100)
check('after release another card takes hover again', await evalJS(`${otherCard}.matches(':hover')`))
await evalJS(`(() => { spotlight(${holdCard}); clearSpotlight(); clearSpotlight(); })()`)
await wait(300)
check('clearing the spotlight twice leaves nothing behind', await evalJS(
  `document.querySelectorAll('.spot-dim, .spot-undim, .spot-on').length === 0 && !document.body.classList.contains('spotlit')`))
await evalJS(`(() => { const el = ${holdCard}; __ptr('pointerdown', el, ...__pt); __ptr('pointerup', null, ...__pt); el.click(); })()`)
check('a short click still opens the card', await evalJS(`state.openTask === 'bd0002'`))
await evalJS(`closeDrawer(); (() => { const el = ${holdCard}; __ptr('pointerdown', el, ...__pt);
  __ptr('pointermove', null, __pt[0] + 12, __pt[1]); })()`)
await evalJS(`new Promise(r => setTimeout(r, 750))`)
check('moving past 5px before 600ms cancels the hold', await evalJS(`!${holdCard}.classList.contains('is-held')`))
await evalJS(`__ptr('pointerup', null, ...__pt); closeDrawer()`)

/* The one thing stops being it when it is ticked off, unless it repeats. */
check('ticking the one thing into Done clears it', await evalJS(`(() => {
  const t = state.doc.buckets.flatMap(b => b.tiers.flatMap(ti => ti.tasks)).find(t => !t.repeat && !t.done);
  t.headline = '2026-08-17';
  setDone(t, true);
  return t.headline === '';
})()`))
check('ticking a recurring one into Done keeps it the one thing', await evalJS(`(() => {
  const t = state.doc.buckets.flatMap(b => b.tiers.flatMap(ti => ti.tasks)).find(t => !t.repeat && !t.done);
  t.repeat = 'wed';
  t.headline = '2026-08-17';
  setDone(t, false, { stay: true });
  setDone(t, true);
  return t.headline === '2026-08-17';
})()`))

/* ---- the point of the guard ---- */

/* The tab is unlocked here, so the board tries to save after every move. The
   guard tore each attempt out of fetch, and this is the check that nothing
   else was attempted. */
check('no write was attempted but the board saving its own file', await evalJS(`
  window.__blocked.every(b => /^(PUT|HEAD) \\/data\\/todo\\.md/.test(b))
`), await evalJS(`window.__blocked.join(' | ')`))

ws.close()
chrome.kill()
const failed = checks.filter(c => !c).length
console.log(failed ? `\n${failed} failed` : `\nall ${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
