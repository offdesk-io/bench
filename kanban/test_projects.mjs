/**
 * Drives the Projects tab and the project drawer in headless Chrome.
 *
 *   python3 kanban/server.py &          # or BOARD_PORT=... at one already up
 *   node kanban/test_projects.mjs
 *
 * Same two guards as test_chats.mjs, for the same reason — this repo has lost
 * the real todo.md to a test twice:
 *
 *   1. The tab is locked before any fixture is loaded. A locked tab cannot save.
 *   2. Every non-GET is torn out of `fetch` and recorded instead of sent, so
 *      there is no path from here to disk even if something unlocks the tab.
 *
 * Neither half of this view writes anything at all, which is the last check
 * below: a project is a folder, the panel reads it, and the only thing on
 * screen that changes anything is a task row that hands over to the drawer.
 *
 * /projects.json and /project.json are both stubbed, so this needs no folder
 * under data/projects/ to exist and never reads the real one.
 */

import { spawn } from 'node:child_process'
import { CHROME_BIN } from './test_browser.mjs'

const PORT = Number(process.env.CDP_PORT) || 9449
const BOARD = process.env.BOARD_PORT || 8765
if (!process.env.BOARD_PORT) console.error('Note: this runs against the live board on 8765. For a throwaway copy: scripts/test-board.sh test_projects.mjs')
const checks = []
const check = (name, pass, detail = '') => {
  checks.push(pass)
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const chrome = spawn(CHROME_BIN, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  `--user-data-dir=${process.env.CHROME_PROFILE || '/tmp/todo-projects-test-profile'}`, '--window-size=1400,1000',
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
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400))
  return r.result?.result?.value
}

// Poll for the page rather than sleeping: a fixed wait fails when the machine is busy.
for (let i = 0; i < 120 && !(await evalJS(`document.readyState === 'complete' && typeof state !== 'undefined' && !!state.doc`).catch(() => false)); i++) await new Promise(r => setTimeout(r, 250))
await new Promise(r => setTimeout(r, 400))
check('the board loaded', await evalJS(`typeof renderProjectsView === 'function'`))
check('and the drawer half of it too', await evalJS(`typeof openProjectDrawer === 'function'`))

// LOCK FIRST, then fixtures. Nothing below can write anything.
await evalJS(`(() => {
  state.locked = true; state.lockedLabel = 'test';
  const real = window.fetch;
  window.__blocked = [];
  // Two folders on disk: one every task in the fixture points at, one nothing
  // does. Live vs orphaned is worked out in the board rather than the server,
  // so both sides of that rule need a folder to stand on.
  const today = new Date(); today.setHours(9, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  window.__projects = [
    { name:'atlas2027', title:'ATLAS2027', blurb:'The team\\'s FY27 annual roadmap.',
      opened:'26 Aug 2026', has_claude_md:true, file_count:4,
      modified: yesterday.toISOString(), url:'/data/projects/atlas2027/' },
    { name:'nobody-here', title:'', blurb:'', opened:'', has_claude_md:false, file_count:1,
      modified:'2026-08-01T09:00:00', url:'/data/projects/nobody-here/' }
  ];
  window.__entries = [
    { name:'sources', dir:true, size:null, children:3, modified:'2026-09-01T10:00:00' },
    { name:'CLAUDE.md', dir:false, size:6528, children:null, modified:'2026-09-06T15:13:10' },
    { name:'redefinition brief.md', dir:false, size:1400000, children:null, modified:'2026-09-06T15:13:10' },
    { name:'notes.txt', dir:false, size:900, children:null, modified:'2026-09-06T15:13:10' },
    { name:'2026-10-20-1000-older-note.md', dir:false, size:2048, children:null, modified:'2026-10-20T10:00:00' },
    { name:'2026-11-05-0900-ive-joined-the-team.md', dir:false, size:3072, children:null, modified:'2026-11-05T09:00:00' }
  ];
  // What opening sources/ answers, and every request that asked for it.
  window.__subEntries = [
    { name:'raw', dir:true, size:null, children:1, modified:'2026-09-01T10:00:00' },
    { name:'interview.md', dir:false, size:512, children:null, modified:'2026-09-01T10:00:00' }
  ];
  window.__subCalls = [];
  // The one the two "it broke" checks swap out. Absent means answer normally.
  window.__projectStatus = 0;
  const json = (body, status) => Promise.resolve(new Response(JSON.stringify(body),
    { status, headers: { 'Content-Type': 'application/json' } }));
  window.fetch = (url, opts) => {
    const method = (opts && opts.method) || 'GET';
    if (method !== 'GET') {
      window.__blocked.push(method + ' ' + url + ' ' + ((opts && opts.body) || ''));
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    }
    const u = String(url);
    if (u.startsWith('/projects.json')) return json({ projects: window.__projects }, 200);
    if (u.startsWith('/project.json') && u.includes('&sub=')) {
      window.__subCalls.push(decodeURIComponent(u.split('&sub=')[1].split('&')[0]));
      return json({ sub:'x', entries: window.__subEntries }, 200);
    }
    if (u.startsWith('/project.json')) {
      if (window.__projectStatus) return json({ error: 'no' }, window.__projectStatus);
      return json(Object.assign({ entries: window.__entries },
        window.__about || { name:'atlas2027', title:'The roadmap for 2027', opened:'26 Aug 2026',
          blurb:'The team\\'s FY27 annual roadmap, and the design initiative inside it.',
          file_count: 4, modified: yesterday.toISOString() }), 200);
    }
    return real(url, opts);
  };
  const md = [
    '# To-do', '', '## 1. Tasks', '', '### To do', '',
    '- [ ] Write the roadmap deck [bucket:: Strategic] [due:: 2026-09-12]',
    '  - Project: data/projects/atlas2027',
    '- [x] Review the roadmap wording [bucket:: People]',
    '  - Project: data/projects/atlas2027', ''
  ].join('\\n');
  load(md, 'demo.md', {});
  state.locked = true;
})()`)
check('the tab is locked', await evalJS(`state.locked === true`))

