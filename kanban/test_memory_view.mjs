/**
 * Drives the Memory view in headless Chrome, against the throwaway server.
 *
 *   scripts/test-board.sh test_memory_view.mjs
 *
 * About and Team save for real (the server is the test runner's own, over a
 * temporary data folder), so the round trip is read back from /memory.json.
 * Context saves through PUT /context; a list still holding a `## Context`
 * section shows it until the first save, which moves it out of state.doc.
 * SHOT_DESKTOP and SHOT_PHONE name PNG files to leave screenshots in.
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { CHROME_BIN } from './test_browser.mjs'

const PORT = Number(process.env.CDP_PORT) || 9453
const BOARD = process.env.BOARD_PORT || 8765
if (!process.env.BOARD_PORT) { console.error('Run this through scripts/test-board.sh test_memory_view.mjs'); process.exit(2) }
const checks = []
const check = (name, pass, detail = '') => {
  checks.push(pass)
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const chrome = spawn(CHROME_BIN, [
  '--headless=new', '--mute-audio', `--remote-debugging-port=${PORT}`, '--no-first-run',
  `--user-data-dir=${process.env.CHROME_PROFILE || '/tmp/todo-memory-test-profile'}`, '--window-size=1400,1000',
  `http://127.0.0.1:${BOARD}/kanban/index.html#settings/memory`
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
const $q = sel => `document.querySelector(${JSON.stringify(sel)})`
const click = sel => evalJS(`${$q(sel)}.click()`)
async function shot (file, w, h, mobile) {
  if (!file) return
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile })
  await wait(400)
  const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  writeFileSync(file, Buffer.from(s.result.data, 'base64'))
  await send('Emulation.clearDeviceMetricsOverride', {})
}
const sections = `[...document.querySelectorAll('#memView .memsec')].map(s => s.dataset.mem).join(',')`

try {
  // Poll for the page rather than sleeping: a fixed wait fails when the machine is busy.
  for (let i = 0; i < 120 && !(await evalJS(`document.readyState === 'complete' && typeof state !== 'undefined' && !!state.doc`).catch(() => false)); i++) await new Promise(r => setTimeout(r, 250))
  await new Promise(r => setTimeout(r, 400))
  check('the board loaded on #settings/memory', await evalJS(`state.view === 'settings' && settingsTab === 'memory' && !!document.querySelector('#memView')`),
    await evalJS(`location.hash + ' / ' + state.view`))
  check('Memory is a tab of the Settings page, not of the top bar', await evalJS(`!viewDefs().some(d => d.id === 'memory') && settingsTabs().some(t => t[0] === 'memory')`))
  await wait(500)
  check('the sections are in order', await evalJS(sections) === 'about,people,context,profile,buckets', await evalJS(sections))
  check('an empty Company says so with an Edit button', await evalJS(`(() => {
    const s = document.querySelector('[data-mem=about]');
    return /No company description yet/.test(s.textContent) && !!s.querySelector('[data-mem-edit=about]');
  })()`))
  check('Team shows no table when empty, with Edit', await evalJS(`(() => {
    const s = document.querySelector('[data-mem=people]');
    return /No team yet/.test(s.textContent) && !!s.querySelector('[data-mem-edit=people]');
  })()`))
  check('every bucket has a block', await evalJS(`document.querySelectorAll('.membucket').length === memData.buckets.length && memData.buckets.length > 0`))
  check('Context renders the list\'s own section as text', await evalJS(`(() => {
    const s = document.querySelector('[data-mem=context] .memtext');
    return !!s && s.textContent.length > 20;
  })()`))
  check('Your profile has an Edit button', await evalJS(`!!document.querySelector('[data-mem=profile] [data-mem-edit=profile]')`))

  // --- The profile edits here and saves through PUT /profile-basics.json -------
  await click('[data-mem-edit=profile]')
  check('Edit opens the facts file and the four sections', await evalJS(
    `!!document.querySelector('[data-mem-profile-about=facts_file]') && ['setup', 'writing', 'recorder', 'habits'].every(k => !!document.querySelector('[data-mem-profile-section=' + k + ']'))`))
  await evalJS(`${$q('[data-mem-profile-section=writing]')}.value = '## Writing\\n- Spelling: British English'`)
  await click('[data-mem-save=profile]')
  check('a ## heading blocks the save with a message', await evalJS(`!!${$q('[data-mem=profile] .memerr')} && memEditing === 'profile'`))
  await evalJS(`${$q('[data-mem-profile-section=writing]')}.value = '- Spelling: British English'`)
  await evalJS(`${$q('[data-mem-profile-section=habits]')}.value = '- Deferring: logs ideas first'`)
  await evalJS(`${$q('[data-mem-profile-about=facts_file]')}.value = 'facts.md'`)
  await click('[data-mem-save=profile]')
  await wait(800)
  const prof = await evalJS(`fetch('/profile-basics.json').then(r => r.json())`)
  check('the sections and facts file are saved', /Spelling: British English/.test(prof.sections.writing) && /Deferring: logs ideas first/.test(prof.sections.habits)
    && prof.about.facts_file === 'facts.md', JSON.stringify(prof).slice(0, 300))
  check('and the view shows them', await evalJS(`/Deferring: logs ideas first/.test(${$q('[data-mem=profile]')}.textContent) && memEditing === null`))

  // --- Edit and Cancel; one section at a time ------------------------------
  await click('[data-mem-edit=about]')
  check('Edit swaps Company for a form', await evalJS(`!!${$q('[data-mem-about]')} && !!${$q('[data-mem-save=about]')} && !!${$q('[data-mem=about] [data-mem-cancel]')}`))
  check('while one form is open the other Edit buttons are disabled', await evalJS(`[...document.querySelectorAll('[data-mem-edit]')].every(b => b.disabled)`))
  await click('[data-mem=about] [data-mem-cancel]')
  await click('[data-mem-edit=people]')
  check('opening another section after Cancel works', await evalJS(`!${$q('[data-mem-about]')} && !!${$q('[data-mem=people] [data-mem-add]')}`))
  await click('[data-mem=people] [data-mem-cancel]')
  check('Cancel puts the text back', await evalJS(`!${$q('[data-mem=people] input')} && !!${$q('[data-mem-edit=people]')}`))

  // --- Company round trip ---------------------------------------------------
  await click('[data-mem-edit=about]')
  await evalJS(`${$q('[data-mem-about]')}.value = 'We make **small** tools.\\n\\n- one\\n- two'`)
  await click('[data-mem-save=about]')
  await wait(600)
  const about = await evalJS(`fetch('/memory.json').then(r => r.json()).then(j => j.about.text)`)
  check('Company saves through PUT /about', /We make \*\*small\*\* tools/.test(about), JSON.stringify(about))
  check('and reads back as rendered text', await evalJS(`(() => {
    const s = document.querySelector('[data-mem=about] .memtext');
    return !!s && !!s.querySelector('strong') && s.querySelectorAll('li').length === 2 && !document.querySelector('[data-mem-about]');
  })()`))

  // --- Team round trip ------------------------------------------------------
  await click('[data-mem-edit=people]')
  await click('[data-mem-add]')
  await evalJS(`(() => {
    const row = document.querySelector('[data-mem-row="0"]');
    const set = (k, v) => { row.querySelector('[data-mem-person=' + k + ']').value = v; };
    set('name', 'Ada L.'); set('role', 'Engineer'); set('team', 'Platform'); set('reports_to', 'Grace H.'); set('notes', 'Part time');
  })()`)
  await click('[data-mem=people] [data-mem-save=people]')
  await wait(600)
  const people = await evalJS(`fetch('/memory.json').then(r => r.json()).then(j => j.people)`)
  check('Team saves through PUT /people', people.length === 1 && people[0].name === 'Ada L.' && people[0].reports_to === 'Grace H.', JSON.stringify(people))
  check('and reads as a table', await evalJS(`(() => {
    const t = document.querySelector('[data-mem=people] table');
    return !!t && /Reports to/.test(t.tHead.textContent) && /Ada L\\./.test(t.tBodies[0].textContent) && /Part time/.test(t.tBodies[0].textContent);
  })()`))
  await click('[data-mem-edit=people]')
  await click('[data-mem-remove="0"]')
  check('Remove drops the row', await evalJS(`!document.querySelector('[data-mem-row]')`))
  await click('[data-mem=people] [data-mem-cancel]')

  // --- A bucket brief goes through the section form -------------------------
  const first = await evalJS(`memData.buckets[0].heading`)
  await click(`.membucket[data-mem-bucket=${JSON.stringify(first)}] [data-mem-edit]`)
  check('a bucket opens the brief form', await evalJS(`document.querySelectorAll('[data-brief-section]').length === BRIEF_SECTIONS.length && !!${$q('[data-mem-brief-summary]')}`))
  await evalJS(`document.querySelector('[data-mem-brief-summary]').value = 'From the Memory page.'`)
  await click('[data-mem-bucket] [data-mem-save]')
  await wait(800)
  const brief = await evalJS(`fetch('/memory.json').then(r => r.json()).then(j => j.buckets[0])`)
  check('and saves it through PUT /bucket-brief', /From the Memory page\./.test(brief.text) && brief.exists, JSON.stringify(brief).slice(0, 200))

  // --- Context: the old section shows, the first save moves it to context.md ---
  check('Context starts from the todo.md section when there is no context.md',
    await evalJS(`memData.context.exists === false && /./.test(memContextText()) && !!memContextSpan()`))
  await click('[data-mem-edit=context]')
  check('Context opens a form holding its own text', await evalJS(`${$q('[data-mem-context]')}.value === memContextText()`))
  await evalJS(`${$q('[data-mem-context]')}.value = 'Ana is away until Friday.'`)
  await click('[data-mem-save=context]')
  await wait(600)
  const after = await evalJS(`serializeDoc(state.doc)`)
  const saved = await evalJS(`getJSON('/context.json')`)
  check('Save writes context.md through the route', saved.exists && saved.text === 'Ana is away until Friday.', JSON.stringify(saved))
  check('and removes the section from the document', !/## Context/.test(after) && await evalJS(`memContextSpan() === null`))
  check('marks the document unsaved for the normal autosave', await evalJS(`state.dirty === true || $('#status').textContent !== 'unsaved changes' `))
  check('and the view shows the new text', await evalJS(`/Ana is away until Friday/.test(${$q('[data-mem=context]')}.textContent)`))
  check('the document keeps its buckets', after.includes('## 1. People') && after.includes('## 4. Strategic'))
  await evalJS(`memLoad()`)
  await wait(600)
  check('a reload reads it back from context.md', await evalJS(`/Ana is away until Friday/.test(${$q('[data-mem=context]')}.textContent)`))

  // The first Context save drops the old section and nothing else: with the
  // section ahead of the first bucket, the blank line before that heading stays.
  const keptBlank = await evalJS(`(() => {
    const keep = state.doc, text = '# Title\\n\\nIntro.\\n\\n## Context\\n\\nAna is away.\\n\\n## 1. Tasks\\n\\n### To do\\n\\n- [ ] One\\n';
    state.doc = parseDoc(text);
    memRemoveContextSection();
    const out = serializeDoc(state.doc);
    state.doc = keep;
    return out === '# Title\\n\\nIntro.\\n\\n## 1. Tasks\\n\\n### To do\\n\\n- [ ] One\\n' ? 'ok' : out;
  })()`)
  check('a Context save leaves the blank line before the first bucket', keptBlank === 'ok', JSON.stringify(keptBlank))

  // --- panels, no index ----------------------------------------------------
  await evalJS(`state.locked = true; renderMemoryView()`)
  await wait(800)
  check('there is no floating index', await evalJS(`!document.querySelector('.memindex') && !document.querySelector('nav[aria-label="On this page"]')`))
  check('every section is a panel in the Overview\'s column markup', await evalJS(`[...document.querySelectorAll('#memView .memsec')].every(s => s.classList.contains('tenon-column') && !!s.querySelector('.tenon-column__title') && !!s.querySelector('.tenon-column__body'))`))
  check('the five panels sit in one left-aligned stack', await evalJS(`(() => {
    const host = document.querySelector('#memView'), r = host.getBoundingClientRect();
    const mid = document.querySelector('#lists').getBoundingClientRect();
    return host.classList.contains('pview') && Math.abs(r.left - mid.left) < 2
  })()`))
  check('Buckets is one panel holding every brief', await evalJS(`document.querySelectorAll('#memView [data-mem=buckets] .membucket').length === memData.buckets.length && document.querySelectorAll('#memView [data-mem=buckets]').length === 1`))
  // an empty subsection under a brief or in the profile says so, in the style of "No brief yet."
  await evalJS(`(() => {
    memData.buckets = [{ heading: 'Foo', name: 'Foo', exists: true, filled: true,
      text: '# Foo\\n\\nWhat lands here.\\n\\n## The processes I run in this bucket\\n\\n> hint only\\n\\n## Who is involved\\n\\n## What good looks like\\n\\nShips on time.' }];
    memData.profile = { name: 'Sam', about: {}, sections: { setup: '', writing: '- British English', recorder: '', habits: '' }, hints: {} };
    memDraw();
  })()`)
  const heads = `[...document.querySelectorAll('#memView [data-mem=buckets] .memtext h4')].map(h => h.textContent + (h.nextElementSibling && h.nextElementSibling.classList.contains('memempty') ? ':empty' : '')).join('|')`
  const headText = await evalJS(heads)
  check('a brief heading with nothing under it shows an empty line', /The processes I run in this bucket:empty/.test(headText) && /Who is involved:empty/.test(headText) && !/What good looks like:empty/.test(headText), headText)
  check('profile sections with nothing in them show an empty line', await evalJS(`(() => {
    const hs = [...document.querySelectorAll('#memView [data-mem=profile] h4[data-mem-sub]')];
    const empty = h => h.nextElementSibling && h.nextElementSibling.classList.contains('memempty');
    return hs.length === 4 && hs.map(h => empty(h)).join() === 'true,false,true,true'
  })()`))
  await evalJS(`state.locked = false; memEditing = 'about'; memDraw()`)
  check('an open edit form still opens', await evalJS(`!!document.querySelector('#memView [data-mem=about] textarea')`))
  await evalJS(`memEditing = null; memLoad()`)
  await wait(600)

  // two bucket headings that slug the same
  await evalJS(`memData.buckets = [
    { heading: 'Foo Bar', name: 'Foo Bar', exists: true, filled: true, text: '# Foo Bar\\n\\nOne.' },
    { heading: 'foo-bar', name: 'foo-bar', exists: true, filled: true, text: '# foo-bar\\n\\nTwo.' }
  ]; memDraw()`)
  check('buckets that slug alike get distinct ids', await evalJS(`(() => { const ids = [...document.querySelectorAll('.membucket')].map(a => a.id); return ids.length === 2 && ids[0] !== ids[1] })()`),
    await evalJS(`[...document.querySelectorAll('.membucket')].map(a => a.id).join(',')`))
  await evalJS(`memLoad()`)
  await wait(600)

  // each section says what it is for, filled or empty
  const descs = `[...document.querySelectorAll('#memView .memsec')].map(s => s.dataset.mem + '=' + (s.querySelector(':scope > .tenon-column__body > .memdesc') || {}).textContent).join('|')`
  const wantDescs = {
    about: 'What this business does, in a few lines every agent reads first.',
    people: 'Who is who: role, team, who reports to whom, and the names that get confused.',
    buckets: 'One per bucket: what kind of work lands there and how it should be handled.',
    context: "What changes week to week: who is on leave, dates that can't move, and what is currently live with someone that you'd get wrong from their role alone.",
    profile: 'Facts about you that agents work from: how you work, write and want things done.'
  }
  const wantStr = ['about', 'people', 'context', 'profile', 'buckets'].map(k => k + '=' + wantDescs[k]).join('|')
  check('each section shows its description', await evalJS(descs) === wantStr, await evalJS(descs))

  // every section empty: each still renders, with a placeholder
  await evalJS(`(() => {
    memData.about = { text: '' }; memData.people = []; memData.buckets = []; memData.profile = {};
    memData.context = { text: '', exists: false };
    const span = memContextSpan(); if (span) span.arr.splice(span.at, span.end - span.at);
    memDraw();
  })()`)
  check('with everything empty every section still renders', await evalJS(sections) === 'about,people,context,profile,buckets', await evalJS(sections))
  check('empty sections keep their description', await evalJS(descs) === wantStr)
  check('each carries a placeholder', await evalJS(`[...document.querySelectorAll('#memView .memsec')].every(s => s.querySelector('.memempty'))`))
  check('Edit still works from an empty section', await evalJS(`!!document.querySelector('[data-mem=about] [data-mem-edit=about]') && !!document.querySelector('[data-mem=people] [data-mem-edit=people]')`))
  await evalJS(`memLoad()`)
  await wait(600)
  await evalJS(`state.view = 'board'; renderView()`)
  await wait(600)
  await evalJS(`openSettingsPage('memory')`)
  await wait(500)

  await shot(process.env.SHOT_DESKTOP, 1200, 1000, false)
  await shot(process.env.SHOT_PHONE, 390, 800, true)

  // --- a locked tab shows Context read-only --------------------------------
  await evalJS(`state.locked = true; renderMemoryView()`)
  await wait(600)
  check('a locked tab has no Edit on Context', await evalJS(`!${$q('[data-mem=context] [data-mem-edit]')} && /read-only/.test(${$q('[data-mem=context]')}.textContent)`))
  check('a locked tab has no Edit on Company, Team or any brief', await evalJS(`document.querySelectorAll('#memView [data-mem-edit]').length === 0`))
  check('and each says the tab is read-only', await evalJS(`['about', 'people', 'buckets'].every(k => /read-only/.test(document.querySelector('[data-mem=' + k + ']').textContent))`))
  await evalJS(`window.__puts = []; window.__put = putJSON; putJSON = (u, d) => { window.__puts.push(u); return window.__put(u, d) }`)
  await evalJS(`memStartEdit('about'); memStartEdit('people'); memStartEdit('bucket:' + memData.buckets[0].heading)`)
  check('a locked tab opens no form', await evalJS(`!document.querySelector('#memView textarea.memarea[data-mem-about]') && !document.querySelector('[data-mem-save]') && memEditing === null`))
  await evalJS(`memEditing = 'about'; memSave('about'); memSave('people'); memSave('context')`)
  await wait(400)
  check('and sends no PUT', await evalJS(`window.__puts.length === 0`), await evalJS(`JSON.stringify(window.__puts)`))
  await evalJS(`putJSON = window.__put; memEditing = null`)
  await evalJS(`state.locked = false`)

  // --- an open form keeps what was typed through a redraw -------------------
  await evalJS(`renderMemoryView()`)
  await wait(600)
  await click('[data-mem-edit=about]')
  await evalJS(`(() => { const b = ${$q('[data-mem-about]')}; b.value = 'typed, not saved'; b.focus(); b.setSelectionRange(3, 5) })()`)
  await evalJS(`renderMemoryView()`)
  await wait(600)
  check('a re-render keeps the Company form open with the typed text', await evalJS(`!!${$q('[data-mem-about]')} && ${$q('[data-mem-about]')}.value === 'typed, not saved'`))
  check('and the cursor where it was', await evalJS(`document.activeElement === ${$q('[data-mem-about]')} && document.activeElement.selectionStart === 3 && document.activeElement.selectionEnd === 5`))
  await evalJS(`memLoad()`)
  await wait(600)
  check('a late memory answer keeps it too', await evalJS(`${$q('[data-mem-about]')}.value === 'typed, not saved'`))
  await click('[data-mem=about] [data-mem-cancel]')
  await click('[data-mem-edit=people]')
  await click('[data-mem-add]')
  await evalJS(`document.querySelector('[data-mem-person=name]').value = 'Typed P.'`)
  await evalJS(`renderMemoryView()`)
  await wait(600)
  check('a Team form keeps its typed row', await evalJS(`document.querySelector('[data-mem-person=name]') && document.querySelector('[data-mem-person=name]').value === 'Typed P.'`))
  await click('[data-mem=people] [data-mem-cancel]')
  await evalJS(`state.view = 'board'; renderView()`)
  await wait(400)
  await evalJS(`openSettingsPage('memory')`)
  await wait(500)
  check('leaving and coming back starts with no form open', await evalJS(`memEditing === null && !document.querySelector('[data-mem-save]')`))

  // --- the hash survives a view switch -------------------------------------
  await evalJS(`state.view = 'board'; syncHash(true); renderView()`)
  check('leaving the view leaves the board', await evalJS(`(() => { const m = document.querySelector('#memView'); return !m || m.offsetParent === null })()`))
  await evalJS(`openSettingsPage('memory')`)
  check('and the hash names it again', await evalJS(`location.hash.startsWith('#settings/memory')`))
  await evalJS(`history.replaceState(null, '', '#memory'); window.dispatchEvent(new HashChangeEvent('hashchange'))`)
  await wait(500)
  check('an old #memory link opens the Memory tab', await evalJS(`state.view === 'settings' && settingsTab === 'memory'`))
} finally {
  chrome.kill()
}

const failed = checks.filter(c => !c).length
console.log(`\n${checks.length - failed} passed${failed ? `, ${failed} failed` : ''}\n`)
process.exit(failed ? 1 : 0)
