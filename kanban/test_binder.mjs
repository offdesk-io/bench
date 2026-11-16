#!/usr/bin/env node
/* Binder is optional: the `binder_url` setting (core/settings.py) decides
 * whether a task's lead is shown at all.
 *
 *   node kanban/test_binder.mjs     # or scripts/test-board.sh test_binder.mjs
 *
 * Starts a server of its own over a temp data root holding one list (`_test`,
 * from demo.md) and no settings.json, so this install has no Binder. Then:
 *   - with no Binder, a lead is on no card, in no drawer and in no PA change,
 *     and the tag itself still reads and writes as it always did;
 *   - PUT /settings.json sets the address (a trailing slash is taken off) and
 *     refuses a value that is not a web address; after a reload the lead chip,
 *     the Lead field and the PA's lead are back, on that address;
 *   - a null clears it, and the page is back to no Binder.
 * The real data/ and the shared test server are never touched.
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
const freePort = () => Number(execFileSync('python3', ['-c',
  'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])']).toString())

const root = mkdtempSync(join(tmpdir(), 'bench-binder-test-'))
const data = join(root, 'data')
mkdirSync(join(data, '_test', 'backups'), { recursive: true })
copyFileSync(join(HERE, 'demo.md'), join(data, '_test', 'todo.md'))
writeFileSync(join(data, '.current'), '_test')
writeFileSync(join(data, 'profile.md'), '- Name: Morgan\n')
const settingsFile = join(data, 'settings.json')
const PORT = freePort()
const CDP = freePort()
const server = spawn('python3', ['-u', join(HERE, 'server.py')], {
  env: { ...process.env, TODOS_SHOW_HIDDEN: '1', TODOS_DATA_ROOT: data, TODOS_PORT: String(PORT), TODOS_NO_BROWSER: '1' },
  stdio: 'ignore',
})
let chrome, ws
const cleanup = () => {
  try { ws?.close() } catch {}
  chrome?.kill(); server.kill()
  try { rmSync(root, { recursive: true, force: true }) } catch {}
}
process.on('exit', cleanup)

const base = `http://127.0.0.1:${PORT}`
const putSettings = (body) => fetch(`${base}/settings.json`, {
  method: 'PUT', headers: { 'X-Board': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})
const savedBinder = () => existsSync(settingsFile)
  ? JSON.parse(readFileSync(settingsFile, 'utf8')).binder_url : undefined

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/datasets.json`)).ok) break } catch {}
    await wait(250)
  }

  chrome = spawn(CHROME_BIN, [
    '--headless=new', '--mute-audio', `--remote-debugging-port=${CDP}`, '--no-first-run',
    `--user-data-dir=${process.env.CHROME_PROFILE ? process.env.CHROME_PROFILE + 'binder' : join(root, 'chrome')}`,
    '--window-size=1400,1000', `${base}/kanban/index.html`,
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
  // Reload, wait for the list, then lock the tab: a locked tab cannot save.
  const reload = async () => {
    await send('Page.reload', {})
    await wait(1500)
    for (let i = 0; i < 80 && !(await evalJS(`!!state.doc`).catch(() => false)); i++) await wait(250)
    await evalJS(`state.locked = true`)
    await wait(300)
  }
  await reload()

  // A task with a lead, put on the page the way the board would draw it.
  const leadOn = (slug) => evalJS(`(() => {
    state.view = 'board';
    const t = state.doc.buckets.flatMap(b => b.tiers.flatMap(x => x.tasks)).find(x => !x.done);
    t.lead = ${JSON.stringify(slug)}; window.__leadTask = t.id; renderView();
    return t.id;
  })()`)
  const cardText = () => evalJS(`(() => {
    const c = document.querySelector('#board .tenon-card[data-id="' + window.__leadTask + '"]');
    return c ? c.textContent : null;
  })()`)
  const drawerLead = () => evalJS(`(() => {
    openDrawer(window.__leadTask);
    return {
      field: !!document.querySelector('#f-lead'),
      open: !!document.querySelector('#f-lead-open'),
      row: [...document.querySelectorAll('#dbody .field > span')].some(s => s.textContent.trim() === 'Lead'),
      links: [...document.querySelectorAll('#dbody a')].map(a => a.getAttribute('href')).filter(h => h && h.indexOf('/o/') > -1),
    };
  })()`)
  const paLead = () => evalJS(`(() => {
    const t = state.doc.buckets.flatMap(b => b.tiers.flatMap(x => x.tasks)).find(x => x.id === window.__leadTask);
    const before = t.lead;
    const edit = paApplyOne({ kind: 'edit', task: t.stableId || t.title, field: 'lead', value: 'Probe Co' });
    const add = paApplyOne({ kind: 'add', title: 'Probe lead task', lead: 'probe-co' });
    const pushed = state.doc.buckets.flatMap(b => b.tiers.flatMap(x => x.tasks)).some(x => x.title === 'Probe lead task');
    return { edit: edit.error || '', editKept: t.lead === before, add: add.error || '', pushed,
      fieldError: (paFieldValue('lead', 'Acme Studio') || {}).error || '' };
  })()`)

  /* ---- no Binder: the install has no binder_url ---- */
  check('with no binder_url, the page has no Binder address', await evalJS(`BINDER_URL === ''`))
  check('and the server says so: /owner.js has no address', (await (await fetch(`${base}/owner.js`)).text()).includes('window.BENCH_BINDER_URL = ""'))
  check('the settings file is absent until something is saved', !savedBinder())

  await leadOn('acme-studio')
  const card = await cardText()
  check('no card shows a lead chip, and no link leads to a Binder organisation', card !== null &&
    !card.includes('acme-studio') && (await evalJS(`document.querySelectorAll('a[href*="/o/"]').length`)) === 0,
    JSON.stringify(card))
  const dr = await drawerLead()
  check('the drawer has no Lead field, no Open in Binder link and no Lead row', !dr.field && !dr.open && !dr.row && dr.links.length === 0,
    JSON.stringify(dr))
  const pa = await paLead()
  check('the PA cannot set a lead: an edit is refused and leaves the task as it was', pa.edit.includes('Binder') && pa.editKept,
    JSON.stringify(pa))
  check('the PA cannot add a task with a lead, and the task is not added', pa.add.includes('Binder') && !pa.pushed, JSON.stringify(pa))
  check('a lead is refused by the field check, with the reason', pa.fieldError.includes('Binder'), JSON.stringify(pa))
  check('the PA\'s first message says there is no lead to set', await evalJS(`paPreface('x').includes('Binder is not set up')`))
  const line = await evalJS(`serializeTask(parseTask(['- [ ] **Filed** [lead:: Acme-Studio] \`id:bbbbbb\`']))[0]`)
  check('the lead tag still reads and writes unchanged with no Binder', line.includes('[lead:: Acme-Studio]') &&
    (await evalJS(`parseTask(['- [ ] **Filed** [lead:: Acme-Studio]']).lead`)) === 'Acme-Studio', line)

  /* ---- the setting: a web address, saved and read back ---- */
  let r = await putSettings({ binder_url: 'binder.example.com' })
  check('a binder_url that is not a web address is refused, and nothing is written', r.status === 400 && !savedBinder(), String(r.status))
  r = await putSettings({ binder_url: 'https://binder.example.com/' })
  check('a web address is saved without its trailing slash', r.status === 200 && savedBinder() === 'https://binder.example.com', String(savedBinder()))

  /* ---- Binder on: the same checks, with the address ---- */
  await reload()
  check('with binder_url set, the page reads it, without a trailing slash', await evalJS(`BINDER_URL === 'https://binder.example.com'`))
  await leadOn('acme-studio')
  check('the lead chip is a link to its page on that address', await evalJS(`
    !!document.querySelector('#board .tenon-card[data-id="' + window.__leadTask + '"] a[href="https://binder.example.com/o/acme-studio"]')`))
  const dr2 = await drawerLead()
  check('the drawer has its Lead row and Open in Binder link on that address', dr2.row && dr2.open &&
    dr2.links.includes('https://binder.example.com/o/acme-studio'), JSON.stringify(dr2))
  const pa2 = await paLead()
  check('the PA sets a lead on that address, and adds one', pa2.edit === '' && pa2.editKept === false && pa2.add === '' && pa2.pushed, JSON.stringify(pa2))

  /* ---- and cleared again ---- */
  r = await putSettings({ binder_url: null })
  check('null clears the address, and the file no longer has one', r.status === 200 && !savedBinder(), String(savedBinder()))
  await reload()
  check('with it cleared, the page has no Binder again', await evalJS(`BINDER_URL === ''`))
  await leadOn('acme-studio')
  check('and the lead is hidden again', (await evalJS(`document.querySelectorAll('a[href*="/o/"]').length`)) === 0)
} finally {
  ws?.close()
  chrome?.kill()
}

const failed = checks.filter(x => !x).length
console.log(`\n${checks.length - failed} checks passed${failed ? `, ${failed} failed` : ''}`)
process.exit(failed ? 1 : 0)
