#!/usr/bin/env node
/* Merging on save, from the tab's side: what the board does with a save the
 * server merged, the box for the same field changed in two places, and the
 * watcher bringing in somebody else's change without closing the open task.
 *
 *   scripts/test-board.sh test_merge_board.mjs
 *
 * It saves for real, so it runs only against the script's throwaway `_test`
 * list and refuses anything else, the live board on 8765 included. "Somebody
 * else" is this script saving {text, base} the way a second tab would.
 */
import { spawn } from 'node:child_process'
import { CHROME_BIN } from './test_browser.mjs'

const PORT = Number(process.env.CDP_PORT) || 9461
const BOARD = process.env.BOARD_PORT
const BASE = `http://127.0.0.1:${BOARD}`
const checks = []
const check = (name, pass, detail = '') => {
  checks.push(pass)
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

if (!BOARD) {
  console.error('This suite saves for real. Run it through: scripts/test-board.sh test_merge_board.mjs')
  process.exit(2)
}
const lists = await (await fetch(`${BASE}/datasets.json`)).json()
if (lists.current !== '_test') {
  console.error(`Refusing: the server on ${BOARD} is on "${lists.current}", not _test.`)
  process.exit(2)
}

const disk = async () => (await fetch(`${BASE}/data/todo.md?t=${Date.now()}`, { cache: 'no-store' })).text()
/* Somebody else's save: read the file, change one line, save it on that read. */
async function elsewhere (from, to) {
  const base = await disk()
  if (!base.includes(from)) throw new Error('not on disk: ' + from)
  const res = await fetch(`${BASE}/data/todo.md`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: base.replace(from, to), base })
  })
  if (!res.ok) throw new Error('the other save answered ' + res.status)
}
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if (await fn()) return true } catch {}   // the page may not be up yet
    await new Promise(r => setTimeout(r, 200))
  }
  return false
}

const chrome = spawn(CHROME_BIN, [
  '--headless=new', '--mute-audio', `--remote-debugging-port=${PORT}`, '--no-first-run',
  `--user-data-dir=${process.env.CHROME_PROFILE || '/tmp/todo-merge-test-profile'}`, '--window-size=1400,1000',
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
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400))
  return r.result?.result?.value
}

