#!/usr/bin/env node
/* The board when someone is signed in (BENCH_AUTH=header).
 *
 *   node kanban/test_signed_in.mjs   # or scripts/test-board.sh test_signed_in.mjs
 *
 * Starts a server of its own with BENCH_AUTH=header over a temp data root and
 * has headless Chrome send nginx's three headers on every request, so the
 * real data/ and the shared test server are never touched. The routes
 * themselves are held by kanban/test_board_access.py; this is the page: the
 * name in the header, the Mac-only parts gone, the wizard's sharing step,
 * Settings as the person's own profile, and the owner's sharing form behind it.
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHROME_BIN } from './test_browser.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const checks = []
const check = (name, pass, detail = '') => {
  checks.push(pass)
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}
const wait = ms => new Promise(r => setTimeout(r, ms))
const freePort = () => {
  for (;;) {
    const p = Number(execFileSync('python3', ['-c',
      'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])']).toString())
    if (p !== 8765 && p !== 8766) return p
  }
}

const JEROME = { 'X-Offdesk-Email': 'jerome@example.com', 'X-Offdesk-Name': 'J%C3%A9r%C3%B4me', 'X-Offdesk-Teams': 'offdesk' }
const root = mkdtempSync(join(tmpdir(), 'bench-signed-in-test-'))
const data = join(root, 'data')
mkdirSync(join(data, 'offdesk', 'backups'), { recursive: true })
copyFileSync(join(HERE, 'demo.md'), join(data, 'offdesk', 'todo.md'))
writeFileSync(join(data, 'offdesk', 'access.json'), JSON.stringify({ owner: 'jerome@example.com', people: [], teams: [] }))
const accessOf = name => JSON.parse(readFileSync(join(data, name, 'access.json'), 'utf8'))
const PORT = freePort()
const CDP = freePort()
const server = spawn('python3', ['-u', join(HERE, 'server.py')], {
  env: { ...process.env, BENCH_AUTH: 'header', TODOS_DATA_ROOT: data, TODOS_PORT: String(PORT), TODOS_NO_BROWSER: '1' },
  stdio: 'ignore',
})
let chrome, ws
const cleanup = () => {
  try { ws?.close() } catch {}
  chrome?.kill(); server.kill()
  try { rmSync(root, { recursive: true, force: true }) } catch {}
}
process.on('exit', cleanup)

try {
  const base = `http://127.0.0.1:${PORT}`
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/whoami`, { headers: JEROME })).ok) break } catch {}
    await wait(250)
  }
  check('the page without a sign-in is a 401', (await fetch(`${base}/kanban/index.html`)).status === 401)

  chrome = spawn(CHROME_BIN, [
    '--headless=new', `--remote-debugging-port=${CDP}`, '--no-first-run',
    `--user-data-dir=${process.env.CHROME_PROFILE ? process.env.CHROME_PROFILE + 'signedin' : join(root, 'chrome')}`,
    '--window-size=1400,1000', 'about:blank',
  ], { stdio: 'ignore' })
  let wsUrl
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      wsUrl = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json())
        .find(t => t.type === 'page')?.webSocketDebuggerUrl
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
    if (x.result?.exceptionDetails) throw new Error(JSON.stringify(x.result.exceptionDetails).slice(0, 400))
    return x.result?.result?.value
  }
  // nginx's part: the same three headers on every request the page makes.
  await send('Network.enable', {})
  await send('Network.setExtraHTTPHeaders', { headers: JEROME })
  const open = async () => { await send('Page.navigate', { url: `${base}/kanban/index.html` }); await wait(3000) }
  await open()

  // --- who is signed in, and what is gone ------------------------------------
  check('the header names who is signed in', await evalJS(`$('#whoName').textContent`) === 'Jérôme')
  check('with a Sign out posting to nginx', await evalJS(
    `(() => { const f = $('#whoami form'); return !$('#whoami').classList.contains('hidden') && f.method === 'post' && f.getAttribute('action') === '/auth/logout' })()`))
  check('the page knows it is signed in', await evalJS(`document.body.classList.contains('signed-in') && state.who.email === 'jerome@example.com'`))
  check('no Agents tab', await evalJS(`!settingsTabs().some(t => t[0] === 'agents') && !$('#viewToggle').textContent.includes('Agents')`))
  check('no Spend and Schedules tabs', await evalJS(`!settingsTabs().some(t => t[0] === 'spend' || t[0] === 'schedules') && settingsTabs().some(t => t[0] === 'settings')`))
  check('the board loaded the list', await evalJS(`!!state.doc && !state.demo && state.dataset === 'offdesk'`))

  // --- a new list, shared with the team ---------------------------------------
  await evalJS(`createDataset()`); await wait(300)
  const press = label => evalJS(`[...(modalEl || settingsRoot()).querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`)
  await evalJS(`(() => { const n = modalEl.querySelector('#wizName'); n.value = 'Team plan'; n.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await press('Next'); await wait(150)
  await evalJS(`(() => { const b = modalEl.querySelector('#wizBuckets'); b.value = 'Work'; b.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await press('Next'); await wait(150)
  await press('Next'); await wait(150)
  check('the last step asks who sees it', await evalJS(`!!modalEl.querySelector('input[name="shKind"]') && modalEl.textContent.includes('Who sees')`))
  check('personal is the default', await evalJS(`modalEl.querySelector('input[value="personal"]').checked`))
  await evalJS(`modalEl.querySelector('input[value="shared"]').click()`)
  check('shared offers the teams from the sign-in', await evalJS(`!!modalEl.querySelector('[data-team="offdesk"]')`))
  await press('Make the list'); await wait(300)
  check('shared with nobody is refused', !existsSync(join(data, 'team-plan')) && await evalJS(`!!modalEl`))
  await evalJS(`modalEl.querySelector('[data-team="offdesk"]').click()`)
  await press('Make the list'); await wait(3500)
  check('the list is made', existsSync(join(data, 'team-plan', 'todo.md')))
  check('shared with the team, owned by whoever made it', JSON.stringify(accessOf('team-plan')) ===
    JSON.stringify({ owner: 'jerome@example.com', people: [], teams: ['offdesk'] }), JSON.stringify(accessOf('team-plan')))
  check('and it is on screen for him', await evalJS(`state.dataset === 'team-plan'`))
  check('data/.current is left alone', !existsSync(join(data, '.current')))

  // --- Settings is his own profile ----------------------------------------------
  const profileFile = join(data, 'users', execFileSync('python3', ['-c',
    'import hashlib,sys;print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:16])', 'jerome@example.com']).toString().trim() + '.profile.md')
  await evalJS(`$('#settingsBtn').click()`); await wait(800)
  check('Settings is his profile', await evalJS(`!!settingsRoot() && settingsRoot().textContent.includes('Your profile') && settingsRoot().querySelector('[data-name]').value === 'Jérôme'`))
  check('with his name and address, and no paths', await evalJS(
    `!!settingsRoot().querySelector('[data-about="addressing"]') && !settingsRoot().querySelector('[data-section]') && !settingsRoot().querySelector('[data-about="facts_file"]')`))
  check('and none of the server’s settings', await evalJS(`!settingsRoot().querySelector('[data-memory]') && !settingsRoot().querySelector('[data-chime]') && !settingsRoot().querySelector('[data-agent-options]')`))
  await evalJS(`(() => {
    const set = (sel, v) => { const el = settingsRoot().querySelector(sel); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }
    set('[data-about="addressing"]', 'Salut Jérôme')
  })()`)
  await press('Save'); await wait(600)
  const own = existsSync(profileFile) ? readFileSync(profileFile, 'utf8') : ''
  check('saved to his own file', /^- Name: Jérôme$/m.test(own) && /^- How to address them: Salut Jérôme$/m.test(own), own.slice(0, 200))
  check('nothing written to the shared profile', !existsSync(join(data, 'profile.md')))
  await evalJS(`$('#settingsBtn').click()`); await wait(800)
  check('it reads back', await evalJS(`settingsRoot().querySelector('[data-about="addressing"]').value === 'Salut Jérôme'`))

  // --- the owner changes the sharing from there ----------------------------------
  await evalJS(`settingsRoot().querySelector('[data-sharing]').click()`); await wait(500)
  check('Who sees is a button in it', await evalJS(`!!modalEl && modalEl.textContent.includes('Who sees') && modalEl.querySelector('input[value="shared"]').checked`))
  await evalJS(`modalEl.querySelector('input[value="personal"]').click()`)
  await press('Save'); await wait(500)
  check('saved as personal', JSON.stringify(accessOf('team-plan')) ===
    JSON.stringify({ owner: 'jerome@example.com', people: [], teams: [] }), JSON.stringify(accessOf('team-plan')))
  await evalJS(`$('#settingsBtn').click()`); await wait(800)
  await evalJS(`settingsRoot().querySelector('[data-sharing]').click()`); await wait(500)
  await evalJS(`modalEl.querySelector('input[value="shared"]').click()`)
  await evalJS(`(() => { const t = modalEl.querySelector('#shPeople'); t.value = 'tiago@example.com'; t.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await press('Save'); await wait(500)
  check('saved with a named person', JSON.stringify(accessOf('team-plan').people) === '["tiago@example.com"]', JSON.stringify(accessOf('team-plan')))
} catch (err) {
  check('the suite ran to the end', false, String(err && err.stack || err).slice(0, 400))
} finally {
  const failed = checks.filter(c => !c).length
  console.log(`\n${checks.length - failed} ok, ${failed} failed`)
  cleanup()
  process.exit(failed ? 1 : 0)
}
