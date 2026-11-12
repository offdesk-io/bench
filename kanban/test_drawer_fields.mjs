#!/usr/bin/env node
/* The task panel's Impact, Effort and Column sliders and its tag chips, on
 * Tenon's StepSlider and TagChip (kanban/ui/DrawerFields.tsx).
 *
 *   scripts/test-board.sh test_drawer_fields.mjs
 *
 * Written 1 Oct 2026. Fetch is torn out so no write can leave the page.
 */
import { spawn } from 'node:child_process'
import { CHROME_BIN } from './test_browser.mjs'

const PORT = Number(process.env.CDP_PORT) || 9497
const BOARD = process.env.BOARD_PORT || 8765
if (!process.env.BOARD_PORT) console.error('Note: this runs against the live board on 8765. For a throwaway copy: scripts/test-board.sh test_drawer_fields.mjs')
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
  // Poll for the page rather than sleeping: a fixed wait fails when the machine is busy.
  for (let i = 0; i < 120 && !(await evalJS(`document.readyState === 'complete' && typeof state !== 'undefined' && !!state.doc`).catch(() => false)); i++) await new Promise(r => setTimeout(r, 250))
  await new Promise(r => setTimeout(r, 400))
  await evalJS(`try { localStorage.removeItem('bench-collapsed') } catch (e) {}`)
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
      "- [ ] **Alpha** [impact:: med] [effort:: S] [owner:: Dev K.]",
      '  - [ ] First step', '  - [ ] Second step',
      '', '## 2. Home', '', '### Doing', '', "- [ ] **Other**",
      ''
    ].join('\\n'), 'demo.md', {});
    state.bucketThemes = { Work: ['Ops', 'Admin'] };
    state.locked = false;
    window.__t = () => state.doc.buckets.flatMap(b => b.tiers).flatMap(x => x.tasks).find(t => t.title === 'Alpha');
    state.view = 'board'; renderView();
    openDrawer(__t().id);
  })()`)
  await wait(300)
  const val = sel => evalJS(`document.querySelector('${sel} [role=slider]').getAttribute('aria-valuetext')`)

  /* ---- the Details section ---- */

  const dsel = `document.querySelector('details[data-collapse=details]')`
  check('Details exists and is closed on first open', await evalJS(`!!${dsel} && !${dsel}.open`))
  check('it holds Column, Impact/Effort, Delegate to, dates, Flags and Tags, Tags last', await evalJS(`(() => {
    const d = ${dsel}; const ids = ['#f-tier', '#f-impact', '#f-effort', '#f-to-dd', '#f-dates', '#f-urgent', '.tagchips'];
    const els = ids.map(i => d.querySelector(i));
    if (els.some(e => !e)) return false;
    for (let i = 1; i < els.length; i++) if (!(els[i-1].compareDocumentPosition(els[i]) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
    const last = [...d.children].pop();
    return last.querySelector('.tagchips') && !last.matches('details') && !d.querySelector('details:not([data-collapse=notes]), hr.dsep');
  })()`))
  check('Bucket, Theme and Description are the first three things in Details', await evalJS(`(() => {
    const d = ${dsel}, kids = [...d.querySelectorAll(':scope > .field')];
    return !!kids[0]?.querySelector('[data-pick-host="f-bucket"]') && !!kids[1]?.querySelector('#f-theme-dd') &&
      kids[2]?.matches('details.subsec[data-collapse=notes]');
  })()`))
  check('Title, Details and Subtasks are top-level sections, the same markup as Outputs', await evalJS(`(() => {
    const top = k => document.querySelector('.dcol-main > details.field.sugg:not(.subsec)[data-collapse="' + k + '"]');
    const out = document.querySelector('.dcol-side > details.field.sugg:not(.subsec)[data-collapse="sugg:outputs"]');
    const same = (a, b) => getComputedStyle(a.querySelector('summary')).fontSize === getComputedStyle(b.querySelector('summary')).fontSize &&
      getComputedStyle(a.querySelector('summary')).color === getComputedStyle(b.querySelector('summary')).color &&
      getComputedStyle(a.querySelector('summary')).fontWeight === getComputedStyle(b.querySelector('summary')).fontWeight;
    return ['details', 'sugg:subtasks'].every(k => top(k) && same(top(k), out)) &&
      !!top('sugg:subtasks').querySelector('#f-subs-host');
  })()`))
  check('Title is the one heading that does not fold: white, same type as Outputs, no caret, no <details>', await evalJS(`(() => {
    const t = document.querySelector('.dcol-main > div.field.sugg.heading'), o = document.querySelector('.dcol-side > details[data-collapse="sugg:outputs"] > summary');
    if (!t || t.closest('details') || t.querySelector('summary') || !t.querySelector('#f-title')) return false;
    const a = getComputedStyle(t.querySelector(':scope > span')), b = getComputedStyle(o);
    return a.fontSize === b.fontSize && a.fontWeight === b.fontWeight && a.color === b.color && a.textTransform === b.textTransform;
  })()`))
  check('an empty subsection (None yet.) has no caret and no fold, and stays open', await evalJS(`(() => {
    const e = document.querySelector('.dcol-side [data-collapse="sugg:Message suggestions"]');
    return !!e && e.tagName === 'DIV' && !e.querySelector('summary') && e.querySelector('.empty').textContent === 'None yet.' &&
      e.querySelector(':scope > span').textContent === 'Message suggestions' && !e.closest('details:not([open])');
  })()`))
  // The text's left edge, whatever the heading is: the summary's text node or the plain heading's.
  const textLeft = sel => evalJS(`(() => {
    const h = document.querySelector('${sel}'); const n = [...(h.matches('summary') ? h : h.querySelector(':scope > span')).childNodes].find(c => c.nodeType === 3 && c.textContent.trim());
    const r = document.createRange(); r.selectNodeContents(n); return Math.round(r.getBoundingClientRect().left * 10) / 10;
  })()`)
  const emptyLeft = await textLeft('.dcol-side [data-collapse="sugg:Message suggestions"]')
  const titleLeft = await textLeft('.dcol-main > div.field.sugg.heading')
  const detailsLeft = await textLeft('.dcol-main > details[data-collapse="details"] > summary')
  check('Title starts where the folding top-level headings do', titleLeft === detailsLeft, titleLeft + ' vs ' + detailsLeft)
  await evalJS(`__t().body.push('  - Suggested message: "Hello"'); openDrawer(__t().id)`)
  await wait(300)
  const fullLeft = await textLeft('.dcol-side [data-collapse="sugg:Message suggestions"] > summary')
  check('an empty subsection\'s heading starts where a folding one\'s does', emptyLeft === fullLeft, emptyLeft + ' vs ' + fullLeft)
  check('once it has content it is a section with a caret again', await evalJS(`(() => {
    const e = document.querySelector('.dcol-side [data-collapse="sugg:Message suggestions"]');
    return !!e && e.tagName === 'DETAILS' && !!e.querySelector(':scope > summary');
  })()`))
  await evalJS(`__t().body.pop(); openDrawer(__t().id)`)
  await wait(300)
  check('Add sub-task sits in the Subtasks title bar, and a click in that bar does not toggle the section', await evalJS(`(() => {
    const sec = document.querySelector('details[data-collapse="sugg:subtasks"]'), b = sec.querySelector('summary .sumaction #f-addsub');
    if (!b || b.textContent !== 'Add sub-task…') return false;
    // The bar around the button, so nothing is added; a click there is held back from the summary.
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    b.parentElement.dispatchEvent(ev);
    return ev.defaultPrevented;
  })()`))
  check('Description has no hint and no Expand button', await evalJS(`(() => {
    const s = document.querySelector('details[data-collapse=notes] > summary');
    return s.textContent === 'Description' && !document.querySelector('#f-body-grow');
  })()`))
  check('the pickers inside the closed section still mounted', await evalJS(`!!document.querySelector('#f-tier [role=slider]') && !!document.querySelector('#f-impact [role=slider]') && !!document.querySelector('#f-to-dd .tenon-dropdown__button') && !!document.querySelector('#f-dates .tenon-date-button') && !!document.querySelector('.tagchips .tenon-tag-chip')`))
  await evalJS(`${dsel}.open = true`)
  await wait(150)
  check('opening it is remembered when the panel is reopened', await evalJS(`(openDrawer(__t().id), true)`) && (await wait(300), await evalJS(`${dsel}.open`)))
  await evalJS(`${dsel}.open = false`)
  await wait(150)
  await evalJS(`openDrawer(__t().id)`)
  await wait(300)
  check('and shutting it is remembered too', await evalJS(`!${dsel}.open`))
  check('by default Dependencies and AI processes are not drawn', await evalJS(`!document.querySelector('#dbody details[data-collapse="sugg:deps"]') && !document.querySelector('#dbody details[data-collapse="sugg:chats"]')`))
  check('by default Jira tickets and Prompt suggestions are not drawn', await evalJS(`!document.querySelector('#dbody details[data-collapse="sugg:jira"]') && !document.querySelector('#dbody details[data-collapse="sugg:Prompt suggestions"]')`))
  check('Files is in Outputs and says so when the task has no folder', await evalJS(`!taskProject(__t()) && !!document.querySelector('details[data-collapse="sugg:files"] #f-files') && document.querySelector('#f-files').textContent === 'No files yet.'`))
  await evalJS(`${dsel}.open = true`)
  await wait(150)
  check('Description and Column are 12px apart in Details', await evalJS(`(() => {
    const d = ${dsel}, n = d.querySelector('details[data-collapse=notes]'), c = d.querySelector('#f-tier').closest('.field');
    return Math.round(c.getBoundingClientRect().top - n.getBoundingClientRect().bottom);
  })()`) === 12)
  await evalJS(`${dsel}.open = false`)
  await wait(150)
  check('closing Details hides its fields, and opening shows them again', await evalJS(`!document.querySelector('#f-tier').checkVisibility({ contentVisibilityAuto: true })`) &&
    (await evalJS(`${dsel}.open = true`), await wait(150), await evalJS(`document.querySelector('#f-tier').checkVisibility({ contentVisibilityAuto: true })`)))

  check('Impact opens on the task\'s own value', await val('#f-impact') === 'Med')
  check('Column opens on the column it is in, with a select beside it', await val('#f-tier') === 'Doing' &&
    await evalJS(`!!document.querySelector('#f-tier select')`))

  await evalJS(`document.querySelectorAll('#f-impact .tenon-step-slider__stop')[3].click()`)
  await wait(150)
  check('clicking a stop label sets it', await evalJS(`__t().impact`) === 'high')
  check('and the handle follows', await val('#f-impact') === 'High')

  await evalJS(`document.querySelector('#f-impact [role=slider]').focus()`)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 })
  await wait(150)
  check('the arrow keys step it', await evalJS(`__t().impact`) === 'med')

  const drag = await evalJS(`(() => { const r = document.querySelector('#f-effort .tenon-step-slider__track').getBoundingClientRect(); return { x0: r.left + 2, x1: r.right - 2, y: r.top + r.height / 2 } })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: drag.x0, y: drag.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: drag.x1, y: drag.y, button: 'left' })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: drag.x1, y: drag.y, button: 'left', clickCount: 1 })
  await wait(200)
  check('dragging the handle to the end lands on the last stop, once', await evalJS(`__t().effort`) === 'L', await evalJS(`__t().effort + ' ' + document.querySelector('#f-effort [role=slider]').getAttribute('aria-valuetext')`))

  /* ---- tags ---- */

  check('a [key:: value] tag shows as an amber chip', await evalJS(`(() => {
    const c = [...document.querySelectorAll('.tagchips .tenon-tag-chip')], add = document.querySelector('#f-tagadd .tenon-tag-chip');
    return c.length === 1 && c[0].textContent === 'owner: Dev K.' && c[0].classList.contains('tenon-tag-chip--warning') &&
      !!add && add.textContent === '+ Add tag';
  })()`))
  await evalJS(`document.querySelector('.tagchips .tenon-tag-chip').click()`)
  await wait(100)
  check('clicking it turns it into a field holding the value', await evalJS(`document.querySelector('.tagchips input').value`) === 'Dev K.')
  await send('Input.insertText', { text: '' })
  await evalJS(`(() => { const i = document.querySelector('.tagchips input'); i.value = 'Mia'; })()`)
  // React's blur handler reads the input's own value, so Enter is the commit.
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await wait(300)
  check('Enter writes it back to the task line', await evalJS(`__t().extra.join(' ')`) === '[owner:: Mia]')

  await evalJS(`openDrawer(__t().id)`)
  await wait(200)
  await evalJS(`document.querySelector('#f-tagadd .tenon-tag-chip--add').click()`)
  await wait(100)
  await evalJS(`(() => { const i = document.querySelectorAll('#f-tagadd input'); i[0].value = 'due'; i[1].value = 'x'; })()`)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await wait(200)
  check('a key the board already reads is refused and nothing is written', await evalJS(`__t().extra.length`) === 1)

  await wait(300)
  /* ---- the Column slider slides too ---- */

  await evalJS(`state.locked = false; openDrawer(__t().id)`)
  await wait(300)
  await evalJS(`window.__lefts = []; const h = () => document.querySelector('#f-tier .tenon-step-slider__handle');
    const rec = () => { const e = h(); if (e) __lefts.push(e.getBoundingClientRect().left); if (__lefts.length < 60) requestAnimationFrame(rec) };
    document.querySelectorAll('#f-tier .tenon-step-slider__stop')[1].click(); rec();`)
  await wait(700)
  check('a column pick rebuilds the panel but the handle still slides, over several frames', await evalJS(`new Set(__lefts.map(x => Math.round(x))).size > 3`), await evalJS(`JSON.stringify([...new Set(__lefts.map(x => Math.round(x)))]) + ' tier=' + locate(__t().id).tier.name + ' stops=' + [...document.querySelectorAll('#f-tier .tenon-step-slider__stop')].map(e => e.textContent).join('|') + ' locked=' + state.locked + ' dis=' + document.querySelector('#f-tier [role=slider]').getAttribute('aria-disabled')`))

  /* ---- dates ---- */

  check('Can start and Due are Tenon date buttons; empty ones read as such', await evalJS(`(() => {
    const b = [...document.querySelectorAll('#f-dates .tenon-date-button')];
    return b.length === 2 && b[0].textContent === 'Any time' && b[0].classList.contains('tenon-date-button--empty') && b[1].textContent === 'No date';
  })()`))
  await evalJS(`document.querySelector('#f-due').click()`)
  await wait(100)
  check('pressing one opens a calendar under both', await evalJS(`!!document.querySelector('#f-dates #f-cal-due.tenon-calendar') && document.querySelector('#f-due').getAttribute('aria-expanded') === 'true'`))
  await evalJS(`document.querySelectorAll('#f-cal-due [data-day]:not([data-day=""])')[14].click()`)
  await wait(300)
  check('picking a day writes it to the task and shuts the calendar', await evalJS(`!!__t().due && !document.querySelector('#f-cal-due')`))
  check('and the button now says the date', await evalJS(`document.querySelector('#f-due').textContent === dueLabel(__t().due)`))
  await evalJS(`document.querySelector('#f-due').click()`)
  await wait(100)
  await evalJS(`document.querySelector('#f-cal-due [data-day=""]').click()`)
  await wait(300)
  check('Clear takes it off again', await evalJS(`!__t().due && document.querySelector('#f-due').textContent === 'No date'`))

  /* ---- due time ---- */

  const setTime = (sel, v) => evalJS(`(() => {
    const i = document.querySelector('${sel}');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '${v}');
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  check('the Due time input is empty and switched off while there is no date', await evalJS(`(() => {
    const i = document.querySelector('#f-time');
    return !!i && i.type === 'time' && i.value === '' && i.disabled;
  })()`))
  await evalJS(`document.querySelector('#f-due').click()`)
  await wait(100)
  await evalJS(`document.querySelectorAll('#f-cal-due [data-day]:not([data-day=""])')[14].click()`)
  await wait(300)
  check('picking a date switches it on', await evalJS(`!document.querySelector('#f-time').disabled`))
  await setTime('#f-time', '15:00')
  await wait(200)
  check('setting a time writes it to the task', await evalJS(`__t().time`) === '15:00')
  check('and the task line carries [time:: 15:00] right after its due date', await evalJS(`serializeTask(__t())[0].includes('[due:: ' + __t().due + '] [time:: 15:00]')`))
  check('a board save and reload keeps it', await evalJS(`(() => {
    const text = serializeDoc(state.doc);
    const t = parseDoc(text).buckets.flatMap(b => b.tiers).flatMap(x => x.tasks).find(t => t.title === 'Alpha');
    return t.time === '15:00' && t.due === __t().due;
  })()`))
  await evalJS(`document.querySelector('#f-due').click()`)
  await wait(100)
  await evalJS(`document.querySelector('#f-cal-due [data-day=""]').click()`)
  await wait(300)
  check('clearing Due clears the time with it', await evalJS(`__t().time === '' && document.querySelector('#f-time').value === '' && !serializeTask(__t())[0].includes('time::')`))

  /* ---- sub-task rows ---- */

  await evalJS(`state.locked = false; window.confirm = () => true; openDrawer(__t().id)`)
  await wait(300)
  const subs = () => evalJS(`[...document.querySelectorAll('#f-subs .sub')].map(r => r.querySelector('.subtext, .subedit').textContent || r.querySelector('.subedit')?.value).join('|')`)
  check('the steps are rows with a grip, tick, delete and chevron', await evalJS(`(() => {
    const r = [...document.querySelectorAll('#f-subs .sub')];
    return r.length === 2 && r.every(x => x.querySelector('[data-tenon-grip]') && x.querySelector('input[type=checkbox]') && x.querySelector('.subdel') && x.querySelector('.subchev'));
  })()`))
  const wasTicked = await evalJS(`document.querySelectorAll('#f-subs .sub')[0].classList.contains('checked')`)
  await evalJS(`document.querySelectorAll('#f-subs .sub')[0].querySelector('input').click()`)
  await wait(300)
  check('ticking a step flips it on the task', await evalJS(`document.querySelectorAll('#f-subs .sub')[0].classList.contains('checked')`) === !wasTicked)
  await evalJS(`document.querySelector('#f-addsub').click()`)
  await wait(300)
  check('Add subtask puts a field in a new last row, focused', await evalJS(`
    document.querySelectorAll('#f-subs .sub').length === 3 && document.activeElement === document.querySelector('#f-subs .subedit')`))
  await evalJS(`(() => { const i = document.querySelector('#f-subs .subedit'); i.value = 'Third step' })()`)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await wait(400)
  check('Enter keeps the run going: the step is written and a fresh field opens under it', await evalJS(`
    document.querySelectorAll('#f-subs .sub').length === 4 && !!document.querySelector('#f-subs .subedit')`))
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await wait(400)
  check('Enter on an empty one stops the run and drops it', await evalJS(`
    document.querySelectorAll('#f-subs .sub').length === 3 && !document.querySelector('#f-subs .subedit')`), await subs())
  await evalJS(`document.querySelectorAll('#f-subs .sub')[2].querySelector('.subdel').click()`)
  await wait(300)
  check('the cross deletes a step', await evalJS(`document.querySelectorAll('#f-subs .sub').length === 2`))
  await evalJS(`document.querySelectorAll('#f-subs .sub')[1].click()`)
  await wait(300)
  check('clicking a row opens that sub-task in its own panel', await evalJS(`document.querySelector('#subpanel').classList.contains('open')`))
  check('a sub-task on its task\'s date has the Due time input switched off', await evalJS(`document.querySelector('#s-time')?.disabled === true`))
  await evalJS(`document.querySelector('#s-due').click()`)
  await wait(100)
  await evalJS(`document.querySelectorAll('#s-cal-due [data-day]:not([data-day=""])')[10].click()`)
  await wait(400)
  await setTime('#s-time', '10:15')
  await wait(200)
  check('a sub-task with its own date takes a time and writes it to its line', await evalJS(`(() => {
    const t = __t(), s = subSteps(t)[1];
    return readSub(t, s.line).time === '10:15' && t.body[s.line].includes('[time:: 10:15]') && t.body[s.line].indexOf('[due::') < t.body[s.line].indexOf('[time::');
  })()`), await evalJS(`__t().body.join(' / ')`))
  check('the task has no time of its own from that', await evalJS(`!__t().time`))
  /* a sub-task with no start of its own says it takes the task's */
  await evalJS(`closeDrawer(); __t().start = '2026-11-03'; openDrawer(__t().id)`)
  await wait(300)
  await evalJS(`document.querySelectorAll('#f-subs .sub')[0].click()`)
  await wait(300)
  check('a sub-task without a start reads "From the task\'s start" with the date, not "Any time"', await evalJS(`(() => {
    const b = document.querySelector('#s-start'), f = b && b.closest('.field');
    return !!b && b.textContent === "From the task's start, " + dueLabel('2026-11-03') && f.classList.contains('inherited');
  })()`), await evalJS(`document.querySelector('#s-start')?.textContent`))
  check('and a task with no start still gives "Any time"', await evalJS(`dateFieldModels('', '', false, '')[0].text === 'Any time' && dateFieldModels('2026-12-01', '', false, '2026-11-03')[0].text === dueLabel('2026-12-01') && !dateFieldModels('2026-12-01', '', false, '2026-11-03')[0].inherited`))

  /* the list tags a sub-task in Doing and an agent's run state */
  await evalJS(`closeDrawer(); (() => { const t = __t(), s = subSteps(t); const a = readSub(t, s[0].line); a.doing = true; writeSub(t, s[0].line, a); })(); openDrawer(__t().id)`)
  await wait(300)
  check('a sub-task in Doing carries a Doing tag; one in To do carries none', await evalJS(`(() => {
    const r = [...document.querySelectorAll('#f-subs .sub')];
    return r[0].querySelector('.substatus')?.textContent === 'Doing' && !r[1].querySelector('.substatus');
  })()`))
  check('an agent run state replaces Doing, and a ticked sub-task has no tag', await evalJS(`(() => {
    const s = { to: 'Plan agent', stableId: 'x1', doing: true };
    agentRuns['x1'] = { state: 'running', started: new Date().toISOString() };
    const run = subRowStatus(s);
    agentRuns['x1'] = { state: 'failed', at: new Date().toISOString() };
    const failed = subRowStatus(s);
    delete agentRuns['x1'];
    return run.label === 'Working' && failed.label === 'Failed' && subRowStatus(s).label === 'Doing' && !subRowStatus({ done: true, doing: true });
  })()`))
  await evalJS(`closeDrawer(); openDrawer(__t().id)`)
  await wait(300)

  /* ---- delegate to ---- */

  await evalJS(`state.agentsSetup = true; if (!peopleNames.includes('Dev K.')) peopleNames.push('Dev K.'); openDrawer(__t().id)`)
  await wait(300)

  check('Delegate to is a Tenon dropdown over a hidden select that still holds the value', await evalJS(`
    !!document.querySelector('#f-to-dd .tenon-dropdown__button') && document.querySelector('#f-to').classList.contains('hidden')`))
  await evalJS(`document.querySelector('#f-to-dd .tenon-dropdown__button').click()`)
  await wait(100)
  check('its list is grouped, Agents then People under their own headings', await evalJS(`
    [...document.querySelectorAll('#f-to-dd .tenon-dropdown__heading')].map(h => h.textContent).join() === 'Agents,People'`))
  await evalJS(`document.querySelector('#f-to-dd [data-value="Plan agent"]').click()`)
  await wait(300)
  check('picking an option sets the select and the task', await evalJS(`document.querySelector('#f-to').value === 'Plan agent' && __t().to === 'Plan agent'`))
  await evalJS(`document.querySelector('#f-to-dd .tenon-dropdown__button').click(); document.querySelector('#f-to-dd .tenon-dropdown__button').focus()`)
  await wait(100)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await wait(100)
  check('Escape shuts the list without picking', await evalJS(`!document.querySelector('#f-to-dd .tenon-dropdown__panel')`))

  /* ---- bucket and theme ---- */

  await evalJS(`state.locked = false; openDrawer(__t().id)`)
  await wait(300)
  check('Bucket is a Tenon dropdown showing the bucket with its colour dot', await evalJS(`(() => {
    const b = document.querySelector('#f-bucket-dd .tenon-dropdown__button');
    return !!b && b.textContent === 'Work' && !!b.querySelector('i');
  })()`))
  check('Theme is one too, over a hidden select, offering None and the bucket\'s themes', await evalJS(`
    !!document.querySelector('#f-theme-dd') && document.querySelector('#f-theme').classList.contains('hidden') &&
    [...document.querySelectorAll('#f-theme option')].map(o => o.textContent).join() === 'None,Ops,Admin'`))
  await evalJS(`document.querySelector('#f-theme-dd .tenon-dropdown__button').click()`)
  await wait(100)
  await evalJS(`document.querySelector('#f-theme-dd [data-value="Ops"]').click()`)
  await wait(200)
  check('picking a theme writes it to the task', await evalJS(`__t().theme`) === 'Ops')
  await evalJS(`window.__tierBefore = locate(__t().id).tier.name; document.querySelector('#f-bucket-dd .tenon-dropdown__button').click()`)
  await wait(100)
  await evalJS(`document.querySelector('#f-bucket-dd [data-value="Home"]').click()`)
  await wait(300)
  check('picking another bucket moves the task there, keeping its column, and the panel stays open', await evalJS(`
    locate(__t().id).bucket.name === 'Home' && locate(__t().id).tier.name === __tierBefore && state.openTask === __t().id`), await evalJS(`JSON.stringify([locate(__t().id).bucket.name, locate(__t().id).tier.name, state.openTask, __t().id])`))
  check('and the field now says Home', await evalJS(`document.querySelector('#f-bucket-dd .tenon-dropdown__button').textContent === 'Home'`))

  await evalJS(`state.locked = true; openDrawer(__t().id)`)
  await wait(300)
  check('a locked tab disables the sliders, dates and dropdown, makes the chips read-only and drops Add', await evalJS(`
    document.querySelector('#f-impact [role=slider]').getAttribute('aria-disabled') === 'true' &&
    document.querySelector('#f-due').disabled && document.querySelector('#f-to-dd .tenon-dropdown__button').disabled && document.querySelector('#f-bucket-dd .tenon-dropdown__button').disabled &&
    !document.querySelector('#f-tagadd .tenon-tag-chip--add') && document.querySelector('.tagchips .tenon-tag-chip').disabled`))

  check('every write was torn out before it left the page', await evalJS(`window.__blocked.every(w => /\\/data\\/todo\\.md$/.test(w))`), await evalJS(`window.__blocked.join(' | ')`))
} finally {
  ws.close()
  chrome.kill()
}

const failed = checks.filter(c => !c).length
console.log(failed ? `\n${failed} failed` : `\nall ${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
