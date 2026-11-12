/**
 * Drives drag to reorder on a task's sub-steps in the drawer, in headless
 * Chrome. The drawer used to run its own dragstart/dragover/drop; it now
 * drags by the grip through `BoardUI.bindReorder` (Tenon v0.9.0), the same
 * as the bucket and column editors.
 *
 *   python3 kanban/server.py &          # or BOARD_PORT=... at one already up
 *   node kanban/test_drawer_subtask_reorder.mjs
 *
 * Same guard as the other browser suites: every non-GET is torn out of
 * `fetch`, so nothing here can reach todo.md.
 */

import { spawn } from 'node:child_process'
import { CHROME_BIN } from './test_browser.mjs'

const PORT = Number(process.env.CDP_PORT) || 9453
const BOARD = process.env.BOARD_PORT || 8765
if (!process.env.BOARD_PORT) console.error('Note: this runs against the live board on 8765. For a throwaway copy: scripts/test-board.sh test_drawer_subtask_reorder.mjs')
const checks = []
const check = (name, pass, detail = '') => {
  checks.push(pass)
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const chrome = spawn(CHROME_BIN, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  `--user-data-dir=${process.env.CHROME_PROFILE || '/tmp/todo-drawer-subtask-reorder-profile'}`, '--window-size=1400,1000',
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
// A hold is 600ms and the fade 200ms more, which a fixed wait left too little
// room around on a slow machine; this waits for the state itself instead.
const until = async (expr, ms = 3000) => {
  for (let t = 0; t < ms; t += 50) { if (await evalJS(expr)) return true; await wait(50) }
  return false
}

try {
  // Poll for the page rather than sleeping: a fixed wait fails when the machine is busy.
  for (let i = 0; i < 120 && !(await evalJS(`document.readyState === 'complete' && typeof state !== 'undefined' && !!state.doc`).catch(() => false)); i++) await new Promise(r => setTimeout(r, 250))
  await new Promise(r => setTimeout(r, 400))
  check('the board loaded', await evalJS(`typeof openDrawer === 'function' && typeof moveSub === 'function'`))

  await evalJS(`(() => {
    const real = window.fetch;
    window.__blocked = [];
    window.fetch = (u, o) => {
      const m = (o && o.method) || 'GET';
      if (m !== 'GET') { window.__blocked.push(m + ' ' + u); return Promise.resolve(new Response('{}', { status: 200 })) }
      return real(u, o);
    };
    window.__dt = new DataTransfer();
    window.__fire = (type, el, where) => {
      const r = el.getBoundingClientRect();
      const y = where === 'lower' ? r.bottom - 2 : r.top + 2;
      return el.dispatchEvent(new DragEvent(type, {
        bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: y, dataTransfer: window.__dt
      }));
    };
    return 'ready';
  })()`)

  await evalJS(`(() => {
    load([
      '# To-do', '', '## 1. People', '',
      '### To do', '',
      '- [ ] Alpha \`id:sr0001\`',
      '  - [ ] first step',
      '  - [ ] second step',
      '  - [ ] third step',
      ''
    ].join('\\n'), 'demo.md', {});
    state.locked = false;
    renderView();
    return 'loaded';
  })()`)
  check('nothing has been written yet', await evalJS(`window.__blocked.length === 0`))

  const opened = await evalJS(`(() => {
    const alpha = allItems().find(i => !i.sub);
    openDrawer(alpha.id);
    return { rows: document.querySelectorAll('#f-subs .sub').length };
  })()`)
  check('the drawer opened with all three steps, each a grip row', opened.rows === 3, `${opened.rows} rows`)
  check('grip carries data-tenon-grip', await evalJS(`!!document.querySelector('#f-subs [data-tenon-grip]')`))
  check('a row is not draggable itself — only the grip starts a drag',
    await evalJS(`document.querySelector('#f-subs .sub').getAttribute('draggable') !== 'true'`))

  const before = await evalJS(`[...document.querySelectorAll('#f-subs .subtext')].map(s => s.textContent.trim())`)
  await evalJS(`(async () => {
    const rows = [...document.querySelectorAll('#f-subs .sub')];
    const grip = rows[0].querySelector('[data-tenon-grip]');
    __fire('dragstart', grip);
    await new Promise(r => setTimeout(r, 20));
    __fire('dragover', rows[1], 'lower');
    __fire('drop', rows[1], 'lower');
    __fire('dragend', grip);
    return 'dropped';
  })()`)
  await wait(100)
  const after = await evalJS(`[...document.querySelectorAll('#f-subs .subtext')].map(s => s.textContent.trim())`)
  check('dragging the first step onto the second moves it after that one',
    JSON.stringify(after) === JSON.stringify([before[1], before[0], before[2]]),
    `${after.join(' | ')}`)
  check('no drag reached the file', await evalJS(`window.__blocked.length === 0`))

  check('the old dragging/over-top/over-bottom classes are never applied',
    await evalJS(`document.querySelectorAll('.sub.dragging,.sub.over-top,.sub.over-bottom').length === 0`))

  /* ---- press and hold on the drawer (ui/hold.ts, wireDrawerHold) ---- */
  await evalJS(`(() => {
    window.__ptr = (type, el, x, y) => (type === 'pointerdown' ? el : window).dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerType: 'mouse', button: 0, clientX: x, clientY: y }));
    window.__mid = el => { const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] };
    window.__eff = el => { let o = 1; for (; el; el = el.parentElement) o *= +getComputedStyle(el).opacity; return o };
    return 'ready';
  })()`)
  const sec = `document.querySelector('#dbody .dcol > details[data-collapse="details"]')`
  const sib = `document.querySelector('#dbody .dcol > details[data-collapse="sugg:history"]')`
  const row = `document.querySelector('#f-subs .sub')`
  check('the drawer has sections and a sibling section to dim', await evalJS(`!!${sec} && !!${sib}`))
  await evalJS(`window.__fev = []; ['board:focus', 'board:unfocus'].forEach(n => window.addEventListener(n, e =>
    __fev.push(n + ':' + e.detail.kind + ':' + e.detail.taskId + ':' + (e.detail.section || e.detail.subIndex))))`)
  await evalJS(`(() => { const p = __mid(${sec}.querySelector('summary')); __ptr('pointerdown', ${sec}.querySelector('summary'), ...p) })()`)
  await until(`${sec}.classList.contains('is-held') && __eff(${sib}) <= 0.35 && __eff(${row}) <= 0.35`)
  check('holding a section gives it the held class', await evalJS(`${sec}.classList.contains('is-held')`))
  check('the held section stays lit and its sibling section and the sub-task cards fade',
    await evalJS(`__eff(${sec}) === +getComputedStyle(${sec}).opacity && __eff(${sib}) <= 0.35 && __eff(${row}) <= 0.35`),
    await evalJS(`JSON.stringify([__eff(${sec}), +getComputedStyle(${sec}).opacity, __eff(${sib}), __eff(${row})])`))
  check('a section hold draws the ring', await evalJS(`getComputedStyle(${sec}, '::after').content !== 'none'`))
  await evalJS(`__ptr('pointerup', null, 0, 0)`)
  await wait(350)
  check('releasing leaves the section held', await evalJS(`${sec}.classList.contains('is-held') && document.body.classList.contains('spotlit')`))
  await evalJS(`__ptr('pointerdown', document.body, 0, 0); __ptr('pointerup', null, 0, 0)`)
  await wait(350)
  check('a press outside clears the held class and the fade',
    await evalJS(`document.querySelectorAll('.is-held, .is-releasing, .holdable, .spot-dim, .spot-undim').length === 0`))
  check('the section focus events carry the task and the section name', await evalJS(
    `__fev.length === 2 && __fev[0] === 'board:focus:section:' + state.openTask + ':' + __fev[0].split(':').pop() && !/undefined$/.test(__fev[0])`),
    await evalJS(`__fev.join()`))

  await evalJS(`(() => { const r = ${row}; __ptr('pointerdown', r.querySelector('.subtext'), ...__mid(r.querySelector('.subtext'))) })()`)
  await until(`${row}.classList.contains('is-held') && __eff(document.querySelectorAll('#f-subs .sub')[1]) <= 0.35 && __eff(${sib}) <= 0.35`)
  check('holding a sub-task card gives it the held class, and not its section',
    await evalJS(`${row}.classList.contains('is-held') && !${row}.closest('.dcol > .field').classList.contains('is-held')`))
  check('the other sub-task cards and the other sections fade',
    await evalJS(`__eff(document.querySelectorAll('#f-subs .sub')[1]) <= 0.35 && __eff(${sib}) <= 0.35 && __eff(${row}) === +getComputedStyle(${row}).opacity`))
  await evalJS(`__fev.length = 0; __ptr('pointerup', null, 0, 0); ${row}.click()`)
  await wait(350)
  check('the click after a hold does not open the sub-task', await evalJS(`!document.querySelector('#subpanel').classList.contains('open')`))
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await wait(350)
  check('Esc ends the sub-task focus and leaves the drawer open',
    await evalJS(`!${row}.classList.contains('is-held') && !!state.openTask && $('#drawer').classList.contains('open') && __fev.join() === 'board:unfocus:subtask:' + state.openTask + ':0'`),
    await evalJS(`__fev.join()`))
  check('nothing is left held after the sub-task hold',
    await evalJS(`document.querySelectorAll('.is-held, .is-releasing, .holdable, .spot-dim, .spot-undim').length === 0`))

  await evalJS(`(() => { const t = document.querySelector('#f-title'); __ptr('pointerdown', t, ...__mid(t)) })()`)
  await wait(950)
  check('a press inside a field starts no hold', await evalJS(`document.querySelectorAll('.is-held').length === 0`))
  await evalJS(`__ptr('pointerup', null, 0, 0)`)

  await evalJS(`(() => { const g = ${row}.querySelector('[data-tenon-grip]'); __ptr('pointerdown', g, ...__mid(g)) })()`)
  await wait(950)
  check('a press on the grip starts no hold', await evalJS(`document.querySelectorAll('.is-held').length === 0`))
  await evalJS(`__ptr('pointerup', null, 0, 0)`)

  await evalJS(`(() => { const r = ${row}.querySelector('.subtext'); __ptr('pointerdown', r, ...__mid(r)); __ptr('pointerup', null, 0, 0); })()`)
  await evalJS(`${row}.click()`)
  await wait(300)
  check('a short click on a sub-task card still opens it',
    await evalJS(`document.querySelector('#subpanel').classList.contains('open')`))
} finally {
  chrome.kill()
}

const failed = checks.filter(c => !c).length
console.log(`\n${checks.length - failed} passed${failed ? `, ${failed} failed` : ''}\n`)
process.exit(failed ? 1 : 0)
