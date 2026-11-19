/**
 * Regenerates fixtures/merge.json by running mergeSaves() in core/todo.js.
 *
 *   node core/fixtures/generate-merge.mjs
 *
 * Each case is a base document and two edits of it: `mine`, the save that
 * arrived built on the base, and `theirs`, the file as it stands. The edits are
 * written below as replacements on the base, so a case reads as what each side
 * did. The answers (the merged text, or null, and the conflicts) are the
 * board's, and core/todo.py's merge_saves() is held to them by
 * core/test_todo.py. Read the diff before committing it.
 */
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import vm from 'node:vm'

const HERE = path.dirname(url.fileURLToPath(import.meta.url))
const board = vm.runInNewContext(
  fs.readFileSync(path.join(HERE, '..', 'todo.js'), 'utf8') + '\n;({ mergeSaves });\n',
  {}, { filename: 'core/todo.js' })

const BASE = [
  '# To-do',
  '',
  '## 1. Work',
  '',
  'What the work bucket is for.',
  '',
  '### To do',
  '',
  '- [ ] **Write the brief** [impact:: high] [effort:: M] [due:: 2026-10-30] `id:aaaaaa`',
  '  - Notes on the brief.',
  '- [ ] **Book the venue** [impact:: med] `id:bbbbbb`',
  '  - [ ] Call the venue `id:s00001`',
  '  - [ ] Send the deposit `id:s00002`',
  '    - Deposit is 10%.',
  '- [ ] **Order badges** `id:cccccc`',
  '',
  '### Doing',
  '',
  '',
  '### Done',
  '',
  '- [x] **Old thing** `done:2026-10-01` `id:dddddd`',
  '',
  '---',
  '',
  '## 2. Home',
  '',
  '### To do',
  '',
  '- [ ] **Fix the shelf** [to:: Jerome] `id:eeeeee`',
  '',
  '---',
  '',
  '## Context',
  '',
  '- Ana is away until Monday.',
  ''
].join('\n')

/* [from, to] pairs applied in order; a `to` of null deletes the line(s). */
const edit = (pairs) => pairs.reduce((text, [from, to]) => {
  if (!text.includes(from)) throw new Error('no ' + JSON.stringify(from))
  return to === null ? text.replace(from + '\n', '') : text.replace(from, to)
}, BASE)

