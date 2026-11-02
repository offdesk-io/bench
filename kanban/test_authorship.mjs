#!/usr/bin/env node
/* Who did what, on screen: the names on the cards and in the task panel, the
 * "Jerome edited 2 min ago" status line, and the Mine filter.
 *
 *   scripts/test-board.sh test_authorship.mjs
 *
 * Locked from the start, with every non-GET torn out of fetch, so nothing here
 * can save. The list is a fixture carrying `created-by:` and `edited-by:` the
 * way the shared server writes them, /activity.json is stubbed, and the
 * signed-in person is set by hand: the script's server is a Mac board, where
 * nobody signs in. kanban/test_authorship.py covers the server writing them.
 */
import { spawn } from 'node:child_process'
import { CHROME_BIN } from './test_browser.mjs'

const PORT = Number(process.env.CDP_PORT) || 9462
const BOARD = process.env.BOARD_PORT || 8765
if (!process.env.BOARD_PORT) console.error('Note: this runs against the live board on 8765. For a throwaway copy: scripts/test-board.sh test_authorship.mjs')
const BASE = `http://127.0.0.1:${BOARD}`
const checks = []
const check = (name, pass, detail = '') => {
  checks.push(pass)
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if (await fn()) return true } catch {}   // the page may not be up yet
    await new Promise(r => setTimeout(r, 200))
  }
  return false
}

const chrome = spawn(CHROME_BIN, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  `--user-data-dir=${process.env.CHROME_PROFILE || '/tmp/todo-merge-test-profile'}`, '--window-size=1400,1000',
  `${BASE}/kanban/index.html`
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

try {
  check('the board loaded', await until(() => evalJS(`!!state.doc && typeof loadActivity === 'function'`)))

  // LOCK FIRST, then fixtures. Nothing below can write anything.
  await evalJS(`(() => {
    state.locked = true; state.lockedLabel = 'test';
    window.__blocked = [];
    const real = window.fetch;
    const twoMin = new Date(Date.now() - 2 * 60000).toISOString();
    window.fetch = (u, o) => {
      const m = (o && o.method) || 'GET';
      if (m !== 'GET') { if (m !== 'HEAD') window.__blocked.push(m + ' ' + u); return Promise.resolve(new Response('{}', { status: 200 })) }
      if (String(u).startsWith('/activity.json')) return Promise.resolve(new Response(JSON.stringify({
        me: 'jerome@example.com',
        names: { 'jerome@example.com': 'Jérôme', 'ana@example.com': 'Ana Silva' },
        entries: [
          { at: new Date().toISOString(), who: 'jerome@example.com', name: 'Jérôme', task: 'Mine', what: 'edited', fields: ['due'] },
          { at: twoMin, who: 'ana@example.com', name: 'Ana Silva', task: 'Shared', what: 'edited', fields: ['title'] }
        ] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      return real(u, o);
    };
    state.who = { email: 'jerome@example.com', name: 'Jérôme', teams: [] };
    load([
      '# To-do', '', '## 1. Tasks', '', '### To do', '',
      '- [ ] **Shared** \`created-by:jerome@example.com\` \`edited-by:ana@example.com\` \`id:au0001\`',
      '  - [ ] A step [to:: jerome@example.com] \`created-by:ana@example.com\` \`id:au0002\`',
      '- [ ] **Written by Ana** [to:: Ana] \`created-by:ana@example.com\` \`id:au0003\`',
      '- [ ] **For Jerome** [to:: Jerome@Example.com] \`id:au0004\`',
      '- [ ] **Named, not addressed** [to:: Jérôme] \`id:au0006\`',
      '- [ ] **Named by first part** [to:: jerome] \`id:au0007\`',
      '- [ ] **From before sign-in** \`id:au0005\`',
      ''
    ].join('\\n'), 'todo.md', {});
    state.locked = true;
    state.view = 'board';
    renderView();
  })()`)

  check('names come from /activity.json',
    await until(async () => { await evalJS(`loadActivity()`); return evalJS(`state.authorNames['ana@example.com'] === 'Ana Silva'`) }))
  const cardText = title => evalJS(`(() => { const el = Array.from(document.querySelectorAll('.tenon-card')).find(c => c.textContent.includes(${JSON.stringify(title)})); return el ? el.textContent : ''; })()`)
  check('a card edited by somebody else says who', (await cardText('Shared')).includes('edited by Ana S.'), await cardText('Shared'))
  check('the byline is plain text in the card\'s top row, not a chip',
    await evalJS(`(() => { const el = Array.from(document.querySelectorAll('.tenon-card')).find(c => c.textContent.includes('Shared'));
      const b = el && el.querySelector('.tenon-card__eyebrow .byline'); return !!b && b.textContent === 'edited by Ana S.' && !!b.title && !el.querySelector('.tenon-card__tags .byline'); })()`))
  check('a card only its writer touched says who wrote it', (await cardText('Written by Ana')).includes('by Ana S.'))
  check('a card from before sign-in says nobody', !/\bby\b/.test(await cardText('From before sign-in')), await cardText('From before sign-in'))

  check('the status line names the latest change by somebody else',
    await until(() => evalJS(`/^Ana S\\. edited 2 min ago$/.test($('#status').textContent)`)),
    await evalJS(`$('#status').textContent`))

  const help = await evalJS(`(() => { try { openDrawer(findTaskByKey('au0001').id); } catch (e) { return 'threw ' + e.message; }
                                     return document.getElementById('drawer').textContent.replace(/\\s+/g, ' '); })()`)
  check('the task panel says who wrote it and who last changed it',
    help.includes('Created by Jérôme · last edited by Ana S.'), help.slice(0, 200))
  await evalJS(`closeDrawer()`)
  const sub = await evalJS(`(() => { openDrawer('au0002'); return $('#subHelp').textContent; })()`)
  check('so does the sub-task panel', sub.includes('Created by Ana S.'), sub)
  await evalJS(`closeDrawer()`)

  // The chip's words, without the initials in the face drawn before them.
  await evalJS(`window.chipWords = () => { const c = $('#mineChip').cloneNode(true);
    c.querySelectorAll('.chipface').forEach(f => f.remove()); return c.textContent.trim(); }`)
  check('Mine counts the tasks given to my email, sub-tasks included, and no task given to my name',
    await until(() => evalJS(`!!$('#mineChip') && chipWords() === '2 mine'`)),
    await evalJS(`$('#mineChip') ? chipWords() : 'no chip'`))
  await evalJS(`$('#mineChip').click()`)
  await new Promise(r => setTimeout(r, 300))
  const shown = await evalJS(`Array.from(document.querySelectorAll('#board .tenon-card')).map(c => c.textContent)`)
  check('and narrows the board to them',
    shown.length === 2 && shown.some(t => t.includes('Shared')) && shown.some(t => t.includes('For Jerome')),
    JSON.stringify(shown).slice(0, 300))
  await evalJS(`$('#mineChip').click()`)
  check('Mine is not offered on a board nobody signs in to',
    await evalJS(`(() => { state.who = null; renderFilterChips(); return !$('#mineChip') || $('#mineChip').closest('[hidden]') !== null || $('#mineChip').offsetParent === null; })()`))

  check('nothing tried to write', await evalJS(`window.__blocked.length === 0`), await evalJS(`window.__blocked.join(' | ')`))
} catch (err) {
  check('the suite ran to the end', false, String(err.message || err))
} finally {
  ws.close()
  chrome.kill()
}

const failed = checks.filter(p => !p).length
console.log(`\n${checks.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
