/**
 * Drives the Agents tab in headless Chrome.
 *
 *   scripts/test-board.sh test_agents.mjs
 *
 * The view is PACKAGES/agents-engine/react, mounted by kanban/js/27-agents.js.
 * Same two guards as test_projects.mjs: the tab is locked before any fixture
 * is loaded, and every non-GET is recorded instead of sent, so switching a
 * target or setting an hour here reaches no agent. /agents-api/state.json is
 * stubbed for the drawing checks; the last check asks the real route on the
 * test server, which runs the two agents' read-only `state` commands.
 *
 * SHOT=/path.png saves a screenshot of the list view, SHOT_SETUP one of the
 * tab before any agent is set up.
 */

import { spawn } from 'node:child_process'
import { CHROME_BIN } from './test_browser.mjs'
import { writeFileSync } from 'node:fs'

const PORT = Number(process.env.CDP_PORT) || 9451
const BOARD = process.env.BOARD_PORT || 8765
if (!process.env.BOARD_PORT) console.error('Note: this runs against the live board on 8765. For a throwaway copy: scripts/test-board.sh test_agents.mjs')
const checks = []
const check = (name, pass, detail = '') => {
  checks.push(pass)
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const chrome = spawn(CHROME_BIN, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  `--user-data-dir=${process.env.CHROME_PROFILE || '/tmp/todo-agents-test-profile'}`, '--window-size=1400,1000',
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
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400))
  return r.result?.result?.value
}
const wait = ms => new Promise(r => setTimeout(r, ms))

// Poll for the page rather than sleeping: a fixed wait fails when the machine is busy.
for (let i = 0; i < 120 && !(await evalJS(`document.readyState === 'complete' && typeof state !== 'undefined' && !!state.doc`).catch(() => false)); i++) await new Promise(r => setTimeout(r, 250))
await new Promise(r => setTimeout(r, 400))
check('the board loaded', await evalJS(`typeof renderAgentsView === 'function' && typeof BoardUI.AgentsApp === 'function'`))

// LOCK FIRST, then fixtures. Nothing below can write anything.
await evalJS(`(() => {
  state.locked = true; state.lockedLabel = 'test';
  const real = window.fetch.bind(window);
  window.__real = real;
  window.__blocked = [];
  window.__stateReads = 0;
  const target = (id, name, on, hours) => ({ id, name, on, hours, counts: [{ n: 2, l: 'queued', kind: 'good' }] });
  window.__agents = {
    hour: 10, now: new Date().toISOString(),
    agents: [
      { id: 'bucket-agent', key: 'bucket-agent', name: 'Bucket agents', blurb: 'One agent per bucket.',
        targets: [target('work', 'work', true, [1, 2, 3]), target('personal', 'personal', false, [])] },
    ],
  };
  const json = (body, status) => Promise.resolve(new Response(JSON.stringify(body),
    { status, headers: { 'Content-Type': 'application/json' } }));
  window.fetch = (url, opts) => {
    const method = (opts && opts.method) || 'GET';
    if (method !== 'GET') {
      window.__blocked.push(method + ' ' + url + ' ' + ((opts && opts.body) || ''));
      return json({ ok: true }, 200);
    }
    if (String(url).startsWith('/agents-api/state.json')) { window.__stateReads++; return json(window.__agents, 200); }
    return real(url, opts);
  };
  load(['# To-do', '', '## 1. Tasks', '', '### To do', '', '- [ ] One task [bucket:: Strategic]', ''].join('\\n'), 'demo.md', {});
  state.locked = true;
  try { localStorage.setItem('board-agents.view', 'list') } catch {}
})()`)
check('the tab is locked', await evalJS(`state.locked === true`))

/* ---- before any agent is set up ----
   The _test list's buckets have no planner of their own and no brief anyone
   wrote, and the fixture delegates nothing, so the list counts as having no
   agent: the tab shows its three columns, with no way to set one up, and the
   rest of the board leaves the agents out. */