const CASES = [
  { why: 'nothing changed on either side', mine: [], theirs: [] },
  { why: 'only the save changed something', mine: [['[due:: 2026-10-30]', '[due:: 2026-11-02]']], theirs: [] },
  { why: 'only the file changed something', mine: [], theirs: [['**Order badges**', '**Order name badges**']] },
  { why: 'two saves on different tasks both land',
    mine: [['[due:: 2026-10-30]', '[due:: 2026-11-02]']],
    theirs: [['**Fix the shelf** [to:: Jerome]', '**Fix the shelf** [to:: Tiago]']] },
  { why: 'the same task, different fields: both land on one rebuilt line',
    mine: [['[due:: 2026-10-30]', '[due:: 2026-11-02]']],
    theirs: [['[impact:: high] [effort:: M]', '[impact:: low] [effort:: M]']] },
  { why: 'the same field changed apart is a conflict', prefer: ['', 'mine', 'theirs'],
    mine: [['[due:: 2026-10-30]', '[due:: 2026-11-02]']],
    theirs: [['[due:: 2026-10-30]', '[due:: 2026-11-05]']] },
  { why: 'the same field changed to the same value is not a conflict',
    mine: [['[due:: 2026-10-30]', '[due:: 2026-11-02]']],
    theirs: [['[due:: 2026-10-30]', '[due:: 2026-11-02]']] },
  { why: 'deleted in the save, edited in the file', prefer: ['', 'mine', 'theirs'],
    mine: [['- [ ] **Order badges** `id:cccccc`', null]],
    theirs: [['**Order badges**', '**Order name badges**']] },
  { why: 'edited in the save, deleted in the file', prefer: ['', 'mine', 'theirs'],
    mine: [['**Order badges**', '**Order name badges**']],
    theirs: [['- [ ] **Order badges** `id:cccccc`', null]] },
  { why: 'deleted on one side and untouched on the other is deleted',
    mine: [['- [ ] **Order badges** `id:cccccc`', null]],
    theirs: [['**Fix the shelf** [to:: Jerome]', '**Fix the shelf** [to:: Tiago]']] },
  { why: 'both sides add a task to one column: the file\'s order, the save\'s slotted after its neighbour',
    mine: [['- [ ] **Book the venue**', '- [ ] **Mine, after the brief** `id:m00001`\n- [ ] **Book the venue**']],
    theirs: [['- [ ] **Order badges** `id:cccccc`', '- [ ] **Order badges** `id:cccccc`\n- [ ] **Theirs, at the end** `id:t00001`']] },
  { why: 'a task the save added at the top of a column stays at the top',
    mine: [['- [ ] **Write the brief**', '- [ ] **Mine, first** `id:m00002`\n- [ ] **Write the brief**']],
    theirs: [['**Order badges**', '**Order name badges**']] },
  { why: 'moved to another column on one side, renamed on the other',
    mine: [['- [ ] **Order badges** `id:cccccc`\n', ''], ['### Doing\n\n', '### Doing\n\n- [ ] **Order badges** `id:cccccc`\n']],
    theirs: [['**Order badges**', '**Order name badges**']] },
  { why: 'moved to two different columns is a conflict on the column', prefer: ['', 'theirs'],
    mine: [['- [ ] **Order badges** `id:cccccc`\n', ''], ['### Doing\n\n', '### Doing\n\n- [ ] **Order badges** `id:cccccc`\n']],
    theirs: [['- [ ] **Fix the shelf** [to:: Jerome] `id:eeeeee`', '- [ ] **Fix the shelf** [to:: Jerome] `id:eeeeee`\n- [ ] **Order badges** `id:cccccc`'],
             ['- [ ] **Order badges** `id:cccccc`\n\n### Doing', '\n### Doing']] },
  { why: 'ticked in the file, re-dated in the save',
    mine: [['[due:: 2026-10-30]', '[due:: 2026-11-02]']],
    theirs: [['- [ ] **Write the brief** [impact:: high] [effort:: M] [due:: 2026-10-30] `id:aaaaaa`\n  - Notes on the brief.\n', ''],
             ['### Done\n\n', '### Done\n\n- [x] **Write the brief** [impact:: high] [effort:: M] [due:: 2026-10-30] `done:2026-10-23` `id:aaaaaa`\n  - Notes on the brief.\n']] },
  { why: 'sub-tasks: one ticked in the save, one added in the file',
    mine: [['- [ ] Call the venue', '- [x] Call the venue']],
    theirs: [['    - Deposit is 10%.', '    - Deposit is 10%.\n  - [ ] Confirm numbers `id:s00003`']] },
  { why: 'sub-tasks: the same field changed apart is a conflict naming the sub-task', prefer: ['', 'mine'],
    mine: [['Call the venue `id:s00001`', 'Call the venue [due:: 2026-10-28] `id:s00001`']],
    theirs: [['Call the venue `id:s00001`', 'Call the venue [due:: 2026-10-29] `id:s00001`']] },
  { why: 'sub-tasks: deleted in the save, edited in the file', prefer: ['', 'mine', 'theirs'],
    mine: [['  - [ ] Call the venue `id:s00001`', null]],
    theirs: [['Call the venue `id:s00001`', 'Call the venue [to:: Jerome] `id:s00001`']] },
  { why: 'notes edited in the save, a sub-task ticked in the file',
    mine: [['  - [ ] Call the venue `id:s00001`', '  - Ring before noon.\n  - [ ] Call the venue `id:s00001`']],
    theirs: [['- [ ] Send the deposit', '- [x] Send the deposit']] },
  { why: 'notes edited apart is a conflict', prefer: ['', 'theirs'],
    mine: [['Notes on the brief.', 'Notes on the brief, mine.']],
    theirs: [['Notes on the brief.', 'Notes on the brief, theirs.']] },
  { why: 'a task with no id yet, given a different one by each tab, is one task',
    base: [['**Order badges** `id:cccccc`', '**Order badges**']],
    mine: [['**Order badges**', '**Order badges** [due:: 2026-11-01] `id:m1m1m1`']],
    theirs: [['**Order badges**', '**Order badges** `id:t1t1t1`']] },
  { why: 'the same task added on both sides with one id is one task',
    mine: [['- [ ] **Order badges** `id:cccccc`', '- [ ] **Order badges** `id:cccccc`\n- [ ] **Both added** `id:b00001`']],
    theirs: [['- [ ] **Order badges** `id:cccccc`', '- [ ] **Order badges** `id:cccccc`\n- [ ] **Both added** `id:b00001`'],
             ['**Fix the shelf** [to:: Jerome]', '**Fix the shelf** [to:: Tiago]']] },
  { why: 'a bucket added in the save, Context edited in the file',
    mine: [['## Context', '## 3. Garden\n\n### To do\n\n- [ ] **Mow** `id:g00001`\n\n---\n\n## Context']],
    theirs: [['- Ana is away until Monday.', '- Ana is back.']] },
  { why: 'a bucket renamed in the file keeps the save\'s edits to its tasks',
    mine: [['**Fix the shelf** [to:: Jerome]', '**Fix the shelf** [to:: Tiago]']],
    theirs: [['## 2. Home', '## 2. House']] },
  { why: 'Context changed apart is a conflict at the bottom of the file', prefer: ['', 'mine'],
    mine: [['- Ana is away until Monday.', '- Ana is away until Tuesday.']],
    theirs: [['- Ana is away until Monday.', '- Ana is back.']] },
  { why: 'who last edited comes from the file, and is never a conflict',
    base: [['**Order badges** `id:cccccc`', '**Order badges** `created-by:jerome@example.com` `id:cccccc`']],
    mine: [['**Order badges**', '**Order name badges**'], ['`created-by:jerome@example.com`', '`created-by:mallory@example.com`']],
    theirs: [['**Order badges** `created-by:jerome@example.com`', '**Order badges** `urgent` `created-by:jerome@example.com` `edited-by:ana@example.com`']] },
  { why: 'an unknown tag rides along on a rebuilt line',
    base: [['`id:cccccc`', '`id:cccccc` `mystery:7`']],
    mine: [['**Order badges**', '**Order name badges**']],
    theirs: [['**Order badges** `id:cccccc`', '**Order badges** `urgent` `id:cccccc`']] },
  { why: 'a lead added in the save, the impact changed in the file: both land on one rebuilt line',
    mine: [['[impact:: med] `id:bbbbbb`', '[impact:: med] [lead:: acme-studio] `id:bbbbbb`']],
    theirs: [['[impact:: med] `id:bbbbbb`', '[impact:: high] `id:bbbbbb`']] },
  { why: 'different leads set on each side is a conflict on the lead', prefer: ['', 'mine', 'theirs'],
    mine: [['[impact:: med] `id:bbbbbb`', '[impact:: med] [lead:: acme-studio] `id:bbbbbb`']],
    theirs: [['[impact:: med] `id:bbbbbb`', '[impact:: med] [lead:: beta-co] `id:bbbbbb`']] }
]

const cases = []
for (const c of CASES) {
  const base = c.base ? edit(c.base) : BASE
  const apply = pairs => pairs.reduce((text, [from, to]) => {
    if (!text.includes(from)) throw new Error(c.why + ': no ' + JSON.stringify(from))
    return to === null ? text.replace(from + '\n', '') : text.replace(from, to)
  }, base)
  const mine = apply(c.mine), theirs = apply(c.theirs)
  for (const prefer of c.prefer || ['']) {
    const got = board.mergeSaves(base, mine, theirs, prefer ? { prefer } : {})
    cases.push({ why: c.why + (prefer ? ' (prefer ' + prefer + ')' : ''), base, mine, theirs, prefer,
                 text: got.text, conflicts: got.conflicts })
  }
}
fs.writeFileSync(path.join(HERE, 'merge.json'), JSON.stringify({ cases }, null, 2) + '\n')
console.log(cases.length + ' merge cases written')