/* ---- the Projects tab ---- */

// The chosen sort is remembered in the test browser's own localStorage, and a
// later section of this file leaves it on Z–A. Start every run from the default.
await evalJS(`setProjectSort('name-asc')`)

await evalJS(`renderProjectsView()`)
await new Promise(r => setTimeout(r, 500))
check('both folders are listed, on disk order', await evalJS(`
  [...document.querySelectorAll('#projectsRoot .reptitle')].map(e => e.textContent).join(',')
`) === 'atlas2027,nobody-here')
check('a folder a task points at is Live', await evalJS(`
  !!document.querySelector('#projectsRoot .repitem:first-child .projlive')
`))
check('and one nothing points at is Orphaned', await evalJS(`
  !!document.querySelector('#projectsRoot .repitem:last-child .projorphan')
`))
check('the file count is shown', await evalJS(`
  /4 files/.test(document.querySelector('#projectsRoot .repmeta').textContent)
`))
check('a missing CLAUDE.md is called out', await evalJS(`
  /no CLAUDE.md/.test(document.querySelectorAll('#projectsRoot .repmeta')[1].textContent)
`))
check('and when it was last edited, in words', await evalJS(`
  /edited yesterday/.test(document.querySelector('#projectsRoot .repmeta').textContent)
`), await evalJS(`document.querySelector('#projectsRoot .repmeta').textContent`))
check('the card says what the project is', await evalJS(`
  /FY27 annual roadmap/.test(document.querySelector('#projectsRoot .projcardblurb')?.textContent || '')
`))
check('a folder with no CLAUDE.md gets no blurb rather than an empty one', await evalJS(`
  document.querySelectorAll('#projectsRoot .projcardblurb').length === 1
`))
/* The whole card is the target, not just its title strip. Clicking the blurb —
   the furthest thing on a card from the .rephead button that used to be the
   only live part — is what proves data-project sits on the <article>. */
await evalJS(`document.querySelector('#projectsRoot .projcardblurb').click()`)
await new Promise(r => setTimeout(r, 300))
check('clicking below the title opens the project too', await evalJS(`
  state.openProject === 'atlas2027'
`))
await evalJS(`closeDrawer()`)

/* ---- the drawer, which is where the folder's own contents show ---- */

await evalJS(`openProjectDrawer('atlas2027')`)
await new Promise(r => setTimeout(r, 600))
check('the drawer opens on the project', await evalJS(`state.openProject === 'atlas2027'`))
check('the folder path is itself a link to the folder', await evalJS(`
  document.querySelector('a.projpath')?.getAttribute('href') === '/data/projects/atlas2027/'
`))