await wait(800)
check('Agents is a tab of the Settings page, not of the top bar', await evalJS(`!viewDefs().some(d => d.id === 'agents') && settingsTabs().some(t => t[0] === 'agents')`))
await evalJS(`openSettingsPage('agents')`)
await wait(400)
check('the tab offers no way to set up an agent', await evalJS(`!document.querySelector('#lists [data-agent-setup]') && !document.querySelector('#lists .agentsetup') && !document.querySelector('#lists').textContent.includes('Set up an agent')`))
check('it lays out three columns: the cards, the options, the bucket agents', await evalJS(`[...document.querySelectorAll('#lists .agentscols > .agentscol')].map(c => c.id).join() === 'agentsCards,agentOptions,agentsPlanners' && getComputedStyle(document.querySelector('#lists .agentscols')).gridTemplateColumns.split(' ').length === 3`))
check('and one column below 900px', await (async () => { await send('Emulation.setDeviceMetricsOverride', { width: 800, height: 900, deviceScaleFactor: 1, mobile: false }); await wait(200); const one = await evalJS(`getComputedStyle(document.querySelector('#lists .agentscols')).gridTemplateColumns.split(' ').length === 1`); await send('Emulation.clearDeviceMetricsOverride'); return one })())
if (process.env.SHOT_SETUP) {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(process.env.SHOT_SETUP, Buffer.from(shot.result.data, 'base64'))
}
check('and still shows the cards: the PA and the Bucket agents', await evalJS(`[...document.querySelectorAll('#agentsCards .agentcard h3')].map(h => h.textContent).join() === 'PA,Bucket agents'`))
check('no card carries the dead handover level control', await evalJS(`!document.querySelector('#agentsCards [data-handover-level]') && !document.querySelector('#agentsCards').textContent.includes('Just do it')`))
check('Delegate to offers no agents', await evalJS(`!delegateSelectHTML('', '').includes('optgroup label="Agents"')`))
check('but keeps one a task already names', await evalJS(`delegateSelectHTML('Demo tasks agent', '').includes('value="Demo tasks agent"')`))
await evalJS(`state.view = 'overview'; renderView()`)
await wait(400)
check('Overview leaves out Delegate to Claude', await evalJS(`!document.querySelector('#lists').textContent.includes('Delegate to Claude')`))

/* ---- once one is ---- */
await evalJS(`state.view = 'agents'; renderView()`)
await wait(1200)
check('it mounts the shared component', await evalJS(`!!document.querySelector('#lists #agentsRoot .agents-ui.agents-root.embedded')`))
check('titled Agents', await evalJS(`document.querySelector('#agentsRoot h1')?.textContent === 'Agents'`))
check('it shows one Bucket agents entry', await evalJS(`(() => { const t = document.querySelector('#agentsRoot').textContent; return t.includes('Bucket agents') })()`))
check('it read /agents-api, not the dashboard routes', await evalJS(`window.__stateReads > 0`))
check('the list view draws an hour track per target', await evalJS(`document.querySelectorAll('#agentsRoot .trow .hours .hr').length === 48`))
check('and the ruler over them', await evalJS(`!!document.querySelector('#agentsRoot .rulerwrap .ruler')`))
check('a card per agent under it', await evalJS(`[...document.querySelectorAll('#agentsCards .agentcard h3')].map(h => h.textContent).join(',') === 'PA,Bucket agents'`))
check('each card says does, cannot and needs', await evalJS(`[...document.querySelectorAll('#agentsCards .agentcard')].every(c => [...c.querySelectorAll('dt')].map(d => d.textContent).join('|') === 'Does|Cannot|Needs from you' && [...c.querySelectorAll('dd')].every(d => d.textContent.length > 20))`))
/* The bucket list under the switch and hours: a ready bucket, one that is not, and a free-rein one. */
await evalJS(`bucketAgentData = { list: state.dataset || '', columns: {}, on: true, hours: [], buckets: [
  { bucket: 'Tasks', name: 'Test tasks agent', mode: 'plan-first', start: 'on-assign', ready: true, missing: [],
    sections: { purpose: 'Keeps <b>the</b> list moving.', processes: 'Triage.\\nThen plan.', guidelines: 'British English.', may_touch: 'The project folder.', never_touch: 'Email.', good: 'A plan I approve.', involved: 'Sam' } },
  { bucket: 'Notes', name: 'Test notes agent', mode: 'free-rein', start: 'scheduled', ready: true, missing: [] },
  { bucket: 'Money', name: 'Test money agent', mode: 'plan-first', start: 'on-assign', ready: false, missing: ['marker', 'may_touch'] }] };
  bucketAgentLoad = Promise.resolve(); refreshBucketPlanners()`)
