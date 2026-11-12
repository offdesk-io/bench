#!/usr/bin/env node
/* The bars around the board: headline, bucket and theme tabs, the two filter
 * chips and the phone's column strip, drawn by React (kanban/ui/HeaderBars.tsx).
 *
 *   node kanban/test_header_bars.mjs   # or scripts/test-board.sh test_header_bars.mjs
 *
 * Written 1 Oct 2026. Locked before the fixture loads and every write torn out
 * of `fetch`, so the run cannot reach todo.md.
 */
import { spawn } from 'node:child_process'
import { CHROME_BIN } from './test_browser.mjs'

const PORT = Number(process.env.CDP_PORT) || 9496
const BOARD = process.env.BOARD_PORT || 8765
if (!process.env.BOARD_PORT) console.error('Note: this runs against the live board on 8765. For a throwaway copy: scripts/test-board.sh test_header_bars.mjs')
const checks = []
const check = (name, pass, detail = '') => {
  checks.push(pass)
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const chrome = spawn(CHROME_BIN, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  `--user-data-dir=${process.env.CHROME_PROFILE || '/tmp/todo-header-bars-test-profile'}`, '--window-size=1400,1000',
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

try {
  await new Promise(r => setTimeout(r, 2500))
  check('the board loaded', await evalJS(`typeof renderHeadline === 'function' && typeof BoardUI.HeadlineBar === 'function'`))

  await evalJS(`(() => {
    state.locked = true; state.lockedLabel = 'test';
    const real = window.fetch;
    window.__blocked = [];
    window.fetch = (u, o) => {
      const m = (o && o.method) || 'GET';
      if (m !== 'GET') { window.__blocked.push(m + ' ' + u); return Promise.resolve(new Response('{}', { status: 200 })) }
      return real(u, o);
    };
    load([
      '# To-do', '', '## 1. Work', '',
      '### Doing', '',
      "- [ ] **Alpha** [impact:: high] [effort:: M] [to:: Plan agent] [theme:: Ops]",
      "- [ ] **Beta** [impact:: med] [effort:: S]",
      "- [ ] **Gamma**",
      '',
      '### To do', '',
      '',
      '## 2. Home', '',
      '### Doing', '',
      "- [ ] **Delta** [impact:: low] [effort:: S]",
      ''
    ].join('\\n'), 'demo.md', {});
    state.bucketThemes = { Work: ['Ops', 'Admin'] };
    state.locked = false;
    window.__task = title => state.doc.buckets.flatMap(b => b.tiers).flatMap(x => x.tasks).find(t => t.title === title);
    state.view = 'board'; renderView();
  })()`)
  await wait(200)
  check('the tab is unlocked, and every write is being torn out', await evalJS(`state.locked === false && window.__blocked.length === 0`))

  /* ---- headline ---- */

  check('with nothing set the bar is the empty invitation', await evalJS(`(() => {
    const b = document.querySelector('#headline');
    return !b.classList.contains('set') && !!b.querySelector('.hlempty') && !b.hasAttribute('role') && !b.querySelector('#hlClear');
  })()`))
  await evalJS(`setHeadline(__task('Alpha').id); renderBoard()`)
  await wait(200)
  check('setting one fills the bar: title, where, tags and a Remove button', await evalJS(`(() => {
    const b = document.querySelector('#headline');
    return b.classList.contains('set') && b.querySelector('.hltitle').textContent.trim() === 'Alpha' &&
      b.querySelector('.hlwhere').textContent.includes('Work') && b.querySelectorAll('.hlmeta .tenon-tag').length >= 2 &&
      !!b.querySelector('#hlClear') && b.getAttribute('role') === 'button' && b.getAttribute('tabindex') === '0';
  })()`))
  await evalJS(`document.querySelector('#headline').click()`)
  await wait(200)
  check('clicking the bar opens the task', await evalJS(`state.openTask === __task('Alpha').id`))
  await evalJS(`closeDrawer()`)
  await evalJS(`document.querySelector('#hlClear').click()`)
  await wait(200)
  check('Remove clears it without opening the task', await evalJS(`
    !document.querySelector('#headline').classList.contains('set') && state.openTask !== __task('Alpha').id`))

  /* ---- bucket tabs ---- */

  check('the tab strip draws All plus one tab per bucket, with counts', await evalJS(`(() => {
    const t = [...document.querySelectorAll('#bucketFilters .tenon-toggle-group__option')];
    return t.length === 3 && t[0].classList.contains('taball') && t[0].querySelector('.tenon-toggle-group__count').textContent === '4' &&
      t[1].dataset.value === 'Work' && t[1].querySelector('.tenon-toggle-group__count').textContent === '3' && !!t[1].querySelector('.tenon-toggle-group__dot');
  })()`))
  await evalJS(`document.querySelector('#bucketFilters [data-value="Work"]').click()`)
  await wait(200)
  check('clicking a bucket turns it on alone and narrows the board', await evalJS(`(() => {
    const on = [...document.querySelectorAll('#bucketFilters .tenon-toggle-group__option--on')].map(t => t.dataset.value);
    const cards = [...document.querySelectorAll('#board .tenon-card')].length;
    return JSON.stringify(on) === '["Work"]' && cards === 3 &&
      document.querySelector('#bucketFilters [data-value="Work"]').getAttribute('aria-pressed') === 'true';
  })()`))
  check('a bucket with themes brings up the theme row', await evalJS(`(() => {
    const bar = document.querySelector('#themeBar');
    return !bar.classList.contains('hidden') &&
      [...document.querySelectorAll('#themeFilters .tenon-toggle-group__option')].map(t => t.dataset.value).join() === 'Ops,Admin';
  })()`))
  await evalJS(`document.querySelector('#themeFilters [data-value="Ops"]').click()`)
  await wait(200)
  check('a theme tab toggles on and narrows to its tasks', await evalJS(`
    document.querySelector('#themeFilters [data-value="Ops"]').getAttribute('aria-pressed') === 'true' &&
    document.querySelectorAll('#board .tenon-card').length === 1`))
  await evalJS(`document.querySelector('#themeFilters [data-value="Ops"]').click()`)
  await evalJS(`document.querySelector('#bucketFilters [data-value="Home"]').click()`)
  await wait(200)
  check('two buckets on at once, and the theme row goes away', await evalJS(`
    document.querySelectorAll('#bucketFilters .tenon-toggle-group__option--on').length === 2 && document.querySelector('#themeBar').classList.contains('hidden') &&
    document.querySelectorAll('#themeFilters .tenon-toggle-group__option').length === 0`))
  await evalJS(`document.querySelector('#bucketFilters [data-value="__all__"]').click()`)
  await wait(200)
  check('All clears the set', await evalJS(`
    document.querySelectorAll('#bucketFilters .tenon-toggle-group__option--on').length === 1 && document.querySelector('#bucketFilters [data-value="__all__"]').getAttribute('aria-pressed') === 'true'`))

  /* ---- chips ---- */

  check('the agent chip counts the delegated tasks, and there is no need-scoring chip', await evalJS(`
    !document.querySelector('#scoreChip') && !/need scoring/.test(document.querySelector('#filterChips').textContent) &&
    document.querySelector('#agentFilterChip').textContent === '1 delegated to an agent'`))
  await evalJS(`document.querySelector('#agentFilterChip').click()`)
  await wait(200)
  check('clicking the agent chip lights it and narrows the board', await evalJS(`
    document.querySelector('#agentFilterChip').getAttribute('aria-pressed') === 'true' &&
    document.querySelector('#agentFilterChip').textContent.startsWith('Showing 1 delegated') &&
    document.querySelectorAll('#board .tenon-card').length === 1`))
  await evalJS(`document.querySelector('#agentFilterChip').click()`)
  await wait(200)
  check('and clicking it again puts everything back', await evalJS(`
    document.querySelector('#agentFilterChip').getAttribute('aria-pressed') === 'false' && document.querySelectorAll('#board .tenon-card').length === 4`))
  check('no card says it needs scoring', await evalJS(`!/needs scoring/.test(document.querySelector('#board').textContent)`))

  /* ---- the phone's chrome stays out of the desktop ---- */

  check('the phone chrome is in the bundle but not drawn at desktop width, and no control id is doubled', await evalJS(`
    typeof BoardUI.PhoneChrome === 'function' && !!document.querySelector('#phTabs') &&
    getComputedStyle(document.querySelector('#phTabs')).display === 'none' &&
    getComputedStyle(document.querySelector('#phTop')).display === 'none' &&
    document.querySelectorAll('#agentFilterChip').length === 1 && document.querySelectorAll('#bucketFilters').length === 1`))

  /* ---- the Settings page swaps the strip for its tabs ---- */

  await evalJS(`state.view = 'agents'; renderView()`)
  await wait(300)
  check('the Agents tab shows the Settings tabs in place of the buckets', await evalJS(`!!document.querySelector('#bucketFilters [data-value=agents]') && !document.querySelector('#bucketFilters .taball')`))
  await evalJS(`state.view = 'board'; renderView()`)
  await wait(200)

  /* ---- the phone's column strip ---- */

  check('the column strip names every column and lights the first', await evalJS(`(() => {
    const t = [...document.querySelectorAll('#colTabs .coltab')];
    return t.length === boardColumns().length && t[0].classList.contains('on') && t.filter(b => b.classList.contains('on')).length === 1;
  })()`))
  await evalJS(`document.querySelectorAll('#colTabs .coltab')[1].click()`)
  await wait(500)
  check('clicking a name lights it', await evalJS(`
    [...document.querySelectorAll('#colTabs .coltab')].findIndex(b => b.classList.contains('on')) === 1`))

  await evalJS(`state.locked = true`)
  /* Setting a headline autosaves, so some writes are expected; every one was
     torn out of fetch, and the only place they aim at is the fixture's own file. */
  check('every write was torn out before it left the page', await evalJS(`window.__blocked.every(w => /\\/data\\/todo\\.md$/.test(w))`), await evalJS(`window.__blocked.join(' | ')`))
} finally {
  ws.close()
  chrome.kill()
}

const failed = checks.filter(c => !c).length
console.log(failed ? `\n${failed} failed` : `\nall ${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
