#!/usr/bin/env node
/* First-run setup and the Settings screen (kanban/js/29-settings.js).
 *
 *   node kanban/test_settings.mjs   # or scripts/test-board.sh test_settings.mjs
 *
 * Starts a server of its own over a temp data root with no profile, so the real
 * data/ and the shared test server are never touched. A second one runs over a
 * root with no list at all, for step 2 of the welcome (the first list).
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

const root = mkdtempSync(join(tmpdir(), 'bench-settings-test-'))
const data = join(root, 'data')
mkdirSync(join(data, '_test', 'backups'), { recursive: true })
copyFileSync(join(HERE, 'demo.md'), join(data, '_test', 'todo.md'))
writeFileSync(join(data, '.current'), '_test')
// Holidays come from fixtures, never the network: a missing file counts as offline.
const fixtures = join(root, 'holiday-fixtures')
mkdirSync(fixtures)
const year = new Date().getFullYear()
const hol = (date, name, global, counties) => ({ date, localName: name, name, global, counties, types: ['Public'] })
writeFileSync(join(fixtures, 'countries.json'), JSON.stringify([
  { countryCode: 'GB', name: 'United Kingdom' }, { countryCode: 'PT', name: 'Portugal' }, { countryCode: 'DE', name: 'Germany' }]))
writeFileSync(join(fixtures, `GB-${year}.json`), JSON.stringify([
  hol(`${year}-01-01`, "New Year's Day", true, null),
  hol(`${year}-01-02`, '2nd January', false, ['GB-SCT']),
  hol(`${year}-11-30`, "St Andrew's Day", false, ['GB-SCT'])]))
writeFileSync(join(fixtures, `DE-${year}.json`), JSON.stringify([hol(`${year}-10-03`, 'German Unity Day', true, null)]))
const PORT = freePort()
const CDP = freePort()
const server = spawn('python3', ['-u', join(HERE, 'server.py')], {
  env: { ...process.env, BENCH_HOLIDAYS_FIXTURES: fixtures, TODOS_DATA_ROOT: data, TODOS_PORT: String(PORT), TODOS_NO_BROWSER: '1' },
  stdio: 'ignore',
})
// A checkout with nothing in data/: no profile, no list.
const data2 = join(root, 'data2')
mkdirSync(data2)
const PORT2 = freePort()
const server2 = spawn('python3', ['-u', join(HERE, 'server.py')], {
  env: { ...process.env, BENCH_HOLIDAYS_FIXTURES: fixtures, TODOS_DATA_ROOT: data2, TODOS_PORT: String(PORT2), TODOS_NO_BROWSER: '1' },
  stdio: 'ignore',
})
let chrome, ws
const cleanup = () => {
  try { ws?.close() } catch {}
  chrome?.kill(); server.kill(); server2.kill()
  try { rmSync(root, { recursive: true, force: true }) } catch {}
}
process.on('exit', cleanup)

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/datasets.json`)).ok) break } catch {}
    await wait(250)
  }
  const base = `http://127.0.0.1:${PORT}`

  // The server side first.
  let r = await fetch(`${base}/profile-basics.json`).then(x => x.json())
  check('no profile asks for setup', r.needs_setup === true && r.name === '')
  r = await fetch(`${base}/profile-basics.json`, { method: 'PUT', body: '{"name":"Sam"}' })
  check('PUT /profile-basics.json without X-Board is refused', r.status === 403)
  r = await fetch(`${base}/settings.json`, { method: 'PUT', body: '{"models":{"plan":"opus"}}' })
  check('PUT /settings.json without X-Board is refused', r.status === 403)
  check('nothing was written by the refused PUTs', !existsSync(join(data, 'profile.md')) && !existsSync(join(data, 'settings.json')))

  chrome = spawn(CHROME_BIN, [
    '--headless=new', `--remote-debugging-port=${CDP}`, '--no-first-run',
    `--user-data-dir=${process.env.CHROME_PROFILE ? process.env.CHROME_PROFILE + 'settings' : join(root, 'chrome')}`,
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
    if (x.result?.exceptionDetails) throw new Error(JSON.stringify(x.result.exceptionDetails).slice(0, 400))
    return x.result?.result?.value
  }
  const reload = async () => { await send('Page.reload', {}); await wait(3000) }
  const shown = () => evalJS(`!!(modalEl && modalEl.textContent.includes('Welcome to Bench'))`)
  const settingsShown = () => evalJS(`!!(modalEl && modalEl.querySelector('[data-name]') && !modalEl.textContent.includes('Welcome'))`)
  const pick = (sel, value) => evalJS(`(() => { const s = modalEl.querySelector(${JSON.stringify(sel)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  const fill = async (name, country, region, models) => {
    await pick('[data-country]', country)
    await wait(600)
    if (region) await pick('[data-region]', region)
    await fillRest(name, models)
  }
  const fillRest = (name, models) => evalJS(`(() => {
    const n = modalEl.querySelector('[data-name]'); n.value = ${JSON.stringify(name)}; n.dispatchEvent(new Event('input', { bubbles: true }))
    for (const [k, v] of Object.entries(${JSON.stringify(models)})) { const s = modalEl.querySelector('[data-model=' + k + ']'); s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })) }
  })()`)
  const press = label => evalJS(`[...modalEl.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`)

  const exists = sel => evalJS(`!!(modalEl && modalEl.querySelector(${JSON.stringify(sel)}))`)
  const saveDisabled = () => evalJS(`[...modalEl.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save').disabled`)
  const label = sel => evalJS(`modalEl.querySelector(${JSON.stringify(sel)} + ' option[value=""]').textContent`)
  const escape = async () => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await wait(300)
  }

  await wait(3000)
  check('onboarding shows with no profile', await shown())
  check('onboarding mentions scripts/install.sh', await evalJS(`modalEl.textContent.includes('scripts/install.sh')`))
  check('default model starts on Sonnet', await evalJS(`modalEl.querySelector('[data-model=default]').value`) === 'sonnet')
  check('brief model starts on Haiku', await evalJS(`modalEl.querySelector('[data-model=brief]').value`) === 'haiku')

  // Required: no way out.
  check('onboarding offers no Projects folder', !(await exists('[data-projects]')))
check('onboarding has no Skip button', !(await evalJS(`modalEl.textContent.includes('Skip')`)))
  check('onboarding has no close button', !(await exists('.tenon-modal__head button')))
  await escape()
  check('Escape does not dismiss onboarding', await shown())
  await evalJS(`document.querySelector('.tenon-modal__scrim').click()`)
  await wait(300)
  check('the scrim does not dismiss onboarding', await shown())
  check('no skip flag is kept in the browser', await evalJS(`Object.keys(localStorage).every(k => !/onboard/i.test(k))`))

  // Name and Country are required.
  check('Save is disabled until Name and Country are set', await saveDisabled())
  check('onboarding offers no "Not set" country', !(await evalJS(`modalEl.querySelector('[data-country]').textContent.includes('Not set')`)))
  await fillRest('Sam', {})
  check('Save is still disabled with a name and no country', await saveDisabled())
  await evalJS(`modalEl.querySelector('[data-country]').dispatchEvent(new Event('focusout', { bubbles: true }))`)
  check('a missing country shows inline text', await evalJS(`modalEl.querySelector('[data-err=country]').textContent`) === 'Choose a country.')
  await fillRest('', {})
  await evalJS(`modalEl.querySelector('[data-name]').dispatchEvent(new Event('focusout', { bubbles: true }))`)
  check('a missing name shows inline text', await evalJS(`modalEl.querySelector('[data-err=name]').textContent`) === 'Add your name.')

  // Agent options: shut by default, and the labels say what they resolve to.
  check('Agent options starts collapsed', await evalJS(`modalEl.querySelector('[data-agent-options]').open`) === false)
  check('Agent options is titled Agent options', await evalJS(`modalEl.querySelector('[data-agent-options] summary').textContent.trim()`) === 'Agent options')
  check('Use default names Sonnet', await label('[data-model=plan]') === 'Use default (Sonnet)')
  check('brief with no default names Haiku after Default is cleared', true)
  await pick('[data-model=default]', 'opus')
  check('labels follow the Default model', await label('[data-model=implement]') === 'Use default (Opus)' && await label('[data-model=chat]') === 'Use default (Opus)')
  await pick('[data-model=default]', '')
  check('with no default, brief falls back to Haiku', await label('[data-model=brief]') === 'Use default (Haiku)')
  check('with no default, others name Claude Code\'s default', await label('[data-model=plan]') === 'Use default (Claude Code’s default)')
  check('the Default select names what each tool falls back to', (await label('[data-model=default]')).includes('Claude Code’s default') && (await label('[data-model=default]')).includes('Haiku for briefs'))
  await pick('[data-model=default]', 'sonnet')
  check('each agent has a start choice defaulting to scheduled', await evalJS(`modalEl.querySelector('[data-start=plan]').value + modalEl.querySelector('[data-start=implement]').value`) === 'scheduledscheduled')
  check('the start choices read as asked', await evalJS(`[...modalEl.querySelectorAll('[data-start=plan] option')].map(o => o.textContent).join('|')`) === 'Wait for its scheduled hours|Start straight away')
  check('each agent shows its avatar beside its name', await evalJS(`[...modalEl.querySelectorAll('.agentopts__group h4')].filter(h => /Plan agent|Implement agent|Bucket planners/.test(h.textContent)).every(h => h.querySelector('.avatar svg[width="18"]'))`)
    && await evalJS(`modalEl.querySelectorAll('.agentopts__group h4 .avatar').length`) === 3)
  check('Plan agent avatar is the one the board draws for it', await evalJS(`(() => { const d = document.createElement('div'); d.innerHTML = agentAvatarHTML('Plan agent', 18); return d.querySelector('svg').innerHTML === modalEl.querySelector('.agentopts__group h4 svg').innerHTML })()`))
  check('the Agents tab line is there', await evalJS(`modalEl.textContent.includes('Set each agent’s hours later in the board’s Agents tab.')`))
  check('chat and brief sit under Other', await evalJS(`[...modalEl.querySelectorAll('.agentopts__group')].some(g => g.textContent.startsWith('Other') && g.querySelector('[data-model=chat]') && g.querySelector('[data-model=brief]'))`))
  await evalJS(`modalEl.querySelector('[data-agent-options]').open = true`)

  await pick('[data-start=plan]', 'now')
  await fill('Sam', 'PT', '', { default: 'sonnet', plan: 'opus', brief: 'haiku' })
  check('Save enables once Name and Country are set', !(await saveDisabled()))
  await press('Save')
  await wait(3500)
  const profile = existsSync(join(data, 'profile.md')) ? readFileSync(join(data, 'profile.md'), 'utf8') : ''
  check('profile.md has the Name', /^- Name: Sam$/m.test(profile), JSON.stringify(profile.slice(0, 80)))
  check('profile.md has the Country', /^- Country: PT$/m.test(profile))
  check('profile.md has no Region for a country without any', !/^- Region:/m.test(profile))
  const saved = JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8'))
  check('settings.json has the models', saved.models.plan === 'opus' && saved.models.default === 'sonnet' && saved.models.brief === 'haiku' && saved.models.chat === null)
  check('settings.json has when each agent starts', saved.agents.plan.start === 'now' && saved.agents.implement.start === 'scheduled', JSON.stringify(saved.agents))
  check('the board knows the new owner without a restart', await evalJS(`OWNER_NAME`) === 'Sam')
  check('onboarding is gone after saving', !(await shown()))
  await reload()
  check('onboarding does not come back on reload', !(await shown()))

  await evalJS(`$('#settingsBtn').click()`)
  await wait(800)
  check('Settings opens from the Data menu', await settingsShown())
  check('Settings has a Cancel and a close', await evalJS(`[...modalEl.querySelectorAll('button')].some(b => b.textContent.trim() === 'Cancel')`) && await exists('.tenon-modal__head button'))
  check('Settings opens with Agent options collapsed', await evalJS(`modalEl.querySelector('[data-agent-options]').open`) === false)
  check('Settings shows the saved name', await evalJS(`modalEl.querySelector('[data-name]').value`) === 'Sam')
  check('Settings shows the saved country', await evalJS(`modalEl.querySelector('[data-country]').value`) === 'PT')
  check('the Region select is hidden for a country without regions', await evalJS(`modalEl.querySelector('[data-region-field]').hidden`) === true)
  check('Settings shows the saved model', await evalJS(`modalEl.querySelector('[data-model=plan]').value`) === 'opus')
  check('Settings shows the saved start', await evalJS(`modalEl.querySelector('[data-start=plan]').value`) === 'now')
  check('the model list is the server\'s', await evalJS(`[...modalEl.querySelectorAll('[data-model=chat] option')].map(o => o.value).join()`) === ',opus,sonnet,haiku')
  await fillRest('', {})
  check('Settings needs a name too', await saveDisabled())
  await fillRest('Sam', {})

  await fill('Alex', 'GB', 'GB-SCT', { plan: '', implement: 'haiku' })
  await pick('[data-start=plan]', 'scheduled')
  await press('Save')
  await wait(3500)
  const p2 = readFileSync(join(data, 'profile.md'), 'utf8')
  const s2 = JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8'))
  check('Settings round-trips the name', /^- Name: Alex$/m.test(p2))
  check('Settings round-trips the country', /^- Country: GB$/m.test(p2))
  check('Settings round-trips the region', /^- Region: GB-SCT$/m.test(p2))
  check('Settings round-trips the start', s2.agents.plan.start === 'scheduled')
  await evalJS(`$('#settingsBtn').click()`)
  await wait(800)
  check('Settings reopens on the saved region', await evalJS(`modalEl.querySelector('[data-region]').value`) === 'GB-SCT'
    && await evalJS(`modalEl.querySelector('[data-region-field]').hidden`) === false)
  // The projects folder: offered in Settings, saved only once it is a folder.
  const projects = join(root, 'PROJECTS')
  mkdirSync(projects)
  check('Settings offers a Projects folder for the open list, empty by default', await evalJS(`modalEl.querySelector('[data-projects]').value`) === ''
    && (await evalJS(`modalEl.querySelector('[data-projects]').closest('label').textContent`)).includes('Projects folder for '))
  await evalJS(`(() => { const i = modalEl.querySelector('[data-projects]'); i.value = ${JSON.stringify(projects)}; i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await press('Save')
  await wait(2500)
  check('Settings saves the Projects folder', (JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8')).projects_roots || {})[await evalJS('state.dataset')] === projects)
  await evalJS(`$('#settingsBtn').click()`)
  await wait(800)
  check('and reopens showing it', await evalJS(`modalEl.querySelector('[data-projects]').value`) === projects)

  // The rest of the profile: About fields, then one box per section, collapsed.
  check('Settings offers every section of the profile', await evalJS(
    `['setup', 'writing', 'recorder', 'habits'].every(k => !!modalEl.querySelector('[data-section="' + k + '"]'))` +
    ` && !!modalEl.querySelector('[data-about="addressing"]') && !!modalEl.querySelector('[data-about="facts_file"]')`))
  check('the profile sections start collapsed, and the boxes empty', await evalJS(
    `!modalEl.querySelector('[data-profile-sections]').open && [...modalEl.querySelectorAll('[data-section]')].every(t => t.value === '')`))
  const setField = (sel, v) => evalJS(`(() => { const el = modalEl.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await setField('[data-section="writing"]', '## Writing\n- Spelling: British English')
  check('a ## heading in a box blocks Save', await saveDisabled())
  await setField('[data-section="writing"]', '- Spelling: British English\n- Message opening: Hey <name>')
  await setField('[data-about="addressing"]', 'Hey <Alex>')
  check('< > in a field blocks Save', await saveDisabled())
  await setField('[data-about="addressing"]', 'Hey Alex')
  await setField('[data-section="habits"]', '- Deferring: logs ideas first')
  await press('Save')
  await wait(3000)
  const p4 = readFileSync(join(data, 'profile.md'), 'utf8')
  check('Settings writes the About field', /^- How to address them: Hey Alex$/m.test(p4), p4)
  check('and each box into its section', /## Writing\n\n- Spelling: British English\n- Message opening: Hey <name>\n/.test(p4)
    && /## Working habits\n\n- Deferring: logs ideas first\n/.test(p4), p4)
  check('a box left empty keeps the template', /## Meeting recorder\n\n- Recorder: </.test(p4), p4)
  check('and the rest of the profile stays', /^- Name: Alex$/m.test(p4) && /^- Country: GB$/m.test(p4))
  check('nobody signed in, nothing goes to data/users', !existsSync(join(data, 'users')))
  await evalJS(`$('#settingsBtn').click()`)
  await wait(800)
  check('and it reads back as written', await evalJS(`modalEl.querySelector('[data-section="habits"]').value === '- Deferring: logs ideas first'
    && modalEl.querySelector('[data-section="writing"]').value === '- Spelling: British English\\n- Message opening: Hey <name>'
    && modalEl.querySelector('[data-about="addressing"]').value === 'Hey Alex'`))

  // The reply chime is a switch: a click turns it off, and Save writes it.
  check('the reply chime starts on, as a switch', await evalJS(`(() => { const s = modalEl.querySelector('[data-chime]');
    return s.getAttribute('role') === 'switch' && s.getAttribute('aria-checked') === 'true' && s.classList.contains('tenon-switch--on') })()`))
  await evalJS(`modalEl.querySelector('[data-chime]').click()`)
  check('a click turns the reply chime off', await evalJS(`modalEl.querySelector('[data-chime]').getAttribute('aria-checked') === 'false'`))
  await press('Save')
  await wait(2500)
  check('Settings saves the reply chime off', JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8')).chime === false)
  await evalJS(`$('#settingsBtn').click()`)
  await wait(800)
  check('and reopens with the switch off', await evalJS(`modalEl.querySelector('[data-chime]').getAttribute('aria-checked') === 'false'`))
  await evalJS(`modalEl.querySelector('[data-chime]').click()`)
  await press('Save')
  await wait(2500)
  check('and a second click saves it back on', JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8')).chime === true)
  await evalJS(`$('#settingsBtn').click()`)
  await wait(800)

  // "This board": the open list's own memory folder, banners and agents.
  const listName = await evalJS('state.dataset')
  const profileBefore = readFileSync(join(data, 'profile.md'), 'utf8')
  const boardSet = () => (JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8')).boards || {})[listName]
  const reopen = async () => { await evalJS(`$('#settingsBtn').click()`); await wait(800) }
  check('Settings has a This board group', await evalJS(`!!modalEl.querySelector('[data-board-group]') && modalEl.querySelector('[data-board-group] h4').textContent === 'This board'`))
  check('it starts on the main memory folder, banners and agents on', await evalJS(`modalEl.querySelector('[data-board-memory-mode]').value === 'inherit'
    && modalEl.querySelector('[data-board-memory]').hidden
    && modalEl.querySelector('[data-board-banners]').getAttribute('aria-checked') === 'true'
    && modalEl.querySelector('[data-board-agents]').getAttribute('aria-checked') === 'true'`))
  check('the memory folder offers the three choices', await evalJS(`[...modalEl.querySelectorAll('[data-board-memory-mode] option')].map(o => o.textContent).join('|')`)
    === 'Same as main memory folder|None, keep everything in Bench|Its own folder')
  check('each control has a line of help', await evalJS(`[...modalEl.querySelectorAll('[data-board-group] .field')].length === 3 && [...modalEl.querySelectorAll('[data-board-group] .field')].every(f => f.querySelector('.help').textContent.length > 10)`))
  await evalJS(`modalEl.querySelector('[data-board-banners]').click()`)
  await press('Save')
  await wait(2500)
  check('switching banners off sends only banners', JSON.stringify(boardSet()) === '{"banners":false}', JSON.stringify(boardSet()))
  await reopen()
  check('and it reopens with banners off', await evalJS(`modalEl.querySelector('[data-board-banners]').getAttribute('aria-checked')`) === 'false')
  await evalJS(`modalEl.querySelector('[data-board-agents]').click()`)
  await press('Save')
  await wait(2500)
  check('switching agents off adds only agents', JSON.stringify(boardSet()) === '{"banners":false,"agents":false}', JSON.stringify(boardSet()))
  await reopen()
  await pick('[data-board-memory-mode]', 'none')
  check('None hides the path field', await evalJS(`modalEl.querySelector('[data-board-memory]').hidden`))
  await press('Save')
  await wait(2500)
  check('None sends a null memory folder', boardSet().memory_root === null && boardSet().banners === false, JSON.stringify(boardSet()))
  await reopen()
  check('and reopens on None', await evalJS(`modalEl.querySelector('[data-board-memory-mode]').value`) === 'none')
  // A list with no memory folder has no profile of its own yet, so its name is empty.
  await fillRest('Alex', {})
  await pick('[data-board-memory-mode]', 'own')
  check('Its own folder shows the path field', await evalJS(`!modalEl.querySelector('[data-board-memory]').hidden`))
  check('an empty path blocks Save', await saveDisabled())
  const ownDir = join(root, 'BOARDMEM')
  mkdirSync(ownDir)
  await setField('[data-board-memory]', ownDir)
  await press('Save')
  await wait(2500)
  check('its own folder is saved as that path', boardSet().memory_root === ownDir, JSON.stringify(boardSet()))
  await reopen()
  check('and reopens showing the path', await evalJS(`modalEl.querySelector('[data-board-memory-mode]').value === 'own' && modalEl.querySelector('[data-board-memory]').value`) === ownDir)
  await setField('[data-board-memory]', join(root, 'no-such-folder'))
  await press('Save')
  await wait(1500)
  check('a path the server refuses shows its message', await evalJS(`[...document.querySelectorAll('#toasts .toast')].some(t => t.textContent.startsWith('Could not save:') && t.textContent.length > 20)`))
  check('and the refused path was not kept', boardSet().memory_root === ownDir)
  await pick('[data-board-memory-mode]', 'inherit')
  await press('Save')
  await wait(2500)
  check('Same as main sends inherit, which drops the entry key', !('memory_root' in boardSet()) && boardSet().banners === false, JSON.stringify(boardSet()))
  await reopen()
  await evalJS(`modalEl.querySelector('[data-board-banners]').click(); modalEl.querySelector('[data-board-agents]').click()`)
  await press('Save')
  await wait(2500)
  check('switching both back on empties the entry', boardSet() === undefined, JSON.stringify(boardSet()))
  // Signed in, the server's settings are not the visitor's: no group.
  await reopen()
  await evalJS(`closeModal(); state.who = { name: 'Visitor', teams: [] }`)
  await reopen()
  check('signed in, there is no This board group', await evalJS(`!modalEl.querySelector('[data-board-group]')`))
  await evalJS(`closeModal(); state.who = null`)
  // The list had a profile of its own while it kept its own folder; put the owner's back as it was.
  rmSync(join(data, listName, 'profile.md'), { force: true })
  writeFileSync(join(data, 'profile.md'), profileBefore)
  await reload()
  await reopen()

  const regionList = await fetch(`${base}/holiday-regions.json?country=GB`).then(x => x.json())
  check('GB has its four regions', regionList.map(x => x.code).join() === 'GB-ENG,GB-NIR,GB-SCT,GB-WLS', JSON.stringify(regionList))
  r = await fetch(`${base}/holiday-countries.json`).then(x => x.json())
  check('the country list is every country', r.countries.length >= 240 && r.regions.GB.length === 4, String(r.countries.length))
  check('countries Nager covers are marked', ['DE', 'PT', 'GB'].every(c => r.countries.find(x => x.code === c).holidays === true)
    && r.countries.find(x => x.code === 'AQ').holidays === false)
  r = await fetch(`${base}/profile-basics.json`, { method: 'PUT', headers: { 'X-Board': '1' }, body: '{"country":"XX"}' })
  check('PUT with an unknown country is refused', r.status === 400)
  r = await fetch(`${base}/profile-basics.json`, { method: 'PUT', headers: { 'X-Board': '1' }, body: '{"country":"GB","region":"PT-20"}' })
  check('PUT with a region from another country is refused', r.status === 400)
  r = await fetch(`${base}/profile-basics.json`).then(x => x.json())
  check('profile-basics reports country and region', r.country === 'GB' && r.region === 'GB-SCT' && !('holidays' in r))
  check('Bucket planners follow the Plan agent by default', await label('[data-model=planner]') === 'Same as the Plan agent (Use default)' ? false : (await label('[data-model=planner]')).startsWith('Same as the Plan agent ('))
  // A country with no holiday list is still saved, with a note.
  await pick('[data-country]', 'AQ')
  await wait(600)
  check('a country with no holiday list shows the note', await evalJS(`!modalEl.querySelector('[data-nolist]').hidden`)
    && (await evalJS(`modalEl.querySelector('[data-nolist]').textContent`)) === 'No public holiday list available for this country, so only weekends count as days off.')
  await pick('[data-country]', 'GB')
  await wait(600)
  check('the note goes for a country with a list', await evalJS(`modalEl.querySelector('[data-nolist]').hidden`))
  // The daily budget lives in the fences file, beside whatever else is in it.
  mkdirSync(join(data, 'agents'), { recursive: true })
  writeFileSync(join(data, 'agents', 'fences.json'), JSON.stringify({ other: 1 }))
  await pick('[data-model=planner]', 'haiku')
  await evalJS(`(() => { const b = modalEl.querySelector('[data-budget]'); b.value = '7.5'; b.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await evalJS(`(() => { const b = modalEl.querySelector('[data-budget]'); b.value = 'lots'; b.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  check('a budget that is not a number blocks Save', await saveDisabled())
  await evalJS(`(() => { const b = modalEl.querySelector('[data-budget]'); b.value = '7.5'; b.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await press('Save')
  await wait(3500)
  let fences = JSON.parse(readFileSync(join(data, 'agents', 'fences.json'), 'utf8'))
  check('the daily budget is written to fences.json, keeping other keys', fences.daily_budget === 7.5 && fences.other === 1, JSON.stringify(fences))
  check('the planner model is saved', JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8')).models.planner === 'haiku')
  await evalJS(`$('#settingsBtn').click()`)
  await wait(800)
  check('Settings reopens on the saved budget', await evalJS(`modalEl.querySelector('[data-budget]').value`) === '7.5')
  await evalJS(`(() => { const b = modalEl.querySelector('[data-budget]'); b.value = ''; b.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await press('Save')
  await wait(3500)
  fences = JSON.parse(readFileSync(join(data, 'agents', 'fences.json'), 'utf8'))
  check('an empty budget removes the limit and keeps other keys', !('daily_budget' in fences) && fences.other === 1, JSON.stringify(fences))
  // A daily budget per agent, in the same file under agent_budgets, keyed by runner id.
  const setAgentBudget = (k, v) => evalJS(`(() => { const b = modalEl.querySelector('[data-agent-budget=${k}]'); b.value = ${JSON.stringify(v)}; b.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  writeFileSync(join(data, 'agents', 'fences.json'), JSON.stringify({ other: 1, agent_budgets: { 'someone-else': 9 } }))
  await evalJS(`$('#settingsBtn').click()`)
  await wait(800)
  check('each agent has a budget field and the planners have none',
    await evalJS(`[...modalEl.querySelectorAll('[data-agent-budget]')].map(i => i.dataset.agentBudget).join()`) === 'plan,implement')
  check('the planners say they spend from the Plan agent’s budget',
    (await evalJS(`modalEl.querySelector('[data-model=planner]').closest('.field').textContent`)).includes('spend from its daily budget'))
  await setAgentBudget('plan', 'lots')
  check('an agent budget that is not a number blocks Save', await saveDisabled())
  await setAgentBudget('plan', '2')
  await setAgentBudget('implement', '5.5')
  await evalJS(`(() => { const b = modalEl.querySelector('[data-budget]'); b.value = '10'; b.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await press('Save')
  await wait(3500)
  fences = JSON.parse(readFileSync(join(data, 'agents', 'fences.json'), 'utf8'))
  check('agent budgets are written beside the total, keeping other keys and agents',
    fences.daily_budget === 10 && fences.other === 1 && fences.agent_budgets['plan-agent'] === 2
    && fences.agent_budgets['implement-agent'] === 5.5 && fences.agent_budgets['someone-else'] === 9, JSON.stringify(fences))
  await evalJS(`$('#settingsBtn').click()`)
  await wait(800)
  check('Settings reopens on the saved agent budgets',
    await evalJS(`modalEl.querySelector('[data-agent-budget=plan]').value`) === '2'
    && await evalJS(`modalEl.querySelector('[data-agent-budget=implement]').value`) === '5.5')
  await setAgentBudget('plan', '')
  await press('Save')
  await wait(3500)
  fences = JSON.parse(readFileSync(join(data, 'agents', 'fences.json'), 'utf8'))
  check('an empty agent budget removes only that agent',
    !('plan-agent' in fences.agent_budgets) && fences.agent_budgets['implement-agent'] === 5.5 && fences.daily_budget === 10, JSON.stringify(fences))
  r = await fetch(`${base}/settings.json`, { method: 'PUT', headers: { 'X-Board': '1' }, body: '{"agent_budgets":{"plan-agent":-1},"models":{"chat":"haiku"}}' })
  check('PUT with a negative agent budget is refused', r.status === 400)
  check('and writes nothing', !JSON.parse(readFileSync(join(data, 'agents', 'fences.json'), 'utf8')).agent_budgets['plan-agent']
    && JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8')).models.chat !== 'haiku')
  await evalJS(`$('#settingsBtn').click()`)
  await wait(800)
  await evalJS(`modalEl.close ? modalEl.close() : 0`)
  check('Settings round-trips the models', s2.models.plan === null && s2.models.implement === 'haiku')
  r = await fetch(`${base}/settings.json`, { method: 'PUT', headers: { 'X-Board': '1' }, body: '{"agents":{"plan":{"start":"later"}}}' })
  check('PUT with an unknown start is refused', r.status === 400)

  // An old profile: a Holidays line and no Country. Saving only a name keeps it.
  writeFileSync(join(data, 'profile.md'), '# PA profile\n\n## About\n\n- Name: Sam\n- Holidays: UK, PT\n')
  await reload()
  await evalJS(`$('#settingsBtn').click()`)
  await wait(800)
  check('an old Holidays line shows Keep current', await evalJS(`modalEl.querySelector('[data-country] option[value=""]').textContent`) === 'Keep current (UK and Portugal)')
  check('and it is the selected one', await evalJS(`modalEl.querySelector('[data-country]').value`) === '')
  await fillRest('Sam Jr', {})
  await press('Save')
  await wait(3500)
  const p3 = readFileSync(join(data, 'profile.md'), 'utf8')
  check('saving only a name changes the name', /^- Name: Sam Jr$/m.test(p3))
  check('saving only a name keeps the Holidays line', /^- Holidays: UK, PT$/m.test(p3), JSON.stringify(p3))
  check('saving only a name writes no Country', !/^- Country:/m.test(p3))
  // A profile with a country does not offer Keep current.
  writeFileSync(join(data, 'profile.md'), '# PA profile\n\n## About\n\n- Name: Sam\n- Country: PT\n')
  await reload()
  await evalJS(`$('#settingsBtn').click()`)
  await wait(800)
  check('a profile with a country offers no Keep current', !(await evalJS(`modalEl.querySelector('[data-country]').textContent.includes('Keep current')`)))
  await evalJS(`closeModal()`)

  // "Start straight away" asks the routes the board already has, after the save.
  await fetch(`${base}/settings.json`, { method: 'PUT', headers: { 'X-Board': '1' }, body: '{"agents":{"plan":{"start":"now"},"implement":{"start":"scheduled"}}}' })
  const calls = await evalJS(`(async () => {
    const real = window.postJSON, got = []
    window.postJSON = async (u, d) => { got.push([u, d || null]); return {} }
    queueAgentStart('plan'); queueAgentStart('implement')
    await flushAgentStarts()
    window.postJSON = real
    return got
  })()`)
  check('Plan agent set to now starts the Plan agent run, and Implement on scheduled waits', calls.length === 1 && calls[0][0] === '/planning_agent/run', JSON.stringify(calls))
  await fetch(`${base}/settings.json`, { method: 'PUT', headers: { 'X-Board': '1' }, body: '{"agents":{"plan":{"start":"scheduled"},"implement":{"start":"now"}}}' })
  const calls2 = await evalJS(`(async () => {
    const real = window.postJSON, got = []
    window.postJSON = async (u, d) => { got.push([u, d || null]); return {} }
    queueAgentStart('plan'); queueAgentStart('implement')
    await flushAgentStarts()
    window.postJSON = real
    return got
  })()`)
  check('Implement agent set to now runs it on the current list', calls2.length === 1 && calls2[0][0] === '/agents-api/run'
    && calls2[0][1].agent === 'implement-agent' && calls2[0][1].action === 'run' && calls2[0][1].target === '_test', JSON.stringify(calls2))
  const drawer = readFileSync(join(HERE, 'js', '19-drawer.js'), 'utf8')
  check('a hand-over and a plan approval both ask for a start', (drawer.match(/queueAgentStart\(/g) || []).length === 2)

  // Step 2: the first list, on a checkout with nothing in data/.
  const base2 = `http://127.0.0.1:${PORT2}`
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base2}/datasets.json`)).ok) break } catch {}
    await wait(250)
  }
  r = await fetch(`${base2}/datasets.json`).then(x => x.json())
  check('a data root with no lists answers without errors', Array.isArray(r.datasets) && r.datasets.length === 0)
  for (const route of ['settings.json', 'profile-basics.json', 'owner.js', 'agent-runs.json', 'chat-viewed.json', 'planning-agent.json', 'agents-planners.json?buckets=Making']) {
    const x = await fetch(`${base2}/${route}`)
    check(`GET /${route} on an empty root is not an error`, x.status === 200, String(x.status))
  }
  await send('Page.navigate', { url: `${base2}/kanban/index.html` })
  await wait(3500)
  check('step 1 is shown on a checkout with nothing', await shown() && await evalJS(`modalEl.textContent.includes('Step 1 of 2')`))
  check('the "Nothing here yet" sheet is gone', !(await evalJS(`document.body.textContent.includes('Nothing here yet')`)))
  await fill('Pat', 'DE', '', {})
  await press('Save')
  await wait(1500)
  check('Save leads to step 2 in the same modal', await shown() && await evalJS(`modalEl.textContent.includes('Step 2 of 2')`))
  check('step 2 has no Skip, no close, and Escape does nothing', !(await evalJS(`modalEl.textContent.includes('Skip')`)) && !(await exists('.tenon-modal__head button')) && (await escape(), await shown()))
  check('profile was saved before step 2', /^- Name: Pat$/m.test(readFileSync(join(data2, 'profile.md'), 'utf8')))
  check('the list name starts as Work', await evalJS(`modalEl.querySelector('[data-list-name]').value`) === 'Work')
  const rows = () => evalJS(`[...modalEl.querySelectorAll('[data-row]')].map(r => [r.querySelector('[data-b-name]').value, r.querySelector('[data-b-about]').value])`)
  let got = await rows()
  check('four buckets are pre-filled', got.map(x => x[0]).join() === 'Making,People,Admin,Learning', JSON.stringify(got.map(x => x[0])))
  check('each carries its description', got[0][1] === 'Designing, writing or building something new. Ends in a file, a draft or a prototype.' && got[3][1] === 'Learning'.length ? false : got[3][1].startsWith('Courses, reading and experiments.'))
  check('Create list is enabled', await evalJS(`!([...modalEl.querySelectorAll('button')].find(b => b.textContent.trim() === 'Create list').disabled)`))
  // required rows
  await evalJS(`(() => { const t = modalEl.querySelectorAll('[data-b-about]')[1]; t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  check('a bucket with no description disables Create list and says why', await evalJS(`[...modalEl.querySelectorAll('button')].find(b => b.textContent.trim() === 'Create list').disabled`)
    && (await evalJS(`modalEl.querySelectorAll('[data-b-err]')[1].textContent`)).length > 0)
  await evalJS(`(() => { modalEl.querySelectorAll('[data-b-remove]')[1].click() })()`)
  got = await rows()
  check('a bucket can be removed', got.map(x => x[0]).join() === 'Making,Admin,Learning')
  await evalJS(`modalEl.querySelector('[data-b-add]').click()`)
  check('a bucket can be added', (await rows()).length === 4 && (await rows())[3][0] === '')
  check('an empty added bucket blocks Create list', await evalJS(`[...modalEl.querySelectorAll('button')].find(b => b.textContent.trim() === 'Create list').disabled`))
  await evalJS(`(() => {
    const r = modalEl.querySelectorAll('[data-row]')[3]
    const n = r.querySelector('[data-b-name]'); n.value = 'People'; n.dispatchEvent(new Event('input', { bubbles: true }))
    const a = r.querySelector('[data-b-about]'); a.value = 'Feedback, one-to-ones, hiring and conversations. Ends in a decision, a message sent or notes shared.'; a.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  check('Create list enables again', await evalJS(`!([...modalEl.querySelectorAll('button')].find(b => b.textContent.trim() === 'Create list').disabled)`))
  await press('Create list')
  await wait(3500)
  r = await fetch(`${base2}/datasets.json`).then(x => x.json())
  check('Create list makes the list and sets it current', r.datasets.join() === 'work' && r.current === 'work', JSON.stringify(r))
  check('.current names it', readFileSync(join(data2, '.current'), 'utf8').trim() === 'work')
  const todo = readFileSync(join(data2, 'work', 'todo.md'), 'utf8')
  check('todo.md has a heading per bucket, in order', ['## 1. Making', '## 2. Admin', '## 3. Learning', '## 4. People'].every((h, i, a) => todo.includes(h) && (i === 0 || todo.indexOf(h) > todo.indexOf(a[i - 1]))), JSON.stringify(todo.slice(0, 120)))
  const readme = readFileSync(join(data2, 'work', 'buckets', 'README.md'), 'utf8')
  check('buckets/README.md has a row per bucket', ['making', 'admin', 'learning', 'people'].every(k => readme.includes('| `' + k + '` |')))
  const brief = n => readFileSync(join(data2, 'work', 'buckets', n, n + '.md'), 'utf8')
  check('each brief opens with its description', brief('making').includes('Designing, writing or building something new. Ends in a file, a draft or a prototype.')
    && brief('learning').includes('Courses, reading and experiments. Ends in notes, or a skill tried on real work.')
    && brief('admin').includes('Email, forms, bills and bookings. Ends in something sent, paid or booked.')
    && brief('people').includes('Feedback, one-to-ones, hiring and conversations.'))
  check('no brief carries the NOT FILLED IN YET marker', ['making', 'admin', 'learning', 'people'].every(n => !brief(n).includes('NOT FILLED IN YET')))
  check('the board loads the new list', !(await shown()) && await evalJS(`state.dataset`) === 'work')

  // Profile set but no list: straight to step 2.
  rmSync(join(data2, 'work'), { recursive: true, force: true })
  rmSync(join(data2, '.current'), { force: true })
  await reload()
  check('a profile with no list opens on step 2', await shown() && await evalJS(`modalEl.textContent.includes('Step 2 of 2') && !!modalEl.querySelector('[data-list-name]')`))
} catch (err) {
  check('the suite ran', false, String((err.stack || '').split('\n').slice(0,2).join(' / ')))
}
cleanup()
process.exit(checks.every(Boolean) ? 0 : 1)
