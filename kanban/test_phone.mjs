#!/usr/bin/env node
/* The phone. Three things the board does only at 400px, and nothing above it.
 *
 *   python3 kanban/server.py &          # or BOARD_PORT=... at one already up
 *   node kanban/test_phone.mjs
 *
 * Written 15 Sep 2026, alongside the three entries in IMPROVEMENTS.md it
 * covers. Drag and drop does not fire on touch and a touch screen never
 * hovers, so a board that is only ever checked at desktop width quietly ships
 * controls a phone cannot reach:
 *
 *   1. Every column is the screen's width and snaps, so nothing says which one
 *      is on screen or how many there are. renderColTabs() (18-timeline.js)
 *      draws the strip; this asserts it names the columns the board drew, that
 *      it lights the one actually on screen, and that tapping one moves there.
 *   2. Moving a card means the drawer's Column field, and six .stepstop labels
 *      across 340px is not a target anyone can hit. It is a native <select>
 *      under 640px and the slider above it — both halves are asserted, at both
 *      widths, because a rule that showed neither or both would pass a test
 *      that only ever looked at one.
 *   3. .sortbtn sits at 55% opacity until .tenon-column:hover, which on a phone means
 *      always, so the control reads as disabled.
 *
 *   4. Below 640px the header and bucket bar give way to a one-row top bar, one
 *      sticky filter row and a bottom tab bar, with sheets for the board, the
 *      account, the buckets and the filters (HeaderBars.tsx PhoneChrome). Added
 *      31 Oct 2026; it reverses the 15 Sep call that nothing is pinned on a
 *      phone, for the filter row only.
 *
 * Both widths run the same checks, so the CSS breakpoint is what is under test
 * rather than one side of it. Same two guards as every other board test: the
 * tab is locked before any fixture is loaded, and every non-GET is torn out of
 * fetch and recorded instead of sent.
 */
import { spawn } from 'node:child_process'
import { CHROME_BIN } from './test_browser.mjs'

