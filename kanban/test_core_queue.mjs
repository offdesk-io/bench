#!/usr/bin/env node
/* What the Offdesk core asks of the board through bench_mcp, applied by the
 * board itself: new tasks from add-queue.json (drainAddQueue() in
 * 10-reference-sections.js), ticks from tick-queue.json that say whose they are
 * (`as`), and a task's `[ref:: ]` drawn as a chip on its card.
 *
 *   scripts/test-board.sh test_core_queue.mjs
 *
 * Written 26 Nov 2026. Both queues are served from a stub, every write is torn
 * out of `fetch`, and the tab is unlocked only for the drain itself, so the run
 * cannot reach todo.md. The runner's settings name a core (core_url), so the
 * chip is a link.
 */
import { spawn } from 'node:child_process'
import { CHROME_BIN } from './test_browser.mjs'

const PORT = Number(process.env.CDP_PORT) || 9495
const BOARD = process.env.BOARD_PORT || 8765
if (!process.env.BOARD_PORT) console.error('Note: this runs against the live board on 8765. For a throwaway copy: scripts/test-board.sh test_core_queue.mjs')
const checks = []
const check = (name, pass, detail = '') => {
  checks.push(pass)
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const chrome = spawn(CHROME_BIN, [
  '--headless=new', '--mute-audio', `--remote-debugging-port=${PORT}`, '--no-first-run',
  `--user-data-dir=${process.env.CHROME_PROFILE || '/tmp/todo-core-queue-test-profile'}`, '--window-size=1400,1000',
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

const FIXTURE = [
  '# To-do', '', '## 1. Work', '',
  '### Done', '',
  '### Reviewing', '',
  '### Doing', '',
  '- [ ] **Send the deck** [lead:: acme-studio] [ref:: binder:org/beta-co] [ref:: calls:call/x-1] `id:aa0001`',
  '  - [ ] Draft it [to:: ana@example.com] `id:s00001`',
  '  - [ ] Check it [to:: rui@example.com] `id:s00002`',
  '  - [ ] Ask the digest [to:: agent:digest] `id:s00003`',
  '  - [ ] The owner\'s own `id:s00004`',
  '  - [ ] Also the owner\'s `id:s00005`',
  '',
  '### To do', '',
  '- [ ] **Order badges** `id:bb0001`',
  '',
  '---', '',
  '## 2. Home', '',
  '### To do', '',
  '- [ ] **Fix the shelf** `id:cc0001`',
  ''
]

/* Loads the fixture once with both queues stubbed, drains once, and locks the
   tab again. Nothing that is not a GET leaves the page. */
async function drain (adds, ticks) {
  await evalJS(`(() => {
    state.locked = true;
    const real = window.__realFetch || (window.__realFetch = window.fetch);
    window.__adds = ${JSON.stringify(adds)};
    window.__ticks = ${JSON.stringify(ticks)};
    window.__posted = window.__posted || [];
    window.fetch = (u, o) => {
      const m = (o && o.method) || 'GET';
      const json = v => Promise.resolve(new Response(JSON.stringify(v), { status: 200 }));
      if (String(u).startsWith('/add-queue.json') && m === 'GET') return json(window.__adds);
      if (String(u).startsWith('/tick-queue.json') && m === 'GET') return json(window.__ticks);
      if (m !== 'GET') { if (m !== 'HEAD') window.__posted.push(m + ' ' + u + ' ' + (o && o.body || '')); return json({}); }
      return real(u, o);
    };
    if (!window.__loaded) {
      load(${JSON.stringify(FIXTURE.join('\n'))}, 'demo.md', {});
      window.__loaded = true;
    }
    state.dirty = false;
    state.locked = false;
  })()`)
  await evalJS(`drainTickQueue()`)
  await new Promise(r => setTimeout(r, 400))
  await evalJS(`state.locked = true`)
}

const all = `state.doc.buckets.flatMap(b => b.tiers.flatMap(x => x.tasks.map(t => ({ t, b: b.name, c: x.name }))))`
const posted = route => evalJS(`(window.__posted.filter(p => p.startsWith('POST ${route}')).pop() || '').split(' ').slice(2).join(' ')`)
const lineOf = sid => evalJS(`(() => { const f = ${all}.find(x => x.t.stableId === ${JSON.stringify(sid)}); return f ? [f.b, f.c, serializeTask(f.t)[0]] : null })()`)

try {
  for (let i = 0; i < 120 && !(await evalJS(`document.readyState === 'complete' && typeof state !== 'undefined' && !!state.doc`).catch(() => false)); i++) await new Promise(r => setTimeout(r, 250))
  await new Promise(r => setTimeout(r, 400))
  check('the board loaded', await evalJS(`typeof drainAddQueue === 'function' && typeof refsOf === 'function'`))

  /* ---- adds ---- */

  await drain([
    { id: 'nw0001', by: 'ana@example.com via routine:r1', as: 'ana@example.com', title: 'Call Acme back', bucket: 'work', column: 'Backlog', due: '2026-12-03', refs: ['binder:org/acme-studio', 'nonsense'] },
    { id: 'nw0002', by: 'agent:digest', as: 'agent:digest', title: 'Water the plants', bucket: 'Home', column: 'To do', due: '', refs: [] },
    { id: 'nw0003', by: 'ana@example.com', title: 'Into a gone bucket', bucket: 'Gone', column: 'To do' },
    { id: 'nw0004', by: 'ana@example.com', title: 'Into Doing', bucket: 'Work', column: 'Doing' },
    { id: 'bb0001', by: 'ana@example.com', title: 'Order badges', bucket: 'Work', column: 'To do' }
  ], [])
  check('a new task lands in the bucket and column asked for, written with its date, refs and id',
    JSON.stringify(await lineOf('nw0001')) === JSON.stringify(['Work', 'Backlog',
      '- [ ] **Call Acme back** [due:: 2026-12-03] [ref:: binder:org/acme-studio] `id:nw0001`']),
    JSON.stringify(await lineOf('nw0001')))
  check('a second one too, in another bucket',
    JSON.stringify(await lineOf('nw0002')) === JSON.stringify(['Home', 'To do', '- [ ] **Water the plants** `id:nw0002`']),
    JSON.stringify(await lineOf('nw0002')))
  check('a task the list already carries the id of is not added again',
    await evalJS(`${all}.filter(x => x.t.stableId === 'bb0001').length`) === 1)
  const addPost = JSON.parse(await posted('/add-queue.json') || '{}')
  check('what was added, or was there already, is cleared by id',
    JSON.stringify(addPost.done) === JSON.stringify(['nw0001', 'nw0002', 'bb0001']), JSON.stringify(addPost))
  check('what could not be added is sent back refused, with why',
    /no bucket called Gone/.test(addPost.refused?.nw0003) && /only the owner/.test(addPost.refused?.nw0004),
    JSON.stringify(addPost.refused))
  check('the tab has something to save and says so',
    await evalJS(`state.dirty === true`) && /2 tasks added through Offdesk/.test(await evalJS(`$('#status').textContent`)),
    await evalJS(`$('#status').textContent`))

  await drain([{ id: 'nw0001', by: 'ana@example.com', title: 'Call Acme back', bucket: 'Work', column: 'Backlog' }], [])
  check('the same entry drained again adds nothing (applied once)',
    await evalJS(`${all}.filter(x => x.t.stableId === 'nw0001').length`) === 1)
  check('and is only cleared', (await posted('/add-queue.json')) === '{"done":["nw0001"],"refused":{}}', await posted('/add-queue.json'))

  /* ---- ticks that say whose they are ---- */

  await drain([], [
    { id: 't1', sub: 's00001', by: 'ana@example.com via routine:r1', as: 'ana@example.com' },
    { id: 't2', sub: 's00002', by: 'ana@example.com', as: 'ana@example.com' },
    { id: 't3', sub: 's00003', by: 'agent:digest', as: 'agent:digest' },
    { id: 't4', sub: 's00004', by: 'owner@example.com', as: 'owner@example.com', owner: true },
    { id: 't5', sub: 's00005', by: 'ana@example.com', as: 'ana@example.com' }
  ])
  const subs = await evalJS(`(() => { const t = ${all}.find(x => x.t.stableId === 'aa0001').t; return splitBody(t).steps.map(s => s.done) })()`)
  check('a tick acting for the assignee is applied, by email or as agent:<name>, and the owner\'s through the PA on a sub-task with no assignee',
    JSON.stringify(subs) === '[true,false,true,true,false]', JSON.stringify(subs))
  check('one for someone else\'s sub-task, or for no one\'s without the owner\'s mark, is refused, and all cleared',
    (await posted('/tick-queue.json')) === '{"done":["t1","t2","t3","t4","t5"]}' && /2 requests refused/.test(await evalJS(`$('#status').textContent`)),
    (await posted('/tick-queue.json')) + ' / ' + await evalJS(`$('#status').textContent`))

  /* ---- the chips ---- */

  const chips = await evalJS(`(() => {
    state.view = 'board';
    renderView();
    const card = document.querySelector('#board .tenon-card[data-id="' + ${all}.find(x => x.t.stableId === 'aa0001').t.id + '"]');
    return [...(card ? card.querySelectorAll('a.tenon-pill') : [])].map(a => [a.textContent, a.getAttribute('href'), a.getAttribute('title')]);
  })()`)
  check('the lead is still its own chip, to Binder', chips.some(c => c[0] === 'acme-studio' && c[1] === 'https://binder.example.com/o/acme-studio'), JSON.stringify(chips))
  check('each ref is a chip with the module\'s name and the id, opening it through the core',
    chips.some(c => c[0] === 'Binder beta-co' && c[1] === 'https://os.example.com/api/refs/open?ref=binder%3Aorg%2Fbeta-co' && c[2] === 'Linked: binder:org/beta-co') &&
    chips.some(c => c[0] === 'Calls x-1' && c[1] === 'https://os.example.com/api/refs/open?ref=calls%3Acall%2Fx-1'),
    JSON.stringify(chips))

  check('nothing reached todo.md', await evalJS(`window.__posted.every(p => /^POST \\/(add|tick)-queue\\.json/.test(p))`), await evalJS(`window.__posted.join(' | ')`))
} finally {
  ws.close()
  chrome.kill()
}

const failed = checks.filter(c => !c).length
console.log(failed ? `\n${failed} failed` : `\nall ${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