// The description at the top, read out of the folder's own CLAUDE.md rather
// than typed into the board anywhere.
check('the panel opens with what the project is', await evalJS(`
  /FY27 annual roadmap/.test(document.querySelector('#projAbout .projblurb')?.textContent || '')
`))
check('a CLAUDE.md title unlike the folder name is shown', await evalJS(`
  document.querySelector('#projAbout .projname')?.textContent === 'The roadmap for 2027'
`))
check('opened and edited sit under it', await evalJS(`
  document.querySelector('#projAbout .projwhen')?.textContent
`) === 'Opened 26 Aug 2026 · Edited yesterday')
check('and the description is above the files, not below them', await evalJS(`
  !!(document.querySelector('#projAbout').compareDocumentPosition(document.querySelector('#projFiles'))
     & Node.DOCUMENT_POSITION_FOLLOWING)
`))
check('both halves are titled', await evalJS(`
  [...document.querySelectorAll('#dbody .field > span:first-child')].map(s => s.textContent).join('|')
`) === 'Files in this folder|Tasks on this project')

const TOP = '#projFiles > .pfnode > .projfile, #projFiles > .projfile'
const rows = await evalJS(`[...document.querySelectorAll(${JSON.stringify(TOP)})].map(a =>
  a.querySelector('.pf').textContent + ' | ' + a.querySelector('.pfd').textContent + ' | ' +
  a.querySelector('.pfm').textContent + ' | ' + (a.getAttribute('href') || '') + ' | ' + a.getAttribute('title'))`)
check('the folder reads as five rows: a folder, three files, one Project files', rows.length === 5, rows.join(' / '))
check('a sub-folder is one row, counting what is inside it',
      rows[0].startsWith('sources/') && rows[0].includes('3 items'), rows[0])
check('folders sort above files', await evalJS(`
  document.querySelector(${JSON.stringify(TOP)}).classList.contains('isdir')`))
check('a dated Markdown name is tidied, with its day beside the size',
      rows[1].startsWith('Ive joined the team | 5 Nov | 3 KB | /data/projects/atlas2027/2026-11-05-0900-ive-joined-the-team.md'), rows[1])
check('newest dated first, then the undated names', rows[2].startsWith('Older note | 20 Oct') && rows[3].startsWith('redefinition brief.md |  | 1.3 MB'),
      rows[2] + ' / ' + rows[3])
check('the full name is the title, for the ellipsis', rows[3].endsWith('| redefinition brief.md'))
check('a space in a name is encoded in the href', rows[3].includes('redefinition%20brief.md'))
check('only Markdown names are tidied', await evalJS(`
  tidyProjectName('2026-11-05-0900-a-b.json') === null && tidyProjectName('2026-13-05-a.md') === null &&
  tidyProjectName('2026-11-05-ive-left.md').date === '5 Nov'`))
check('each name sits on one line, cut by an ellipsis', await evalJS(`(() => {
  const cs = getComputedStyle(document.querySelector('#projFiles .projfile .pf'));
  return cs.textOverflow === 'ellipsis' && cs.whiteSpace === 'nowrap'; })()`))
check('every file row has an icon', await evalJS(`
  [...document.querySelectorAll('#projFiles .projfile')].every(a => !!a.querySelector('svg.pficon'))`))
check('every file opens in a new tab, so the board keeps its own', await evalJS(`
  [...document.querySelectorAll('#projFiles a.projfile')].every(a => a.target === '_blank')
`))

// Project files: CLAUDE.md and the non-Markdown, non-image files wait in one shut row.
check('CLAUDE.md and notes.txt are not in the list, they are under Project files', rows.every(r => !r.startsWith('CLAUDE.md') && !r.startsWith('notes.txt')) &&
      rows[4].startsWith('Project files |  | 2 files'), rows[4])
check('and that row is shut', await evalJS(`(() => {
  const b = document.querySelector('#projFiles .pfgroup');
  return b.getAttribute('aria-expanded') === 'false' && b.nextElementSibling.hidden; })()`))
await evalJS(`document.querySelector('#projFiles .pfgroup').click()`)
check('opening it shows both files', await evalJS(`(() => {
  const k = document.querySelector('#projFiles .pfgroup').nextElementSibling;
  return !k.hidden && document.querySelector('#projFiles .pfgroup').getAttribute('aria-expanded') === 'true' &&
    [...k.querySelectorAll('.pf')].map(e => e.textContent).join() === 'CLAUDE.md,notes.txt'; })()`))
