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
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  `--user-data-dir=${process.env.CHROME_PROFILE || '/tmp/todo-memory-test-profile'}`, '--window-size=1400,1000',
  `http://127.0.0.1:${BOARD}/kanban/index.html#memory`
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
  await wait(2500)
  check('the board loaded on #memory', await evalJS(`state.view === 'memory' && !!document.querySelector('#memView')`),
    await evalJS(`location.hash + ' / ' + state.view`))
  check('Memory is a tab', await evalJS(`viewDefs().some(d => d.id === 'memory')`))
  await wait(500)
  check('the sections are in order', await evalJS(sections) === 'about,people,buckets,context,profile', await evalJS(sections))
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
  check('Your profile is read-only with a link to Settings', await evalJS(`(() => {
    const s = document.querySelector('[data-mem=profile]');
    return !!s.querySelector('[data-mem-profile]') && !s.querySelector('textarea, input');
  })()`))

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

  // --- the index -----------------------------------------------------------
  await evalJS(`state.locked = true; renderMemoryView()`)
  await wait(800)
  const want = `document.querySelectorAll('#memView .memsec').length + document.querySelectorAll('#memView .membucket[id], #memView h4[data-mem-sub]').length`
  const links = `document.querySelectorAll('nav[aria-label="On this page"] a[data-mem-jump]').length`
  check('the index is a nav named "On this page"', await evalJS(`!!document.querySelector('#memView > nav[aria-label="On this page"]')`))
  check('the index has one link per section and subsection', await evalJS(links) === await evalJS(want) && await evalJS(links) >= 5,
    `${await evalJS(links)} links, ${await evalJS(want)} targets`)
  check('every link points at an element with that id', await evalJS(`[...document.querySelectorAll('[data-mem-jump]')].every(a => document.getElementById(a.dataset.memJump) && a.getAttribute('href') === '#' + a.dataset.memJump)`))
  check('at least one entry is current (a subsection and its section may both be)', await evalJS(`document.querySelectorAll('.memindex a[aria-current="true"]').length`) >= 1)
  const hashBefore = await evalJS(`location.hash`)
  await evalJS(`document.querySelector('[data-mem-jump="mem-profile"]').click()`)
  await wait(800)
  check('clicking a link leaves location.hash alone', await evalJS(`location.hash`) === hashBefore, await evalJS(`location.hash`))
  check('and scrolls the target into view', await evalJS(`(() => { const r = document.getElementById('mem-profile').getBoundingClientRect(); return r.top < innerHeight })()`))
  const linksBefore = await evalJS(links)
  await evalJS(`state.locked = false; memEditing = 'about'; memDraw()`)
  check('an open edit form adds no index entries', await evalJS(`!!document.querySelector('#memView textarea')`) && await evalJS(links) === linksBefore)
  await evalJS(`memEditing = null; memDraw()`)
  // the index stays put while the page scrolls
  await evalJS(`(() => { const sp = document.createElement('div'); sp.id = 'memSpacer'; sp.style.height = '4000px'; document.querySelector('.memcontent').appendChild(sp); })()`)
  await evalJS(`scrollTo(0, 0)`)
  await wait(300)
  const navTop = () => evalJS(`document.querySelector('.memindex').getBoundingClientRect().top`)
  await evalJS(`document.scrollingElement.scrollTo(0, 800)`)
  await wait(400)
  const navTopStart = await navTop()
  await evalJS(`document.scrollingElement.scrollTo(0, document.scrollingElement.scrollHeight)`)
  await wait(500)
  const navTopEnd = await navTop()
  const scrolled = await evalJS(`document.scrollingElement.scrollTop`)
  const hdrBottom = await evalJS(`document.getElementById('hdr').getBoundingClientRect().bottom`)
  check('the page really scrolled', scrolled > 500, String(scrolled))
  check('the index is in the same place at the bottom as part way down', Math.abs(navTopEnd - navTopStart) < 1.5,
    `${navTopStart} -> ${navTopEnd}`)
  check('and sits inside the viewport, below the header', navTopEnd >= hdrBottom - 1 && navTopEnd < await evalJS(`innerHeight`), `top ${navTopEnd}, header bottom ${hdrBottom}`)
  await evalJS(`document.getElementById('memSpacer').remove(); scrollTo(0, 0)`)

  // two bucket headings that slug the same
  await evalJS(`memData.buckets = [
    { heading: 'Foo Bar', name: 'Foo Bar', exists: true, filled: true, text: '# Foo Bar\\n\\nOne.' },
    { heading: 'foo-bar', name: 'foo-bar', exists: true, filled: true, text: '# foo-bar\\n\\nTwo.' }
  ]; memDraw()`)
  check('buckets that slug alike get distinct ids', await evalJS(`(() => { const ids = [...document.querySelectorAll('.membucket')].map(a => a.id); return ids.length === 2 && ids[0] !== ids[1] })()`),
    await evalJS(`[...document.querySelectorAll('.membucket')].map(a => a.id).join(',')`))
  check('and both have a working index link', await evalJS(`(() => { const l = [...document.querySelectorAll('[data-mem-jump^="mem-bucket-foo-bar"]')]; return l.length === 2 && l[0].dataset.memJump !== l[1].dataset.memJump && l.every(a => document.getElementById(a.dataset.memJump)) })()`))
  await evalJS(`memLoad()`)
  await wait(600)

  // each section says what it is for, filled or empty
  const descs = `[...document.querySelectorAll('#memView .memsec')].map(s => s.dataset.mem + '=' + (s.querySelector(':scope > .memdesc') || {}).textContent).join('|')`
  const wantDescs = {
    about: 'What this business does, in a few lines every agent reads first.',
    people: 'Who is who: role, team, who reports to whom, and the names that get confused.',
    buckets: 'One per bucket: what kind of work lands there and how it should be handled.',
    context: "What changes week to week: who is on leave, dates that can't move, and what is currently live with someone that you'd get wrong from their role alone.",
    profile: 'Facts about you that agents work from: how you work, write and want things done.'
  }
  const wantStr = ['about', 'people', 'buckets', 'context', 'profile'].map(k => k + '=' + wantDescs[k]).join('|')
  check('each section shows its description', await evalJS(descs) === wantStr, await evalJS(descs))
  check('descriptions are not index entries', await evalJS(`document.querySelectorAll('.memindex a').length === document.querySelectorAll('#memView .memsec, #memView .membucket[id], #memView h4[data-mem-sub]').length`))

  // every section empty: each still renders, with a placeholder and an index entry
  await evalJS(`(() => {
    memData.about = { text: '' }; memData.people = []; memData.buckets = []; memData.profile = {};
    memData.context = { text: '', exists: false };
    const span = memContextSpan(); if (span) span.arr.splice(span.at, span.end - span.at);
    memDraw();
  })()`)
  check('with everything empty every section still renders', await evalJS(sections) === 'about,people,buckets,context,profile', await evalJS(sections))
  check('empty sections keep their description', await evalJS(descs) === wantStr)
  check('each carries a placeholder', await evalJS(`[...document.querySelectorAll('#memView .memsec')].every(s => s.querySelector('.memempty'))`))
  check('and keeps its index entry', await evalJS(`[...document.querySelectorAll('#memView .memsec')].every(s => document.querySelector('.memindex a[data-mem-jump="' + s.id + '"]'))`))
  check('Edit still works from an empty section', await evalJS(`!!document.querySelector('[data-mem=about] [data-mem-edit=about]') && !!document.querySelector('[data-mem=people] [data-mem-edit=people]')`))
  await evalJS(`memLoad()`)
  await wait(600)
  check('the observer is running in the view', await evalJS(`memObserver !== null`))
  await evalJS(`state.view = 'board'; renderView()`)
  await wait(600)
  check('leaving the view disconnects the observer', await evalJS(`memObserver === null`))
  await evalJS(`state.view = 'memory'; renderView()`)
  await wait(500)

  await shot(process.env.SHOT_DESKTOP, 1200, 1000, false)
  await shot(process.env.SHOT_PHONE, 390, 800, true)

  // --- a locked tab shows Context read-only --------------------------------
  await evalJS(`state.locked = true; renderMemoryView()`)
  await wait(600)
  check('a locked tab has no Edit on Context', await evalJS(`!${$q('[data-mem=context] [data-mem-edit]')} && /read-only/.test(${$q('[data-mem=context]')}.textContent)`))
  await evalJS(`state.locked = false`)

  // --- the hash survives a view switch -------------------------------------
  await evalJS(`state.view = 'board'; syncHash(true); renderView()`)
  check('leaving the view leaves the board', await evalJS(`(() => { const m = document.querySelector('#memView'); return !m || m.offsetParent === null })()`))
  await evalJS(`state.view = 'memory'; syncHash(true); renderView()`)
  check('and the hash names it again', await evalJS(`location.hash.startsWith('#memory')`))
} finally {
  chrome.kill()
}

const failed = checks.filter(c => !c).length
console.log(`\n${checks.length - failed} passed${failed ? `, ${failed} failed` : ''}\n`)
process.exit(failed ? 1 : 0)