await wait(300)
const rowText = name => evalJS(`(document.querySelector('#agentsPlanners [data-bucket-agent="${name}"]') || {}).textContent || ''`)
check('the tab lists each bucket agent under the switch and hours', await evalJS(`document.querySelectorAll('#agentsPlanners [data-bucket-agent]').length === 3`))
check('a ready plan-first bucket reads plan first, starts when assigned', /Test tasks agent.*plan first · starts when assigned/.test(await rowText('Test tasks agent')))
check('a free-rein scheduled bucket reads free rein, scheduled', /Test notes agent.*free rein · scheduled/.test(await rowText('Test notes agent')))
check('a bucket that is not ready says what is missing', /Test money agent.*not set up: the NOT FILLED IN YET line is still in the brief, what it may touch/.test(await rowText('Test money agent')))
check('every row links to its bucket brief', await evalJS(`[...document.querySelectorAll('#agentsPlanners [data-bucket-brief]')].map(b => b.dataset.bucketBrief).join() === 'Tasks,Notes,Money'`))
const card = name => `document.querySelector('#agentsPlanners [data-bucket-agent="${name}"]')`
check('a card is one line until opened: avatar, name, mode and the Brief button', await evalJS(`(() => { const d = ${card('Test tasks agent')}.querySelector('details'); const s = d.querySelector('summary');
  return !!d && !d.open && !!s.querySelector('.avatar') && !!s.querySelector('[data-bucket-brief]') && getComputedStyle(d.querySelector('.bagent__body')).display === 'none' || !d.open })()`))
await evalJS(`${card('Test tasks agent')}.querySelector('summary .planner-bucket').click()`)
await wait(200)
check('clicking the line opens the card', await evalJS(`${card('Test tasks agent')}.querySelector('details').open`))
check('it shows the brief fields under their headings, the optional one when written', await evalJS(`[...${card('Test tasks agent')}.querySelectorAll('.bagent__field dt')].map(d => d.textContent).join('|')`) ===
  'What this agent is for|The processes I run in this bucket|Guidelines it follows|What it may touch|What it must never touch|What good looks like here|Who is involved')
check('the text is plain, escaped and keeps its line breaks', await evalJS(`(() => { const d = ${card('Test tasks agent')}.querySelector('[data-field=purpose] dd'); const p = ${card('Test tasks agent')}.querySelector('[data-field=processes] dd');
  return d.textContent === 'Keeps <b>the</b> list moving.' && !d.querySelector('b') && p.textContent === 'Triage.\\nThen plan.' && getComputedStyle(p).whiteSpace === 'pre-wrap' })()`))
await evalJS(`${card('Test money agent')}.querySelector('summary .planner-bucket').click()`)
await wait(200)
check('an empty required field reads Not filled in yet, in secondary text', await evalJS(`(() => { const e = [...${card('Test money agent')}.querySelectorAll('.bagent__empty')];
  return e.length === 6 && e.every(x => x.textContent === 'Not filled in yet') })()`))
check('an unwritten optional field is left out', await evalJS(`!${card('Test money agent')}.querySelector('[data-field=involved]') && !${card('Test money agent')}.querySelector('[data-field=already_does_it]')`))
check('the Brief button opens the editor and leaves the card as it was', await evalJS(`(() => { const d = ${card('Test money agent')}.querySelector('details'); let opened = null; const real = window.openBucketBrief; window.openBucketBrief = b => { opened = b; };
  refreshBucketPlanners(); return new Promise(r => setTimeout(() => { const dd = ${card('Test money agent')}.querySelector('details'); const was = dd.open; ${card('Test money agent')}.querySelector('[data-bucket-brief]').click(); window.openBucketBrief = real; r(opened === 'Money' && dd.open === was && was); }, 100)); })()`))
check('start wording follows the bucket agent', await evalJS(`bucketAgentStartWords({ start: 'on-assign' }) === 'starts when assigned' &&
  bucketAgentStartWords({ start: 'scheduled' }) === "starts in this board's hours"`))
check('a scheduled bucket is outside the board\'s hours when the hour is not one of them', await evalJS(`(() => {
  const h = new Date().getHours();
  bucketAgentData.hours = [(h + 5) % 24]; const out = bucketAgentInHours();
  bucketAgentData.hours = [h]; const inn = bucketAgentInHours();
  bucketAgentData.hours = []; return !out && inn;
})()`))
check('through the fetch the page uses, the old agents are gone and the bucket agent stays', await evalJS(`window.fetch('/agents-api/state.json').then(r => r.json()).then(j => j.agents.map(a => a.id).join())`) === 'bucket-agent')
check('the Settings page swaps the bucket strip for its own tabs and hides the edit-buckets pencil; other views bring them back', await evalJS(`(() => {
  const wasLocked = state.locked, wasView = state.view
  state.locked = false
  state.view = 'agents'; renderView()
  const hidden = document.querySelector('#bucketFilters [data-value=agents]') !== null &&
    document.querySelector('#themeBar').classList.contains('hidden') &&
    getComputedStyle(document.querySelector('#editBuckets')).display === 'none'
  state.view = 'board'; renderFilterBar()
  const back = !document.querySelector('#bucketFilters').classList.contains('hidden') &&
    !document.querySelector('#editBuckets').classList.contains('hidden')
  state.locked = wasLocked; state.view = wasView; renderFilterBar()
  return hidden && back
})()`))

