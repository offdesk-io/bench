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
const sections = `[...document.querySelectorAll('#memView .spage__section')].map(s => s.dataset.section).join(',')`
const titles = `[...document.querySelectorAll('#memView .spage__label')].map(s => s.textContent).join(',')`
/* Every PUT the page sends, so a test can say what a Save did and did not write. */
const watchPuts = () => evalJS(`(() => { window.__puts = []; if (!window.__realFetch) { window.__realFetch = window.fetch;
  window.fetch = (u, o) => { if (o && o.method === 'PUT') window.__puts.push(String(u).split('?')[0] + ' ' + String(o.body || '')); return window.__realFetch(u, o) } } })()`)
/* The board's own autosave of the list is not the page's, so it is left out. */
const puts = () => evalJS(`window.__puts.map(x => x.split(' ')[0]).filter(u => !/\\.md$/.test(u)).join()`)
const saveAll = async () => { await evalJS(`document.querySelector('.spage__head [data-mem-save-all]').click()`); await wait(1000) }
const setVal = (sel, v) => evalJS(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', { bubbles: true })) })()`)

try {
  // Poll for the page rather than sleeping: a fixed wait fails when the machine is busy.
  for (let i = 0; i < 120 && !(await evalJS(`document.readyState === 'complete' && typeof state !== 'undefined' && !!state.doc`).catch(() => false)); i++) await new Promise(r => setTimeout(r, 250))
  await new Promise(r => setTimeout(r, 400))
  check('the board loaded on #settings/memory', await evalJS(`state.view === 'settings' && settingsTab === 'memory' && !!document.querySelector('#memView')`),
    await evalJS(`location.hash + ' / ' + state.view`))
  check('Memory is a tab of the Settings page, not of the top bar', await evalJS(`!viewDefs().some(d => d.id === 'memory') && settingsTabs().some(t => t[0] === 'memory')`))
  await wait(500)
  check('the page is titled Memory', await evalJS(`document.querySelector('#memView h1.spage__title').textContent === 'Memory'`))
  check('the sections are in order', await evalJS(sections) === 'profile,recorder,company,context,buckets', await evalJS(sections))
  check('with the titles About you, Meeting recorder, Company and team, Other context, Buckets', await evalJS(titles) === 'About you,Meeting recorder,Company and team,Other context,Buckets', await evalJS(titles))
  check('there is a Save under the title and one at the foot', await evalJS(`!!document.querySelector('#memView .spage__head [data-mem-save-all]') && !!document.querySelector('#memView .spage__foot [data-mem-save-all]')`))
  check('no section has an Edit or Cancel button, apart from a bucket\'s own', await evalJS(`![...document.querySelectorAll('#memView [data-mem-edit]')].some(b => !b.dataset.memEdit.startsWith('bucket:')) && !document.querySelector('#memView [data-mem-cancel]')`))
  check('Company and Team are always open for typing', await evalJS(`!!document.querySelector('[data-mem-about]') && !!document.querySelector('[data-mem-add]') && !document.querySelector('[data-mem-about]').readOnly`))
  check('an empty Team says so', await evalJS(`/No team yet/.test(document.querySelector('[data-section=company]').textContent) && !document.querySelector('[data-mem-row]')`))
  check('every bucket has a block', await evalJS(`document.querySelectorAll('.membucket').length === memData.buckets.length && memData.buckets.length > 0`))
  check('Other context holds the list\'s own section as text', await evalJS(`document.querySelector('[data-mem-context]').value.length > 20`))
  check('About you holds the facts file, working habits, writing rules and how to address you, in that order', await evalJS(
    `[...document.querySelectorAll('[data-section=profile] .tenon-field > .tenon-field__label')].map(x => x.textContent).join() === 'Facts file,Working habits,Writing rules,How to address you'`))
  check('Meeting recorder holds its profile section, and Setup is not on this page', await evalJS(
    `!!document.querySelector('[data-section=recorder] [data-mem-profile-section=recorder]') && !document.querySelector('[data-mem-profile-section=setup]')`))
  check('every field is Tenon\'s Field: label tied by for and id, help under the control and describing it, no Bench field styling', await evalJS(`(() => {
    const fields = [...document.querySelectorAll('#memView .tenon-field')];
    return fields.length >= 5 && fields.every(f => {
      const l = f.querySelector('label.tenon-field__label'), c = f.querySelector('.tenon-field__control');
      const n = f.querySelector('.tenon-field__note');
      if (!l || !c || !l.htmlFor || l.htmlFor !== c.id || document.querySelectorAll('[id="' + c.id + '"]').length !== 1) return false;
      if (!n || !(c.getAttribute('aria-describedby') || '').split(' ').includes(n.id)) return !n && !c.hasAttribute('aria-describedby') && !!c.closest('.memrow');
      return !!(c.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING);
    }) && !document.querySelector('#memView .field, #memView .memarea, #memView .memsubhead, #memView label:not(.tenon-field__label)') })()`))
  check('all the textareas share one width', await evalJS(`(() => { const w = [...document.querySelectorAll('#memView textarea')].map(t => Math.round(t.getBoundingClientRect().width)); return w.length >= 5 && new Set(w).size === 1 })()`), await evalJS(`[...document.querySelectorAll('#memView textarea')].map(t => Math.round(t.getBoundingClientRect().width)).join()`))
  await watchPuts()

  // --- Nothing changed: Save sends nothing ----------------------------------
  await saveAll()
  check('Save with nothing changed sends no request', await puts() === '', await puts())

  // --- The profile saves through PUT /profile-basics.json, only what changed --
  await setVal('[data-mem-profile-section=writing]', '## Writing\n- Spelling: British English')
  await saveAll()
  check('a ## heading blocks the save with a message', await evalJS(`!!document.querySelector('#memView > .memerr')`) && await puts() === '', await puts())
  check('and keeps what was typed', await evalJS(`document.querySelector('[data-mem-profile-section=writing]').value.startsWith('## Writing')`))
  await setVal('[data-mem-profile-section=writing]', '- Spelling: British English')
  await setVal('[data-mem-profile-section=habits]', '- Deferring: logs ideas first')
  await setVal('[data-mem-profile-about=facts_file]', 'facts.md')
  await setVal('[data-mem-profile-about=addressing]', 'Hey Sam')
  await evalJS(`window.__puts = []`)
  await saveAll()
  const prof = await evalJS(`fetch('/profile-basics.json').then(r => r.json())`)
  check('the sections, facts file and address are saved', /Spelling: British English/.test(prof.sections.writing) && /Deferring: logs ideas first/.test(prof.sections.habits)
    && prof.about.facts_file === 'facts.md' && prof.about.addressing === 'Hey Sam', JSON.stringify(prof).slice(0, 300))
  check('in one request to the profile route, and nothing else', await puts() === '/profile-basics.json', await puts())
  check('only the changed keys went, so Meeting recorder was not sent', await evalJS(`(() => { const b = JSON.parse(window.__puts[0].slice(window.__puts[0].indexOf(' ') + 1)); return !('recorder' in b.sections) && !('setup' in b.sections) && Object.keys(b.sections).sort().join() === 'habits,writing' })()`))
  check('and the page shows them after the save', await evalJS(`/Deferring: logs ideas first/.test(document.querySelector('[data-mem-profile-section=habits]').value)`))
  check('a < > in How to address you blocks the save', await (async () => {
    await setVal('[data-mem-profile-about=addressing]', 'Hey <Sam>'); await evalJS(`window.__puts = []`); await saveAll()
    const r = await puts() === '' && await evalJS(`!!document.querySelector('#memView > .memerr')`)
    await setVal('[data-mem-profile-about=addressing]', 'Hey Sam'); await evalJS(`memPageError = ''; memDraw(true)`)
    return r })())

  // --- One Save writes two changed sections: Company and Team ----------------
  await click('[data-mem-add]')
  await evalJS(`(() => {
    const row = document.querySelector('[data-mem-row="0"]');
    const set = (k, v) => { row.querySelector('[data-mem-person=' + k + ']').value = v; };
    set('name', 'Ada L.'); set('role', 'Engineer'); set('team', 'Platform'); set('reports_to', 'Grace H.'); set('notes', 'Part time');
  })()`)
  await setVal('[data-mem-about]', 'We make **small** tools.\n\n- one\n- two')
  check('adding a person keeps what was typed in Company', await evalJS(`document.querySelector('[data-mem-about]').value.startsWith('We make')`))
  await evalJS(`window.__puts = []`)
  await saveAll()
  check('one Save writes the two changed sections, About then People, and no others', await puts() === '/about,/people', await puts())
  const about = await evalJS(`fetch('/memory.json').then(r => r.json()).then(j => j.about.text)`)
  check('Company saves through PUT /about', /We make \*\*small\*\* tools/.test(about), JSON.stringify(about))
  const people = await evalJS(`fetch('/memory.json').then(r => r.json()).then(j => j.people)`)
  check('Team saves through PUT /people', people.length === 1 && people[0].name === 'Ada L.' && people[0].reports_to === 'Grace H.', JSON.stringify(people))
  check('and the Team row reads back as inputs', await evalJS(`document.querySelector('[data-mem-row="0"] [data-mem-person=notes]').value === 'Part time'`))
  await click('[data-mem-remove="0"]')
  check('Remove drops the row', await evalJS(`!document.querySelector('[data-mem-row]')`))
  await evalJS(`window.__puts = []`)
  await saveAll()
  check('and a Save sends the emptied Team on its own', await puts() === '/people', await puts())
  check('which leaves no people', (await evalJS(`fetch('/memory.json').then(r => r.json()).then(j => j.people)`)).length === 0)

  // --- A bucket brief goes through the section form -------------------------
  const first = await evalJS(`memData.buckets[0].heading`)
  await setVal('[data-mem-about]', 'Typed before opening a bucket.')
  await click(`.membucket[data-mem-bucket=${JSON.stringify(first)}] [data-mem-edit]`)
  check('a bucket opens the brief form', await evalJS(`document.querySelectorAll('[data-brief-section]').length === BRIEF_SECTIONS.length && !!${$q('[data-mem-brief-summary]')}`))
  check('opening it keeps what was typed above', await evalJS(`document.querySelector('[data-mem-about]').value === 'Typed before opening a bucket.'`))
  await evalJS(`document.querySelector('[data-mem-brief-summary]').value = 'From the Memory page.'`)
  await click('[data-mem-bucket] [data-mem-save]')
  await wait(800)
  const brief = await evalJS(`fetch('/memory.json').then(r => r.json()).then(j => j.buckets[0])`)
  check('and saves it through PUT /bucket-brief', /From the Memory page\./.test(brief.text) && brief.exists, JSON.stringify(brief).slice(0, 200))
  check('saving a bucket leaves the unsaved Company text alone', await evalJS(`document.querySelector('[data-mem-about]').value === 'Typed before opening a bucket.'`))
  await setVal('[data-mem-about]', 'We make **small** tools.\n\n- one\n- two')
  await evalJS(`memLoad(true)`)
  await wait(600)

  // --- Context: the old section shows, the first save moves it to context.md ---
  check('Context starts from the todo.md section when there is no context.md',
    await evalJS(`memData.context.exists === false && /./.test(memContextText()) && !!memContextSpan()`))
  check('the Context box holds its own text', await evalJS(`${$q('[data-mem-context]')}.value === memContextText()`))
  await setVal('[data-mem-context]', 'Ana is away until Friday.')
  await evalJS(`window.__puts = []`)
  await saveAll()
  const after = await evalJS(`serializeDoc(state.doc)`)
  const saved = await evalJS(`getJSON('/context.json')`)
  check('Save writes context.md through the route, alone', saved.exists && saved.text === 'Ana is away until Friday.' && await puts() === '/context', JSON.stringify(saved) + await puts())
  check('and removes the section from the document', !/## Context/.test(after) && await evalJS(`memContextSpan() === null`))
  check('marks the document unsaved for the normal autosave', await evalJS(`state.dirty === true || $('#status').textContent !== 'unsaved changes' `))
  check('and the box shows the new text', await evalJS(`/Ana is away until Friday/.test(${$q('[data-mem-context]')}.value)`))
  check('the document keeps its buckets', after.includes('## 1. People') && after.includes('## 4. Strategic'))
  await evalJS(`memLoad(true)`)
  await wait(600)
  check('a reload reads it back from context.md', await evalJS(`/Ana is away until Friday/.test(${$q('[data-mem-context]')}.value)`))

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

  // --- a re-render under typing keeps the text, the cursor and an open brief --
  await evalJS(`(() => { const b = ${$q('[data-mem-about]')}; b.value = 'typed, not saved'; b.focus(); b.setSelectionRange(3, 5) })()`)
  await evalJS(`renderMemoryView()`)
  await wait(700)
  check('a re-render keeps the typed Company text', await evalJS(`${$q('[data-mem-about]')}.value === 'typed, not saved'`))
  check('and the cursor where it was', await evalJS(`document.activeElement === ${$q('[data-mem-about]')} && document.activeElement.selectionStart === 3 && document.activeElement.selectionEnd === 5`))
  await evalJS(`memLoad()`)
  await wait(700)
  check('a late memory answer keeps it too', await evalJS(`${$q('[data-mem-about]')}.value === 'typed, not saved'`))
  await evalJS(`refreshSettingsPage()`)
  check('and so does a refresh of the view', await evalJS(`${$q('[data-mem-about]')}.value === 'typed, not saved'`))
  await click('[data-mem-add]')
  await evalJS(`document.querySelector('[data-mem-person=name]').value = 'Typed P.'`)
  await evalJS(`renderMemoryView()`)
  await wait(700)
  check('a Team row typed in survives a re-render', await evalJS(`document.querySelector('[data-mem-person=name]').value === 'Typed P.' && ${$q('[data-mem-about]')}.value === 'typed, not saved'`))
  await evalJS(`memLoad(true)`)
  await wait(700)
  check('a read made for a fresh start drops the typing', await evalJS(`${$q('[data-mem-about]')}.value !== 'typed, not saved' && !document.querySelector('[data-mem-row]')`))
  const firstHead = await evalJS(`memData.buckets[0].heading`)
  await click(`.membucket[data-mem-bucket=${JSON.stringify(firstHead)}] [data-mem-edit]`)
  await evalJS(`document.querySelector('[data-mem-brief-summary]').value = 'brief typed, not saved'`)
  await evalJS(`renderMemoryView()`)
  await wait(700)
  check('an open bucket brief survives a re-render with its text', await evalJS(`!!${$q('[data-mem-brief-summary]')} && ${$q('[data-mem-brief-summary]')}.value === 'brief typed, not saved'`))
  await evalJS(`memLoad(); refreshSettingsPage()`)
  await wait(700)
  check('and a late answer or a refresh', await evalJS(`!!${$q('[data-mem-brief-summary]')} && ${$q('[data-mem-brief-summary]')}.value === 'brief typed, not saved'`))
  await click('[data-mem-bucket] [data-mem-cancel]')
  await evalJS(`memLoad(true)`)
  await wait(500)

  // --- a refresh under typing does not wipe it -------------------------------
  await setVal('[data-mem-about]', 'Half typed')
  await evalJS(`refreshSettingsPage()`)
  check('a board refresh leaves unsaved typing alone', await evalJS(`document.querySelector('[data-mem-about]').value === 'Half typed'`))
  const modalPress = l => evalJS(`[...modalEl.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(l)}).click()`)
  check('unsaved typing raises the browser warning on close or reload', await evalJS(`(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented })()`))
  await click('#viewToggle [data-view=board]'); await wait(400)
  check('opening a board view with unsaved typing asks: Stay, Discard, Save', await evalJS(`!!modalEl && [...modalEl.querySelectorAll('button')].map(b => b.textContent.trim()).filter(t => t !== '×').join() === 'Stay,Discard,Save'`), await evalJS(`modalEl ? [...modalEl.querySelectorAll('button')].map(b => JSON.stringify(b.textContent)).join('|') : 'nomodal'`))
  await modalPress('Stay'); await wait(300)
  check('Stay keeps the Memory page and the typing', await evalJS(`state.view === 'settings' && !modalEl && document.querySelector('[data-mem-about]').value === 'Half typed'`))
  await click('#bucketFilters [data-value=agents]'); await wait(400)
  check('a tab switch asks too', await evalJS(`!!modalEl && settingsTab === 'memory'`))
  await modalPress('Discard'); await wait(900)
  check('Discard goes on to the other tab', await evalJS(`!modalEl && settingsTab === 'agents'`))
  await evalJS(`openSettingsPage('memory')`); await wait(900)
  check('with nothing changed, leaving asks nothing', await (async () => { await click('#bucketFilters [data-value=settings]'); await wait(700); return evalJS(`!modalEl && settingsTab === 'settings'`) })())
  await evalJS(`openSettingsPage('memory')`); await wait(900)
  await evalJS(`memLoad(true)`)
  await wait(600)

  // --- no index; the page is left-aligned ------------------------------------
  await evalJS(`state.locked = true; renderMemoryView()`)
  await wait(800)
  check('there is no floating index', await evalJS(`!document.querySelector('.memindex') && !document.querySelector('nav[aria-label="On this page"]')`))
  check('the content is one left-aligned stack at most 1200px wide', await evalJS(`(() => {
    const host = document.querySelector('#memView .spage'), r = host.getBoundingClientRect();
    const mid = document.querySelector('#lists').getBoundingClientRect();
    return Math.abs(r.left - mid.left) < 2 && r.width <= 1200.5
  })()`))
  check('Buckets is one section holding every brief', await evalJS(`document.querySelectorAll('#memView [data-section=buckets] .membucket').length === memData.buckets.length && document.querySelectorAll('#memView [data-section=buckets]').length === 1`))
  await evalJS(`state.locked = false`)
  // an empty subsection under a brief says so, in the style of "No brief yet."
  await evalJS(`(() => {
    memData.buckets = [{ heading: 'Foo', name: 'Foo', exists: true, filled: true,
      text: '# Foo\\n\\nWhat lands here.\\n\\n## The processes I run in this bucket\\n\\n> hint only\\n\\n## Who is involved\\n\\n## What good looks like\\n\\nShips on time.' }];
    memReset();
  })()`)
  const heads = `[...document.querySelectorAll('#memView [data-section=buckets] .memtext h4')].map(h => h.textContent + (h.nextElementSibling && h.nextElementSibling.classList.contains('memempty') ? ':empty' : '')).join('|')`
  const headText = await evalJS(heads)
  check('a brief heading with nothing under it shows an empty line', /The processes I run in this bucket:empty/.test(headText) && /Who is involved:empty/.test(headText) && !/What good looks like:empty/.test(headText), headText)
  await evalJS(`memLoad(true)`)
  await wait(600)

  // two bucket headings that slug the same
  await evalJS(`memData.buckets = [
    { heading: 'Foo Bar', name: 'Foo Bar', exists: true, filled: true, text: '# Foo Bar\\n\\nOne.' },
    { heading: 'foo-bar', name: 'foo-bar', exists: true, filled: true, text: '# foo-bar\\n\\nTwo.' }
  ]; memReset()`)
  check('buckets that slug alike get distinct ids', await evalJS(`(() => { const ids = [...document.querySelectorAll('.membucket')].map(a => a.id); return ids.length === 2 && ids[0] !== ids[1] })()`),
    await evalJS(`[...document.querySelectorAll('.membucket')].map(a => a.id).join(',')`))
  await evalJS(`memLoad(true)`)
  await wait(600)

  // each section says what it is for, filled or empty
  const descs = `[...document.querySelectorAll('#memView .spage__section')].map(s => s.dataset.section + '=' + [...s.querySelectorAll('[data-mem-desc]')].map(d => d.textContent).join('+')).join('|')`
  const wantDescs = {
    profile: 'Facts about you that agents work from: how you work, write and want things done.',
    recorder: '',
    company: 'What this business does, in a few lines every agent reads first.+Who is who: role, team, who reports to whom, and the names that get confused.',
    context: "What changes week to week: who is on leave, dates that can't move, and what is currently live with someone that you'd get wrong from their role alone.",
    buckets: 'One per bucket: what kind of work lands there and how it should be handled.'
  }
  const wantStr = ['profile', 'recorder', 'company', 'context', 'buckets'].map(k => k + '=' + wantDescs[k]).join('|')
  check('each section shows its description', await evalJS(descs) === wantStr, await evalJS(descs))

  // every section empty: each still renders, with a box or a placeholder to type in
  await evalJS(`(() => {
    memData.about = { text: '' }; memData.people = []; memData.buckets = []; memData.profile = {};
    memData.context = { text: '', exists: false };
    const span = memContextSpan(); if (span) span.arr.splice(span.at, span.end - span.at);
    memReset();
  })()`)
  check('with everything empty every section still renders', await evalJS(sections) === 'profile,recorder,company,context,buckets', await evalJS(sections))
  check('empty sections keep their description', await evalJS(descs) === wantStr)
  check('each carries a placeholder', await evalJS(`[...document.querySelectorAll('#memView .spage__section')].every(s => s.querySelector('.memempty, textarea[placeholder]'))`))
  check('Company and Team can still be typed into', await evalJS(`!!document.querySelector('[data-mem-about]') && !!document.querySelector('[data-mem-add]')`))
  await evalJS(`memLoad(true)`)
  await wait(600)
  await evalJS(`state.view = 'board'; renderView()`)
  await wait(600)
  await evalJS(`openSettingsPage('memory')`)
  await wait(500)

  await shot(process.env.SHOT_DESKTOP, 1200, 1000, false)
  await shot(process.env.SHOT_PHONE, 390, 800, true)

  // --- below 900px a section stacks ------------------------------------------
  await send('Emulation.setDeviceMetricsOverride', { width: 800, height: 900, deviceScaleFactor: 1, mobile: false })
  await wait(300)
  check('below 900px a section is one column', await evalJS(`getComputedStyle(document.querySelector('#memView .spage__section')).gridTemplateColumns.split(' ').length === 1`))
  await send('Emulation.clearDeviceMetricsOverride', {})

  // --- a locked tab: every field readonly, nothing saves ---------------------
  await evalJS(`state.locked = true; renderMemoryView()`)
  await wait(700)
  check('a locked tab says it is read-only, with no Save', await evalJS(`/read-only/.test(${$q('#memView')}.textContent) && !document.querySelector('[data-mem-save-all]')`))
  check('every field is readonly', await evalJS(`(() => { const f = [...document.querySelectorAll('#memView textarea, #memView input')]; return f.length > 5 && f.every(x => x.readOnly) })()`))
  check('with no Add, Remove or bucket Edit', await evalJS(`!document.querySelector('#memView [data-mem-add], #memView [data-mem-remove], #memView [data-mem-edit]')`))
  await evalJS(`window.__puts = []`)
  await evalJS(`memDraft.about = 'changed'; memDraft.context = 'changed'; memDraft.people.push({ name: 'X' })`)
  await evalJS(`memStartEdit('bucket:' + memData.buckets[0].heading)`)
  check('a locked tab opens no bucket form', await evalJS(`memEditing === null && !document.querySelector('[data-mem-brief-summary]')`))
  await evalJS(`memEditing = 'bucket:' + memData.buckets[0].heading; memBucketParts = { summary: 'x', sections: {} }`)
  const lockedSaves = await evalJS(`Promise.all([memSaveAll(), memSaveBucket(memEditing), settingsPageSave()]).then(r => JSON.stringify(r))`)
  await wait(400)
  check('Save, the bucket Save and the unsaved-changes prompt\'s Save all refuse', lockedSaves === '[false,null,false]', lockedSaves)
  check('and no PUT goes out', await puts() === '', await puts())
  check('a locked page is never dirty, so leaving it asks nothing', await evalJS(`memIsDirty() === false && !settingsPageDirty()`))
  await evalJS(`memDraft = null; memEditing = null; memBucketParts = null; state.locked = false; memLoad(true)`)
  await wait(600)

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
