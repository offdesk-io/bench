#!/usr/bin/env node
/* Giving a task to a person on a shared board: the board's people in Delegate
 * to, their round faces with initials, an email in [to:: ] read as a person
 * and never an agent, Mine on the stored email, and the Mac board unchanged.
 *
 *   scripts/test-board.sh test_assign_people.mjs
 *
 * Locked from the start, with every non-GET torn out of fetch, so nothing here
 * can save. /board-people.json is stubbed and the signed-in person set by
 * hand: the script's server is a Mac board. kanban/test_board_people.py
 * covers the server's list.
 */
import { spawn } from 'node:child_process'
import { CHROME_BIN } from './test_browser.mjs'

const PORT = Number(process.env.CDP_PORT) || 9463
const BOARD = process.env.BOARD_PORT || 8765
if (!process.env.BOARD_PORT) console.error('Note: this runs against the live board on 8765. For a throwaway copy: scripts/test-board.sh test_assign_people.mjs')
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

const LIST = [
  '# To-do', '', '## 1. Tasks', '', '### To do', '',
  '- [ ] **For Ana** [to:: ana@example.com] `id:ap0001`',
  '- [ ] **For Jerome** [impact:: med] [to:: Jerome@Example.com] `id:ap0002`',
  '  - [ ] Ana helps [to:: ana@example.com] `id:ap0003`',
  '- [ ] **For the Plan agent** [to:: Plan agent] `id:ap0004`',
  '- [ ] **For a people.md name** [to:: Mia] `id:ap0005`',
  '- [ ] **For Carla, who never signed in** [to:: carla@example.com] `id:ap0006`',
  '- [ ] **For Jerome by name, which is not him** [to:: Jérôme] `id:ap0007`',
  '- [ ] **For jerome, also not him** [to:: jerome] `id:ap0008`',
  '  - [ ] Waiting on him by name [to:: Jérôme D.] `id:ap0009`',
  ''
].join('\n')

