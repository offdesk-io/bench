/* Where an agent's run on a task stands: the line on its card
 * (agentRunStatus(), kanban/js/28-agent-runs.js), and what the sub-task's panel
 * offers from it.
 *
 * Run through scripts/test-board.sh, which gives it a throwaway server. The run
 * records are set in the page rather than written to disk, and every non-GET is
 * torn out of fetch and recorded, so nothing here reaches todo.md or
 * agent-runs.json; the last check says so.
 */
import { spawn } from 'node:child_process'
import { CHROME_BIN } from './test_browser.mjs'

const PORT = Number(process.env.CDP_PORT) || 9461
const BOARD = process.env.BOARD_PORT || 8765
if (!process.env.BOARD_PORT) console.error('Note: this runs against the live board on 8765. For a throwaway copy: scripts/test-board.sh test_agent_runs.mjs')
const checks = []
const check = (name, pass, detail = '') => {
  checks.push(pass)
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const chrome = spawn(CHROME_BIN, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  `--user-data-dir=${process.env.CHROME_PROFILE || '/tmp/todo-board-test-profile-runs'}`, '--window-size=1500,1000',
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

await wait(2500)
check('the board loaded', await evalJS(`typeof agentRunStatus === 'function' && typeof renderBoard === 'function'`))

/* Two tasks handed to the Plan agent, one to nobody. handOver() lays out the
   sub-tasks, so the test reads their ids back rather than writing them. */
await evalJS(`(() => {
  const real = window.fetch;
  window.__blocked = [];
  window.fetch = (u, o) => {
    const m = (o && o.method) || 'GET';
    if (m !== 'GET') {
      window.__blocked.push(m + ' ' + u);
      /* Answers /agent-runs the way kanban/server.py would, on the page's copy. */
      if (u === '/agent-runs') {
        const b = JSON.parse(o.body), runs = Object.assign({}, window.__runs || {});
        if (b.action === 'retry' && runs[b.sub]) runs[b.sub] = Object.assign({}, runs[b.sub], { state: 'queued', retry: '2026-09-27T10:00:00' });
        if (b.action === 'clear') delete runs[b.sub];
        window.__runs = runs;
        return Promise.resolve(new Response(JSON.stringify({ ok: true, subs: runs }), { status: 200 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    }
    if (String(u).startsWith('/agent-runs.json')) return Promise.resolve(new Response(JSON.stringify({ subs: window.__runs || {} }), { status: 200 }));
    return real(u, o);
  };
  state.view = 'board';
  load([
    '# To-do', '', '## 1. People', '',
    '### To do', '',
    '- [ ] Alpha [impact:: high] [effort:: S]',
    '- [ ] Beta [impact:: low] [effort:: M]',
    '- [ ] Gamma [impact:: med] [effort:: M] [to:: Plan agent]',
    ''
  ].join('\\n'), 'demo.md', {});
  state.locked = false;
  const byTitle = n => allItems().find(x => !x.sub && x.title === n).task;
  handOver(byTitle('Alpha'), 'Plan agent');
  handOver(byTitle('Beta'), 'Plan agent');
  window.__t = byTitle;
  window.__sub = (n, kind) => subSteps(byTitle(n)).find(s => s.slug === byTitle(n).stableId + '-' + kind);
  window.__line = n => { const el = document.querySelector('#board .tenon-card[data-id="' + byTitle(n).id + '"] .runline'); return el ? el.textContent : ''; };
  window.__tone = n => { const el = document.querySelector('#board .tenon-card[data-id="' + byTitle(n).id + '"] .runline'); return el ? el.className : ''; };
  window.__set = runs => { window.__runs = runs; agentRuns = runs; agentRunsSig = JSON.stringify(runs); refreshView(); };
  renderView();
})()`)
await wait(200)

/* ---- the status line ---- */

check('a task handed over with no run yet reads queued',
  await evalJS(`__line('Alpha')`) === 'Plan agent · queued for tonight', await evalJS(`__line('Alpha')`))
check('a task tagged to an agent with no handover has no line',
  await evalJS(`__line('Gamma')`) === '')

await evalJS(`(() => {
  const now = new Date(); now.setHours(2, 5, 0, 0);
  const iso = now.toISOString().slice(0, 19);
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  const a = __sub('Alpha', 'plan').stableId, b = __sub('Beta', 'plan').stableId;
  const soon = new Date(Date.now() - 10 * 60000);
  window.__soon = new Date(soon.getTime() - soon.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  __set({ [a]: { sub: a, state: 'running', started: __soon, at: __soon, agent: 'Plan agent' },
          [b]: { sub: b, state: 'done', at: local, label: 'planned', agent: 'Plan agent' } });
})()`)
await wait(200)
check('a run in progress reads working, with when it started',
  await evalJS(`__line('Alpha') === 'Plan agent · working · since ' + runWhen(__soon)`), await evalJS(`__line('Alpha')`))
check('and is drawn in the running tone', /runline--running/.test(await evalJS(`__tone('Alpha')`)))

/* The board applies the Plan agent's tick; its review is then the owner's. */
await evalJS(`(() => {
  const t = __t('Beta'), s = __sub('Beta', 'plan');
  const f = readSub(t, s.line); f.done = true; writeSub(t, s.line, f); refreshView();
})()`)
await wait(200)
check('a written plan reads waiting for you, with when it landed',
  await evalJS(`__line('Beta')`) === 'Plan agent · waiting for you · 02:05', await evalJS(`__line('Beta')`))
check('in the tone that says it is his', /runline--you/.test(await evalJS(`__tone('Beta')`)))

check('a card with no agent part has the same body as before',
  await evalJS(`!document.querySelector('#board .tenon-card[data-id="' + __t('Gamma').id + '"] .tenon-card__body')`))

/* ---- a failed run ---- */

await evalJS(`(() => {
  const a = __sub('Alpha', 'plan').stableId;
  const runs = Object.assign({}, window.__runs);
  runs[a] = { sub: a, state: 'failed', at: __soon, agent: 'Plan agent', why: 'the CLI exited 1',
              error: 'Traceback (most recent call last):\\nValueError: nope' };
  __set(runs);
})()`)
await wait(200)
check('a failed run reads failed on the card',
  await evalJS(`__line('Alpha') === 'Plan agent · failed · ' + runWhen(__soon)`), await evalJS(`__line('Alpha')`))
check('in the error tone', /runline--failed/.test(await evalJS(`__tone('Alpha')`)))

await evalJS(`openDrawer(__t('Alpha').id)`)
await wait(200)
check('the task drawer shows the line with its three ways out', await evalJS(`
  [...document.querySelectorAll('#dbody .runblock [data-run]')].map(b => b.textContent).join('|')
`) === 'Read the log|Retry|Take it back')

await evalJS(`document.querySelector('#dbody .runblock [data-run="log"]').click()`)
await wait(200)
check('Read the log shows the run\'s own output', await evalJS(`
  !!(modalEl && /ValueError: nope/.test(modalEl.querySelector('.runlog').textContent))
`))
await evalJS(`closeModal()`)

await evalJS(`openDrawer(__sub('Alpha', 'plan').stableId)`)
await wait(200)
check('the Plan sub-task\'s own panel carries the same block', await evalJS(`
  document.querySelectorAll('#sbody .runblock [data-run]').length === 3
`))
check('its Review the plan does not', await evalJS(`(() => {
  openDrawer(__sub('Alpha', 'plan-review').stableId);
  return !document.querySelector('#sbody .runblock');
})()`))

await evalJS(`(() => { closeSubPanel(); openDrawer(__t('Alpha').id);
  document.querySelector('#dbody .runblock [data-run="retry"]').click(); })()`)
await wait(300)
check('Retry asks the server to queue it again', await evalJS(`
  window.__blocked.some(b => b.startsWith('POST /agent-runs'))
`), await evalJS(`window.__blocked.join(' | ')`))
check('and the card then says when it goes again',
  await evalJS(`__line('Alpha')`) === 'Plan agent · retrying tonight', await evalJS(`__line('Alpha')`))

await evalJS(`(() => {
  const a = __sub('Alpha', 'plan').stableId;
  const runs = Object.assign({}, window.__runs);
  runs[a] = Object.assign({}, runs[a], { state: 'failed' });
  __set(runs);
  openDrawer(__t('Alpha').id);
  window.__blocked.length = 0;
  document.querySelector('#dbody .runblock [data-run="takeback"]').click();
})()`)
await wait(300)
check('Take it back puts him on every open agent step', await evalJS(`
  ['plan', 'implement'].every(k => __sub('Alpha', k).to === OWNER_NAME)
`))
check('and takes the agent off the task', await evalJS(`!agentOf(__t('Alpha').to)`))
check('so the card has no agent line left', await evalJS(`__line('Alpha')`) === '')
check('and the run record is cleared', await evalJS(`
  window.__blocked.some(b => b.startsWith('POST /agent-runs'))
`))

/* ---- the activity feed ---- */

await evalJS(`(() => {
  const b = __sub('Beta', 'plan').stableId;
  const runs = Object.assign({}, window.__runs);
  runs[b] = { sub: b, state: 'done', at: __soon, label: 'planned', agent: 'Plan agent',
              summary: 'Three steps, one message.', plan: 'bd-beta.md' };
  __set(runs);
  const t = __t('Beta');
  t.body.unshift('  - Hire for the role by March.');
  openDrawer(__sub('Beta', 'plan-review').stableId);
})()`)
await wait(300)
const heads = await evalJS(`[...document.querySelectorAll('#sbody .actfeed .acthead')].map(e => e.textContent).join('|')`)
check('a review\'s panel carries the feed: the brief, then the plan', heads === 'Brief|Plan agent · wrote the plan · ' + await evalJS(`runWhen(__soon)`), heads)
check('the brief is the task\'s own note', await evalJS(`
  /Hire for the role by March/.test(document.querySelector('#sbody .actfeed .actbody').textContent)
`))
check('the plan entry can be read from there', await evalJS(`
  document.querySelector('#sbody .actfeed [data-readplan]').dataset.readplan === 'bd-beta.md'
`))
check('the reply goes to the agent that last touched it', await evalJS(`
  document.querySelector('#act-send').textContent === 'Send to Plan agent'
`))

await evalJS(`(() => {
  document.querySelector('#act-reply').value = 'Cover the notice period too.';
  document.querySelector('#act-send').click();
})()`)
await wait(300)
check('a reply to a finished step sends it back: the Plan step opens again', await evalJS(`!__sub('Beta', 'plan').done`))
check('carrying the reply as a feedback note the agent reads', await evalJS(`
  /- feedback: Cover the notice period too\\./.test(stepNoteText(__t('Beta'), __sub('Beta', 'plan').line))
`))
check('and the feed shows it as his', await evalJS(`
  [...document.querySelectorAll('#sbody .actfeed .act--you .actbody')].some(e => /notice period/.test(e.textContent))
`))

await evalJS(`(() => {
  closeSubPanel();
  const t = __t('Beta');
  ['plan', 'plan-review'].forEach(k => { const s = __sub('Beta', k); const f = readSub(t, s.line); f.done = true; writeSub(t, s.line, f); });
  const i = __sub('Beta', 'implement').stableId;
  const runs = Object.assign({}, window.__runs);
  runs[i] = { sub: i, state: 'done', at: __soon, label: 'done', agent: 'Implement agent', summary: 'Wrote the brief.',
    output: { files: ['brief.md', 'note.draft.md'], project: 'beta', drafts: [{ name: 'note.draft.md', text: 'Hey Sam' }],
              figma: 'https://www.figma.com/design/ABC123/Beta-screens?node-id=1-2',
              branch: { name: 'implement/2026-09-27', commits: 2, repo: '/x/tenon', summary: 'Tokens renamed.' } } };
  __set(runs);
  openDrawer(__sub('Beta', 'work-review').stableId);
})()`)
await wait(300)
check('the output\'s files are links into the project, drafts left out', await evalJS(`
  [...document.querySelectorAll('#sbody .actfile')].map(b => b.textContent + '@' + b.dataset.project).join(',')
`) === 'brief.md@beta')
check('a draft is shown in full, ready to copy', await evalJS(`
  document.querySelector('#sbody .actdraft pre').textContent === 'Hey Sam' && !!document.querySelector('#sbody .actdraft [data-copy]')
`))
check('a branch shows its name and commit count', await evalJS(`
  document.querySelector('#sbody .actbranch').textContent
`) === 'implement/2026-09-27 · 2 commits · tenon')
check('a Figma link opens in the desktop app', await evalJS(`
  document.querySelector('#sbody .actfigma').getAttribute('href')
`) === 'figma://file/ABC123/Beta-screens?node-id=1-2')
check('the reply now goes to the Implement agent', await evalJS(`
  document.querySelector('#act-send').textContent === 'Send to Implement agent'
`), await evalJS(`document.querySelector('#act-send')?.textContent + '/' + subSteps(__t('Beta')).map(s=>s.clean+':'+s.to+':'+s.done).join(',')`))
await evalJS(`closeSubPanel()`)

/* ---- nothing written ---- */

check('no write was attempted but the board saving its own file and its run requests', await evalJS(`
  window.__blocked.every(b => /^(PUT|HEAD) \\/data\\/todo\\.md/.test(b) || /^POST \\/agent-runs$/.test(b))
`), await evalJS(`window.__blocked.join(' | ')`))

ws.close()
chrome.kill()
const failed = checks.filter(c => !c).length
console.log(failed ? `\n${failed} failed` : `\nall ${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
