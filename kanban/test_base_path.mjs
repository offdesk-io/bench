#!/usr/bin/env node
/* The board under a base path, the way os.offdesk.io serves it: nginx answers
 * /bench/..., removes the prefix and hands the rest to Bench.
 *
 *   node kanban/test_base_path.mjs     # or scripts/test-board.sh test_base_path.mjs
 *
 * Starts a server of its own with BENCH_BASE=/bench over a temp data root
 * holding one list (`_test`, from demo.md), and in front of it a small proxy
 * that does what nginx does: /bench/<path> goes to the server as /<path>, and
 * anything else is answered 404 and written down. Headless Chrome opens
 * /bench/, goes through the views, opens a task and the settings, and then:
 *   - nothing the board asked for fell outside /bench/;
 *   - no link on the page points outside it, but the sign-in's /auth/;
 *   - the board's own address is still the page under /bench/, with its
 *     #!board= fragment.
 * kanban/test_base_path.py has the server's half. The real data/ and the
 * shared test server are never touched.
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHROME_BIN } from './test_browser.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASE = '/bench'
const checks = []
const check = (name, pass, detail = '') => {
  checks.push(pass)
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}
const wait = ms => new Promise(r => setTimeout(r, ms))
const freePort = () => Number(execFileSync('python3', ['-c',
  'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])']).toString())

const root = mkdtempSync(join(tmpdir(), 'bench-base-test-'))
const data = join(root, 'data')
mkdirSync(join(data, '_test', 'backups'), { recursive: true })
copyFileSync(join(HERE, 'demo.md'), join(data, '_test', 'todo.md'))
writeFileSync(join(data, '.current'), '_test')
writeFileSync(join(data, 'profile.md'), '- Name: Morgan\n')
const PORT = freePort()
const FRONT = freePort()
const CDP = freePort()
const env = { ...process.env, TODOS_SHOW_HIDDEN: '1', TODOS_DATA_ROOT: data, TODOS_PORT: String(PORT),
  TODOS_NO_BROWSER: '1', BENCH_BASE: BASE }
delete env.BENCH_AUTH
const server = spawn('python3', ['-u', join(HERE, 'server.py')], { env, stdio: 'ignore' })

// nginx's part: the prefix comes off, and nothing outside it reaches Bench.
const asked = []
const outside = []
const front = http.createServer((req, res) => {
  asked.push(req.method + ' ' + req.url)
  if (req.url === BASE) { res.writeHead(301, { Location: BASE + '/' }); return res.end() }
  if (!req.url.startsWith(BASE + '/')) {
    if (!req.url.startsWith('/favicon.ico')) outside.push(req.method + ' ' + req.url)
    res.writeHead(404); return res.end()
  }
  const up = http.request({ host: '127.0.0.1', port: PORT, method: req.method,
    path: req.url.slice(BASE.length), headers: req.headers }, (r) => {
    res.writeHead(r.statusCode, r.headers)
    r.pipe(res)
  })
  up.on('error', () => { res.writeHead(502); res.end() })
  req.pipe(up)
})
front.listen(FRONT, '127.0.0.1')

let chrome, ws
const cleanup = () => {
  try { ws?.close() } catch {}
  chrome?.kill(); server.kill(); front.close()
  try { rmSync(root, { recursive: true, force: true }) } catch {}
}
process.on('exit', cleanup)

const site = `http://127.0.0.1:${FRONT}`
try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${site}${BASE}/datasets.json`)).ok) break } catch {}
    await wait(250)
  }

  chrome = spawn(CHROME_BIN, [
    '--headless=new', '--mute-audio', `--remote-debugging-port=${CDP}`, '--no-first-run',
    `--user-data-dir=${process.env.CHROME_PROFILE ? process.env.CHROME_PROFILE + 'base' : join(root, 'chrome')}`,
    '--window-size=1400,1000', `${site}${BASE}/`,
  ], { stdio: 'ignore' })
  let wsUrl
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      wsUrl = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json())
        .find(t => t.type === 'page' && t.url.includes('index.html'))?.webSocketDebuggerUrl
    } catch {}
    if (!wsUrl) await wait(250)
  }
  ws = new WebSocket(wsUrl)
  await new Promise(r => (ws.onopen = r))
  let id = 0
  const pending = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (method, params) => new Promise(res => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })) })
  const evalJS = async expr => {
    const x = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (x.result?.exceptionDetails) throw new Error(expr.slice(0, 200) + ' // ' + JSON.stringify(x.result.exceptionDetails).slice(0, 400))
    return x.result?.result?.value
  }
  for (let i = 0; i < 80 && !(await evalJS(`!!state.doc`).catch(() => false)); i++) await wait(250)
  // A locked tab cannot save.
  await evalJS(`state.locked = true`)
  await wait(500)

  check('the root under the base opens the board', await evalJS(`!!state.doc && location.pathname`) === BASE + '/kanban/index.html',
    await evalJS(`location.pathname`))
  check('the board knows its base', await evalJS(`BOARD_BASE`) === BASE)
  check('benchUrl puts it in front of a path of the server\'s, and leaves an address alone',
    await evalJS(`JSON.stringify([benchUrl('/data/todo.md'), benchUrl('https://example.com/x'), benchUrl('js/x.js')])`) ===
    JSON.stringify([BASE + '/data/todo.md', 'https://example.com/x', 'js/x.js']))

  // Through the views, a task's drawer and the settings, so most of what the
  // board asks for is asked for at least once.
  for (const view of ['board', 'overview', 'reports', 'backups', 'projects', 'plans', 'agents', 'memory', 'settings', 'board']) {
    await evalJS(`(() => { try { state.view = ${JSON.stringify(view)}; renderView(); } catch (e) {} return 1 })()`)
    await wait(700)
  }
  await evalJS(`(() => { const t = state.doc.buckets.flatMap(b => b.tiers.flatMap(x => x.tasks))[0]; openDrawer(t.id); return 1 })()`)
  await wait(800)
  await evalJS(`(async () => { try { await getJSON('/whoami') } catch (e) {} try { await refreshOwnerName() } catch (e) {} return 1 })()`)
  await evalJS(`(async () => { try { await openSettings(false, false) } catch (e) {} return 1 })()`)
  await wait(1200)

  check('the board asked for a good many things', asked.length > 40, String(asked.length))
  check('and every one of them under the base', outside.length === 0, JSON.stringify(outside))
  for (const want of ['/owner.js', '/core/todo.js', '/kanban/board.css', '/kanban/dist/board-ui.js',
    '/data/todo.md', '/datasets.json', '/settings.json', '/claude.json', '/reports.json', '/backups.json',
    '/agents-api/state.json']) {
    check(`it asked for ${BASE}${want}`, asked.some(a => a.split(' ')[1].split('?')[0] === BASE + want))
  }
  const links = await evalJS(`JSON.stringify([...document.querySelectorAll('[href], [src], form[action]')]
    .map(e => e.getAttribute('href') || e.getAttribute('src') || e.getAttribute('action'))
    .filter(u => u && u.startsWith('/') && !u.startsWith('//') && !u.startsWith(${JSON.stringify(BASE + '/')}) && !u.startsWith('/auth/')))`)
  check('no link on the page points outside the base, but the sign-in\'s', links === '[]', links)
  check('the sign-out form still posts to the sign-in\'s own /auth/logout',
    await evalJS(`!!document.querySelector('form[action="/auth/logout"]')`))
  check('the board\'s own address is still a fragment on the page under the base',
    await evalJS(`location.pathname === ${JSON.stringify(BASE + '/kanban/index.html')} && /^#!?/.test(location.hash || '#')`),
    await evalJS(`location.href`))
} finally {
  ws?.close()
  chrome?.kill()
}

const failed = checks.filter(x => !x).length
console.log(`\n${checks.length - failed} checks passed${failed ? `, ${failed} failed` : ''}`)
process.exit(failed ? 1 : 0)