check('and sizes read as sizes', await evalJS(`
  [...document.querySelector('#projFiles .pfgroup').nextElementSibling.querySelectorAll('.pfm')].map(e => e.textContent).join() === '6 KB,900 B'`))

// A folder opens in place under its own toggle, one level, fetched when opened.
check('nothing was asked of a sub-folder before it was opened', await evalJS(`window.__subCalls.length === 0`))
check('a folder row is a toggle, shut', await evalJS(`(() => {
  const b = document.querySelector('#projFiles .isdir');
  return b.tagName === 'BUTTON' && b.getAttribute('aria-expanded') === 'false' && b.nextElementSibling.hidden; })()`))
await evalJS(`document.querySelector('#projFiles .isdir').click()`)
await new Promise(r => setTimeout(r, 300))
check('opening it asks for that one folder', await evalJS(`JSON.stringify(window.__subCalls)`) === '["sources"]')
check('and lists its rows under it, in place', await evalJS(`(() => {
  const b = document.querySelector('#projFiles .isdir');
  const k = b.nextElementSibling;
  return b.getAttribute('aria-expanded') === 'true' && !k.hidden &&
    [...k.querySelectorAll(':scope > .pfnode > .projfile, :scope > .projfile')].map(e => e.querySelector('.pf').textContent).join() === 'raw/,interview.md' &&
    k.querySelector('a.projfile').getAttribute('href') === '/data/projects/atlas2027/sources/interview.md'; })()`))
await evalJS(`document.querySelector('#projFiles .isdir').click()`)
check('a second click shuts it again', await evalJS(`document.querySelector('#projFiles .isdir').nextElementSibling.hidden`))
await evalJS(`document.querySelector('#projFiles .isdir').click()`)
check('and opening it again does not ask twice', await evalJS(`window.__subCalls.length === 1`))
await evalJS(`document.querySelector('#projFiles .isdir').nextElementSibling.querySelector('.isdir').click()`)
await new Promise(r => setTimeout(r, 300))
check('a folder inside one asks for its full path', await evalJS(`window.__subCalls.join()`) === 'sources,sources/raw')
check('the task rows are still under it', await evalJS(`
  document.querySelectorAll('#dbody .projrow').length === 2
`))

// A folder with no CLAUDE.md in it: the one field here nothing on disk
// guarantees, so the panel says what would fill it rather than sitting blank.
await evalJS(`window.__about = { name:'atlas2027', title:'', blurb:'', opened:'',
  modified:'2026-08-01T09:00:00' }`)
await evalJS(`openProjectDrawer('atlas2027')`)
await new Promise(r => setTimeout(r, 500))
check('a folder with no CLAUDE.md says what would describe it', await evalJS(`
  /Nothing describes this folder yet/.test(document.querySelector('#projAbout')?.textContent || '')
`))
// In the browser's own locale, as the board writes every date: "1 Aug" in
// some, "Aug 1" in a headless Chrome left on US English.
check('and still says when it was last edited', await evalJS(`
  document.querySelector('#projAbout .projwhen')?.textContent === 'Edited ' +
    new Date('2026-08-01T09:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
`), await evalJS(`document.querySelector('#projAbout .projwhen')?.textContent`))
await evalJS(`window.__about = null`)

// A folder that has gone from disk since the list was drawn.
await evalJS(`window.__projectStatus = 404`)
await evalJS(`openProjectDrawer('atlas2027')`)
await new Promise(r => setTimeout(r, 500))
check('a folder that is gone says so rather than spinning', await evalJS(`
  /not on disk/.test(document.querySelector('#projFiles')?.textContent || '')
`), await evalJS(`document.querySelector('#projFiles')?.textContent`))

// A helper that predates the route — the symptom CLAUDE.md names.
await evalJS(`window.__projectStatus = 501`)
await evalJS(`openProjectDrawer('atlas2027')`)
await new Promise(r => setTimeout(r, 500))
check('an older helper is named as the cause', await evalJS(`
  /needs restarting/.test(document.querySelector('#projFiles')?.textContent || '')
`))

/* ---- a task with a folder, in the drawer ----
   The Project card is gone from the drawer. The folder's one action, Open
   folder, is a button in the header, and the Outputs section leads the second
   column with the folder links only while a task has no folder. */