const BOARD = process.env.BOARD_PORT || 8765
if (!process.env.BOARD_PORT) console.error('Note: this runs against the live board on 8765. For a throwaway copy: scripts/test-board.sh test_phone.mjs')
const checks = []
const check = (name, pass, detail = '') => {
  checks.push(pass)
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

/* The fixture's tier is To do rather than Done: a bucket whose only tier is
   called Done gives the board two columns of that name, since Done is also one
   of the fixed ones, and the strip would then name it twice for a reason that
   has nothing to do with what is being tested. */
const FIXTURE = [
  '# To-do', '', '## 1. People', '', '### To do', '',
  '- [ ] Alpha [impact:: high] [effort:: M]',
  '- [ ] Beta [impact:: low] [effort:: S]', '', '### Doing', ''
].join('\n')

async function run (label, width, height) {
  const port = (Number(process.env.CDP_PORT) || 9480) + (width < 700 ? 0 : 1)
  const chrome = spawn(CHROME_BIN, [
    '--headless=new', `--remote-debugging-port=${port}`, '--no-first-run',
    `--user-data-dir=${process.env.CHROME_PROFILE || '/tmp/todo-phone-test-'}${width}`, `--window-size=${width},${height}`,
    `http://127.0.0.1:${BOARD}/kanban/index.html`
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  const target = async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/list`)
        const t = (await r.json()).find(t => t.type === 'page' && t.url.includes('index.html'))
        if (t?.webSocketDebuggerUrl) return t.webSocketDebuggerUrl
      } catch {}
      await new Promise(r => setTimeout(r, 250))
    }
    throw new Error('no page')
  }
  const ws = new WebSocket(await target())
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
  const evalJS = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500))
    return r.result?.result?.value
  }

  const phone = width < 700
  const at = s => `${label}: ${s}`

  await new Promise(r => setTimeout(r, 2500))
  check(at('the board loaded'), await evalJS(`typeof renderColTabs === 'function'`))

  // LOCK FIRST, then the fixture. Nothing below can write anything.
  await evalJS(`(() => {
    state.locked = true; state.lockedLabel = 'test';
    const real = window.fetch;
    window.__blocked = [];
    window.fetch = (u, o) => {
      const m = (o && o.method) || 'GET';
      if (m !== 'GET') { window.__blocked.push(m + ' ' + u); return Promise.resolve(new Response('{}', { status: 200 })) }
      return real(u, o);
    };
    load(${JSON.stringify(FIXTURE)}, 'demo.md', {});
    state.locked = true;
  })()`)
  check(at('the tab is locked'), await evalJS(`state.locked === true`))

  await evalJS(`document.querySelector('#main').scrollLeft = 0; state.view = 'board'; renderView()`)
  await new Promise(r => setTimeout(r, 300))

  /* ---- 1. the column strip ---- */

  const named = await evalJS(`[...document.querySelectorAll('#colTabs .coltab')].map(b => b.textContent).join('|')`)
  const drawn = await evalJS(`[...document.querySelector('#board').children].map(c => c.dataset.tier).join('|')`)
  check(at('the strip names exactly the columns the board drew, in that order'), named === drawn, named)

  check(at('and it is drawn at phone width only'),
    await evalJS(`getComputedStyle(document.querySelector('#colTabs')).display`) === (phone ? 'flex' : 'none'))

  if (phone) {
    check(at('the lit tab is the column on screen'),
      await evalJS(`document.querySelector('#colTabs .coltab').classList.contains('on')`))
    /* Scrolling relights it with no render in between — the listener is what
       keeps the strip honest while a swipe is happening. */
    await evalJS(`(async () => {
      document.querySelector('#main').scrollLeft = document.querySelector('#board').children[1].offsetLeft;
      await new Promise(r => setTimeout(r, 150));
    })()`)
    check(at('scrolling to the next column lights its tab'),
      await evalJS(`[...document.querySelectorAll('#colTabs .coltab')].findIndex(b => b.classList.contains('on'))`) === 1)
    await evalJS(`document.querySelectorAll('#colTabs .coltab')[2].click()`)
    check(at('and tapping a tab lights that one'),
      await evalJS(`[...document.querySelectorAll('#colTabs .coltab')].findIndex(b => b.classList.contains('on'))`) === 2)
  }

  check(at('the strip is put away on every other view'),
    await evalJS(`state.view = 'overview'; renderView(); document.querySelector('#colTabs').classList.contains('hidden')`))
  await evalJS(`state.view = 'board'; renderView()`)

  /* ---- 2. the Column field ---- */

  const firstId = await evalJS(`state.doc.buckets[0].tiers[0].tasks[0].id`)
  await evalJS(`openDrawer(${JSON.stringify(firstId)})`)
  await new Promise(r => setTimeout(r, 200))

  check(at('the Column field carries both a slider and a select'),
    await evalJS(`!!document.querySelector('#f-tier .tenon-step-slider') && !!document.querySelector('#f-tier .tenon-step-slider__select')`))
  check(at('and the width picks which one shows'),
    await evalJS(`getComputedStyle(document.querySelector('#f-tier .tenon-step-slider__select')).display`) === (phone ? 'block' : 'none') &&
    (await evalJS(`getComputedStyle(document.querySelector('#f-tier .tenon-step-slider')).display`) === 'none') === phone)
  check(at('the select offers the same stops as the slider, in the same order'),
    await evalJS(`
      [...document.querySelectorAll('#f-tier .tenon-step-slider__select option')].map(o => o.textContent).join('|') ===
      [...document.querySelectorAll('#f-tier .tenon-step-slider__stop')].map(o => o.textContent).join('|')
    `))
  check(at('and it opens on the column the task is in'),
    await evalJS(`document.querySelector('#f-tier .tenon-step-slider__select').selectedOptions[0].textContent`) === 'To do')
  // A read-only tab disables both halves, the same as every other field.
  check(at('a locked tab disables it'), await evalJS(`document.querySelector('#f-tier .tenon-step-slider__select').disabled === true`))
  /* Impact and Effort are scales rather than picks from a list, so they keep
     their sliders at every width and get no select of their own. */
  check(at('Impact and Effort keep their sliders and gain no select'),
    await evalJS(`!document.querySelector('#f-impact .tenon-step-slider__select') && !document.querySelector('#f-effort .tenon-step-slider__select')`))
  await evalJS(`closeDrawer()`)

  /* ---- what is pinned ----

     The 15 Sep decision was that neither the header nor the bucket strip is
     pinned on a phone: stacked, they took half the screen. The phone now has
     its own chrome, so that decision stands for the old bars and is reversed
     for the filter row only: one row, 57px, sticky. Asserted at both widths,
     since the breakpoint is what is under test. */

  const pinned = sel => evalJS(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).position`)
  check(at('the old header is pinned only where it costs nothing'),
    await pinned('header') === (phone ? 'static' : 'sticky'), await pinned('header'))
  if (phone) {
    check(at('the column strip stays pinned, and the filter row too'),
      await pinned('#colTabs') === 'sticky' && await pinned('#phFilters') === 'sticky')
  } else {
    check(at('the bucket strip is pinned where it costs nothing'), await pinned('.bucketbar') === 'sticky')
  }

  /* ---- 4. the phone's chrome ---- */

  const shown = sel => evalJS(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && getComputedStyle(e).display !== 'none'; })()`)
  if (!phone) {
    check(at('none of the phone chrome is drawn, and the header is'),
      !(await shown('#phTop')) && !(await shown('#phTabs')) && !(await shown('#phFilters')) && await shown('#hdr'))
  } else {
    check(at('the header and bucket bar give way'), !(await shown('#hdr')) && !(await shown('#bucketBar')))
    check(at('a one-row top bar names Bench'), await shown('#phTop') &&
      await evalJS(`document.querySelector('#phTop').getBoundingClientRect().height < 80 && /Bench/.test(document.querySelector('#phTop').textContent)`))
    const defs = await evalJS(`viewDefs().filter(d => !d.sep).map(d => d.id).join('|')`)
    check(at('the tab bar holds every view, with labels and icons, at the bottom'),
      await evalJS(`[...document.querySelectorAll('#phTabs .phtab')].map(b => b.dataset.view).join('|')`) === defs &&
      await evalJS(`[...document.querySelectorAll('#phTabs .phtab')].every(b => b.querySelector('svg') && b.textContent.trim())`) &&
      await pinned('#phTabs') === 'fixed')
    check(at('the current view carries aria-current'), await evalJS(`
      [...document.querySelectorAll('#phTabs .phtab')].filter(b => b.getAttribute('aria-current') === 'page').map(b => b.dataset.view).join() === state.view`))
    await evalJS(`document.querySelector('#phTabs [data-view="overview"]').click()`)
    await new Promise(r => setTimeout(r, 300))
    check(at('a tab switches the view and moves aria-current'), await evalJS(`state.view === 'overview' &&
      document.querySelector('#phTabs [aria-current="page"]').dataset.view === 'overview'`))
    await evalJS(`document.querySelector('#phTabs [data-view="board"]').click()`)
    await new Promise(r => setTimeout(r, 300))

    check(at('the column strip sticks directly under the filter row, not behind it'), await evalJS(`(() => {
      const f = document.querySelector('#phFilters').getBoundingClientRect();
      const c = document.querySelector('#colTabs').getBoundingClientRect();
      return Math.abs(c.top - f.bottom) <= 1 && parseFloat(getComputedStyle(document.querySelector('#colTabs')).top) >= f.height - 1;
    })()`), await evalJS(`JSON.stringify([document.querySelector('#phFilters').getBoundingClientRect().bottom, document.querySelector('#colTabs').getBoundingClientRect().top, getComputedStyle(document.querySelector('#colTabs')).top])`))
    await evalJS(`window.scrollTo(0, 300)`)
    await new Promise(r => setTimeout(r, 200))
    check(at('and stays there once the page has scrolled'), await evalJS(`(() => {
      const f = document.querySelector('#phFilters').getBoundingClientRect();
      const c = document.querySelector('#colTabs').getBoundingClientRect();
      return Math.abs(c.top - f.bottom) <= 1;
    })()`))
    await evalJS(`window.scrollTo(0, 0)`)
    check(at('every target is at least 44px tall'), await evalJS(`
      [...document.querySelectorAll('#phTop button, #phFilters button, #phTabs button')].every(b => b.getBoundingClientRect().height >= 44)`))
    check(at('the bars pad for the notch and the home bar'), await evalJS(`
      (() => { const all = []; const walk = rs => { for (const r of rs) { all.push(r.cssText || ''); if (r.cssRules) walk(r.cssRules) } };
        [...document.styleSheets].forEach(s => { try { walk(s.cssRules) } catch {} });
        return all.some(t => t.includes('phtabs') && t.includes('safe-area-inset-bottom')) &&
               all.some(t => t.includes('phtop') && t.includes('safe-area-inset-top')); })()`))

    const wait = ms => new Promise(r => setTimeout(r, ms))
    const sheetOpen = () => evalJS(`!!document.querySelector('[role="dialog"].phonesheet')`)
    const key = k => send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k })

    // The bucket sheet.
    check(at('the bucket button says what is showing'), await evalJS(`document.querySelector('#phBucket').textContent.replace('▾', '').trim()`) === 'All · 2')
    await evalJS(`document.querySelector('#phBucket').click()`)
    await wait(300)
    check(at('it opens a dialog that takes focus'), await sheetOpen() &&
      await evalJS(`document.querySelector('[role="dialog"].phonesheet').contains(document.activeElement)`))
    check(at('listing All and every bucket, with counts, All being current'), await evalJS(`
      [...document.querySelectorAll('.phonesheet [data-bucket]')].map(b => b.dataset.bucket + ':' + b.querySelector('.phcount').textContent).join() === '__all__:2,People:2' &&
      document.querySelector('.phonesheet [data-bucket="__all__"]').getAttribute('aria-current') === 'true' &&
      !document.querySelector('.phonesheet [data-bucket="People"]').hasAttribute('aria-current')`))
    await evalJS(`document.querySelector('.phonesheet [data-bucket="People"]').click()`)
    await wait(300)
    check(at('picking a bucket filters the board and moves aria-current'), await evalJS(`
      state.bucketFilter.has('People') && document.querySelector('.phonesheet [data-bucket="People"]').getAttribute('aria-current') === 'true' &&
      !document.querySelector('.phonesheet [data-bucket="__all__"]').hasAttribute('aria-current')`))
    await key('Escape')
    await wait(300)
    check(at('Escape closes the sheet'), !(await sheetOpen()))
    check(at('and the button now names the bucket'), await evalJS(`document.querySelector('#phBucket').textContent.replace('▾', '').trim()`) === 'People · 2')
    await evalJS(`state.bucketFilter.clear(); renderTabs(); refreshView()`)

    // A swipe down closes a sheet too.
    await evalJS(`document.querySelector('#phBucket').click()`)
    await wait(300)
    await evalJS(`(() => {
      const el = document.querySelector('.phonesheet__inner');
      const t = y => new Touch({ identifier: 1, target: el, clientX: 100, clientY: y });
      const fire = (type, y) => el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [t(y)], changedTouches: [t(y)] }));
      fire('touchstart', 400); fire('touchmove', 520); fire('touchend', 520);
    })()`)
    await wait(300)
    check(at('a swipe down closes the sheet'), !(await sheetOpen()))

    // The Filters sheet.
    check(at('Filters has no badge while nothing is on'), await evalJS(`!document.querySelector('#phFilterBtn .phbadge')`))
    await evalJS(`document.querySelector('#phFilterBtn').click()`)
    await wait(300)
    check(at('it offers need scoring, and says when nothing does'), await evalJS(`
      !!document.querySelector('.phonesheet [data-filter="score"]')`))
    await key('Escape')
    await wait(200)
    // The count, with one on: the chip is hidden at zero, so give a task no score.
    await evalJS(`state.unscoredOnly = true; refreshView()`)
    await wait(300)
    check(at('Filters carries a badge counting what is on'), await evalJS(`document.querySelector('#phFilterBtn .phbadge')?.textContent === '1'`))
    await evalJS(`state.unscoredOnly = false; refreshView()`)
    await wait(200)

    // The account sheet.
    await evalJS(`document.querySelector('#phAvatar').click()`)
    await wait(300)
    check(at('the avatar opens a sheet of the header actions'), await evalJS(`
      ['undo', 'download', 'backups', 'settings'].every(id => !!document.querySelector('.phonesheet [data-action="' + id + '"]'))`))
    check(at('with the status line underneath'), await evalJS(`
      document.querySelector('.phonesheet .tenon-modal__subtitle')?.textContent === document.querySelector('#status').textContent`))
    await key('Escape')
    await wait(300)
    check(at('and Escape closes it'), !(await sheetOpen()))

    // Search.
    await evalJS(`document.querySelector('#phSearchBtn').click()`)
    await wait(200)
    check(at('the search icon widens to a full bar with Cancel'), await evalJS(`
      !!document.querySelector('#phSearch') && !!document.querySelector('#phCancel') && !document.querySelector('#phBucket')`))
    await evalJS(`(() => {
      const el = document.querySelector('#phSearch');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'Alpha');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await wait(300)
    check(at('typing searches through the desktop box'), await evalJS(`state.query === 'Alpha' && document.querySelector('#q').value === 'Alpha'`))
    await evalJS(`document.querySelector('#phCancel').click()`)
    await wait(300)
    check(at('Cancel clears it and puts the row back'), await evalJS(`state.query === '' && !!document.querySelector('#phBucket')`))
  }

  /* ---- 3. the sort control on a touch screen ---- */

  check(at('.sortbtn is at full opacity where nothing can hover'), await evalJS(`
    (() => {
      const all = [];
      const walk = rs => { for (const r of rs) { all.push(r.cssText || ''); if (r.cssRules) walk(r.cssRules) } };
      [...document.styleSheets].forEach(s => { try { walk(s.cssRules) } catch {} });
      return all.some(t => /hover:\\s*none/.test(t) && t.includes('sortbtn') && t.includes('opacity: 1'));
    })()
  `))

  check(at('nothing was written'), await evalJS(`window.__blocked.length === 0`),
    await evalJS(`window.__blocked.join(' | ')`))

  ws.close()
  chrome.kill()
}

await run('phone', 400, 900)
await run('desktop', 1400, 1000)

const failed = checks.filter(c => !c).length
console.log(failed ? `\n${failed} failed` : `\nall ${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
