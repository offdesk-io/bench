/**
 * The focus prompt (FocusPrompt.tsx, kanban/js/10a-focus-prompt.js): the
 * floating prompt to the PA that a hold on a card, a sub-task or a drawer
 * section brings up, driven in headless Chrome.
 *
 *   scripts/test-board.sh test_focus_prompt.mjs
 *
 * No Claude is called. Every non-GET is torn out of `fetch` and recorded, the
 * way test_chats.mjs does it, and a POST to /claude answers with a stream this
 * file writes into line by line, so each state of the prompt can be looked at
 * while it lasts. The tab is unlocked, because a locked tab shows no prompt,
 * and nothing can reach disk: saveFile is stubbed and the fetch guard holds
 * every write.
 */

import { spawn } from 'node:child_process'
import { CHROME_BIN } from './test_browser.mjs'

const PORT = Number(process.env.CDP_PORT) || 9471
const BOARD = process.env.BOARD_PORT || 8765
if (!process.env.BOARD_PORT) console.error('Note: this runs against the live board on 8765. For a throwaway copy: scripts/test-board.sh test_focus_prompt.mjs')
const checks = []
const check = (name, pass, detail = '') => {
  checks.push(pass)
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const chrome = spawn(CHROME_BIN, [
  '--headless=new', '--mute-audio', `--remote-debugging-port=${PORT}`, '--no-first-run',
  `--user-data-dir=${process.env.CHROME_PROFILE || '/tmp/todo-focus-prompt-test-profile'}`, '--window-size=1500,1000',
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
const until = async (expr, ms = 3000) => {
  for (let t = 0; t < ms; t += 50) { if (await evalJS(expr)) return true; await wait(50) }
  return false
}
const key = async (k, o = {}) => {
  const base = { key: k, code: k, windowsVirtualKeyCode: k === 'Enter' ? 13 : k === 'Escape' ? 27 : 0, modifiers: o.shift ? 8 : 0 }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(k === 'Enter' ? { text: '\r' } : {}) })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}
const type = text => send('Input.insertText', { text })

// Poll for the page rather than sleeping: a fixed wait fails when the machine is busy.
for (let i = 0; i < 120 && !(await evalJS(`document.readyState === 'complete' && typeof state !== 'undefined' && !!state.doc`).catch(() => false)); i++) await new Promise(r => setTimeout(r, 250))
await new Promise(r => setTimeout(r, 400))
check('the board loaded', await evalJS(`typeof renderBoard === 'function' && typeof BoardUI.FocusPrompt === 'function'`))

/* ---- nothing docked ---- */
check('no PA bar or docked bar exists on load', await evalJS(`
  !document.querySelector('.aic-docked, .aic-pinned, .aic-minimised, .aic-anchored, [data-ai-chat]') &&
  typeof ensurePaBar === 'undefined' && typeof openPaChat === 'undefined'`))

await evalJS(`(() => {
  const real = window.fetch;
  window.__blocked = [];
  window.__runs = [];
  /* A POST to /claude is a run: its stream stays open until the test ends it,
     so Working can be looked at. Anything else that writes is recorded and
     answered with an empty body. */
  window.fetch = (u, o) => {
    const m = (o && o.method) || 'GET';
    if (m === 'POST' && String(u) === '/claude') {
      const run = { body: JSON.parse(o.body), lines: [] };
      if (window.__failNext) { window.__failNext = false; window.__runs.push(run);
        return Promise.resolve(new Response(JSON.stringify({ error: 'The helper is not running' }), { status: 500 })); }
      const enc = new TextEncoder();
      const stream = new ReadableStream({ start(c) { run.c = c; } });
      run.push = line => run.c.enqueue(enc.encode(JSON.stringify(line) + '\\n'));
      run.end = () => run.c.close();
      window.__runs.push(run);
      return Promise.resolve(new Response(stream, { status: 200 }));
    }
    if (m !== 'GET') { window.__blocked.push(m + ' ' + u); return Promise.resolve(new Response('{}', { status: 200 })); }
    return real(u, o);
  };
  window.__ptr = (type, el, x, y) => (type === 'pointerdown' ? el : window).dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerType: 'mouse', button: 0, clientX: x, clientY: y }));
  window.__mid = el => { const r = el.getBoundingClientRect(); return [r.x + Math.min(20, r.width / 2), r.y + Math.min(12, r.height / 2)] };
  window.__eff = el => { let o = 1; for (; el; el = el.parentElement) o *= +getComputedStyle(el).opacity; return o };
  state.view = 'board';
  load([
    '# To-do', '', '## 1. People', '',
    '### To do', '',
    '- [ ] Alpha \`id:bd0001\` [impact:: high] [effort:: S]',
    '  - A note on Alpha.',
    '  - [ ] first step',
    '  - [ ] second step',
    '- [ ] Beta \`id:bd0002\` [impact:: low] [effort:: L]',
    '- [ ] Gamma \`id:bd0003\` [impact:: med] [effort:: M]',
    '',
    '### Doing', '',
    ''
  ].join('\\n'), 'demo.md', {});
  state.locked = false;
  const ids = { Alpha: 'bd0001', Beta: 'bd0002', Gamma: 'bd0003' };
  state.doc.buckets.forEach(b => b.tiers.forEach(t => t.tasks.forEach(k => { if (ids[k.title]) k.id = ids[k.title]; })));
  /* The test server may have no Claude CLI behind it: the board is told there
     is one. Nothing is saved: saveFile is a no-op and the file never moves. */
  chat.available = () => true;
  saveFile = async () => { state.dirty = false; };
  diskVersion = async () => ({ stamp: '', hash: '' });
  renderView();
})()`)

const card = idx => `document.querySelector('#board .tenon-card[data-id="${idx}"]')`
const holdOn = async sel => {
  await evalJS(`(() => { const el = ${sel}; window.__pt = __mid(el); __ptr('pointerdown', el, ...__pt); })()`)
  await wait(800)
  await evalJS(`__ptr('pointerup', null, ...__pt)`)
  await wait(100)
}
const P = `document.querySelector('#focusPrompt .focus-prompt')`
const chipText = () => evalJS(`(${P} && ${P}.querySelector('.focus-prompt__chiptext').textContent) || ''`)

/* ---- a card ---- */
await holdOn(card('bd0002'))
check('holding a card brings the prompt up', await until(`!!${P} && !!${P}.querySelector('textarea')`))
check('  its chip names the task', await chipText() === 'Task: "Beta"', await chipText())
check('  the box has keyboard focus and a suggestion for a task', await until(
  `document.activeElement === ${P}.querySelector('textarea') && ${P}.querySelector('textarea').placeholder === 'Move to Doing'`))
check('  it floats 300px wide at the bottom centre, 36px up', await evalJS(`(() => {
  const r = ${P}.getBoundingClientRect();
  return Math.abs(r.width - 300) < 1 && Math.abs(innerHeight - r.bottom - 36) < 1.5 && Math.abs(r.left + r.width / 2 - innerWidth / 2) < 1.5;
})()`), await evalJS(`JSON.stringify(${P}.getBoundingClientRect())`))
check('  it is not dimmed with the rest of the page, and takes the pointer', await evalJS(
  `__eff(${P}) === 1 && getComputedStyle(${P}.querySelector('textarea')).pointerEvents === 'auto' && document.body.classList.contains('spotlit')`))
check('  and it is at least 104px tall', await evalJS(`${P}.getBoundingClientRect().height >= 103`),
  await evalJS(`${P}.getBoundingClientRect().height`))
await evalJS(`(() => { const t = ${P}.querySelector('textarea'); __ptr('pointerdown', t, ...__mid(t)); __ptr('pointerup', null, ...__mid(t)); })()`)
check('a press inside the prompt keeps the focus', await evalJS(`${card('bd0002')}.classList.contains('is-held') && !!${P}`))

await key('Escape')
check('Esc in the box ends the focus and closes the prompt', await until(`!${P} && !${card('bd0002')}.classList.contains('is-held')`))
check('  and holding then Esc without sending leaves no session behind', await evalJS(`__runs.length === 0`))

/* ---- a sub-task and a section, in the drawer ---- */
await evalJS(`openDrawer('bd0001')`)
await wait(200)
await holdOn(`document.querySelector('#f-subs .sub .subtext')`)
check('holding a sub-task names it on the chip', await until(`${P} && ${P}.querySelector('.focus-prompt__chiptext').textContent === 'Subtask: "first step"'`), await chipText())
check('  with a suggestion for a sub-task', await evalJS(`${P}.querySelector('textarea').placeholder === 'Start the draft'`))
await key('Escape')
await until(`!${P}`)
await holdOn(`document.querySelector('#dbody .dcol > details[data-collapse="details"] > summary')`)
check('holding a section names the section and its task', await until(`${P} && ${P}.querySelector('.focus-prompt__chiptext').textContent === 'Details: "Alpha"'`), await chipText())
check('  with a suggestion for a section', await evalJS(`${P}.querySelector('textarea').placeholder === 'Add context'`))
await key('Escape')
await until(`!${P}`)
await evalJS(`closeDrawer()`)
await wait(200)

/* ---- sending ---- */
await holdOn(card('bd0002'))
await until(`document.activeElement === ${P}.querySelector('textarea')`)
await key('Enter')
check('Enter on an empty box sends nothing', await evalJS(`__runs.length === 0 && !!${P}.querySelector('textarea')`))
await type('Move it')
await key('Enter', { shift: true })
await type('to Doing please')
check('Shift+Enter is a newline and sends nothing', await evalJS(
  `__runs.length === 0 && ${P}.querySelector('textarea').value === 'Move it\\nto Doing please'`), await evalJS(`JSON.stringify(${P}.querySelector('textarea').value)`))
check('  and the box grows with what is in it', await evalJS(`${P}.querySelector('textarea').getBoundingClientRect().height >= 78`))
await key('Enter')
check('Enter sends', await until(`__runs.length === 1`))
const sent = await evalJS(`__runs[0].body`)
check('  to the PA, under the board’s PA key, as a new session', sent.owner === 'board-pa' && sent.session === '' && sent.mode === 'ask', JSON.stringify({ owner: sent.owner, session: sent.session, mode: sent.mode }))
check('  carrying the held element ahead of the owner’s words',
  sent.prompt.startsWith('/pa (Focused element: task bd0002 "Beta". Its current content: - [ ] Beta') &&
  sent.prompt.includes('.)\n\nMove it\nto Doing please'), sent.prompt.slice(0, 160))
check('  with the preface asking for the doing: and done: lines', sent.prompt.includes('"doing:') && sent.prompt.includes('"done:'))
check('Working replaces the box, and the chip stays', await until(
  `!${P}.querySelector('textarea') && ${P}.querySelector('.focus-prompt__status--working .focus-prompt__line').textContent === 'Working on it…' && !!${P}.querySelector('.focus-prompt__chip')`))
check('  with the PA’s name and the time', await evalJS(
  `/^PA Agent \\d{1,2}:\\d{2} (AM|PM)$/.test(${P}.querySelector('.focus-prompt__who').textContent)`), await evalJS(`${P}.querySelector('.focus-prompt__who').textContent`))
await evalJS(`__runs[0].push({ type: 'system', subtype: 'init', session_id: 'aaaaaaaa-0000-0000-0000-000000000001' });
  __runs[0].push({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'doing: Moving Beta into Doing' }] } })`)
check('Working shows the doing: line as soon as it arrives', await until(
  `${P}.querySelector('.focus-prompt__line').textContent === 'Moving Beta into Doing…'`), await evalJS(`${P}.querySelector('.focus-prompt__line').textContent`))
check('  in orange', await evalJS(`getComputedStyle(${P}.querySelector('.focus-prompt__line')).color === 'rgb(240, 133, 90)'`))
await evalJS(`(() => {
  const fence = String.fromCharCode(96).repeat(3);
  const text = 'Moved it.\\ndone: Moved Beta to Doing\\n' + fence + 'pa-changes\\n' + JSON.stringify([{ kind: 'note', task: 'bd0002', text: 'Moved on request.' }]) + '\\n' + fence;
  __runs[0].push({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text }] } });
  __runs[0].push({ type: 'result', result: 'doing: Moving Beta into Doing\\n\\n' + text, session_id: 'aaaaaaaa-0000-0000-0000-000000000001' });
  __runs[0].end();
})()`)
check('Done shows the done: line', await until(`${P}.querySelector('.focus-prompt__status--done .focus-prompt__line') &&
  ${P}.querySelector('.focus-prompt__line').textContent === 'Moved Beta to Doing'`), await evalJS(`${P} && ${P}.querySelector('.focus-prompt__line').textContent`))
check('  green, with a check in the avatar', await evalJS(`(() => {
  const s = ${P}.querySelector('.focus-prompt__status');
  return getComputedStyle(s).backgroundColor === 'rgb(4, 41, 19)' &&
    getComputedStyle(${P}.querySelector('.focus-prompt__who')).color === 'rgb(103, 182, 128)' &&
    !!s.querySelector('.focus-prompt__avatar path[stroke]');
})()`))
check('the pa-changes block was applied', await evalJS(`state.doc.buckets[0].tiers.flatMap(t => t.tasks).find(t => t.title === 'Beta').body.some(l => l.includes('Moved on request.'))`))
check('  and the card it changed has a green outline', await until(`${card('bd0002')} && ${card('bd0002')}.getAttribute('data-pa-changed') !== null &&
  getComputedStyle(${card('bd0002')}).outlineColor === 'rgb(83, 169, 112)'`))
check('the focus is still on', await evalJS(`${card('bd0002')}.classList.contains('is-held')`))
await wait(4500)
check('after 4s the card and the outline fade, and the prompt is back to Idle for the next message', await until(
  `!!${P} && !!${P}.querySelector('textarea') && !document.querySelector('[data-pa-changed]')`), await evalJS(`${P} ? ${P}.innerHTML.slice(0, 200) : 'gone'`))

/* ---- a second message carries the same session on ---- */
await until(`document.activeElement === ${P}.querySelector('textarea')`)
await type('And date it')
await key('Enter')
await until(`__runs.length === 2`)
const second = await evalJS(`__runs[1].body`)
check('a second message in the same focus carries the same session on', second.session === 'aaaaaaaa-0000-0000-0000-000000000001' &&
  second.prompt.startsWith('(Focused element: task bd0002') && !second.prompt.startsWith('/pa') && second.prompt.includes('As before'), JSON.stringify(second).slice(0, 200))
await evalJS(`__runs[1].push({ type: 'result', result: 'Nothing to do.' }); __runs[1].end()`)
check('  a reply with no done: line says Done', await until(`${P}.querySelector('.focus-prompt__line') && ${P}.querySelector('.focus-prompt__line').textContent === 'Done'`))
await evalJS(`__ptr('pointerdown', document.body, 5, 5); __ptr('pointerup', null, 5, 5)`)
check('  a press outside during Done keeps the prompt until it fades', await evalJS(`!${card('bd0002')}.classList.contains('is-held') && !!${P}`))
check('  and then it goes', await until(`!${P}`, 5500))

/* ---- the focus ends while the PA is still working ---- */
await holdOn(card('bd0003'))
await until(`document.activeElement === ${P}.querySelector('textarea')`)
await type('Anything?')
await key('Enter')
await until(`__runs.length === 3`)
check('a new focus starts a fresh session', await evalJS(`__runs[2].body.session === '' && __runs[2].body.prompt.includes('task bd0003 "Gamma"')`))
await evalJS(`__ptr('pointerdown', document.body, 5, 5); __ptr('pointerup', null, 5, 5)`)
await wait(400)
check('the focus ended mid-run, and the prompt stays, still Working', await evalJS(
  `!${card('bd0003')}.classList.contains('is-held') && !!${P} && !!${P}.querySelector('.focus-prompt__status--working') && ${P}.querySelector('.focus-prompt__chiptext').textContent === 'Task: "Gamma"'`))
await evalJS(`__runs[2].push({ type: 'assistant', message: { id: 'g1', content: [{ type: 'text', text: 'doing: Looking at Gamma\\nAll fine.\\ndone: Looked at Gamma' }] } });
  __runs[2].push({ type: 'result', result: 'doing: Looking at Gamma\\nAll fine.\\ndone: Looked at Gamma' }); __runs[2].end()`)
check('  then shows Done', await until(`${P} && ${P}.querySelector('.focus-prompt__status--done') && ${P}.querySelector('.focus-prompt__line').textContent === 'Looked at Gamma'`))
check('  and fades once Done has shown for 4s', await until(`!${P}`, 5500))

/* ---- a run that fails ---- */
await holdOn(card('bd0003'))
await until(`document.activeElement === ${P}.querySelector('textarea')`)
await evalJS(`window.__failNext = true`)
await type('Try')
await key('Enter')
check('a failed run shows its error in muted red', await until(`${P} && ${P}.querySelector('.focus-prompt__status--error') &&
  ${P}.querySelector('.focus-prompt__line').textContent === 'The helper is not running' &&
  getComputedStyle(${P}.querySelector('.focus-prompt__line')).color === 'rgb(217, 139, 134)'`))
check('  and goes back to Idle', await until(`${P} && !!${P}.querySelector('textarea')`, 5500))
await key('Escape')
await until(`!${P}`)

/* ---- a change that redraws the drawer under a held sub-task ---- */
await evalJS(`openDrawer('bd0001')`)
await wait(200)
await holdOn(`document.querySelectorAll('#f-subs .sub .subtext')[1]`)
await until(`${P} && document.activeElement === ${P}.querySelector('textarea')`)
await type('Split this')
await key('Enter')
await until(`__runs.length === 5`)
check('a sub-task’s reference names it, its place and its task', await evalJS(
  `__runs[4].body.prompt.startsWith('/pa (Focused element: subtask 2 of task bd0001 "Alpha": "second step". Its current content: - [ ] second step')`),
  await evalJS(`__runs[4].body.prompt.slice(0, 140)`))
await evalJS(`(() => {
  const fence = String.fromCharCode(96).repeat(3);
  const text = 'doing: Splitting the step\\ndone: Added 1 new subtask\\n' + fence + 'pa-changes\\n' +
    JSON.stringify([{ kind: 'step', action: 'add', task: 'bd0001', text: 'third step' }]) + '\\n' + fence;
  __runs[4].push({ type: 'result', result: text }); __runs[4].end();
})()`)
check('the drawer is redrawn, the focus with it, and the prompt survives to show Done', await until(
  `${P} && ${P}.querySelector('.focus-prompt__status--done') && ${P}.querySelector('.focus-prompt__line').textContent === 'Added 1 new subtask' &&
   BoardUI.focusedElement() === null && !document.body.classList.contains('spotlit')`))
check('  the new sub-task row, found again after the redraw, is outlined green', await evalJS(`(() => {
  const rows = [...document.querySelectorAll('#f-subs .sub')];
  const row = rows.find(r => r.textContent.includes('third step'));
  return rows.length === 3 && !!row && row.hasAttribute('data-pa-changed') && !rows[0].hasAttribute('data-pa-changed');
})()`))
check('  and so is its card', await evalJS(`${card('bd0001')}.hasAttribute('data-pa-changed')`))
check('  then the prompt and the outlines go', await until(`!${P} && !document.querySelector('[data-pa-changed]')`, 5500))
await evalJS(`closeDrawer()`)
await wait(200)

/* ---- locked ---- */
await evalJS(`state.locked = true`)
await holdOn(card('bd0001'))
check('a locked tab shows no prompt, and the hold still works', await evalJS(`!${P} && ${card('bd0001')}.classList.contains('is-held')`))
await key('Escape')
await evalJS(`state.locked = false; chat.available = () => false`)
await holdOn(card('bd0001'))
check('nor does a board with no chat engine', await evalJS(`!${P} && ${card('bd0001')}.classList.contains('is-held')`))
await key('Escape')

check('nothing reached disk', await evalJS(`window.__blocked.every(b => /^(PUT|HEAD) \\/data\\/todo\\.md|^POST \\/chat-viewed/.test(b))`), await evalJS(`window.__blocked.join(' | ')`))

ws.close()
chrome.kill()
const failed = checks.filter(c => !c).length
console.log(failed ? `\n${failed} failed` : `\nall ${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