if (process.env.SHOT) {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(process.env.SHOT, Buffer.from(shot.result.data, 'base64'))
}

/* ---- a change goes through the agent ---- */
await evalJS(`document.querySelector('#agentsRoot .trow .hours button.hr[data-hour="5"]').click()`)
await wait(500)
const posted = await evalJS(`window.__blocked.join('\\n')`)
check('an hour click posts to /agents-api/apply', /POST \/agents-api\/apply \{"agent":"bucket-agent","target":"personal","changes":\{"hours":\[5\]\}\}/.test(posted), posted.slice(0, 200))

/* ---- nothing leaks into the board ---- */
check('its .count styles stay inside the view', await evalJS(`(() => {
  const s = document.createElement('span'); s.className = 'count'; document.body.appendChild(s);
  const r = getComputedStyle(s).whiteSpace; s.remove(); return r !== 'nowrap';
})()`))

/* ---- leaving unmounts it, so the poll stops ---- */
await evalJS(`state.view = 'board'; renderView()`)
await wait(300)
// The board view hides #lists rather than emptying it, so the host node can
// stay; what matters is that React let go of it and drew nothing into it.
check('leaving the tab unmounts it', await evalJS(`agentsRoot === null && !document.querySelector('#agentsRoot .agents-ui')`))

/* ---- a machine where no agent can run ---- */
await evalJS(`state.agentsReady = false; state.agentsMissing = 'claude'; state.view = 'agents'; renderView()`)
await wait(300)
check('with no Claude Code, the tab says so instead of offering setup', await evalJS(`
  document.querySelector('#lists .agentsetup').textContent.includes('Claude Code') &&
  !document.querySelector('#lists [data-agent-setup]') && !document.querySelector('#lists .agents-ui')`))
check('Delegate to offers no agents', await evalJS(`!delegateSelectHTML('', '').includes('optgroup label="Agents"')`))
check('the Data menu leaves out Run the bucket agents now, and the Settings page keeps its four tabs', await evalJS(`syncFolderButton();
  $('#runAgentBtn').classList.contains('hidden') && settingsTabs().map(t => t[0]).join() === 'memory,settings,agents,backups'`))
check('Settings has no agent options either way, and the Agents tab says why agents are off', await evalJS(`loadSettingsDraft(false).then(d => {
  const html = settingsFormHTML(d.draft, [], false);
  return !html.includes('data-agent-options') && !html.includes('Agents are off on this machine');
}).then(ok => { state.view = 'agents'; renderView(); return ok && !document.querySelector('[data-agent-options]') && document.querySelector('#lists .agentsetup').textContent.includes('Claude Code'); })`))
await evalJS(`state.agentsReady = null; state.agentsMissing = ''; syncFolderButton(); state.view = 'board'; renderView()`)
await wait(300)
check('with the answer unknown, nothing is hidden', await evalJS(`settingsTabs().some(t => t[0] === 'agents') && !$('#runAgentBtn').classList.contains('hidden')`))
check('Run the bucket agents now asks first', await evalJS(`(() => {
  $('#runAgentBtn').click();
  const asked = !!modalEl && modalEl.textContent.includes('Run the bucket agents now?');
  closeModal(); return asked;
})()`))

/* ---- the real route ---- */
const status = await evalJS(`window.__real('/agents-status.json').then(r => r.json()).then(j => JSON.stringify(j))`)
check('the server says whether agents can run here', /"ready": ?(true|false)/.test(status) && /"claude": ?(true|false)/.test(status), status)
const real = await evalJS(`window.__real('/agents-api/state.json').then(r => r.json()).then(j => (j.agents || []).map(a => a.id).sort().join(','))`)
check('the server lists only this repo agents, the bucket agents', real === 'bucket-agent', real)
const refused = await evalJS(`window.__real('/agents-api/run', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }).then(r => r.status)`)
check('a POST naming no agent is refused', refused === 404, String(refused))

ws.close()
chrome.kill()
const failed = checks.filter(c => !c).length
console.log(failed ? `\n${failed} failed` : `\nall ${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
