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
    '--headless=new', '--mute-audio', `--remote-debugging-port=${CDP}`, '--no-first-run',
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
  const shown = () => evalJS(`!!(settingsRoot() && settingsRoot().textContent.includes('Welcome to Bench'))`)
  const settingsShown = () => evalJS(`!!(settingsRoot() && settingsRoot().querySelector('[data-name]') && !settingsRoot().textContent.includes('Welcome'))`)
  const pick = (sel, value) => evalJS(`(() => { const s = settingsRoot().querySelector(${JSON.stringify(sel)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  const fill = async (name, country, region, models) => {
    await pick('[data-country]', country)
    await wait(600)
    if (region) await pick('[data-region]', region)
    await fillRest(name, models)
  }
  const fillRest = (name, models) => evalJS(`(() => {
    const n = settingsRoot().querySelector('[data-name]'); n.value = ${JSON.stringify(name)}; n.dispatchEvent(new Event('input', { bubbles: true }))
    for (const [k, v] of Object.entries(${JSON.stringify(models)})) { const s = settingsRoot().querySelector('[data-model=' + k + ']'); s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })) }
  })()`)
  const press = label => evalJS(`[...settingsRoot().querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`)

  const exists = sel => evalJS(`!!(settingsRoot() && settingsRoot().querySelector(${JSON.stringify(sel)}))`)
  const saveDisabled = () => evalJS(`[...settingsRoot().querySelectorAll('button')].find(b => b.textContent.trim() === 'Save').disabled`)
  const label = sel => evalJS(`settingsRoot().querySelector(${JSON.stringify(sel)} + ' option[value=""]').textContent`)
  const escape = async () => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await wait(300)
  }

  await wait(3000)
  check('onboarding shows with no profile', await shown())
  check('onboarding mentions scripts/install.sh', await evalJS(`settingsRoot().textContent.includes('scripts/install.sh')`))
  check('onboarding has no agent options: they live on the Agents tab', await evalJS(`!settingsRoot().querySelector('[data-agent-options]') && !settingsRoot().querySelector('[data-model]') && !settingsRoot().querySelector('[data-budget]')`))

  // Required: no way out.
  check('onboarding offers no Projects folder', !(await exists('[data-projects]')))
check('onboarding has no Skip button', !(await evalJS(`settingsRoot().textContent.includes('Skip')`)))
  check('onboarding has no close button', !(await exists('.tenon-modal__head button')))
  await escape()
  check('Escape does not dismiss onboarding', await shown())
  await evalJS(`document.querySelector('.tenon-modal__scrim').click()`)
  await wait(300)
  check('the scrim does not dismiss onboarding', await shown())
  check('no skip flag is kept in the browser', await evalJS(`Object.keys(localStorage).every(k => !/onboard/i.test(k))`))

  // Name and Country are required.
  check('Save is disabled until Name and Country are set', await saveDisabled())
  check('onboarding offers no "Not set" country', !(await evalJS(`settingsRoot().querySelector('[data-country]').textContent.includes('Not set')`)))
  await fillRest('Sam', {})
  check('Save is still disabled with a name and no country', await saveDisabled())
  await evalJS(`settingsRoot().querySelector('[data-country]').dispatchEvent(new Event('focusout', { bubbles: true }))`)
  check('a missing country shows inline text', await evalJS(`settingsRoot().querySelector('[data-err=country]').textContent`) === 'Choose a country.')
  await fillRest('', {})
  await evalJS(`settingsRoot().querySelector('[data-name]').dispatchEvent(new Event('focusout', { bubbles: true }))`)
  check('a missing name shows inline text', await evalJS(`settingsRoot().querySelector('[data-err=name]').textContent`) === 'Add your name.')

  check('the Settings form has no Agent options, and no line about the Agents tab', await evalJS(`!settingsRoot().textContent.includes('Agent options') && !settingsRoot().textContent.includes('Set each agent')`))

  await fill('Sam', 'PT', '', {})
  check('Save enables once Name and Country are set', !(await saveDisabled()))
  await press('Save')
  await wait(3500)
  const profile = existsSync(join(data, 'profile.md')) ? readFileSync(join(data, 'profile.md'), 'utf8') : ''
  check('profile.md has the Name', /^- Name: Sam$/m.test(profile), JSON.stringify(profile.slice(0, 80)))
  check('profile.md has the Country', /^- Country: PT$/m.test(profile))
  check('profile.md has no Region for a country without any', !/^- Region:/m.test(profile))
  const saved = JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8'))
  check('settings.json has the welcome\'s starting models', saved.models.plan === null && saved.models.default === 'sonnet' && saved.models.brief === 'haiku' && saved.models.chat === null)
  check('the board knows the new owner without a restart', await evalJS(`OWNER_NAME`) === 'Sam')
  check('onboarding is gone after saving', !(await shown()))
  await reload()
  check('onboarding does not come back on reload', !(await shown()))

  await evalJS(`$('#settingsBtn').click()`)
  await wait(800)
  check('Settings opens from the Data menu', await settingsShown())
  // Settings is a page now: five tabs where the bucket tabs were, and the buckets come back.
  const tabNames = `[...document.querySelectorAll('#bucketFilters .tenon-toggle-group__option')].map(b => b.dataset.value).join()`
  check('Settings is a page on the Settings tab, not a pop-up', await evalJS(`state.view === 'settings' && settingsTab === 'settings' && !modalEl && !!document.querySelector('#settingsPage')`))
  check('the four tabs replace the bucket tabs', await evalJS(tabNames) === 'memory,settings,agents,backups', await evalJS(tabNames))
  check('and the Settings tab is the one pressed', await evalJS(`document.querySelector('#bucketFilters [data-value=settings]').getAttribute('aria-pressed') === 'true'`))
  check('the hash names the page and its tab', await evalJS(`location.hash.startsWith('#settings/settings')`))
  check('the Data menu has no Backups or Spend and schedules', await evalJS(`!$('#backupsBtn') && !$('#refCardsBtn') && !!$('#settingsBtn') && !!$('#runAgentBtn')`))
  check('Memory is not in the top bar', await evalJS(`![...document.querySelectorAll('#viewToggle [data-view]')].some(b => b.dataset.view === 'memory')`))
  for (const [tab, probe] of [['memory', '#memView'], ['agents', '#lists .agentsview'], ['backups', '#backupsRoot']]) {
    await evalJS(`document.querySelector('#bucketFilters [data-value=${tab}]').click()`)
    await wait(1200)
    check('the ' + tab + ' tab draws its content', await evalJS(`!!document.querySelector(${JSON.stringify(probe)})`), tab)
  }
  // Spend and Schedules are panels of the Agents tab, and their old links open it.
  await evalJS(`openSettingsPage('agents')`)
  await wait(1200)
  check('Agents holds Token Session and the clock card as panels', await evalJS(`!!document.querySelector('.agentsview #refCardsRoot #usageOut') && !!document.querySelector('.agentsview #refCardsRoot #schedOut')`))
  check('Spend and Schedules are no longer tabs', await evalJS(`!document.querySelector('#bucketFilters [data-value=spend]') && !document.querySelector('#bucketFilters [data-value=schedules]')`))
  for (const old of ['spend', 'schedules']) {
    await evalJS(`state.view = 'board'; renderView(); history.replaceState(null, '', '#settings/${old}'); window.dispatchEvent(new HashChangeEvent('hashchange'))`)
    await wait(800)
    check('#settings/' + old + ' opens the Agents tab', await evalJS(`state.view === 'settings' && settingsTab === 'agents' && location.hash.startsWith('#settings/agents')`), old)
  }
  check('the Settings page leaves out the delegated-to-an-agent button', await evalJS(`getComputedStyle(document.querySelector('#bucketBar')).display !== 'none' && ![...document.querySelectorAll('#bucketBar button, #bucketBar [role=button]')].some(b => b.offsetParent !== null && /delegated to an agent/.test(b.textContent))`))
  await evalJS(`openSettingsPage('settings')`)
  await wait(800)
  check('and the panel is left-aligned', await evalJS(`(() => { const p = document.querySelector('#lists .tenon-column'); const l = document.querySelector('#lists').getBoundingClientRect(); return !!p && Math.abs(p.getBoundingClientRect().left - l.left) < 2 })()`))
  await evalJS(`document.querySelector('#viewToggle [data-view=board]').click()`)
  await wait(800)
  check('leaving brings the bucket tabs back', await evalJS(tabNames) !== 'memory,settings,agents,backups' && await evalJS(`!document.querySelector('#bucketBar').classList.contains('bucketbar--page')`), await evalJS(tabNames))
  await evalJS(`$('#settingsBtn').click()`)
  await wait(800)
  check('Settings shows the saved name', await evalJS(`settingsRoot().querySelector('[data-name]').value`) === 'Sam')
  check('Settings shows the saved country', await evalJS(`settingsRoot().querySelector('[data-country]').value`) === 'PT')
  check('the Region select is hidden for a country without regions', await evalJS(`settingsRoot().querySelector('[data-region-field]').hidden`) === true)
  await fillRest('', {})
  check('Settings needs a name too', await saveDisabled())
  await fillRest('Sam', {})

  await fill('Alex', 'GB', 'GB-SCT', {})
  await press('Save')
  await wait(3500)
  const p2 = readFileSync(join(data, 'profile.md'), 'utf8')
  const s2 = JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8'))
  check('Settings round-trips the name', /^- Name: Alex$/m.test(p2))
  check('Settings round-trips the country', /^- Country: GB$/m.test(p2))
  check('Settings round-trips the region', /^- Region: GB-SCT$/m.test(p2))
  await evalJS(`$('#settingsBtn').click()`)
  await wait(800)
  check('Settings reopens on the saved region', await evalJS(`settingsRoot().querySelector('[data-region]').value`) === 'GB-SCT'
    && await evalJS(`settingsRoot().querySelector('[data-region-field]').hidden`) === false)
  // The projects folder: offered in Settings, saved only once it is a folder.
  const projects = join(root, 'PROJECTS')
  mkdirSync(projects)
  check('Settings offers a Projects folder for the open list, empty by default', await evalJS(`settingsRoot().querySelector('[data-projects]').value`) === ''
    && (await evalJS(`settingsRoot().querySelector('[data-projects]').closest('label').textContent`)).includes('Projects folder for '))
  await evalJS(`(() => { const i = settingsRoot().querySelector('[data-projects]'); i.value = ${JSON.stringify(projects)}; i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await press('Save')
  await wait(2500)
  check('Settings saves the Projects folder', (JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8')).projects_roots || {})[await evalJS('state.dataset')] === projects)
  await evalJS(`$('#settingsBtn').click()`)
  await wait(800)
  check('and reopens showing it', await evalJS(`settingsRoot().querySelector('[data-projects]').value`) === projects)

  // The profile's facts file and sections moved to the Memory page; Settings keeps the address.
  check('Settings offers How to address you but no profile sections or facts file', await evalJS(
    `!!settingsRoot().querySelector('[data-about="addressing"]') && !settingsRoot().querySelector('[data-about="facts_file"]')` +
    ` && !settingsRoot().querySelector('[data-section]') && !settingsRoot().querySelector('[data-profile-sections]')`))
  const setField = (sel, v) => evalJS(`(() => { const el = settingsRoot().querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await setField('[data-about="addressing"]', 'Hey <Alex>')
  check('< > in a field blocks Save', await saveDisabled())
  await setField('[data-about="addressing"]', 'Hey Alex')
  await press('Save')
  await wait(3000)
  const p4 = readFileSync(join(data, 'profile.md'), 'utf8')
  check('Settings writes the About field', /^- How to address them: Hey Alex$/m.test(p4), p4)
  check('and the rest of the profile stays', /^- Name: Alex$/m.test(p4) && /^- Country: GB$/m.test(p4))
  check('nobody signed in, nothing goes to data/users', !existsSync(join(data, 'users')))
  await evalJS(`$('#settingsBtn').click()`)
  await wait(800)
  check('and it reads back as written', await evalJS(`settingsRoot().querySelector('[data-about="addressing"]').value === 'Hey Alex'`))

  // The reply chime is a switch: a click turns it off, and Save writes it.
  check('the reply chime starts on, as a switch', await evalJS(`(() => { const s = settingsRoot().querySelector('[data-chime]');
    return s.getAttribute('role') === 'switch' && s.getAttribute('aria-checked') === 'true' && s.classList.contains('tenon-switch--on') })()`))
  await evalJS(`settingsRoot().querySelector('[data-chime]').click()`)
  check('a click turns the reply chime off', await evalJS(`settingsRoot().querySelector('[data-chime]').getAttribute('aria-checked') === 'false'`))
  await press('Save')
  await wait(2500)
  check('Settings saves the reply chime off', JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8')).chime === false)
  await evalJS(`$('#settingsBtn').click()`)
  await wait(800)
  check('and reopens with the switch off', await evalJS(`settingsRoot().querySelector('[data-chime]').getAttribute('aria-checked') === 'false'`))
  await evalJS(`settingsRoot().querySelector('[data-chime]').click()`)
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
  check('Settings has a This board group', await evalJS(`!!settingsRoot().querySelector('[data-board-group]') && settingsRoot().querySelector('[data-board-group] h4').textContent === 'This board'`))
  check('it starts on the main memory folder, banners and agents on', await evalJS(`settingsRoot().querySelector('[data-board-memory-mode]').value === 'inherit'
    && settingsRoot().querySelector('[data-board-memory]').hidden
    && settingsRoot().querySelector('[data-board-banners]').getAttribute('aria-checked') === 'true'
    && settingsRoot().querySelector('[data-board-agents]').getAttribute('aria-checked') === 'true'`))
  check('the memory folder offers the three choices', await evalJS(`[...settingsRoot().querySelectorAll('[data-board-memory-mode] option')].map(o => o.textContent).join('|')`)
    === 'Same as main memory folder|None, keep everything in Bench|Its own folder')
  check('each control has a line of help', await evalJS(`[...settingsRoot().querySelectorAll('[data-board-group] .field')].length === 3 && [...settingsRoot().querySelectorAll('[data-board-group] .field')].every(f => f.querySelector('.help').textContent.length > 10)`))
  await evalJS(`settingsRoot().querySelector('[data-board-banners]').click()`)
  await press('Save')
  await wait(2500)
  check('switching banners off sends only banners', JSON.stringify(boardSet()) === '{"banners":false}', JSON.stringify(boardSet()))
  await reopen()
  check('and it reopens with banners off', await evalJS(`settingsRoot().querySelector('[data-board-banners]').getAttribute('aria-checked')`) === 'false')
  await evalJS(`settingsRoot().querySelector('[data-board-agents]').click()`)
  await press('Save')
  await wait(2500)
  check('switching agents off adds only agents', JSON.stringify(boardSet()) === '{"banners":false,"agents":false}', JSON.stringify(boardSet()))
  await reopen()
  await pick('[data-board-memory-mode]', 'none')
  check('None hides the path field', await evalJS(`settingsRoot().querySelector('[data-board-memory]').hidden`))
  await press('Save')
  await wait(2500)
  check('None sends a null memory folder', boardSet().memory_root === null && boardSet().banners === false, JSON.stringify(boardSet()))
  await reopen()
  check('and reopens on None', await evalJS(`settingsRoot().querySelector('[data-board-memory-mode]').value`) === 'none')
  // A list with no memory folder has no profile of its own yet, so its name is empty.
  await fillRest('Alex', {})
  await pick('[data-board-memory-mode]', 'own')
  check('Its own folder shows the path field', await evalJS(`!settingsRoot().querySelector('[data-board-memory]').hidden`))
  check('an empty path blocks Save', await saveDisabled())
  const ownDir = join(root, 'BOARDMEM')
  mkdirSync(ownDir)
  await setField('[data-board-memory]', ownDir)
  await press('Save')
  await wait(2500)
  check('its own folder is saved as that path', boardSet().memory_root === ownDir, JSON.stringify(boardSet()))
  await reopen()
  check('and reopens showing the path', await evalJS(`settingsRoot().querySelector('[data-board-memory-mode]').value === 'own' && settingsRoot().querySelector('[data-board-memory]').value`) === ownDir)
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
  await evalJS(`settingsRoot().querySelector('[data-board-banners]').click(); settingsRoot().querySelector('[data-board-agents]').click()`)
  await press('Save')
  await wait(2500)
  check('switching both back on empties the entry', boardSet() === undefined, JSON.stringify(boardSet()))
  // Signed in, the server's settings are not the visitor's: no group.
  await reopen()
  await evalJS(`closeModal(); state.who = { name: 'Visitor', teams: [] }`)
  await reopen()
  check('signed in, there is no This board group', await evalJS(`!settingsRoot().querySelector('[data-board-group]')`))
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
  // A country with no holiday list is still saved, with a note.
  await pick('[data-country]', 'AQ')
  await wait(600)
  check('a country with no holiday list shows the note', await evalJS(`!settingsRoot().querySelector('[data-nolist]').hidden`)
    && (await evalJS(`settingsRoot().querySelector('[data-nolist]').textContent`)) === 'No public holiday list available for this country, so only weekends count as days off.')
  await pick('[data-country]', 'GB')
  await wait(600)
  check('the note goes for a country with a list', await evalJS(`settingsRoot().querySelector('[data-nolist]').hidden`))
  // Agent options live on the Agents tab, not the general Settings form.
  check('the general tab has no Agent options', await evalJS(`!document.querySelector('[data-agent-options]') && !settingsRoot().querySelector('[data-model]')`))
  const openSettingsPageFresh = async () => { await evalJS(`openSettingsPage('settings')`); await wait(500); await openAgents() }
  const openAgents = async () => { await evalJS(`openSettingsPage('agents')`); await wait(1500) }
  const A = `document.querySelector('#agentOptions')`
  const aSet = (sel, v, ev = 'input') => evalJS(`(() => { const b = ${A}.querySelector(${JSON.stringify(sel)}); b.value = ${JSON.stringify(v)}; b.dispatchEvent(new Event('${ev}', { bubbles: true })) })()`)
  const aSave = () => evalJS(`${A}.querySelector('[data-agent-options-save]').click()`)
  const aSaveDisabled = () => evalJS(`${A}.querySelector('[data-agent-options-save]').disabled`)
  const aLabel = sel => evalJS(`${A}.querySelector(${JSON.stringify(sel)} + ' option[value=""]').textContent`)
  mkdirSync(join(data, 'agents'), { recursive: true })
  writeFileSync(join(data, 'agents', 'fences.json'), JSON.stringify({ other: 1 }))
  await openAgents()
  check('Agent options is on the Agents tab, always open, above the board switch and hours', await evalJS(`(() => { const o = ${A}.querySelector('[data-agent-options]'); const h = document.querySelector('#agentsRoot');
    return !!o && o.tagName !== 'DETAILS' && !o.querySelector('summary') && !!h && !!(o.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING) })()`))
  check('titled Agent options, with no "hours later" note', await evalJS(`${A}.querySelector('h2').textContent === 'Agent options' && !document.querySelector('#lists').textContent.includes('Set each agent’s hours later')`))
  check('the model list is the server\'s', await evalJS(`[...${A}.querySelectorAll('[data-model=chat] option')].map(o => o.value).join()`) === ',opus,sonnet,haiku')
  check('Use default names Sonnet', await aLabel('[data-model=plan]') === 'Use default (Sonnet)')
  await aSet('[data-model=default]', 'opus', 'change')
  check('labels follow the Default model', await aLabel('[data-model=implement]') === 'Use default (Opus)' && await aLabel('[data-model=chat]') === 'Use default (Opus)')
  await aSet('[data-model=default]', '', 'change')
  check('with no default, brief falls back to Haiku', await aLabel('[data-model=brief]') === 'Use default (Haiku)')
  check('with no default, others name Claude Code\'s default', await aLabel('[data-model=plan]') === 'Use default (Claude Code’s default)')
  check('the Default select names what each tool falls back to', (await aLabel('[data-model=default]')).includes('Claude Code’s default') && (await aLabel('[data-model=default]')).includes('Haiku for briefs'))
  await aSet('[data-model=default]', 'sonnet', 'change')
  check('no start choice: when a bucket agent starts is its brief\'s', await evalJS(`!${A}.querySelector('[data-start]')`))
  check('one Bucket agents group, with its avatar, a model for plans and one for the work', await evalJS(`(() => {
    const g = [...${A}.querySelectorAll('.agentopts__group')].filter(g => /^Bucket agents/.test(g.querySelector('h4')?.textContent || ''));
    return g.length === 1 && !!g[0].querySelector('h4 .avatar svg[width="18"]')
      && !!g[0].querySelector('[data-model=plan]') && !!g[0].querySelector('[data-model=implement]');
  })()`))
  check('and no group for the old agents or the planners', await evalJS(`!/Plan agent|Implement agent|Bucket planners/.test(${A}.textContent) && !${A}.querySelector('[data-model=planner]')`))
  check('chat and brief sit under Other', await evalJS(`[...${A}.querySelectorAll('.agentopts__group')].some(g => g.textContent.startsWith('Other') && g.querySelector('[data-model=chat]') && g.querySelector('[data-model=brief]'))`))
  // The daily budget lives in the fences file, beside whatever else is in it.
  await aSet('[data-model=plan]', 'haiku', 'change')
  await aSet('[data-budget]', 'lots')
  check('a budget that is not a number blocks Save', await aSaveDisabled())
  check('and shows its message', await evalJS(`${A}.querySelector('[data-err=budget]').textContent`) === 'Enter an amount in dollars, or leave it empty.')
  await aSet('[data-budget]', '7.5')
  await aSave()
  await wait(2500)
  let fences = JSON.parse(readFileSync(join(data, 'agents', 'fences.json'), 'utf8'))
  check('the daily budget is written to fences.json, keeping other keys', fences.daily_budget === 7.5 && fences.other === 1, JSON.stringify(fences))
  check('the model for plans is saved, and the others kept', JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8')).models.plan === 'haiku' && JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8')).models.default === 'sonnet')
  await openSettingsPageFresh()
  check('Agents reopens on the saved budget', await evalJS(`${A}.querySelector('[data-budget]').value`) === '7.5')
  await aSet('[data-budget]', '')
  await aSave()
  await wait(2500)
  fences = JSON.parse(readFileSync(join(data, 'agents', 'fences.json'), 'utf8'))
  check('an empty budget removes the limit and keeps other keys', !('daily_budget' in fences) && fences.other === 1, JSON.stringify(fences))
  // A daily budget per agent, in the same file under agent_budgets, keyed by runner id.
  writeFileSync(join(data, 'agents', 'fences.json'), JSON.stringify({ other: 1, agent_budgets: { 'someone-else': 9 } }))
  await openSettingsPageFresh()
  check('the bucket agents have one budget field between them',
    await evalJS(`[...${A}.querySelectorAll('[data-agent-budget]')].map(i => i.dataset.agentBudget).join()`) === 'bucket')
  await aSet('[data-agent-budget=bucket]', 'lots')
  check('an agent budget that is not a number blocks Save', await aSaveDisabled())
  check('and shows its message', await evalJS(`${A}.querySelector('[data-err=budget-bucket]').textContent`) === 'Enter an amount in dollars, or leave it empty.')
  await aSet('[data-agent-budget=bucket]', '5.5')
  await aSet('[data-budget]', '10')
  await aSave()
  await wait(2500)
  fences = JSON.parse(readFileSync(join(data, 'agents', 'fences.json'), 'utf8'))
  check('the bucket agents\' budget is written beside the total under their runner id, keeping other keys and agents',
    fences.daily_budget === 10 && fences.other === 1 && fences.agent_budgets['bucket-agent'] === 5.5
    && fences.agent_budgets['someone-else'] === 9 && !('plan-agent' in fences.agent_budgets), JSON.stringify(fences))
  await openSettingsPageFresh()
  check('Agents reopens on the saved agent budget',
    await evalJS(`${A}.querySelector('[data-agent-budget=bucket]').value`) === '5.5')
  await aSet('[data-agent-budget=bucket]', '')
  await aSave()
  await wait(2500)
  fences = JSON.parse(readFileSync(join(data, 'agents', 'fences.json'), 'utf8'))
  check('an empty agent budget removes only that agent',
    !('bucket-agent' in fences.agent_budgets) && fences.agent_budgets['someone-else'] === 9 && fences.daily_budget === 10, JSON.stringify(fences))
  // The Agents tab still says why when agents cannot run here.
  await evalJS(`state.agentsReady = false; state.agentsMissing = 'claude'; renderView()`)
  await wait(500)
  check('agents off: the Agents tab shows its fallback text and no options', await evalJS(`document.querySelector('#lists').textContent.includes('Agents need Claude Code') && !document.querySelector('[data-agent-options]')`))
  await evalJS(`state.agentsReady = true; openSettingsPage('settings')`)
  await wait(800)
  // Saving the general Settings form leaves the budgets and models alone.
  await evalJS(`settingsRoot().querySelector('[data-chime]').click()`)
  await press('Save')
  await wait(3000)
  fences = JSON.parse(readFileSync(join(data, 'agents', 'fences.json'), 'utf8'))
  check('saving the general form keeps the budgets and models', fences.daily_budget === 10 && JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8')).models.plan === 'haiku', JSON.stringify(fences))
  r = await fetch(`${base}/settings.json`, { method: 'PUT', headers: { 'X-Board': '1' }, body: '{"agent_budgets":{"bucket-agent":-1},"models":{"chat":"haiku"}}' })
  check('PUT with a negative agent budget is refused', r.status === 400)
  r = await fetch(`${base}/settings.json`, { method: 'PUT', headers: { 'X-Board': '1' }, body: '{"agent_budgets":{"plan-agent":2}}' })
  check('and one for a retired agent too', r.status === 400)
  check('and writes nothing', !('bucket-agent' in JSON.parse(readFileSync(join(data, 'agents', 'fences.json'), 'utf8')).agent_budgets)
    && JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8')).models.chat !== 'haiku')
  await evalJS(`$('#settingsBtn').click()`)
  await wait(800)
  await evalJS(`settingsRoot().close ? settingsRoot().close() : 0`)
  check('saving Settings leaves the models alone', s2.models.plan === null && s2.models.default === 'sonnet')
  r = await fetch(`${base}/settings.json`, { method: 'PUT', headers: { 'X-Board': '1' }, body: '{"agents":{"plan":{"start":"later"}}}' })
  check('PUT with an unknown start is refused', r.status === 400)

  // An old profile: a Holidays line and no Country. Saving only a name keeps it.
  writeFileSync(join(data, 'profile.md'), '# PA profile\n\n## About\n\n- Name: Sam\n- Holidays: UK, PT\n')
  await reload()
  await evalJS(`$('#settingsBtn').click()`)
  await wait(800)
  check('an old Holidays line shows Keep current', await evalJS(`settingsRoot().querySelector('[data-country] option[value=""]').textContent`) === 'Keep current (UK and Portugal)')
  check('and it is the selected one', await evalJS(`settingsRoot().querySelector('[data-country]').value`) === '')
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
  check('a profile with a country offers no Keep current', !(await evalJS(`settingsRoot().querySelector('[data-country]').textContent.includes('Keep current')`)))
  await evalJS(`closeModal()`)

  // Step 2: the first list, on a checkout with nothing in data/.
  const base2 = `http://127.0.0.1:${PORT2}`
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base2}/datasets.json`)).ok) break } catch {}
    await wait(250)
  }
  r = await fetch(`${base2}/datasets.json`).then(x => x.json())
  check('a data root with no lists answers without errors', Array.isArray(r.datasets) && r.datasets.length === 0)
  for (const route of ['settings.json', 'profile-basics.json', 'owner.js', 'agent-runs.json', 'chat-viewed.json', 'bucket-agent.json']) {
    const x = await fetch(`${base2}/${route}`)
    check(`GET /${route} on an empty root is not an error`, x.status === 200, String(x.status))
  }
  await send('Page.navigate', { url: `${base2}/kanban/index.html` })
  await wait(3500)
  check('step 1 is shown on a checkout with nothing', await shown() && await evalJS(`settingsRoot().textContent.includes('Step 1 of 2')`))
  check('the "Nothing here yet" sheet is gone', !(await evalJS(`document.body.textContent.includes('Nothing here yet')`)))
  await fill('Pat', 'DE', '', {})
  await press('Save')
  await wait(1500)
  check('Save leads to step 2 in the same modal', await shown() && await evalJS(`settingsRoot().textContent.includes('Step 2 of 2')`))
  check('step 2 has no Skip, no close, and Escape does nothing', !(await evalJS(`settingsRoot().textContent.includes('Skip')`)) && !(await exists('.tenon-modal__head button')) && (await escape(), await shown()))
  check('profile was saved before step 2', /^- Name: Pat$/m.test(readFileSync(join(data2, 'profile.md'), 'utf8')))
  check('the list name starts as Work', await evalJS(`settingsRoot().querySelector('[data-list-name]').value`) === 'Work')
  const rows = () => evalJS(`[...settingsRoot().querySelectorAll('[data-row]')].map(r => [r.querySelector('[data-b-name]').value, r.querySelector('[data-b-about]').value])`)
  let got = await rows()
  check('four buckets are pre-filled', got.map(x => x[0]).join() === 'Making,People,Admin,Learning', JSON.stringify(got.map(x => x[0])))
  check('each carries its description', got[0][1] === 'Designing, writing or building something new. Ends in a file, a draft or a prototype.' && got[3][1] === 'Learning'.length ? false : got[3][1].startsWith('Courses, reading and experiments.'))
  check('Create list is enabled', await evalJS(`!([...settingsRoot().querySelectorAll('button')].find(b => b.textContent.trim() === 'Create list').disabled)`))
  // required rows
  await evalJS(`(() => { const t = settingsRoot().querySelectorAll('[data-b-about]')[1]; t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  check('a bucket with no description disables Create list and says why', await evalJS(`[...settingsRoot().querySelectorAll('button')].find(b => b.textContent.trim() === 'Create list').disabled`)
    && (await evalJS(`settingsRoot().querySelectorAll('[data-b-err]')[1].textContent`)).length > 0)
  await evalJS(`(() => { settingsRoot().querySelectorAll('[data-b-remove]')[1].click() })()`)
  got = await rows()
  check('a bucket can be removed', got.map(x => x[0]).join() === 'Making,Admin,Learning')
  await evalJS(`settingsRoot().querySelector('[data-b-add]').click()`)
  check('a bucket can be added', (await rows()).length === 4 && (await rows())[3][0] === '')
  check('an empty added bucket blocks Create list', await evalJS(`[...settingsRoot().querySelectorAll('button')].find(b => b.textContent.trim() === 'Create list').disabled`))
  await evalJS(`(() => {
    const r = settingsRoot().querySelectorAll('[data-row]')[3]
    const n = r.querySelector('[data-b-name]'); n.value = 'People'; n.dispatchEvent(new Event('input', { bubbles: true }))
    const a = r.querySelector('[data-b-about]'); a.value = 'Feedback, one-to-ones, hiring and conversations. Ends in a decision, a message sent or notes shared.'; a.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  check('Create list enables again', await evalJS(`!([...settingsRoot().querySelectorAll('button')].find(b => b.textContent.trim() === 'Create list').disabled)`))
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
  check('a profile with no list opens on step 2', await shown() && await evalJS(`settingsRoot().textContent.includes('Step 2 of 2') && !!settingsRoot().querySelector('[data-list-name]')`))
} catch (err) {
  check('the suite ran', false, String((err.stack || '').split('\n').slice(0,2).join(' / ')))
}
cleanup()
process.exit(checks.every(Boolean) ? 0 : 1)
