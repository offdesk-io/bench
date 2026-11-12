#!/usr/bin/env node
/* The board while pa works: pa-working.json makes the cards it names glow,
 * holds the reload until it goes, and the reload after slides each moved card
 * into place and lights what changed. The watchers are in
 * kanban/js/24-autosave-watching.js, the look at the end of board.css.
 *
 *   scripts/test-board.sh test_pa_working.mjs
 *
 * Written 20 Oct 2026. The route and todo.md are both served from stubs and
 * every write is torn out of `fetch`, so the tab is unlocked without being
 * able to reach the file. The last check asks the test server's real route,
 * which with no pa-working.json in the _test list says pa is not working.
 */
import { spawn } from 'node:child_process'
import { CHROME_BIN } from './test_browser.mjs'

const PORT = Number(process.env.CDP_PORT) || 9497
const BOARD = process.env.BOARD_PORT || 8765
if (!process.env.BOARD_PORT) console.error('Note: this runs against the live board on 8765. For a throwaway copy: scripts/test-board.sh test_pa_working.mjs')
const checks = []
const check = (name, pass, detail = '') => {
  checks.push(pass)
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const chrome = spawn(CHROME_BIN, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  `--user-data-dir=${process.env.CHROME_PROFILE || '/tmp/todo-pa-working-test-profile'}`, '--window-size=1400,1000',
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

const FIXTURE = [
  '# To-do', '', '## 1. People', '',
  '### Doing', '',
  '### To do', '',
  '- [ ] **Write the agenda** `id:aa0001`',
  '- [ ] **Book the room** `id:bb0001`',
  '- [ ] **Order the cake** `id:cc0001`',
  '',
  '### Backlog', '',
  ''
].join('\n')
// What pa leaves on disk: the agenda moved into Doing, the cake edited.
const AFTER = FIXTURE
  .replace('- [ ] **Write the agenda** `id:aa0001`\n', '')
  .replace('### Doing\n', '### Doing\n\n- [ ] **Write the agenda** `id:aa0001`\n')
  .replace('**Order the cake** `id:cc0001`', '**Order the cake** `id:cc0001`\n  - Chocolate, for twelve.')

/* The tab is unlocked, so every write is caught here and nothing leaves the
   page that is not a GET. todo.md and the route answer from window.__disk and
   window.__pa. */
async function setUp () {
  await evalJS(`(() => {
    state.locked = true;
    const real = window.__realFetch || (window.__realFetch = window.fetch);
    window.__disk = { text: ${JSON.stringify(FIXTURE)}, stamp: 'Mon, 19 Oct 2026 09:00:00 GMT', hash: 'h1' };
    window.__pa = { working: false, tasks: [], age: 0 };
    window.__posted = [];
    window.fetch = (u, o) => {
      const m = (o && o.method) || 'GET';
      const url = String(u);
      if (url.startsWith('/pa-working.json')) {
        return Promise.resolve(window.__pa === 404 ? new Response('', { status: 404 })
          : new Response(JSON.stringify(window.__pa), { status: 200 }));
      }
      if (url.startsWith(FILE_URL) && (m === 'GET' || m === 'HEAD')) {
        const h = { 'Last-Modified': window.__disk.stamp, 'X-Todo-Hash': window.__disk.hash };
        return Promise.resolve(new Response(m === 'HEAD' ? null : window.__disk.text, { status: 200, headers: h }));
      }
      if (m !== 'GET') { window.__posted.push(m + ' ' + url); return Promise.resolve(new Response('{}', { status: 200 })) }
      return real(u, o);
    };
    state.view = 'board';
    load(window.__disk.text, 'todo.md', {});
    state.diskStamp = window.__disk.stamp;
    state.diskHash = window.__disk.hash;
    state.dirty = false;
    state.migratedOnly = false;
    paWatchOff = false;
    paWorking = null;
    state.locked = false;
  })()`)
}

const cardEl = title => `[...document.querySelectorAll('.tenon-card[data-id]')].find(el => el.textContent.includes(${JSON.stringify(title)}))`
const anim = title => evalJS(`(() => { const el = ${cardEl(title)}; return el ? getComputedStyle(el).animationName : 'no card'; })()`)
const shadow = title => evalJS(`(() => { const el = ${cardEl(title)}; return el ? getComputedStyle(el).boxShadow : 'no card'; })()`)
const slides = title => evalJS(`(() => { const el = ${cardEl(title)}; return el ? el.getAnimations().filter(a => !(a instanceof CSSAnimation)).length : -1; })()`)
const column = title => evalJS(`locate(state.doc.buckets[0].tiers.flatMap(x => x.tasks).find(t => t.title === ${JSON.stringify(title)}).id).tier.name`)

// Motion on, whatever the machine says: a runner with Reduce Motion switched on
// would otherwise draw every card still and fail the checks that expect a glow.
const MOTION_ON = { name: 'prefers-reduced-motion', value: 'no-preference' }

try {
  await send('Emulation.setEmulatedMedia', { features: [MOTION_ON] })
  // Poll for the page rather than sleeping: a fixed wait fails when the machine is busy.
  for (let i = 0; i < 120 && !(await evalJS(`document.readyState === 'complete' && typeof state !== 'undefined' && !!state.doc`).catch(() => false)); i++) await new Promise(r => setTimeout(r, 250))
  await new Promise(r => setTimeout(r, 400))
  check('the board loaded', await evalJS(`typeof paWorkingTick === 'function' && typeof settleChanges === 'function'`))

  /* ---- pa names two cards and starts editing ---- */

  await setUp()
  await evalJS(`window.__pa = { working: true, tasks: ['Write the agenda', 'cc0001'], age: 1 }; paWorkingTick()`)
  await wait(200)
  check('a card named by title glows while pa works', await anim('Write the agenda') === 'pa-working', await anim('Write the agenda'))
  check('so does one named by its id', await anim('Order the cake') === 'pa-working', await anim('Order the cake'))
  check('a card pa did not name stays as it was', await anim('Book the room') === 'none', await anim('Book the room'))

  await evalJS(`renderView()`)
  check('the glow survives a redraw of the board', await anim('Write the agenda') === 'pa-working', await anim('Write the agenda'))

  // pa's edit lands on disk while the file is still there.
  await evalJS(`window.__disk = { text: ${JSON.stringify(AFTER)}, stamp: 'Mon, 19 Oct 2026 09:01:00 GMT', hash: 'h2' }; watchTick()`)
  await wait(300)
  check('the reload is held while pa is still working', await column('Write the agenda') === 'To do', await column('Write the agenda'))

  /* ---- pa finishes ---- */

  await evalJS(`window.__pa = { working: false, tasks: [], age: 0 }; paWorkingTick()`)
  await wait(150)
  check('the reload happens as soon as pa finishes', await column('Write the agenda') === 'Doing', await column('Write the agenda'))
  check('the working glow is gone', await evalJS(`document.getElementById('paWorkingSheet').textContent === ''`))
  check('the moved card slides into its new place', await slides('Write the agenda') > 0, String(await slides('Write the agenda')))
  check('the moved card glows once more', await anim('Write the agenda') === 'pa-settled', await anim('Write the agenda'))
  check('the edited card glows too', await anim('Order the cake') === 'pa-settled', await anim('Order the cake'))
  check('the untouched card does not', await anim('Book the room') === 'none', await anim('Book the room'))
  check('the reload is said in the status line', /reloaded/.test(await evalJS(`$('#status').textContent`)), await evalJS(`$('#status').textContent`))
  await wait(2600)
  check('and the glow clears after', await evalJS(`document.getElementById('paSettledSheet').textContent === ''`) &&
    await anim('Write the agenda') === 'none', await anim('Write the agenda'))
  check('nothing was written', (await evalJS(`window.__posted.length`)) === 0, await evalJS(`window.__posted.join(', ')`))

  /* ---- a file a crashed session left behind ---- */

  await setUp()
  await evalJS(`window.__pa = { working: true, tasks: ['Write the agenda'], age: 3600 }; paWorkingTick()`)
  await wait(150)
  check('a pa-working.json older than ten minutes is ignored', await anim('Write the agenda') === 'none', await anim('Write the agenda'))
  check('and does not hold the reload', await evalJS(`paWorking === null`))

  /* ---- reduced motion ---- */

  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await setUp()
  await evalJS(`window.__pa = { working: true, tasks: ['Write the agenda'], age: 1 }; paWorkingTick()`)
  await wait(150)
  check('with reduced motion the working glow holds still', await anim('Write the agenda') === 'none' &&
    /rgb/.test(await shadow('Write the agenda')), `${await anim('Write the agenda')} / ${await shadow('Write the agenda')}`)
  await evalJS(`window.__disk = { text: ${JSON.stringify(AFTER)}, stamp: 'Mon, 19 Oct 2026 09:01:00 GMT', hash: 'h2' }`)
  await evalJS(`window.__pa = { working: false, tasks: [], age: 0 }; paWorkingTick()`)
  await wait(150)
  check('nothing slides', await column('Write the agenda') === 'Doing' && await slides('Write the agenda') === 0,
    `${await column('Write the agenda')}, ${await slides('Write the agenda')} slides`)
  check('and the settled glow steps rather than fades',
    await evalJS(`getComputedStyle(${cardEl('Write the agenda')}).animationTimingFunction`) === 'steps(1)',
    await evalJS(`getComputedStyle(${cardEl('Write the agenda')}).animationTimingFunction`))
  await send('Emulation.setEmulatedMedia', { features: [MOTION_ON] })

  /* ---- no route behind the page ---- */

  await setUp()
  await evalJS(`window.__pa = 404; paWorkingTick()`)
  await wait(100)
  check('a page with no route stops asking', await evalJS(`paWatchOff === true`))

  /* ---- the real route ---- */

  const real = await (await fetch(`http://127.0.0.1:${BOARD}/pa-working.json`)).json()
  check('the server says pa is not working when there is no file', real.working === false && Array.isArray(real.tasks), JSON.stringify(real))
} catch (err) {
  check('the run threw', false, String(err.message || err))
} finally {
  ws.close()
  chrome.kill()
}

const passed = checks.filter(Boolean).length
console.log(`\n${passed}/${checks.length} passed`)
process.exit(passed === checks.length ? 0 : 1)
