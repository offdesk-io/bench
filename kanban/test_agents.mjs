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
 * tab before any agent is set up, SHOT_QUESTION one setup question and
 * SHOT_DONE the sheet setup ends on.
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

await wait(2500)
check('the board loaded', await evalJS(`typeof renderAgentsView === 'function' && typeof BoardUI.AgentsApp === 'function'`))

// LOCK FIRST, then fixtures. Nothing below can write anything.
await evalJS(`(() => {
  state.locked = true; state.lockedLabel = 'test';
  const real = window.fetch;
  window.__real = real;
  window.__blocked = [];
  window.__stateReads = 0;
  const target = (id, name, on, hours) => ({ id, name, on, hours, counts: [{ n: 2, l: 'queued', kind: 'good' }] });
  window.__agents = {
    hour: 10, now: new Date().toISOString(),
    agents: [
      { id: 'plan-agent', key: 'plan-agent', name: 'Plan agent', blurb: 'Writes plans overnight.',
        targets: [target('work', 'work', true, [1, 2, 3]), target('personal', 'personal', false, [])] },
      { id: 'implement-agent', key: 'implement-agent', name: 'Implement agent', blurb: 'Carries out agreed plans.',
        targets: [target('work', 'work', false, [4])] },
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
   agent: the tab offers setup and the cards, and the rest of the board leaves
   the agents out. */
await wait(800)
check('a list with no agent counts as not set up', await evalJS(`state.agentsSetup === false && agentsSetUp() === false`))
check('Agents is a tab of the Settings page, not of the top bar', await evalJS(`!viewDefs().some(d => d.id === 'agents') && settingsTabs().some(t => t[0] === 'agents')`))
await evalJS(`openSettingsPage('agents')`)
await wait(400)
check('the tab offers setup instead of the hour tracks', await evalJS(`!!document.querySelector('#lists .agentsetup [data-agent-setup]') && !document.querySelector('#lists .agents-ui')`))
if (process.env.SHOT_SETUP) {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(process.env.SHOT_SETUP, Buffer.from(shot.result.data, 'base64'))
}
check('and still shows the cards', await evalJS(`document.querySelectorAll('#agentsCards .agentcard').length === 3`))
check('the Plan and Implement agents\' cards each carry a handover level, and the PA\'s does not', await evalJS(`
  [...document.querySelectorAll('#agentsCards .agentcard')].map(c => c.dataset.agentCard + ':' +
    [...c.querySelectorAll('[data-handover-level] option')].map(o => o.value).join('/')).join(' ')`) ===
  'PA: Plan agent:plan-first/just-do-it/off Implement agent:just-do-it/off')
check('Delegate to offers no agents', await evalJS(`!delegateSelectHTML('', '').includes('Plan agent')`))
check('but keeps one a task already names', await evalJS(`delegateSelectHTML('Plan agent', '').includes('Implement agent')`))
await evalJS(`state.view = 'overview'; renderView()`)
await wait(400)
check('Overview leaves out Delegate to Claude', await evalJS(`!document.querySelector('#lists').textContent.includes('Delegate to Claude')`))
check('a delegated task counts as set up', await evalJS(`(() => {
  const t = state.doc.buckets[0].tiers.find(ti => ti.tasks.length).tasks[0];
  t.to = 'Plan agent'; const on = agentsSetUp(); t.to = ''; return on && !agentsSetUp();
})()`))
check('a brief carrying only the template counts as unwritten', await evalJS(`(() => {
  const tpl = '# <Bucket name>\\n\\n<One line>\\n\\n## The processes I run in this bucket\\n\\nOne per heading.\\n';
  const scaffolded = tpl.replace('<Bucket name>', 'Tasks').replace('<One line>', 'Things I do');
  const written = scaffolded.replace('One per heading.', 'Weekly invoices, sent every Friday.');
  const b = text => ({ exists: true, filled: true, text, template: tpl });
  return !briefWritten(b(scaffolded)) && briefWritten(b(written));
})()`))

/* ---- setting one up: four questions, written into the bucket's brief ---- */
const clickModal = label => evalJS(`(() => {
  const b = [...(modalEl ? modalEl.querySelectorAll('button') : [])].find(b => b.textContent.trim() === ${JSON.stringify(label)});
  if (!b) return false; b.click(); return true;
})()`)
const answer = text => evalJS(`(() => {
  const box = modalEl && modalEl.querySelector('#agentSetupAnswer');
  if (!box) return false; box.value = ${JSON.stringify(text)}; box.dispatchEvent(new Event('input')); return true;
})()`)
const heading = () => evalJS(`modalEl ? (modalEl.querySelector('h2, h1, .tenon-modal-title') || {}).textContent || '' : ''`)
await evalJS(`state.view = 'agents'; renderView(); document.querySelector('#lists [data-agent-setup]').click()`)
await wait(300)
check('Set up an agent asks which bucket first', await evalJS(`!!(modalEl && modalEl.querySelector('#agentSetupBucket option[value="Tasks"]'))`))
await clickModal('Next'); await wait(200)
check('then what the agent should be like', (await heading()).includes('What should this agent be like'), await heading())
await answer('Ask before starting anything longer than an hour.')
await clickModal('Next'); await wait(200)
check('then what tasks it does', (await heading()).includes('What tasks should it do'))
await clickModal('Next'); await wait(200)
check('which cannot be left empty', (await heading()).includes('What tasks should it do') && await evalJS(`!!modalEl.querySelector('.agentsetup-missing')`))
await answer('Weekly invoices, sent every Friday.')
await clickModal('Next'); await wait(200)
check('then whether there is documentation', (await heading()).includes('documentation'))
await clickModal('Back'); await wait(200)
check('Back keeps what was typed', await evalJS(`modalEl.querySelector('#agentSetupAnswer').value === 'Weekly invoices, sent every Friday.'`))
await clickModal('Next'); await wait(200)
await clickModal('Next'); await wait(200)
check('then what the output looks like', (await heading()).includes('output'))
await answer('A PDF per client, named by month.')
if (process.env.SHOT_QUESTION) {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(process.env.SHOT_QUESTION, Buffer.from(shot.result.data, 'base64'))
}
await evalJS(`window.__blocked = []`)
await clickModal('Set up the agent'); await wait(800)
const put = await evalJS(`window.__blocked.find(b => b.startsWith('PUT /bucket-brief')) || ''`)
const sent = put ? JSON.parse(put.slice(put.indexOf('{'))) : {}
check('it writes the bucket\'s brief', sent.bucket === 'Tasks', put.slice(0, 120))
check('tasks go under the processes', /## The processes I run in this bucket\n\nWeekly invoices, sent every Friday\./.test(sent.text || ''))
check('how it works and the output go under what good looks like', /## What good looks like here\n\nHow the agent should work: Ask before.*\n\nWhat the output looks like: A PDF per client/.test(sent.text || ''))
check('an unanswered question leaves the template\'s guidance', /## What already does it\n\nWhich of my skills/.test(sent.text || ''))
check('the brief no longer carries the empty marker', !(sent.text || '').includes('NOT FILLED IN YET'))
check('it ends on the Plan agent\'s card', await evalJS(`!!(modalEl && modalEl.querySelector('.agentcard.on[data-agent-card="Plan agent"]'))`))
check('and the list now counts as set up', await evalJS(`agentsSetUp() === true`))
if (process.env.SHOT_DONE) {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(process.env.SHOT_DONE, Buffer.from(shot.result.data, 'base64'))
}
await clickModal('Done')
check('an answer goes under text someone already wrote', await evalJS(`(() => {
  const tpl = '# <Bucket name>\\n\\n## The processes I run in this bucket\\n\\nOne per heading.\\n';
  const out = briefWithAnswers({ text: '# Money\\n\\n## The processes I run in this bucket\\n\\nPayroll.\\n', template: tpl }, 'Money', { tasks: 'Invoices.' });
  return /Payroll\\.\\n\\nInvoices\\./.test(out);
})()`))

/* ---- once one is ---- */
await evalJS(`state.agentsSetup = true; state.view = 'agents'; renderView()`)
await wait(1200)
check('it mounts the shared component', await evalJS(`!!document.querySelector('#lists #agentsRoot .agents-ui.agents-root.embedded')`))
check('titled Agents', await evalJS(`document.querySelector('#agentsRoot h1')?.textContent === 'Agents'`))
check('it shows both agents', await evalJS(`(() => { const t = document.querySelector('#agentsRoot').textContent; return t.includes('Plan agent') && t.includes('Implement agent') })()`))
check('it read /agents-api, not the dashboard routes', await evalJS(`window.__stateReads > 0`))
check('the list view draws an hour track per target', await evalJS(`document.querySelectorAll('#agentsRoot .trow .hours .hr').length === 72`))
check('and the ruler over them', await evalJS(`!!document.querySelector('#agentsRoot .rulerwrap .ruler')`))
check('a card per agent under it', await evalJS(`[...document.querySelectorAll('#agentsCards .agentcard h3')].map(h => h.textContent).join(',') === 'PA,Plan agent,Implement agent'`))
check('each card says does, cannot and needs', await evalJS(`[...document.querySelectorAll('#agentsCards .agentcard')].every(c => [...c.querySelectorAll('dt')].map(d => d.textContent).join('|') === 'Does|Cannot|Needs from you' && [...c.querySelectorAll('dd')].every(d => d.textContent.length > 20))`))
check('the tab lists this list\'s bucket planners under the cards', await evalJS(`(() => {
  const el = document.querySelector('#agentsPlanners .planners li')
  if (!el) return false
  return el.querySelector('.planner-bucket')?.textContent === 'Tasks' &&
    el.querySelector('.planner-name')?.textContent === 'fallback planner'
})()`))
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
check('an hour click posts to /agents-api/apply', /POST \/agents-api\/apply \{"agent":"plan-agent","target":"personal","changes":\{"hours":\[5\]\}\}/.test(posted), posted.slice(0, 200))

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
check('and no list counts as set up, delegated tasks included', await evalJS(`(() => {
  const t = state.doc.buckets[0].tiers.find(ti => ti.tasks.length).tasks[0];
  t.to = 'Plan agent'; const on = agentsSetUp(); t.to = ''; return on === false;
})()`))
check('Delegate to offers no agents', await evalJS(`!delegateSelectHTML('', '').includes('Plan agent')`))
check('the Data menu leaves out Run the Plan agent now, and the Settings page leaves out Spend and Schedules', await evalJS(`syncFolderButton();
  $('#runAgentBtn').classList.contains('hidden') && !settingsTabs().some(t => t[0] === 'spend' || t[0] === 'schedules')`))
check('Settings leaves out the agent options', await evalJS(`loadSettingsDraft(false).then(d => {
  const html = settingsFormHTML(d.draft, [], false);
  return !html.includes('data-agent-options') && html.includes('Agents are off on this machine');
})`))
check('a hand-over set to start now starts nothing', await evalJS(`(async () => {
  window.__blocked = []; queueAgentStart('plan'); await flushAgentStarts();
  return !window.__blocked.some(b => b.includes('/planning_agent/run'));
})()`))
await evalJS(`state.agentsReady = null; state.agentsMissing = ''; syncFolderButton(); state.view = 'board'; renderView()`)
await wait(300)
check('with the answer unknown, nothing is hidden', await evalJS(`settingsTabs().some(t => t[0] === 'spend') && !$('#runAgentBtn').classList.contains('hidden')`))
check('Run the Plan agent now asks first', await evalJS(`(() => {
  $('#runAgentBtn').click();
  const asked = !!modalEl && modalEl.textContent.includes('Run the Plan agent now?');
  closeModal(); return asked;
})()`))

/* ---- the real route ---- */
const status = await evalJS(`window.__real('/agents-status.json').then(r => r.json()).then(j => JSON.stringify(j))`)
check('the server says whether agents can run here', /"ready": ?(true|false)/.test(status) && /"claude": ?(true|false)/.test(status), status)
const real = await evalJS(`window.__real('/agents-api/state.json').then(r => r.json()).then(j => (j.agents || []).map(a => a.id).sort().join(','))`)
check('the server lists only this repo agents', real === 'implement-agent,plan-agent', real)
const refused = await evalJS(`window.__real('/agents-api/run', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }).then(r => r.status)`)
check('a POST naming no agent is refused', refused === 404, String(refused))

ws.close()
chrome.kill()
const failed = checks.filter(c => !c).length
console.log(failed ? `\n${failed} failed` : `\nall ${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