// The two failure cases above left the stub answering 501 to everything.
await evalJS(`window.__projectStatus = 0`)
const taskId = await evalJS(`(() => {
  let found = '';
  state.doc.buckets.forEach(b => b.tiers.forEach(t => t.tasks.forEach(x => {
    if (!found && taskProject(x) === 'atlas2027') found = x.id;
  })));
  return found;
})()`)
check('the fixture has a task on the project', !!taskId)
await evalJS(`openDrawer(${JSON.stringify(taskId)})`)
await new Promise(r => setTimeout(r, 600))

check('the second column leads with Outputs', await evalJS(`
  document.querySelector('.dcol-side > details > summary')?.textContent.trim() === 'Outputs'
`))
check('the project is gone from the left-hand column', await evalJS(`
  !document.querySelector('.dcol-main [data-project]')
`))
check('and the drawer offers no folder links for a task that has one', await evalJS(`
  !document.querySelector('#f-projstart') && !document.querySelector('#f-projpick')
`))
await new Promise(r => setTimeout(r, 300))
check('Files lists the folder, one row a file', await evalJS(`
  document.querySelectorAll('#f-files .projfile').length > 0
`))
check('the drawer Files box is the same list: wrapped, folders as toggles, a Project files row', await evalJS(`
  document.querySelector('#f-files').classList.contains('projfiles') &&
  !!document.querySelector('#f-files .pftoggle.isdir') && !!document.querySelector('#f-files .pfgroup')
`))
check('the header offers Open project folder', await evalJS(`
  !document.querySelector('#dheadProj').classList.contains('hidden') &&
  document.querySelector('#dheadProj').textContent === 'Open project folder'
`))

// One shape for every section in that column — the whole point of the change.
check('every section in the column is the same kind of section', await evalJS(`
  [...document.querySelectorAll('.dcol-side > *')].every(el =>
    el.tagName === 'HR' ||
    (el.tagName === 'DETAILS' && el.classList.contains('field') &&
     el.classList.contains('sugg') && !!el.querySelector(':scope > summary')))
`), await evalJS(`[...document.querySelectorAll('.dcol-side > *')].map(e => e.tagName + '.' + e.className).join(' / ')`))
check('and none of them still draws the packaged heading', await evalJS(`
  !document.querySelector('.dcol-side .aic-field, .dcol-side .aic-sublabel')
`))


/* ---- the third state: pointed at, with nothing left open ----
   No fixture project can be in it and Live at the same time, so this swaps the
   document for one where every task on atlas2027 is ticked rather than adding a
   third folder — a third folder would move :last-child and the .repmeta index
   the two checks above count on. It runs last for the same reason: everything
   before it is reading the document this replaces. */
await evalJS(`(() => {
  load([
    '# To-do', '', '## 1. Tasks', '', '### To do', '',
    '- [x] Write the roadmap deck [bucket:: Strategic]',
    '  - Project: data/projects/atlas2027',
    '- [x] Review the roadmap wording [bucket:: People]',
    '  - Project: data/projects/atlas2027', ''
  ].join('\\n'), 'demo.md', {});
  state.locked = true;
})()`)
await evalJS(`renderProjectsView()`)
await new Promise(r => setTimeout(r, 500))
check('a folder every task on it has finished is Completed', await evalJS(`
  document.querySelector('#projectsRoot .repitem:first-child .tag')?.className === 'tag projcompleted'
`), await evalJS(`document.querySelector('#projectsRoot .repitem:first-child .tag')?.className`))
check('and the tag says so', await evalJS(`
  document.querySelector('#projectsRoot .repitem:first-child .tag')?.textContent === 'Completed'
`))
check('one nothing points at is still Orphaned, not Completed', await evalJS(`
  !!document.querySelector('#projectsRoot .repitem:last-child .projorphan')
`))

/* ---- the mechanics the React port changed, 13 Sep 2026 ----
   Projects is drawn by kanban/ui/ProjectsView.tsx now and everything above
   passed unchanged, which is the point — the markup is the markup that was
   there. What is new underneath it is worth its own checks, because none of it
   is visible in the markup.

   The sort control is wired through React's onChange rather than an assigned
   .onchange, and was never covered at all. And the root sits on a node this
   view creates rather than on #lists, because the other nine views still draw
   by assigning to #lists.innerHTML and would tear the DOM out from under a
   live root without saying so. Switching away and back is the case that
   breaks if that guard is ever removed. */
