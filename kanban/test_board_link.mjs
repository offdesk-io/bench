#!/usr/bin/env node
/* A banner's link names its board: #!board=<name>!task=<key>.
 *
 *   scripts/test-board.sh test_board_link.mjs
 *
 * Written 26 Oct 2026. Two lists, a link into the one that is not showing: the
 * board switches (through the list menu's own route), opens the card, and takes
 * the board segment off the address. A link naming a list that does not exist,
 * or the one already up, opens the card where it is. A tab whose list was
 * switched away from elsewhere saves nothing into the new one. It makes a
 * second list, so it runs only against the throwaway server.
 */
import { spawn } from 'node:child_process'
import { CHROME_BIN } from './test_browser.mjs'

const PORT = Number(process.env.CDP_PORT) || 9463
const BOARD = process.env.BOARD_PORT
const BASE = `http://127.0.0.1:${BOARD}`
const checks = []
const check = (name, pass, detail = '') => {
  checks.push(pass)
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}
if (!BOARD) {
  console.error('This makes a list. Run it through: scripts/test-board.sh test_board_link.mjs')
  process.exit(2)
}
const lists = await (await fetch(`${BASE}/datasets.json`)).json()
if (lists.current !== '_test') {
  console.error(`Refusing: the server on ${BOARD} is on "${lists.current}", not _test.`)
  process.exit(2)
}
const post = (path, body) => fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json())
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if (await fn()) return true } catch {}
    await new Promise(r => setTimeout(r, 200))
  }
  return false
}

/* A second list with one card the first does not have, then back to _test. */
await post('/datasets', { name: 'elsewhere' })
const base = await (await fetch(`${BASE}/data/todo.md`, { cache: 'no-store' })).text()
const doc = ['# To-do', '', '## 1. Work', '', '### Doing', '', '- [ ] **Only on the other list** `#only-there` `id:zz9y8x`', ''].join('\n')
const saved = await fetch(`${BASE}/data/todo.md`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: doc, base }) })
await post('/dataset/select', { name: '_test' })

const chrome = spawn(CHROME_BIN, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  `--user-data-dir=${process.env.CHROME_PROFILE || '/tmp/todo-board-link-test-profile'}`, '--window-size=1400,1000',
  `${BASE}/kanban/index.html`
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
const dialogs = []
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  /* An alert freezes the page and every evaluate with it. Say it was there and
     close it, so a refusal shows up as a failed check rather than a hang. */
  if (m.method === 'Page.javascriptDialogOpening') {
    dialogs.push(m.params.message)
    ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }))
  }
}
const send = (method, params) => new Promise(res => {
  const n = ++id
  pending.set(n, res)
  ws.send(JSON.stringify({ id: n, method, params }))
})
/* A navigation destroys the page's context mid-call, and Runtime.evaluate then
   never answers. Every call is bounded, so a poll that lands in that gap fails
   and tries again instead of hanging the suite. */
async function evalJS (expr, ms = 3000) {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('evaluate timed out')), ms))
  ])
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400))
  return r.result?.result?.value
}

const go = async url => {
  await send('Page.navigate', { url: 'about:blank' })
  await new Promise(r => setTimeout(r, 300))
  await send('Page.navigate', { url })
  await until(() => evalJS(`typeof state !== 'undefined' && !!state.doc`))
}
const OPEN = `(state.openTask ? (locate(state.openTask)?.task.title || '') : '')`
const link = frag => `${BASE}/kanban/index.html${frag}`

