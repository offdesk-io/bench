#!/usr/bin/env node
/* The first minutes of a new list: which view it opens on, the first-task
 * input on an empty board, and a new task's drawer.
 *
 *   scripts/test-board.sh test_first_view.mjs
 *
 * Written 14 Nov 2026. Fetch is torn out so no write can leave the page.
 */
import { spawn } from 'node:child_process'
import { CHROME_BIN } from './test_browser.mjs'

const PORT = Number(process.env.CDP_PORT) || 9512
const BOARD = process.env.BOARD_PORT || 8765
if (!process.env.BOARD_PORT) console.error('Note: this runs against the live board on 8765. For a throwaway copy: scripts/test-board.sh test_first_view.mjs')
const checks = []
const check = (name, pass, detail = '') => {
  checks.push(pass)
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const chrome = spawn(CHROME_BIN, [
  '--headless=new', '--mute-audio', `--remote-debugging-port=${PORT}`, '--no-first-run',
  `--user-data-dir=${process.env.CHROME_PROFILE || '/tmp/todo-first-view-test-profile'}`, '--window-size=1400,1000',
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

try {
  for (let i = 0; i < 120 && !(await evalJS(`document.readyState === 'complete' && typeof state !== 'undefined' && !!state.doc`).catch(() => false)); i++) await wait(250)
  await wait(400)
  await evalJS(`(() => {
    state.locked = true;
    const real = window.fetch;
    window.__blocked = [];
    window.fetch = (u, o) => {
      const m = (o && o.method) || 'GET';
      if (m !== 'GET') { window.__blocked.push(m + ' ' + u); return Promise.resolve(new Response('{}', { status: 200 })) }
      return real(u, o);
    };
    window.__empty = ['# To-do', '', '## 1. Making', '', '### To do', '', '## 2. Admin', '', '### To do', ''].join('\\n');
    window.__ticked = ['# To-do', '', '## 1. Making', '', '### Done', '', '- [x] **Old**', ''].join('\\n');
    window.__open = ['# To-do', '', '## 1. Making', '', '### To do', '', '- [ ] **Open**', '', '## 2. Admin', '', '### To do', ''].join('\\n');
    state.viewFromHash = false;
    try { Object.keys(localStorage).filter(k => k.startsWith('bench-view:')).forEach(k => localStorage.removeItem(k)) } catch (e) {}
  })()`)

  /* ---- the opening view ---- */
  const opens = text => evalJS(`(() => { state.locked = true; load(${JSON.stringify(text)}, 'a.md', { opening: true, board: 'tb' }); return state.view })()`)
  check('a list with nothing ticked off opens on Board', await opens(await evalJS('__empty')) === 'board')
  check('so does one with open tasks and none ticked', await opens(await evalJS('__open')) === 'board')
  check('a list with something ticked off opens on Overview', await opens(await evalJS('__ticked')) === 'overview')
  await evalJS(`state.view = 'matrix'; renderView()`)
  await evalJS(`state.locked = false; state.docBoard = 'tb'; state.view = 'matrix'; renderView()`)
  check('a returning owner gets the view they last used', await opens(await evalJS('__ticked')) === 'matrix')
  await evalJS(`state.viewFromHash = true; state.view = 'timeline'`)
  check('a view named in the URL beats the remembered one', await opens(await evalJS('__ticked')) === 'timeline')
  await evalJS(`state.viewFromHash = false; localStorage.removeItem('bench-view:tb'); state.docBoard = ''`)

  /* ---- the empty board ---- */
  await evalJS(`load(__empty, 'a.md', {}); state.locked = false; state.view = 'board'; renderView()`)
  await wait(300)
  check('an empty board holds one input in the first column, "What’s on your plate?"', await evalJS(`(() => {
    const i = document.querySelectorAll('#board textarea.intake');
    return i.length === 1 && i[0].placeholder === 'What’s on your plate?' && i[0].closest('.tenon-column') === document.querySelector('#board .tenon-column');
  })()`))
  await evalJS(`state.locked = true; renderBoard()`)
  await wait(150)
  check('a locked board has no input', await evalJS(`!document.querySelector('#board textarea.intake')`))
  await evalJS(`state.locked = false; renderBoard()`)
  await wait(150)
  await evalJS(`(() => {
    const ta = document.querySelector('#board textarea.intake');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, 'Send invoice\\n\\nBook the van\\nSand the table');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await wait(100)
  await evalJS(`document.querySelector('#board textarea.intake').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`)
  await wait(300)
  check('Enter makes one task per line, skipping blank ones', await evalJS(`JSON.stringify(state.doc.buckets[0].tiers[0].tasks.map(t => t.title))`) === JSON.stringify(['Send invoice', 'Book the van', 'Sand the table']))
  check('no drawer opens for them, and the input is gone', await evalJS(`state.openTask === null && !document.querySelector('#board textarea.intake')`))

  /* ---- a new task's drawer ---- */
  await evalJS(`load(__open, 'a.md', {}); state.locked = false; state.view = 'board'; state.bucketFilter = new Set(); renderView(); addTask('To do')`)
  await wait(300)
  const under = `(() => {
    const main = document.querySelector('.dcol-main'), det = main.querySelector('details[data-collapse=details]');
    const kids = [...main.children];
    const title = kids.findIndex(k => k.querySelector('#f-title'));
    const nf = kids.findIndex(k => k.classList.contains('dnewfields'));
    const d = k => document.querySelector(k);
    return title > -1 && nf === title + 1 && !!main.querySelector('.dnewfields #f-dates') && !!main.querySelector('.dnewfields #f-to') &&
      !det.querySelector('#f-dates, #f-to, #f-bucket-chips, [data-pick-host="f-bucket"]');
  })()`
  check('Bucket, Due and Delegate to sit right under the title, outside Details', await evalJS(under))
  check('the head reads "New task" until it has a title', await evalJS(`document.querySelector('#drawerTitle').textContent`) === 'New task')
  check('under the All tab the bucket shows as chips', await evalJS(`document.querySelectorAll('#f-bucket-chips button').length`) === 2, await evalJS(`JSON.stringify([!!document.querySelector('.dnewfields'), state.bucketFilter.size, document.querySelector('.dnewfields')?.innerHTML.slice(0,300)])`))
  check('the first bucket is the one picked', await evalJS(`(() => { const b = [...document.querySelectorAll('#f-bucket-chips button')]; return b[0].textContent === 'Making' && b[0].getAttribute('aria-pressed') === 'true' && b[1].getAttribute('aria-pressed') === 'false' })()`))
  await evalJS(`document.querySelectorAll('#f-bucket-chips button')[1].click()`)
  await wait(300)
  const where = await evalJS(`JSON.stringify([locate(state.openTask).bucket.name, document.querySelector('.dnewfields') !== null, document.querySelector('#drawerTitle').textContent])`)
  check('picking a chip files the task there and the fields stay under the title', where === JSON.stringify(['Admin', true, 'New task']), where)
  await evalJS(`(() => { const el = document.querySelector('#f-title'); el.value = 'Invoice Sam'; el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  check('once it has a title the head reads Edit task', await evalJS(`document.querySelector('#drawerTitle').textContent`) === 'Edit task')
  await evalJS(`openDrawer(state.doc.buckets[0].tiers[0].tasks[0].id)`)
  await wait(300)
  check('another card opens with the usual Details layout', await evalJS(`!document.querySelector('.dnewfields') && !!document.querySelector('details[data-collapse=details] #f-dates')`))
  await evalJS(`state.bucketFilter = new Set(['Admin']); addTask('To do')`)
  await wait(300)
  check('with a bucket tab on, the bucket stays a dropdown', await evalJS(`!document.querySelector('#f-bucket-chips') && !!document.querySelector('.dnewfields [data-pick-host="f-bucket"]')`))

  check('every write was torn out before it left the page', await evalJS(`window.__blocked.every(w => /\\/data\\/todo\\.md$/.test(w))`), await evalJS(`window.__blocked.join(' | ')`))
} finally {
  ws.close()
  chrome.kill()
}

const failed = checks.filter(c => !c).length
console.log(failed ? `\n${failed} failed` : `\nall ${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