await evalJS(`(() => {
  window.__projects = [
    { name:'zebra', blurb:'', has_claude_md:true, file_count:1, modified:'2026-09-10T09:00:00' },
    { name:'alpha', blurb:'', has_claude_md:true, file_count:2, modified:'2026-08-01T09:00:00' }
  ];
  projectSort = 'name-asc';
})()`)
const projNames = () => evalJS(
  `[...document.querySelectorAll('#projectsRoot .reptitle')].map(e => e.textContent).join(',')`)

await evalJS(`renderProjectsView()`)
await new Promise(r => setTimeout(r, 500))
check('the default order is A–Z', await projNames() === 'alpha,zebra', await projNames())

await evalJS(`(() => { const s = document.querySelector('#projectSort'); s.value = 'name-desc';
  s.dispatchEvent(new Event('change', { bubbles: true })); })()`)
await new Promise(r => setTimeout(r, 300))
check('the sort select reorders the list', await projNames() === 'zebra,alpha', await projNames())
check('and the select shows the order it is in',
  await evalJS(`document.querySelector('#projectSort').value`) === 'name-desc')

// The count in the head was filled in by setColCount() after the fetch and is
// a prop now, so it is React that has to get it right.
check('the head count is the number of folders',
  await evalJS(`document.querySelector('#projectsCol .tenon-column__head .tenon-column__count')?.textContent`) === '2',
  await evalJS(`document.querySelector('#projectsCol .tenon-column__head .tenon-column__count')?.textContent`))

await evalJS(`$('#lists').innerHTML = '<div class="lists">another view was here</div>'`)
await new Promise(r => setTimeout(r, 200))
check('another view can take the container', await evalJS(`!!document.querySelector('#projectsRoot')`) === false)

await evalJS(`renderProjectsView()`)
await new Promise(r => setTimeout(r, 600))
check('coming back redraws the whole view', await projNames() === 'zebra,alpha', await projNames())
check('and it kept the order it was left in',
  await evalJS(`document.querySelector('#projectSort').value`) === 'name-desc')
check('with one root and one column rather than two of either', await evalJS(`
  document.querySelectorAll('#projectsRoot').length === 1 &&
  document.querySelectorAll('#projectsCol').length === 1
`))

/* ---- the point of the second guard ---- */

check('nothing in this whole view wrote anything', await evalJS(`
  window.__blocked.length === 0
`), await evalJS(`window.__blocked.join(' | ')`))

/* ---- starting, choosing and opening a folder, 25 Sep 2026 ----
   After the no-writes check on purpose: Open folder and Start a project each
   post to the server. The posts are still caught by the stub above, and the
   tab is only unlocked for the two clicks that add a note, then locked again. */
await evalJS(`(() => {
  window.__blocked = [];
  const stubbed = window.fetch;
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u === '/project/start') {
      window.__blocked.push('POST ' + u + ' ' + opts.body);
      return Promise.resolve(new Response(JSON.stringify({ ok:true, name:'write-the-brief',
        note:'data/projects/write-the-brief' }), { status: 200 }));
    }
    return stubbed(url, opts);
  };
  window.__projects = [
    { name:'atlas2027', has_claude_md:true, file_count:1, modified:'2026-09-10T09:00:00' },
    { name:'/home/someone/Work/client a', external:true, url:null, has_claude_md:false,
      file_count:1, modified:'2026-09-10T09:00:00' }
  ];
  window.prompt = (msg, def) => def;
  window.confirm = () => true;
  load([
    '# To-do', '', '## 1. Tasks', '', '### To do', '',
    '- [ ] Write the brief [bucket:: Strategic]',
    '  - [ ] First step',
    '  - Waiting on: HR',
    '- [ ] Pick a folder [bucket:: Strategic]',
    '  - A note already here',
    '- [ ] On the roadmap [bucket:: Strategic]',
    '  - Project: data/projects/atlas2027', ''
  ].join('\\n'), 'demo.md', {});
  state.locked = true;
  // A board with no todo.md of its own falls back to the example list, which
  // sets state.demo; this section is about the live board, so it is cleared.
  state.demo = false;
})()`)
const idOf = title => evalJS(`(() => { let f=''; state.doc.buckets.forEach(b => b.tiers.forEach(t =>
  t.tasks.forEach(x => { if (x.title === ${JSON.stringify(title)}) f = x.id; }))); return f; })()`)
const briefId = await idOf('Write the brief')
const pickId = await idOf('Pick a folder')
const aopId = await idOf('On the roadmap')

