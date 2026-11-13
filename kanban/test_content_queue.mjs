#!/usr/bin/env node
/* The content board's move request — a card moved to Reviewing with a link to
 * its draft, asked for by the content strategist agent's evening run through
 * tick-queue.json and applied by drainMove() in 10-reference-sections.js.
 *
 *   scripts/test-board.sh test_content_queue.mjs
 *
 * Written 6 Oct 2026. The queue is served from a stub, every write is torn out
 * of `fetch`, and the tab is unlocked only for the drain itself, so the run
 * cannot reach todo.md.
 */
import { spawn } from 'node:child_process'
import { CHROME_BIN } from './test_browser.mjs'

const PORT = Number(process.env.CDP_PORT) || 9493
const BOARD = process.env.BOARD_PORT || 8765
if (!process.env.BOARD_PORT) console.error('Note: this runs against the live board on 8765. For a throwaway copy: scripts/test-board.sh test_content_queue.mjs')
const checks = []
const check = (name, pass, detail = '') => {
  checks.push(pass)
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const chrome = spawn(CHROME_BIN, [
  '--headless=new', '--mute-audio', `--remote-debugging-port=${PORT}`, '--no-first-run',
  `--user-data-dir=${process.env.CHROME_PROFILE || '/tmp/todo-content-queue-test-profile'}`, '--window-size=1400,1000',
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

const DRAFT = '/path/to/bench/data/content/posts/2026-10-08-ui-got-cheap.md'
const FIXTURE = [
  '# To-do', '', '## 1. Designer\'s role', '',
  '### Reviewing', '',
  '### To do', '',
  '- [ ] **UI got cheap** [due:: 2026-10-08] `id:aa0001`',
  '  - Angle: making a screen is cheap.',
  '  - [ ] Find the talk outline `id:st0001`',
  '- [ ] **The design bonanza is over** `id:bb0001`',
  '  - Angle: who goes first.',
  '- [ ] **I didn\'t change a comma** `id:cc0001`',
  '',
  '### Backlog', '',
  ''
]

/* Loads the fixture on the named list with the queue stubbed, drains once, and
   locks the tab again. Nothing that is not a GET leaves the page. */
async function drain (dataset, queue) {
  await evalJS(`(() => {
    state.locked = true;
    const real = window.__realFetch || (window.__realFetch = window.fetch);
    window.__queue = ${JSON.stringify(queue)};
    window.__posted = window.__posted || [];
    window.fetch = (u, o) => {
      const m = (o && o.method) || 'GET';
      if (String(u).startsWith('/tick-queue.json') && m === 'GET') return Promise.resolve(new Response(JSON.stringify(window.__queue), { status: 200 }));
      if (m !== 'GET') { if (m !== 'HEAD') window.__posted.push(m + ' ' + u + ' ' + (o && o.body || '')); return Promise.resolve(new Response('{}', { status: 200 })) }
      return real(u, o);
    };
    if (!window.__loaded) {
      load(${JSON.stringify(FIXTURE.join('\n'))}, 'demo.md', {});
      window.__loaded = true;
    }
    state.dataset = ${JSON.stringify(dataset)};
    state.dirty = false;
    state.locked = false;
  })()`)
  await evalJS(`drainTickQueue()`)
  await new Promise(r => setTimeout(r, 300))
  await evalJS(`state.locked = true`)
}

const card = title => `state.doc.buckets[0].tiers.flatMap(x => x.tasks).find(t => t.title === ${JSON.stringify(title)})`
const column = title => evalJS(`locate(${card(title)}.id).tier.name`)
const body = title => evalJS(`${card(title)}.body.join(' / ')`)
const lastPost = () => evalJS(`(window.__posted.filter(p => p.startsWith('POST /tick-queue.json')).pop() || '').split(' ').slice(2).join(' ')`)

try {
  // Poll for the page rather than sleeping: a fixed wait fails when the machine is busy.
  for (let i = 0; i < 120 && !(await evalJS(`document.readyState === 'complete' && typeof state !== 'undefined' && !!state.doc`).catch(() => false)); i++) await new Promise(r => setTimeout(r, 250))
  await new Promise(r => setTimeout(r, 400))
  check('the board loaded', await evalJS(`typeof drainTickQueue === 'function' && typeof drainMove === 'function'`))

  /* ---- on another list, nothing moves ---- */

  await drain('personal', [{ id: 'm0', move: 'aa0001', column: 'Reviewing', by: 'Content strategist agent', draft: DRAFT }])
  check('on a list other than content the request is refused', await column('UI got cheap') === 'To do')
  check('and cleared, since waiting would not change the answer', await lastPost() === '{"done":["m0"]}', await lastPost())
  check('and nothing on the card changed', !/Draft:/.test(await body('UI got cheap')))

  /* ---- on content ---- */

  await drain('content', [
    { id: 'm1', move: 'aa0001', column: 'Reviewing', by: 'Content strategist agent', draft: DRAFT },
    { id: 'm2', move: 'bb0001', column: 'Reviewing', by: 'Plan agent', draft: DRAFT },
    { id: 'm3', move: 'cc0001', column: 'Done', by: 'Content strategist agent' },
    { id: 'm4', move: 'zz9999', column: 'Reviewing', by: 'Content strategist agent', draft: DRAFT }
  ])
  check('the content strategist agent\'s request moves the card into Reviewing', await column('UI got cheap') === 'Reviewing')
  check('with the draft linked on the card, above its sub-tasks',
    await body('UI got cheap') === `  - Angle: making a screen is cheap. /   - Draft: ${DRAFT} /   - [ ] Find the talk outline \`id:st0001\``,
    await body('UI got cheap'))
  check('a request from any other agent is refused', await column('The design bonanza is over') === 'To do')
  check('a request for any column but Reviewing is refused', await column('I didn\'t change a comma') === 'To do')
  check('what was dealt with is taken out by id, and the card it could not find stays', await lastPost() === '{"done":["m1","m2","m3"]}', await lastPost())
  check('the tab has something to save', await evalJS(`state.dirty === true`))
  check('and says what arrived', /1 draft ready, moved into Reviewing/.test(await evalJS(`$('#status').textContent`)), await evalJS(`$('#status').textContent`))

  /* ---- a second draft for a card already in Reviewing ---- */

  const NEWER = DRAFT.replace('2026-10-08', '2026-10-09')
  await drain('content', [{ id: 'm5', move: 'aa0001', column: 'Reviewing', by: 'Content strategist agent', draft: NEWER }])
  check('a newer draft replaces the link rather than adding a second', (await body('UI got cheap')).split('Draft:').length === 2 && (await body('UI got cheap')).includes(NEWER), await body('UI got cheap'))
  check('and the card stays in Reviewing', await column('UI got cheap') === 'Reviewing')

  /* ---- the point of the guard ---- */

  check('nothing reached todo.md', await evalJS(`window.__posted.every(p => p.startsWith('POST /tick-queue.json'))`), await evalJS(`window.__posted.join(' | ')`))
} finally {
  ws.close()
  chrome.kill()
}

const failed = checks.filter(c => !c).length
console.log(failed ? `\n${failed} failed` : `\nall ${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