try {
  check('the board loaded the _test list',
    await until(() => evalJS(`!!(state.doc && state.fileName === 'todo.md' && !state.locked)`)))
  check('it checks every 3 seconds on screen and every 15 hidden',
    await evalJS(`WATCH_MS === 3000 && WATCH_HIDDEN_MS === 15000`))

  // The load gives every task an id and wants to save it; let it, so the
  // file and the tab start out the same.
  await evalJS(`(async () => { if (state.dirty) await saveFile(false); })()`)
  check('the list starts out saved', await until(async () => (await disk()).includes('`id:')))
  const task = title => `(() => { let f = null; state.doc.buckets.forEach(b => b.tiers.forEach(t => t.tasks.forEach(k => { if (k.title === ${JSON.stringify(title)}) f = k; }))); return f; })()`

  // --- different tasks: the save is merged and the tab shows both ----------------
  await elsewhere('**Chase the 360 responses**', '**Chase the 360 responses today**')
  await evalJS(`(async () => {
    const t = ${task('Tidy up the shared 1:1 notes template')};
    t.due = '2026-12-01'; t.dirty = true; markDirty();
    await saveFile(false);
  })()`)
  const both = await disk()
  check('two saves on different tasks both reach the file',
    both.includes('**Chase the 360 responses today**') && /Tidy up the shared 1:1 notes template\*\*.*\[due:: 2026-12-01\]/.test(both))
  check('and the tab shows the other change',
    await until(() => evalJS(`!!${task('Chase the 360 responses today')}`)))
  check('with nothing left unsaved', await until(() => evalJS(`!state.dirty`)))

  // --- the watcher: somebody else's change arrives, the open task stays open -----
  await evalJS(`(() => { openDrawer(${task('Decide whether to open the mid-weight design role')}.id);
                         document.activeElement && document.activeElement.blur(); })()`)
  await elsewhere('**Rewrite the design career framework**', '**Rewrite the career framework**')
  check('the watcher brings in a change made elsewhere',
    await until(() => evalJS(`!!${task('Rewrite the career framework')}`)))
  check('and the task that was open is still open',
    await evalJS(`(() => { const l = state.openTask != null && locate(state.openTask);
                           return !!l && l.task.title === 'Decide whether to open the mid-weight design role'; })()`))
  await evalJS(`closeDrawer()`)

  // --- the same field: the box names the task and field ---------------------------
  await elsewhere(/\*\*Review the onboarding flow before it ships\*\*/.exec(await disk())[0] + ' [impact:: high] [effort:: S] [due:: 2026-08-28]',
                  '**Review the onboarding flow before it ships** [impact:: high] [effort:: S] [due:: 2026-12-24]')
  await evalJS(`(async () => {
    const t = ${task('Review the onboarding flow before it ships')};
    t.due = '2026-12-25'; t.dirty = true; markDirty();
    await saveFile(false);
  })()`)
  check('the same field changed in two places opens the box',
    await until(() => evalJS(`!!modalEl && /Changed in two places/.test(modalEl.textContent)`)))
  const said = await evalJS(`modalEl ? modalEl.textContent : ''`)
  check('naming the task and the field',
    said.includes('Review the onboarding flow before it ships') && said.includes('due date'), said.slice(0, 200))
  check('and nothing was written yet', (await disk()).includes('[due:: 2026-12-24]'))
  await evalJS(`Array.from(modalEl.querySelectorAll('button')).find(b => b.textContent.trim() === 'Keep mine').click()`)
  check('Keep mine saves mine', await until(async () => (await disk()).includes('[due:: 2026-12-25]')))
  check('and the box is gone', await evalJS(`!modalEl`))

  // --- deleted here, edited there ------------------------------------------------
  await elsewhere('**Audit which projects have no design owner**', '**Audit which projects have no owner**')
  await evalJS(`(async () => {
    state.doc.buckets.forEach(b => b.tiers.forEach(t => {
      t.tasks = t.tasks.filter(k => k.title !== 'Audit which projects have no design owner');
    }));
    markDirty();
    await saveFile(false);
  })()`)
  check('deleted here and edited there opens the box',
    await until(() => evalJS(`!!modalEl && /deleted in one place, edited in the other/.test(modalEl.textContent)`)))
  await evalJS(`Array.from(modalEl.querySelectorAll('button')).find(b => b.textContent.trim() === 'Use theirs').click()`)
  check('Use theirs keeps the edited task on disk',
    await until(async () => (await disk()).includes('**Audit which projects have no owner**')))
  check('and in the tab', await until(() => evalJS(`!!${task('Audit which projects have no owner')}`)))

  // --- Reload with unsaved changes merges first -----------------------------------
  // The watcher is held (watchBusy) so only reload() can bring the other change in.
  await evalJS(`watchBusy = true`)
  await elsewhere('**Rewrite the career framework**', '**Rewrite the career framework again**')
  await evalJS(`(() => { const t = ${task('Chase the 360 responses today')}; t.due = '2026-12-02'; t.dirty = true; markDirty(); })()`)
  check('the tab has not seen the other change before Reload',
    await evalJS(`!${task('Rewrite the career framework again')}`))
  await evalJS(`window.__merges = 0; const realMerge = mergeSaves; mergeSaves = (...a) => { window.__merges++; return realMerge(...a); }`)
  await evalJS(`reload()`)
  check('Reload ran the merge itself', await evalJS(`window.__merges === 1`))
  check('Reload with different tasks changed merges without a box',
    await evalJS(`!modalEl && !!${task('Rewrite the career framework again')} && ${task('Chase the 360 responses today')}.due === '2026-12-02'`))
  check('keeps my change waiting to be saved', await evalJS(`state.dirty`))
  check('and says it reloaded on the status line', await evalJS(`/^reloaded/.test($('#status').textContent)`),
    await evalJS(`$('#status').textContent`))
  await evalJS(`saveFile(false)`)
  check('and that save reaches the file', await until(async () => (await disk()).includes('[due:: 2026-12-02]')))

  await evalJS(`watchBusy = true`)
  await elsewhere('[due:: 2026-12-02]', '[due:: 2026-12-03]')
  await evalJS(`(() => { const t = ${task('Chase the 360 responses today')}; t.due = '2026-12-04'; t.dirty = true; markDirty(); })()`)
  await evalJS(`reload()`)
  check('Reload with the same field changed in both places opens the merge box',
    await until(() => evalJS(`!!modalEl && /Changed in two places/.test(modalEl.textContent)`)))
  await evalJS(`Array.from(modalEl.querySelectorAll('button')).find(b => b.textContent.trim() === 'Use theirs').click()`)
  check('Use theirs settles it', await until(async () => (await disk()).includes('[due:: 2026-12-03]')))
  await evalJS(`watchBusy = false`)
} catch (err) {
  check('the suite ran to the end', false, String(err.message || err))
} finally {
  ws.close()
  chrome.kill()
}

const failed = checks.filter(p => !p).length
console.log(`\n${checks.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