try {
  check('the board loaded', await until(() => evalJS(`!!state.doc && typeof loadBoardPeople === 'function'`)))

  // LOCK FIRST, then fixtures. Nothing below can write anything.
  await evalJS(`(() => {
    state.locked = true; state.lockedLabel = 'test';
    window.__blocked = [];
    const real = window.fetch;
    window.fetch = (u, o) => {
      const m = (o && o.method) || 'GET';
      if (m !== 'GET') { if (m !== 'HEAD') window.__blocked.push(m + ' ' + u); return Promise.resolve(new Response('{}', { status: 200 })) }
      if (String(u).startsWith('/board-people.json')) return Promise.resolve(new Response(JSON.stringify({ people: [
        { email: 'tiagopedras+claude@gmail.com', name: 'Tiago Pedras' },
        // Signed in with an override, an isolate, a mark and a bell in it.
        { email: 'jerome@example.com', name: '\\u202EJérôme\\u2066 Dupont\\u200F\\u0007' },
        { email: 'ana@example.com', name: 'Ana Silva' },
        { email: 'carla@example.com', name: '' },
        { email: 'pa-tiago@offdesk.invalid', name: 'Tiago Assistant' }
      ] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      return real(u, o);
    };
  })()`)

  // --- the Mac board first: nobody signed in --------------------------------------
  const macTrip = await evalJS(`(() => {
    state.who = null; state.boardPeople = [];
    load(${JSON.stringify(LIST)}, 'todo.md', {});
    state.locked = true; state.view = 'board'; renderView();
    return serializeDoc(state.doc) === ${JSON.stringify(LIST)};
  })()`)
  check('on the Mac a list with people in it round-trips unchanged', macTrip)
  await evalJS(`loadBoardPeople()`)
  check('the Mac board asks for no people', await evalJS(`state.boardPeople.length === 0`))
  await evalJS(`bucketAgentData = { list: state.dataset || '', buckets: [{ bucket: 'b', name: 'Test b agent', mode: 'plan-first', start: 'on-assign', ready: true, missing: [] }],
    columns: { [locate(findTaskByKey('ap0005').id).bucket.name]: 'b' } }`)
  const macPick = await evalJS(`(() => { openDrawer(findTaskByKey('ap0005').id);
    const o = PICK_SPECS['f-to'].options.map(o => o.value); closeDrawer(); return o; })()`)
  check('on the Mac Delegate to offers no board people',
    !macPick.some(v => /@/.test(v)) && macPick.includes('Test b agent'), JSON.stringify(macPick))

  // --- signed in -------------------------------------------------------------------
  await evalJS(`(async () => {
    state.who = { email: 'jerome@example.com', name: '\u202EJérôme\u2066 Dupont\u200F\u0007', teams: ['offdesk'] };
    await loadBoardPeople();
    renderView();
  })()`)
  check('signed in, the board\'s people load', await evalJS(`state.boardPeople.length === 5`))
  await evalJS(`bucketAgentData.columns[locate(findTaskByKey('ap0001').id).bucket.name] = 'b'`)
  const pick = await evalJS(`(() => { openDrawer(findTaskByKey('ap0001').id);
    const o = PICK_SPECS['f-to'].options; closeDrawer();
    return o.map(x => ({ v: x.value, l: x.label, g: x.group || '', i: x.iconHtml || '' })); })()`)
  const ana = pick.find(o => o.v === 'ana@example.com')
  check('Delegate to offers the board\'s people, stored by email and shown by name',
    !!ana && ana.l === 'Ana S.' && ana.g === 'People', JSON.stringify(pick).slice(0, 300))
  check('Delegate to leaves the PA\'s sign-in out, and lists the humans',
    !pick.some(o => /@offdesk\.invalid$/.test(o.v)) && ['ana@example.com', 'jerome@example.com', 'carla@example.com'].every(e => pick.some(o => o.v === e)),
    JSON.stringify(pick.map(o => o.v)))
  check('a card the PA edited still resolves its name',
    await evalJS(`personFullName('pa-tiago@offdesk.invalid') === 'Tiago Assistant'`))
  const jer = pick.find(o => o.v === 'jerome@example.com')
  check('a name is shown as first name and last initial, with bidi and control characters gone',
    !!jer && jer.l === 'Jérôme D.' && !/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u0000-\u001F]/.test(jer.l), JSON.stringify(jer && jer.l))
  check('and the face carries both initials, cleaned too', !!jer && />JD<\/text>/.test(jer.i), jer && jer.i)
  check('the header shows the cleaned short name',
    await evalJS(`(() => { $('#whoName').textContent = personName(state.who.email); return $('#whoName').textContent === 'Jérôme D.'; })()`))
  check('each with a round face carrying their initials',
    !!ana && /class="avatar person"/.test(ana.i) && /<circle/.test(ana.i) && />AS<\/text>/.test(ana.i), ana && ana.i)
  const carla = pick.find(o => o.v === 'carla@example.com')
  check('someone with no name gets the first letter of their email', !!carla && />C<\/text>/.test(carla.i), carla && carla.i)
  check('and nobody outside the board is offered',
    pick.filter(o => /@/.test(o.v)).map(o => o.v).sort().join() ===
      'ana@example.com,carla@example.com,jerome@example.com,tiagopedras+claude@gmail.com')
  const agent = pick.find(o => o.v === 'Test b agent')
  check('agents keep their square faces', !!agent && !/person/.test(agent.i) && /<rect|<path/.test(agent.i))

  const card = title => evalJS(`(() => { const el = Array.from(document.querySelectorAll('#board .tenon-card')).find(c => c.textContent.includes(${JSON.stringify(title)})); return el ? el.innerHTML : ''; })()`)
  const anaCard = await card('For Ana')
  check('the card shows the person by face only, name in the tooltip',
    anaCard.includes('title="Delegated to Ana S."') && anaCard.includes('aria-label="Delegated to Ana S."') && !anaCard.includes('→'))
  check('with their face', /svg class="person"/.test(anaCard) && />AS<\/text>/.test(anaCard))
  check('the same colour every time',
    await evalJS(`personAvatarSvg('ana@example.com', 'Ana Silva', 16) === personAvatarSvg('ANA@example.com ', 'Ana Silva', 16)`))
  check('a people.md name still shows as written, with no face',
    (await card('For a people.md name')).includes('→ Mia') && !/svg class="person"/.test(await card('For a people.md name')))

  const subRow = await evalJS(`(() => { openDrawer(findTaskByKey('ap0002').id);
    const html = $('#f-subs-host') ? $('#f-subs-host').innerHTML : ''; closeDrawer(); return html; })()`)
  check('a sub-task row shows its person\'s face', />AS<\/text>/.test(subRow), subRow.slice(0, 200))
  const subPick = await evalJS(`(() => { openDrawer('ap0003'); const v = PICK_SPECS['s-to'] && PICK_SPECS['s-to'].value;
    const o = PICK_SPECS['s-to'] ? PICK_SPECS['s-to'].options.some(o => o.value === 'ana@example.com') : false; closeDrawer(); return [v, o]; })()`)
  check('the sub-task panel offers and shows the person', subPick[0] === 'ana@example.com' && subPick[1], JSON.stringify(subPick))

  // --- an email is a person, never an agent ------------------------------------------
  check('agentOf never reads an email as an agent',
    await evalJS(`['ana@example.com', 'plan-agent@example.com', 'Plan agent@example.com'].every(e => agentOf(e) === '')`))
  check('a task given to a person is not delegated to an agent',
    await evalJS(`!delegatedToAgent(findTaskByKey('ap0001')) && !delegatedToAgent(findTaskByKey('ap0002'))`))
  check('and the agent chip leaves it out',
    await evalJS(`(() => { state.agentFilter = true; refreshView();
      const t = Array.from(document.querySelectorAll('#board .tenon-card')).map(c => c.textContent);
      state.agentFilter = false; refreshView();
      return t.length === 1 && t[0].includes('For the Plan agent'); })()`))

  // --- Mine on the stored email ---------------------------------------------------------
  // The chip's words, without the initials drawn in the face before them.
  await evalJS(`window.chipText = () => { const c = $('#mineChip').cloneNode(true);
    c.querySelectorAll('.chipface').forEach(f => f.remove()); return c.textContent.trim(); }`)
  check('Mine counts the tasks given to my email, however it is cased',
    await until(() => evalJS(`!!$('#mineChip') && chipText() === '1 mine'`)),
    await evalJS(`$('#mineChip') ? chipText() : 'no chip'`))
  check('and wears my face', await evalJS(`!!$('#mineChip .chipface svg.person')`))
  await evalJS(`state.who = { email: 'ana@example.com', name: 'Ana Silva', teams: [] }; renderFilterChips()`)
  check('for Ana, a sub-task given to her counts too',
    await until(() => evalJS(`chipText() === '2 mine'`)), await evalJS(`chipText()`))
  await evalJS(`state.who = { email: 'jerome@example.com', name: 'Jérôme Dupont', teams: ['offdesk'] }; renderFilterChips()`)
  check('a task given to his name or the first part of his email is not his',
    await evalJS(`!forMe(findTaskByKey('ap0007')) && !forMe(findTaskByKey('ap0008')) && forMe(findTaskByKey('ap0002'))`))
  check('nor is a sub-task waiting on his name his move', await evalJS(`!yourMove(findTaskByKey('ap0008'))`))
  check('while one waiting on his email is',
    await evalJS(`yourMove(parseTask(['- [ ] **x**', '  - [ ] step [to:: jerome@example.com]']))`))
  check('on the Mac, your move is still the owner\'s name',
    await evalJS(`(() => { const was = state.who; state.who = null;
      const got = yourMove(parseTask(['- [ ] **x**', '  - [ ] step [to:: ' + OWNER_NAME + ']']));
      state.who = was; return got; })()`))

  // --- two people with one short name ----------------------------------------------------
  await evalJS(`state.boardPeople = state.boardPeople.concat([{ email: 'ana.sousa@example.com', name: 'Ana Sousa' }])`)
  check('two people with one short name are told apart by their email',
    await evalJS(`personName('ana@example.com') === 'Ana S. (ana)' && personName('ana.sousa@example.com') === 'Ana S. (ana.sousa)'`),
    await evalJS(`personName('ana@example.com') + ' / ' + personName('ana.sousa@example.com')`))
  check('in the picker too',
    await evalJS(`(() => { openDrawer(findTaskByKey('ap0001').id); const l = PICK_SPECS['f-to'].options.map(o => o.label);
      closeDrawer(); return l.includes('Ana S. (ana)') && l.includes('Ana S. (ana.sousa)') && l.includes('Tiago P.'); })()`))
  check('and nobody else changes', await evalJS(`personName('tiagopedras+claude@gmail.com') === 'Tiago P.'`))

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