await send('Page.enable', {})
try {
  check('the second list exists with its card', saved.ok && (await (await fetch(`${BASE}/datasets.json`)).json()).datasets.includes('elsewhere'))

  await go(link('#!board=elsewhere!task=only-there'))
  check('a link naming the other list switches to it', await until(() => evalJS(`state.dataset === 'elsewhere'`)))
  check('and opens the card there', await until(async () => (await evalJS(OPEN)) === 'Only on the other list'),
    await evalJS(`JSON.stringify({ open: state.openTask, titles: state.doc.buckets.flatMap(b => b.tiers).flatMap(t => t.tasks).map(t => t.title), hash: location.hash, pend: state.pendingTask })`))
  check('and the board segment is gone from the address', await evalJS(`!location.hash.includes('board=')`), await evalJS('location.hash'))
  await send('Page.reload', {})
  await new Promise(r => setTimeout(r, 800))
  await until(() => evalJS(`typeof state !== 'undefined' && !!state.doc`))
  check('a reload stays on that list rather than switching again', await evalJS(`state.dataset`) === 'elsewhere')

  /* The same card by its id and by its title with spaces, as a banner's link
     carries them, loaded fresh the way `open <url>` lands in a new tab. */
  await post('/dataset/select', { name: '_test' })
  await go(link('#!board=elsewhere!task=zz9y8x'))
  check('a fresh load by the task id switches and opens the card', await until(async () => (await evalJS(OPEN)) === 'Only on the other list'),
    await evalJS(`JSON.stringify({ ds: state.dataset, names: state.datasetNames, hash: location.hash, open: state.openTask, pb: state.pendingBoard, pt: state.pendingTask, sw: state.switching, dialogs: ${JSON.stringify(dialogs)} })`).catch(e => String(e)))
  await post('/dataset/select', { name: '_test' })
  await go(link('#!board=elsewhere!task=Only%20on%20the%20other%20list'))
  check('and by its title, %20 and all', await until(async () => (await evalJS(OPEN)) === 'Only on the other list') && await evalJS(`state.dataset`) === 'elsewhere')

  await post('/dataset/select', { name: '_test' })
  const known = 'Chase the 360 responses'
  await go(link('#!board=no-such-list!task=' + encodeURIComponent(known)))
  check('an unknown list is ignored and the card opens where it is', await until(async () => (await evalJS(OPEN)) === known))
  check('still on _test, and the board segment is gone', await evalJS(`state.dataset === '_test' && !location.hash.includes('board=')`), await evalJS('location.hash'))

  await go(link('#!board=_test!task=' + encodeURIComponent(known)))
  check('naming the list already up opens the card without switching', await until(async () => (await evalJS(OPEN)) === known) && await evalJS(`state.dataset`) === '_test')

  await go(link('#!task=' + encodeURIComponent(known)))
  check('a link with no board behaves as before', await until(async () => (await evalJS(OPEN)) === known))

  /* A switch the browser keeps the tab through (the leave-site prompt, cancelled)
     must give saving back, and point the server at this list again. */
  await post('/dataset/select', { name: '_test' })
  await go(link(''))
  /* A slow reload first: nothing was prompted, so nothing is posted back. */
  await evalJS(`window.reloadPage = () => {}; switchDataset('elsewhere')`)
  await until(async () => (await (await fetch(`${BASE}/datasets.json`)).json()).current === 'elsewhere')
  await new Promise(r => setTimeout(r, 3800))
  check('a slow reload is not mistaken for a cancelled one: the server stays on the new list',
    (await (await fetch(`${BASE}/datasets.json`)).json()).current === 'elsewhere' && await evalJS(`state.switching`))
  await post('/dataset/select', { name: '_test' })
  await evalJS(`state.switching = false`)
  /* Now one the leave-site prompt was raised for. */
  await evalJS(`window.reloadPage = () => { state.leavePrompted = true; }; markDirty(); switchDataset('elsewhere')`)
  await until(async () => (await (await fetch(`${BASE}/datasets.json`)).json()).current === 'elsewhere')
  check('while a switch is under way a save is refused, out loud', await evalJS(`(saveFile(true), state.switching && /switching lists/.test($('#status').textContent))`))
  await new Promise(r => setTimeout(r, 3800))
  check('a switch the page survives clears itself', await evalJS(`!state.switching`))
  check('and the server is pointed back at this list', (await (await fetch(`${BASE}/datasets.json`)).json()).current === '_test')
  check('and the board can save again: the save goes out', await evalJS(`(async () => {
    const real = window.fetch; let puts = 0;
    window.fetch = (u, o) => { if (o && o.method === 'PUT') puts++; return real(u, o); };
    state.dirty = true;
    await saveFile(true);
    window.fetch = real;
    return puts === 1;
  })()`))

  /* Two tabs on two lists: the server is moved to another list from
     somewhere else (another tab's menu, here a POST), and this tab still
     holds the one it read. Its save names that list, so it is refused rather
     than merged into the other one. */
  await go(link(''))
  await until(() => evalJS(`state.docBoard === '_test' && !state.dirty`))
  check('a tab knows which list it read', await evalJS(`state.docBoard`) === '_test')
  await evalJS(`window.reloadPage = () => { window.reloadedForMove = true; }`)
  await post('/dataset/select', { name: 'elsewhere' })
  const otherBefore = await (await fetch(`${BASE}/data/todo.md`, { cache: 'no-store' })).text()
  await evalJS(`(() => {
    const t = state.doc.buckets.flatMap(b => b.tiers).flatMap(t => t.tasks)[0];
    t.title = t.title + ' edited here';
    t.dirty = true;
    markDirty();
  })()`)
  await evalJS(`saveFile(true)`)
  const otherAfter = await (await fetch(`${BASE}/data/todo.md`, { cache: 'no-store' })).text()
  check('a save after the list moved elsewhere writes nothing into the other list', otherAfter === otherBefore && !otherAfter.includes('edited here'))
  check('the tab says the board moved and keeps its changes',
    await evalJS(`state.boardMoved === 'elsewhere' && state.dirty && !!modalEl && !window.reloadedForMove`),
    await evalJS(`JSON.stringify({ moved: state.boardMoved, dirty: state.dirty, modal: !!modalEl })`))
  await evalJS(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Switch back and save').click()`)
  check('switching back saves the changes on the list they were made on',
    await until(async () => (await (await fetch(`${BASE}/data/todo.md`, { cache: 'no-store' })).text()).includes('edited here')) &&
      (await (await fetch(`${BASE}/datasets.json`)).json()).current === '_test' && await evalJS(`!state.dirty && !state.boardMoved`),
    await evalJS(`JSON.stringify({ moved: state.boardMoved, dirty: state.dirty, status: $('#status').textContent })`))
  /* With nothing unsaved, the tab simply goes over to the list now on. */
  await post('/dataset/select', { name: 'elsewhere' })
  await evalJS(`watchOnce()`)
  check('a tab with nothing unsaved reloads onto the list the board moved to',
    await until(() => evalJS(`window.reloadedForMove === true`)) && await evalJS(`!modalEl`))
  await post('/dataset/select', { name: '_test' })

  /* Typing before the board list has answered: the changes may be the person's,
     so the link asks instead of switching. The answer is held back to make the
     order certain. */
  const hold = await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const real = window.fetch;
    window.fetch = (u, o) => String(u).includes('datasets.json')
      ? new Promise(r => setTimeout(() => r(real(u, o)), 1500)) : real(u, o);
  })()` })
  dialogs.length = 0
  await go(link('#!board=elsewhere!task=zz9y8x'))
  await evalJS(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })); applyDirty()`)
  await new Promise(r => setTimeout(r, 2500))
  check('typing before the board list arrives blocks the switch', await evalJS(`state.dataset === '_test'`) && dialogs.length === 1, JSON.stringify(dialogs))
  check('and the board segment still comes off the address', await evalJS(`!location.hash.includes('board=')`))
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: hold.result.identifier })

  /* An open tab has long since heard the list of boards; wait for that here, or
     the link arrives before there is a board to switch to. */
  dialogs.length = 0
  await until(() => evalJS(`state.datasetNames.length > 1 && !state.dirty`))
  await evalJS(`closeDrawer()`)
  await evalJS(`location.hash = '#!board=elsewhere!task=only-there'`)
  check('a link arriving at a tab that is already open switches too', await until(() => evalJS(`state.dataset === 'elsewhere'`)) && !dialogs.length,
    await evalJS(`JSON.stringify({ ds: state.dataset, names: state.datasetNames, hash: location.hash, dirty: state.dirty })`))
} catch (err) {
  check('the suite ran to the end', false, String(err.message || err))
} finally {
  await post('/dataset/select', { name: '_test' }).catch(() => {})
  ws.close()
  chrome.kill()
}

const failed = checks.filter(p => !p).length
console.log(`\n${checks.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