await evalJS(`openDrawer(${JSON.stringify(aopId)})`)
await new Promise(r => setTimeout(r, 400))
check('a task with a folder offers Open folder, even locked', await evalJS(`!document.querySelector('#dheadProj').classList.contains('hidden')`))
await evalJS(`document.querySelector('#dheadProj').click()`)
await new Promise(r => setTimeout(r, 200))
check('which asks the server to open that folder', await evalJS(`window.__blocked.some(b =>
  b.startsWith('POST /project/open') && b.includes('atlas2027'))`), await evalJS(`window.__blocked.join(' | ')`))

await evalJS(`openDrawer(${JSON.stringify(briefId)})`)
await new Promise(r => setTimeout(r, 300))
check('a locked tab offers no Start a project', await evalJS(`!document.querySelector('#f-projstart')`))

await evalJS(`state.locked = false; openDrawer(${JSON.stringify(briefId)})`)
await new Promise(r => setTimeout(r, 300))
check('an unlocked one does', await evalJS(`!!document.querySelector('#f-projstart')`))
await evalJS(`document.querySelector('#f-projstart').click()`)
await new Promise(r => setTimeout(r, 400))
await evalJS(`state.locked = true`)
check('Start a project posts the task title', await evalJS(`window.__blocked.some(b =>
  b.startsWith('POST /project/start') && b.includes('Write the brief'))`))
const briefBody = await evalJS(`locate(${JSON.stringify(briefId)}).task.body`)
check('the note lands above every other note, in a code span',
  briefBody[0] === '  - Project: `data/projects/write-the-brief`', JSON.stringify(briefBody))
check('and the rest of the body keeps its order',
  briefBody[1] === '  - [ ] First step' && briefBody[2] === '  - Waiting on: HR', JSON.stringify(briefBody))
check('the task reads the new folder back', await evalJS(`taskProject(locate(${JSON.stringify(briefId)}).task)`) === 'write-the-brief')
check('the task is marked for autosave', await evalJS(`locate(${JSON.stringify(briefId)}).task.dirty === true`))
check('the drawer now shows the folder, not the links', await evalJS(`!document.querySelector('#f-projstart') && !document.querySelector('#dheadProj').classList.contains('hidden')`))

await evalJS(`state.locked = false; openDrawer(${JSON.stringify(pickId)})`)
await new Promise(r => setTimeout(r, 300))
await evalJS(`document.querySelector('#f-projpick').click()`)
await new Promise(r => setTimeout(r, 400))
check('the picker lists the default and the approved folders', await evalJS(`
  [...document.querySelectorAll('#f-projsel option')].map(o => o.textContent).join('|')
`) === 'data/projects/atlas2027|/home/someone/Work/client a')
await evalJS(`document.querySelector('#f-projpath').value = '/home/someone/Elsewhere';
  document.querySelector('#f-projapprove').click()`)
await new Promise(r => setTimeout(r, 300))
check('approving a path posts it once confirmed', await evalJS(`window.__blocked.some(b =>
  b.startsWith('POST /project-folders') && b.includes('/home/someone/Elsewhere'))`))
await evalJS(`document.querySelector('#f-projsel').value = '/home/someone/Work/client a';
  document.querySelector('#f-projuse').click()`)
await new Promise(r => setTimeout(r, 300))
await evalJS(`state.locked = true`)
const pickBody = await evalJS(`locate(${JSON.stringify(pickId)}).task.body`)
check('picking an approved folder writes its path', pickBody[0] === '  - Project: `/home/someone/Work/client a`',
  JSON.stringify(pickBody))
check('which taskProject() reads back whole', await evalJS(`taskProject(locate(${JSON.stringify(pickId)}).task)`) ===
  '/home/someone/Work/client a')

await evalJS(`openProjectDrawer('/home/someone/Work/client a')`)
await new Promise(r => setTimeout(r, 500))
check('a folder of his own shows its path as text, not a link', await evalJS(`
  document.querySelector('.projpath')?.tagName === 'CODE'`))
check('its files are rows, not links that would 404', await evalJS(`
  document.querySelectorAll('#projFiles a.projfile').length === 0 &&
  document.querySelectorAll('#projFiles .projfile').length > 0`))
check('and the panel offers Open folder', await evalJS(`!!document.querySelector('#projOpenFolder')`))

await evalJS(`state.demo = true; openDrawer(${JSON.stringify(aopId)})`)
await new Promise(r => setTimeout(r, 300))
check('the static copy offers no Open folder', await evalJS(`document.querySelector('#dheadProj').classList.contains('hidden')`))
await evalJS(`openProjectDrawer('atlas2027')`)
await new Promise(r => setTimeout(r, 300))
check('in either panel', await evalJS(`!document.querySelector('#projOpenFolder')`))
await evalJS(`state.demo = false`)

/* ---- Add file when the task's folder is not usable ----
   The upload route answers with a code the drawer can tell apart. A folder the
   task names that is not there gets the default one made and the note pointed
   at it; one that is there but not approved gets the approve confirm. Either
   way the file goes up with no error line, and only a declined confirm shows one. */
const uploadRun = async (body, calls, confirmAnswer) => evalJS(`(async () => {
  window.__calls = [];
  const was = window.fetch;
  window.confirm = () => ${confirmAnswer};
  let first = true;
  window.fetch = (url, opts) => {
    const u = String(url), m = (opts && opts.method) || 'GET';
    if (u.startsWith('/project/upload')) {
      window.__calls.push('UPLOAD ' + decodeURIComponent(u));
      const code = window.__uploadFail;
      if (first && code) { first = false;
        return Promise.resolve(new Response(JSON.stringify({ error: 'x', code }), { status: code === 'missing' ? 404 : 403 })); }
      first = false;
      return Promise.resolve(new Response(JSON.stringify({ ok: true, name: 'a.txt' }), { status: 200 }));
    }
    if (u === '/project/start') { window.__calls.push('START ' + opts.body);
      return Promise.resolve(new Response(JSON.stringify({ ok: true, name: 'fresh-one' }), { status: 200 })); }
    if (u === '/project-folders' && m === 'POST') { window.__calls.push('APPROVE ' + opts.body);
      return Promise.resolve(new Response('{"ok":true}', { status: 200 })); }
    return was(url, opts);
  };
  load(${JSON.stringify(body)}.join('\\n'), 'demo.md', {});
  state.locked = false; state.demo = false;
  const t = state.doc.buckets[0].tiers[0].tasks[0];
  openDrawer(t.id);
  await new Promise(r => setTimeout(r, 300));
  const input = document.querySelector('#f-fileinput');
  const dt = new DataTransfer(); dt.items.add(new File(['hi'], 'a.txt'));
  input.files = dt.files; input.onchange();
  await new Promise(r => setTimeout(r, 700));
  const out = { calls: window.__calls.slice(), body: t.body.slice(), err: document.querySelector('#f-fileerr')?.textContent || '',
    errHidden: document.querySelector('#f-fileerr')?.classList.contains('hidden') };
  window.fetch = was; state.locked = true;
  return JSON.stringify(out);
})()`)
const fixture = path => ['# To-do', '', '## 1. Tasks', '', '### To do', '', '- [ ] Mend the fence [bucket:: Strategic]', '  - Project: `' + path + '`', '']
await evalJS(`window.__uploadFail = 'missing'`)
const a = JSON.parse(await uploadRun(fixture('/gone/for/good'), 0, 'true'))
check('a missing folder: the default one is made from the task title, then the file goes up',
  a.calls.length === 3 && a.calls[1].startsWith('START') && a.calls[1].includes('Mend the fence') &&
  a.calls[2] === 'UPLOAD /project/upload?name=fresh-one&file=a.txt', JSON.stringify(a.calls))
check('the task note is pointed at the new folder, nothing else added', a.body[0] === '  - Project: `data/projects/fresh-one`' && a.body.length === 1, JSON.stringify(a.body))
check('and no error shows', a.errHidden === true && a.err === '', JSON.stringify(a))
await evalJS(`window.__uploadFail = 'unapproved'`)
const b = JSON.parse(await uploadRun(fixture('/real/but/unapproved'), 0, 'true'))
check('an unapproved folder: the approve confirm runs, then the same file goes up',
  b.calls.length === 3 && b.calls[1].startsWith('APPROVE') && b.calls[1].includes('/real/but/unapproved') && b.calls[2].includes('/real/but/unapproved'), JSON.stringify(b.calls))
check('and no error shows', b.errHidden === true, JSON.stringify(b))
const c = JSON.parse(await uploadRun(fixture('/real/but/unapproved'), 0, 'false'))
check('declining the confirm uploads nothing and shows the error', c.calls.length === 1 && c.errHidden === false && /a\.txt/.test(c.err), JSON.stringify(c))

ws.close()
chrome.kill()
const failed = checks.filter(c => !c).length
console.log(failed ? `\n${failed} failed` : `\nall ${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
