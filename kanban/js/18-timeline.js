'use strict';

/* =========================================================================
   4c. Timeline — top-level tasks as bars across dates, grouped by bucket.

   `start:` and `due:` already exist on every task and sub-step (see "Two
   dates, not one" in the README) — this view is the first thing to draw both
   of them at once rather than reading one and ignoring the other.

   Nothing here invents a date the file doesn't have. (One exception, drawn
   and not written: a task with neither date but a dated open step draws a
   span from the earliest to the latest step date, outlined rather than
   filled. It writes nothing until it is dragged, which gives the task its
   own start and due.) A task with both draws
   as a bar; a task with only `due:` — most of the list — draws as a diamond
   on that date rather than a bar backed by a start date nobody set; a task
   with only `start:` draws the same diamond on its start, outlined rather
   than filled, whether that start is past or still to come. It used to draw
   as a bar out to today, which for a start next week painted the days
   before it could begin. A task with neither gets a lane row with an empty
   track, which dates it when clicked or dragged.

   A lane's vertical order is its own thing, not the tier order the board
   uses — a lane mixes tasks pulled from every tier, so there is no shared
   position to read one off. Dragging a row's label writes `tlrank`, and only
   dragging ever does; a lane nobody has touched just keeps falling back to
   board order (see timelineSection()).
   ========================================================================= */
const TL_DAY_PX = 28;
const TL_MIN_DAYS = 56;          // ~8 weeks, so a short list isn't a sliver

function addDays(d, n){ const r = new Date(d); r.setDate(r.getDate() + n); return r; }
/* Standard ISO-8601 week number — the same figure `week_tag` in server.py
   already stamps a weekly backup with, computed here instead because the
   header labels every week in range, not just the current one. */
function isoWeekNumber(d){
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (t.getUTCDay() + 6) % 7;               // Mon=0..Sun=6
  t.setUTCDate(t.getUTCDate() - day + 3);            // nearest Thursday
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const firstDay = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - firstDay + 3);
  return 1 + Math.round((t - firstThu) / (7 * 86400000));
}

/* Same split `matrixTasks` does — top-level only, open only, `matches()`
   filtered — plus the one extra split this view needs: dated vs undated.
   "Dated" means the task itself carries a date, or one of its steps does,
   since a step's own bar would otherwise never be reachable. */
/* A sub-task's bar is its bucket's colour two steps darker on the same Tenon
   scale, so it reads as part of the task above without matching its weight.
   The steps per theme live in board.css as --tl-sub-N; a colour that isn't
   one of the chart swatches falls through unchanged. */
function subBarColor(color){
  const m = /^var\(--tenon-chart-(\d+)\)$/.exec(color || '');
  return m ? 'var(--tl-sub-' + m[1] + ', ' + color + ')' : color;
}

function timelineTasks(){
  const items = allItems();
  const dated = [], undated = [];
  // Same bucket tabs as the board and Matrix — see the comment in
  // matrixTasks for why blocker lookups stay against the full items list.
  const shownNames = new Set(shownBuckets().map(b => b.name));
  state.doc.buckets.forEach((b, bi) => {
    if (!shownNames.has(b.name)) return;
    const color = bucketColor(b.name, bi);
    b.tiers.forEach(tier => tier.tasks.forEach(t => {
      if (t.done || !matches(t, tier.name)) return;
      const it = items.find(i => i.id === t.id && !i.sub);
      const blocked = !!it && !actionable(items, it);
      // A step with no date of its own shows the task's, the way the drawer
      // shows what it inherits. It carries its own id, so it drags and opens
      // like a task; one written before ids were minted keeps its parent's
      // and stays still. Every open step gets a row now, dated or not — a
      // dateless one under a dateless task draws an empty track same as the
      // task above it, rather than being left off entirely.
      const steps = splitBody(t).steps
        .filter(s => !s.done)
        .map(s => ({ id: s.stableId || t.id, sub: !!s.stableId, title: s.clean, color: subBarColor(color),
                     start: laterOf(s.start, t.start), due: s.due || t.due }));
      const row = { id: t.id, title: t.title, bucket: b.name, color,
                    start: t.start, due: t.due, blocked, steps, tlrank: t.tlrank,
                    span: (t.start || t.due) ? null : tlSpanOf(steps) };
      // Whether the task itself carries a date, or a step does — same test as
      // before, just no longer readable off steps.length now that a dateless
      // step is kept too. Every row gets a lane row either way (see timelineSection).
      const hasDate = !!(t.start || t.due) || steps.some(s => s.start || s.due);
      (hasDate ? dated : undated).push(row);
    }));
  });
  return { dated, undated };
}

/* The earliest and latest date across a list of steps, folding every start
   and due (a step with one date gives that one). Null when none has a date.
   Dates are YYYY-MM-DD, so a plain compare is a chronological one. */
function tlSpanOf(steps){
  let lo = null, hi = null;
  steps.forEach(s => [s.start, s.due].forEach(v => {
    if (!v) return;
    if (lo == null || v < lo) lo = v;
    if (hi == null || v > hi) hi = v;
  }));
  return lo == null ? null : { start: lo, due: hi };
}

/* The day range every lane draws against, padded a few days either side so a
   bar or diamond is never flush against the scroll edge, and floored to a
   minimum span so three tasks next week don't render as a two-inch strip. */
function timelineScale(dated){
  let min = today(), max = today();
  dated.forEach(row => {
    [row.start, row.due].concat(row.steps.flatMap(s => [s.start, s.due])).forEach(v => {
      const d = parseDue(v);
      if (!d) return;
      if (d < min) min = d;
      if (d > max) max = d;
    });
  });
  min = addDays(min, -3);
  max = addDays(max, 4);
  let days = Math.round((max - min) / 86400000);
  if (days < TL_MIN_DAYS) days = TL_MIN_DAYS;
  return { min, days, dayPx: TL_DAY_PX };
}
function tlOffset(scale, dateStr){
  const d = parseDue(dateStr);
  return d ? Math.round((d - scale.min) / 86400000) : null;
}
/* The first of each month inside the scale's range, so the header can label
   the scale without a caller having to walk the calendar itself. */
function tlMonths(scale){
  const out = [];
  const cur = new Date(scale.min.getFullYear(), scale.min.getMonth(), 1);
  const end = addDays(scale.min, scale.days);
  if (cur < scale.min) cur.setMonth(cur.getMonth() + 1);
  while (cur <= end) {
    out.push({ offset: Math.round((cur - scale.min) / 86400000),
               label: cur.toLocaleDateString(undefined, { month:'short', year:'numeric' }) });
    cur.setMonth(cur.getMonth() + 1);
  }
  return out;
}
/* Every Monday inside the scale's range, each with its ISO week number —
   the gridlines that actually mean something, rather than a plain repeat
   every seven days from wherever the scale happens to start. */
function tlWeeks(scale){
  const out = [];
  const cur = new Date(scale.min);
  const dow = (cur.getDay() + 6) % 7;                // Mon=0..Sun=6
  if (dow !== 0) cur.setDate(cur.getDate() + (7 - dow));
  const end = addDays(scale.min, scale.days);
  while (cur <= end) {
    out.push({ offset: Math.round((cur - scale.min) / 86400000), n: isoWeekNumber(cur) });
    cur.setDate(cur.getDate() + 7);
  }
  return out;
}
/* Every Saturday–Sunday inside the scale's range, as one two-day span each —
   decided in IMPROVEMENTS.md against collapsing them: a weekend stays real
   space on the axis, no change to tlOffset or the day-to-pixel math anywhere
   else, and is marked instead with a diagonal-striped seam (see .tlweekend
   in board.css) so five working days next to two off ones still reads as
   what it is without the scale itself lying about how long either span is. */
function tlWeekends(scale){
  const out = [];
  const cur = new Date(scale.min);
  const dow = cur.getDay();                          // Sun=0..Sat=6
  if (dow !== 6) cur.setDate(cur.getDate() + ((6 - dow + 7) % 7));
  const end = addDays(scale.min, scale.days);
  while (cur <= end) {
    out.push({ offset: Math.round((cur - scale.min) / 86400000) });
    cur.setDate(cur.getDate() + 7);
  }
  return out;
}

/* One row as data for TimelineBody (kanban/ui/TimelineBody.tsx): a sticky
   label plus a track the width of the whole scale, with the bar or diamond
   positioned inside it by day offset. `sub` is a step nested under its
   parent: same track, thinner mark, and the same drags a task has, which
   rewrite its line's own tags through tlTarget(). A step with no id of its
   own has nothing to write to, so it alone stays still.

   Every task's mark has an edge at each end. On a bar they set start and due.
   A diamond's left edge sets the start and its right edge the due, so on a
   due-only diamond the left one adds the start it is missing, and on a
   start-only one the right one adds the due, either way making it a bar.
   Dragging the diamond itself moves the one date it has. */
function timelineRowModel(row, scale, sub){
  const s = tlOffset(scale, row.start), d = tlOffset(scale, row.due);
  const drag = !sub || row.sub;
  let mark = null;
  if (s != null && d != null) {
    const di = dueInfo(row.due);
    mark = { kind: 'bar', left: Math.min(s, d) * scale.dayPx,
             width: Math.max(1, Math.abs(d - s) + 1) * scale.dayPx,
             dueCls: di ? di.cls : undefined, title: row.title,
             drag: drag ? 'move' : null, handles: drag };
  } else if (s != null) {
    mark = { kind: 'milestone', start: true, left: s * scale.dayPx, width: scale.dayPx,
             title: row.title + ' — starts ' + dueLabel(row.start) + ', no due date yet',
             drag: drag ? 'start' : null, handles: drag };
  } else if (d != null) {
    const di = dueInfo(row.due);
    mark = { kind: 'milestone', left: d * scale.dayPx, width: scale.dayPx, dueCls: di ? di.cls : undefined,
             title: row.title, drag: drag ? 'due' : null, handles: drag };
  } else if (row.span && !sub) {
    const a = tlOffset(scale, row.span.start), z = tlOffset(scale, row.span.due);
    mark = { kind: 'span', left: a * scale.dayPx, width: Math.max(1, z - a + 1) * scale.dayPx,
             title: row.title + ' — spans its steps', drag: 'move', handles: true };
  }
  // A step carries no colour of its own (see timelineTasks), and never has.
  return { id: row.id, title: row.title, sub: !!sub, draggable: drag,
           blocked: !!row.blocked, color: row.color, mark,
           steps: (!sub && row.steps) ? row.steps.length : 0, expanded: tlExpanded.has(row.id) };
}

/* A lane: its tasks in order, each followed by its steps when expanded. */
function timelineLaneModel(bucket, rows, scale){
  const key = 'tl:' + bucket;
  const out = [];
  rows.forEach(row => {
    out.push(timelineRowModel(row, scale));
    if (row.steps.length && tlExpanded.has(row.id)) {
      row.steps.forEach(st => out.push(timelineRowModel(st, scale, true)));
    }
  });
  return { bucket, color: rows[0].color, collapseKey: key, open: !sectionCollapsed(key),
           count: rows.length, rows: out };
}

/* The header's months, week numbers, weekends and today, in day offsets. */
function timelineScaleModel(scale){
  return {
    dayPx: scale.dayPx,
    trackWidth: scale.days * scale.dayPx,
    labelWidth: state.tlLabelWidth,
    months: tlMonths(scale),
    weeks: tlWeeks(scale),
    weekends: tlWeekends(scale),
    // Half a day in, so the line runs down the middle of today's column,
    // the same place a diamond due today sits.
    todayOffset: tlOffset(scale, ymd(today())) + 0.5,
  };
}

/* Everything the Timeline's body draws, as data for TimelineBody. Every open top-level task gets a lane row
   now, dated or not — an undated one draws with an empty track, clickable
   the same way a dated one's already was. `scale` is null only when nothing at all is open —
   dated.length === 0 no longer means that, since an undated row still needs
   a scale to draw its empty track against (see timelineScale, which floors
   to a window around today with nothing dated to measure). The count is
   every open top-level task, dated or not. */
function timelineSection(){
  const { dated, undated } = timelineTasks();
  const rows = dated.concat(undated);
  if (!rows.length) return { model: { scale: null, lanes: [], legendColors: [] }, n: 0 };
  const scale = timelineScale(dated);
  const byBucket = new Map();
  rows.forEach(row => {
    if (!byBucket.has(row.bucket)) byBucket.set(row.bucket, []);
    byBucket.get(row.bucket).push(row);
  });
  const lanes = [];
  byBucket.forEach((bucketRows, bucket) => {
    // Dragged rows carry a `tlrank` and sort by it; everything else falls
    // back to board order, same split Delegate uses for its own `rank`.
    const ranked = bucketRows.filter(r => r.tlrank != null).sort((a, b) => a.tlrank - b.tlrank);
    const unranked = bucketRows.filter(r => r.tlrank == null);
    lanes.push(timelineLaneModel(bucket, ranked.concat(unranked), scale));
  });
  const stepIds = rows.filter(r => r.steps.length).map(r => r.id);
  return {
    model: { scale: timelineScaleModel(scale), lanes,
             hasSteps: stepIds.length > 0, allExpanded: stepIds.length > 0 && stepIds.every(id => tlExpanded.has(id)),
             legendColors: Array.from(byBucket.values()).map(bucketRows => bucketRows[0].color) },
    n: dated.length + undated.length,
  };
}

/* Which day of the scale a pointer is over, measured against .tlbody. */
function tlDayAt(body, clientX){
  const rect = body.getBoundingClientRect();
  const scale = timelineScale(timelineTasks().dated);
  return { rect, scale, dayN: Math.floor((clientX - rect.left - state.tlLabelWidth) / scale.dayPx) };
}

/* Every pointer interaction the Timeline has, handed to TimelineBody as props.
   A locked tab gets none of them: renderSections() passes null instead. */
const timelineHandlers = {
  // An in-progress drag or track click (tlTrackActive) suppresses the hover
  // guide, since the mark being dragged already says which day it is.
  onScalePointerMove(e, body){
    if (tlReorderId || tlTrackActive) { hideTlHoverLine(); return; }
    const { rect, scale, dayN } = tlDayAt(body, e.clientX);
    const x = e.clientX - rect.left - state.tlLabelWidth;
    if (x < 0 || e.clientY < rect.top || dayN < 0 || dayN > scale.days) { hideTlHoverLine(); return; }
    showTlHoverLine(scale, dayN);
  },
  onScalePointerLeave(){ hideTlHoverLine(); },
  onMarkPointerDown(e, id, kind){ tlMarkPointerDown(e, id, kind); },
  onTrackPointerDown(e, id){ tlTrackPointerDown(e, id); },
  onResizePointerDown(e, scroll){ tlResizePointerDown(e, scroll); },
  onResizeReset(){ setTlLabelWidth(200); },
  onReorderStart(){ tlReorderId = true; hideTlHoverLine(); },
  onReorderEnd(){ tlReorderId = null; },
  onReorder(bucket, ids){ reorderTimelineLane(ids); },
};

/* The lane header's "Sort by date" button — a one-off, not a standing rule.
   Writes `tlrank` in earliest-date order (`start:` where it exists, else
   `due:`, both plain `YYYY-MM-DD` strings so a lexical compare is already a
   chronological one) across every dated task in that bucket, the same field
   a grip drag writes one row at a time (see reorderTimelineLane below). A later
   drag on any single row overwrites its own rank same as it always did —
   this does not lock the lane into staying date-ordered. */
function sortTimelineLane(bucket){
  if (state.locked) return;
  const rows = timelineTasks().dated.filter(r => r.bucket === bucket);
  const ranked = rows.slice().sort((a, b) => {
    const da = a.start || a.due, db = b.start || b.due;
    return da < db ? -1 : da > db ? 1 : 0;
  });
  ranked.forEach((row, i) => {
    const loc = locate(row.id);
    if (loc) { loc.task.tlrank = i; loc.task.dirty = true; }
  });
  markDirty();
  refreshView();
}

/* Dragging a row's label up or down writes a `tlrank` on every task in that
   lane, renumbered 0.. in the row's new visual order, the dedicated order
   timelineSection() reads back (see there). The drag itself is Tenon's
   `bindReorder`, bound once per lane by the `Lane` component in
   kanban/ui/TimelineBody.tsx, so a task can only be reordered against others
   in the same bucket. `bindReorder` stops its own dragover and drop at the
   lane. This is
   what it calls with the lane's task ids in their new order.

   tlReorderId is still tracked by hand, for the hover line's guard above:
   bindReorder doesn't hand out a "mid-drag" flag of its own. */
let tlReorderId = null;
function reorderTimelineLane(ids){
  tlReorderId = null;
  ids.forEach((rowId, i) => {
    const loc = locate(rowId);
    if (loc) { loc.task.tlrank = i; loc.task.dirty = true; }
  });
  markDirty();
  refreshView();
}

/* The grey hover guide — .tltoday's own line and label, but following the
   pointer instead of pinned to today, so the reader always knows exactly
   which day is under the cursor before clicking or dragging on a row's
   track. The label lives in the sticky header's track, the same place
   .tltodaylabel does, so it stays visible through a horizontal scroll; the
   line itself is a sibling of the rows, the same as .tltoday. Both are
   appended to the .tlbody React drew rather than drawn by it, since they
   follow the pointer on every move; renderSections() removes them before
   each render, because React keeps the same .tlbody from one render to the
   next rather than replacing it. */
let tlHoverEl = null, tlHoverLabelEl = null;
function showTlHoverLine(scale, dayN){
  const body = $('.tlbody');
  if (!body) return;
  if (!tlHoverEl) {
    tlHoverEl = document.createElement('div');
    tlHoverEl.className = 'tlhoverline';
    body.appendChild(tlHoverEl);
  }
  tlHoverEl.style.left = (state.tlLabelWidth + (dayN + 0.5) * scale.dayPx) + 'px';
  const headerTrack = body.querySelector('.tlheader .tltrack');
  if (!headerTrack) return;
  if (!tlHoverLabelEl) {
    tlHoverLabelEl = document.createElement('span');
    tlHoverLabelEl.className = 'tlhoverlabel';
    headerTrack.appendChild(tlHoverLabelEl);
  }
  tlHoverLabelEl.style.left = ((dayN + 0.5) * scale.dayPx) + 'px';
  tlHoverLabelEl.textContent = dueLabel(ymd(addDays(scale.min, dayN)));
}
function hideTlHoverLine(){
  if (tlHoverEl) { tlHoverEl.remove(); tlHoverEl = null; }
  if (tlHoverLabelEl) { tlHoverLabelEl.remove(); tlHoverLabelEl = null; }
}

/* A small fixed tooltip that follows the pointer — the live date(s) while a
   bar or milestone is being dragged. One element, reused rather than
   rebuilt, the same way the matrix and trend-line hover previews are. */
let tlPopoverEl = null;
function showTlPopover(x, y, text){
  if (!tlPopoverEl) {
    tlPopoverEl = document.createElement('div');
    tlPopoverEl.className = 'tlpopover';
    document.body.appendChild(tlPopoverEl);
  }
  tlPopoverEl.textContent = text;
  tlPopoverEl.style.left = x + 'px';
  tlPopoverEl.style.top = (y - 14) + 'px';
  tlPopoverEl.classList.add('on');
}
function hideTlPopover(){ if (tlPopoverEl) tlPopoverEl.classList.remove('on'); }

/* Drag a bar or a milestone to reschedule the task it belongs to, straight
   from the chart — the Gantt exists to make "push this a week" a drag rather
   than a trip to the drawer. Three targets, all wired the same way:
     .tlbar itself       — data-tldrag="move", shifts start and due together
     .tlhandle-l/-r       — data-tldrag="start"/"due", resizes one end
     .tlmilestone         — data-tldrag="due", or "start" on a start-only
                            diamond, the only date it has
   A sub-task's marks carry the same, written through tlTarget(); only a step
   with no id of its own gets none (see Mark in kanban/ui/TimelineBody.tsx).
   This is the handler each mark's
   onPointerDown calls, with the element as e.currentTarget.

   A stopped drag under a few pixels is treated as the click it probably
   was — `moved` stays false and nothing is written, so the native click
   pointerup is about to fire still opens the drawer. A drag that actually
   moved never gets that far: `ev.preventDefault()` inside move(), once
   movement is confirmed, is what stops the browser following through with
   that trailing click at all, so there is nothing left to suppress by hand
   once the drag itself has run.

   React keeps the same element from one render to the next, where the string
   version replaced it, so up() takes both its listeners off: one left behind
   would fire on a later pointercancel and write this drag's dates again. */
/* What a timeline drag writes to: a task's own start and due, or a sub-task's
   line through readSub()/writeSub(), the way its drawer writes it. `start` and
   `due` are what the row shows, inherited dates included, so a drag starts
   from the mark on screen and writes the step dates of its own. */
function tlTarget(id){
  const loc = locate(id);
  if (loc) {
    const t = loc.task;
    // A task with neither date drawn as a span starts its drag from the span's
    // dates; write() below still lands on the task, both dates at once.
    const span = (t.start || t.due) ? null : tlSpanOf(splitBody(t).steps.filter(s => !s.done));
    return { start: span ? span.start : t.start, due: span ? span.due : t.due,
             write(start, due){
               if (span) { t.start = start != null ? start : span.start; t.due = due != null ? due : span.due; }
               else {
                 if (start != null) t.start = start;
                 if (due != null) t.due = due;
               }
               t.dirty = true;
             } };
  }
  const found = locateSub(id);
  if (!found || !found.loc) return null;
  const t = found.loc.task, line = found.step.line;
  const cur = readSub(t, line);
  if (!cur) return null;
  return { start: laterOf(cur.start, t.start), due: cur.due || t.due,
           write(start, due){
             const f = readSub(t, line);
             if (!f) return;
             if (start != null) f.start = start;
             if (due != null) f.due = due;
             writeSub(t, line, f);
           } };
}

function tlMarkPointerDown(e, id, kind){
  const el = e.currentTarget;
  if (e.button) return;
  // A handle sits inside its own .tlbar, which carries data-tldrag="move"
  // too — without this, the pointerdown a handle just handled keeps
  // bubbling, reaches the bar's own handler as well, and that second
  // handler's setPointerCapture() steals the pointer back off the
  // handle, so every resize drag was actually moving the whole bar.
  e.stopPropagation();
  const t = tlTarget(id);
  const track = el.closest('.tltrack');
  if (!t || !track) return;
  const scale = timelineScale(timelineTasks().dated);
  const bar = el.classList.contains('tlbar') ? el : el.closest('.tlbar');
  // A diamond's edge handles sit beside it rather than in it, so a press on
  // one still moves the diamond while the drag keeps to one date. Once it
  // spans two, the range is shown as a ghost bar, the one an empty track drag
  // draws, and the diamond stays where it was.
  const milestone = el.classList.contains('tlmilestone') ? el
    : (!bar && el.classList.contains('tlmhandle')
       ? track.querySelector('.tlmilestone[data-tlrow="' + id + '"]') : null);
  let ghost = null;
  // What React drew, put back before the redraw. React compares the new
  // position with the one it last drew, not with what this drag wrote to the
  // element, so a scale that shifted by exactly the drag would leave the
  // dragged position standing, twice as far along as it should be.
  const drawn = (bar || milestone) ? { left: (bar || milestone).style.left, width: bar ? bar.style.width : '' } : null;
  const trackRect = track.getBoundingClientRect();
  const origStart = t.start ? tlOffset(scale, t.start) : null;
  const origDue = t.due ? tlOffset(scale, t.due) : null;
  const beginDay = Math.round((e.clientX - trackRect.left) / scale.dayPx);
  let moved = false, newStart = origStart, newDue = origDue;

  hideTlHoverLine();
  el.setPointerCapture(e.pointerId);

  const move = ev => {
    if (!moved && Math.abs(ev.clientX - e.clientX) < 3) return;
    // Only once real movement is confirmed, and on this event rather than
    // the pointerdown that started it: calling preventDefault there
    // unconditionally suppresses the click a plain, unmoved press fires
    // afterwards — the same click that opens the drawer the rest of the
    // time. By now preventing it just stops the drag turning into a text
    // selection.
    ev.preventDefault();
    moved = true;
    const day = Math.round((ev.clientX - trackRect.left) / scale.dayPx);
    if (kind === 'move' || el === milestone) {
      // A diamond is picked up by its middle, half a day past the edge a
      // handle sits on, so it moves by how far the pointer has, as a bar
      // does, rather than jumping to the day under it.
      const delta = day - beginDay;
      newStart = origStart != null ? origStart + delta : null;
      newDue = origDue != null ? origDue + delta : null;
    } else if (kind === 'start') {
      newStart = origDue != null ? Math.min(day, origDue) : day;
    } else if (kind === 'due') {
      newDue = origStart != null ? Math.max(day, origStart) : day;
    }
    const endOf = newDue != null ? newDue : newStart;
    const lo = newStart != null ? Math.min(newStart, endOf) : newDue;
    const hi = newStart != null ? Math.max(newStart, endOf) : newDue;
    if (bar) {
      bar.style.left = (lo * scale.dayPx) + 'px';
      bar.style.width = (Math.max(1, hi - lo + 1) * scale.dayPx) + 'px';
    } else if (milestone && newStart != null && newDue != null) {
      if (!ghost) {
        ghost = document.createElement('div');
        ghost.className = 'tlbar tlghostbar';
        ghost.style.setProperty('--bc', milestone.style.getPropertyValue('--bc'));
        track.appendChild(ghost);
      }
      milestone.style.left = drawn.left;
      ghost.style.left = (lo * scale.dayPx) + 'px';
      ghost.style.width = (Math.max(1, hi - lo + 1) * scale.dayPx) + 'px';
    } else if (milestone) {
      if (ghost) { ghost.remove(); ghost = null; }
      milestone.style.left = (lo * scale.dayPx) + 'px';
    }
    const label = newStart != null && newDue != null
      ? dueLabel(ymd(addDays(scale.min, newStart))) + ' → ' + dueLabel(ymd(addDays(scale.min, newDue)))
      : dueLabel(ymd(addDays(scale.min, newStart != null ? newStart : newDue)));
    showTlPopover(ev.clientX, ev.clientY, label);
  };
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    hideTlPopover();
    if (ghost) { ghost.remove(); ghost = null; }
    if (!moved) return;
    if (bar) { bar.style.left = drawn.left; bar.style.width = drawn.width; }
    else if (milestone) milestone.style.left = drawn.left;
    // The click this release is about to fire lands on the same element,
    // which React keeps, and its data-open would open the drawer. The string
    // version never saw it because the redraw had already replaced the bar.
    const swallow = ev => { ev.stopPropagation(); ev.preventDefault(); };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
    t.write(newStart != null ? ymd(addDays(scale.min, newStart)) : null,
            newDue != null ? ymd(addDays(scale.min, newDue)) : null);
    markDirty();
    refreshView();
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up, { once:true });
  el.addEventListener('pointercancel', up, { once:true });
}

/* Click anywhere on a row's own track, outside the mark it already draws, to
   set its due date directly, with no trip to the drawer for "give this a
   deadline". A click that moves before release sets start and due together,
   the two ends of a fresh bar, the same shape tlMarkPointerDown's "move"
   writes. A stopped drag under a few pixels is the click it probably was,
   same rule tlMarkPointerDown uses for the same reason.

   Guarded against the marks .tlbar/.tlmilestone/.tlhandle already draw on
   top of the track: e.target.closest('[data-tldrag]') is true for any of
   them, and this leaves them to tlMarkPointerDown rather than fighting it for
   the same pointerdown. Each row's track calls this from its onPointerDown,
   a sub-task's included; only a step with no id of its own has none. */
let tlTrackActive = false;
function tlTrackPointerDown(e, id){
  const track = e.currentTarget;
  if (e.button) return;
  if (e.target.closest('[data-tldrag]')) return;
  const t = tlTarget(id);
  if (!t) return;
  const scale = timelineScale(timelineTasks().dated);
  const trackRect = track.getBoundingClientRect();
  const beginDay = Math.floor((e.clientX - trackRect.left) / scale.dayPx);
  let moved = false, endDay = beginDay, ghost = null;
  tlTrackActive = true;
  hideTlHoverLine();
  track.setPointerCapture(e.pointerId);

  const move = ev => {
    if (!moved && Math.abs(ev.clientX - e.clientX) < 3) return;
    ev.preventDefault();
    moved = true;
    endDay = Math.floor((ev.clientX - trackRect.left) / scale.dayPx);
    const lo = Math.min(beginDay, endDay), hi = Math.max(beginDay, endDay);
    // The bar being drawn, live: the same shape the real one takes once it
    // lands, not just a popover promising it.
    if (!ghost) {
      ghost = document.createElement('div');
      ghost.className = 'tlbar tlghostbar';
      track.appendChild(ghost);
    }
    ghost.style.left = (lo * scale.dayPx) + 'px';
    ghost.style.width = (Math.max(1, hi - lo + 1) * scale.dayPx) + 'px';
    showTlPopover(ev.clientX, ev.clientY,
      dueLabel(ymd(addDays(scale.min, lo))) + ' → ' + dueLabel(ymd(addDays(scale.min, hi))));
  };
  // Both listeners come off, since React keeps this track for the next
  // render (see tlMarkPointerDown).
  const up = () => {
    track.removeEventListener('pointermove', move);
    track.removeEventListener('pointerup', up);
    track.removeEventListener('pointercancel', up);
    hideTlPopover();
    if (ghost) { ghost.remove(); ghost = null; }
    tlTrackActive = false;
    if (moved) {
      const lo = Math.min(beginDay, endDay), hi = Math.max(beginDay, endDay);
      t.write(ymd(addDays(scale.min, lo)), ymd(addDays(scale.min, hi)));
    } else {
      t.write(null, ymd(addDays(scale.min, beginDay)));
    }
    markDirty();
    refreshView();
  };
  track.addEventListener('pointermove', move);
  track.addEventListener('pointerup', up, { once:true });
  track.addEventListener('pointercancel', up, { once:true });
}

/* Drag the title column's right edge to make it wider or narrower. The
   handle itself sits inside the header's sticky label cell (see Header in
   kanban/ui/TimelineBody.tsx), so it tracks the frozen column during a horizontal
   scroll for free — no separate offset to keep in step. Everything that
   isn't sticky (the today line, the week gridlines) carries its own day
   offset instead, so a resize can reposition them without a full re-render. */
function setTlLabelWidth(px){
  state.tlLabelWidth = Math.round(Math.min(Math.max(px, 120), 400));
  try { localStorage.setItem('bench-tl-label', state.tlLabelWidth); } catch (e) {}
  const body = $('.tlbody');
  if (!body) return;
  body.style.setProperty('--tllabelw', state.tlLabelWidth + 'px');
  const dayPx = +body.dataset.daypx || TL_DAY_PX;
  body.querySelectorAll('[data-dayoffset]').forEach(el => {
    el.style.left = (state.tlLabelWidth + (+el.dataset.dayoffset) * dayPx) + 'px';
  });
}
/* The resize grip's onPointerDown (see Header in kanban/ui/TimelineBody.tsx);
   a double-click resets it through timelineHandlers.onResizeReset. */
function tlResizePointerDown(e, scroll){
  const grip = e.currentTarget;
  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  grip.classList.add('active');
  const rect = scroll.getBoundingClientRect();
  const move = ev => setTlLabelWidth(ev.clientX - rect.left);
  const up = () => {
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', up);
    grip.removeEventListener('pointercancel', up);
    grip.classList.remove('active');
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up, { once:true });
  grip.addEventListener('pointercancel', up, { once:true });
}

/* Overview, Matrix and Timeline draw their sections through the same Column
   every other column in the app is drawn with — a section here has always
   been a column of the list in everything but the furniture it was made of.
   `OverviewView`/`MatrixView`/`TimelineView` (kanban/ui/SectionsView.tsx) are
   the components; `renderSections()` below builds the data
   they draw from. Each still calls the section builders it always called —
   `bigRocksSection()`, `matrixSection()`, `timelineSection()` and the rest.
   Every one of those returns data for a body component.

   The five titles and hints that used to be built here — 'Big rocks', 'High
   impact, L effort...' and the rest — are hardcoded in SectionsView.tsx now,
   since none of the eight across all three views ever varies. What still
   comes from here is only what does: the count, the body, whether an
   Overview section is open (overviewOpen(), unchanged — the toggle listener
   in 19-drawer.js that persists it reads data-column-collapse off the rendered
   <details> either way, string-built or React). */
let sectionsRoot = null;
function sectionsMountPoint(){
  const lists = $('#lists');
  if (!lists) return null;
  let host = lists.querySelector('#sectionsRoot');
  if (!host) {
    if (sectionsRoot) BoardUI.unmount(sectionsRoot);
    lists.innerHTML = '<div id="sectionsRoot"></div>';
    host = lists.querySelector('#sectionsRoot');
    sectionsRoot = host;
  }
  return host;
}

function renderSections(viewId){
  // The grid is rebuilt from scratch here, so any preview on screen is pointing
  // at a dot that no longer exists.
  hideMatrixPreview();
  renderFilterBar();
  // Same bucket tabs as the board, same meaning: narrowed to one bucket
  // unless the AI filter, the urgent filter, the unscored chip or All widens
  // it back out, per shownBuckets().
  const shownNames = new Set(shownBuckets().map(b => b.name));
  const items = allItems().filter(i => shownNames.has(i.bucket));
  const host = sectionsMountPoint();
  if (!host) return;

  // mountFlushed(), not mount(): capMsgCards() below measures the real,
  // painted .ref .msg boxes, which is not something a prop could carry — see
  // the note in kanban/ui/index.ts.
  if (viewId === 'overview') {
    // One section per column, left to right, the same way the board reads.
    BoardUI.mountFlushed(host, BoardUI.OverviewView({
      bigRocks: Object.assign(bigRocksSection(items), { open: overviewOpen('ov:Big rocks') }),
      thisWeek: Object.assign(weekSection(items), { open: overviewOpen('ov:This week') }),
      quickWins: Object.assign(quickSection(items), { open: overviewOpen('ov:Quick wins') }),
    }));
  } else if (viewId === 'reports') {
    // Tasks finished and Written reports, built in 12-reports.js (see
    // reportsColumnProps there). The counted half needs nothing fetched, so the
    // page paints now and the written column fills in when /reports.json lands.
    // ensureWrittenReports() is a no-op on every render but the first of a visit.
    BoardUI.mountFlushed(host, BoardUI.ReportsView({ reports: reportsColumnProps() }));
    ensureWrittenReports();
  } else if (viewId === 'matrix') {
    // The chain sits beside the matrix: both answer "what can I actually start",
    // one by score and one by what is still waiting on something else.
    BoardUI.mountFlushed(host, BoardUI.MatrixView({
      impactEffort: matrixSection(),
      dependencyChain: chainSection(items),
    }));
  } else if (viewId === 'timeline') {
    // The hover line is appended to .tlbody, not drawn by React, and React
    // keeps the same .tlbody across renders, so take it down before this one
    // rather than leave it where it was.
    hideTlHoverLine();
    const tl = timelineSection();
    BoardUI.mountFlushed(host, BoardUI.TimelineView({ timeline: {
      body: BoardUI.h(BoardUI.TimelineBody, {
        model: tl.model, locked: state.locked,
        // A locked tab drags nothing, the same as when this was wired by hand.
        handlers: state.locked ? null : timelineHandlers,
      }),
      count: tl.n,
    } }));
  }

  capMsgCards();
}

/* .ref .msg's three-line clamp is CSS, and CSS alone cannot tell a card that
   happens to run to exactly three lines from one three screens long — so once
   the cards are actually in the DOM, measure each one against its own scroll
   height and mark the ones truncation really cut. Only .capped gets the fade
   and the label; a card that fits gets neither. A clamped box reports the
   same way a height-capped one did: clientHeight is the three lines it shows,
   scrollHeight the whole text. */
function capMsgCards(){
  $('#lists').querySelectorAll('.ref .msg').forEach(el => {
    el.classList.toggle('capped', el.scrollHeight > el.clientHeight + 1);
  });
}

/* The tab strip. Board, Matrix and Timeline are three plain tabs, since the strip
   has the room and a menu would be a click spent finding what is already named
   on the tab. Drawn by BoardUI.ViewTabs (kanban/ui/ViewTabs.tsx), Tenon's
   SegmentedControl; what picking a view does stays here. */
function renderViewTabs(defs){
  BoardUI.mount($('#viewToggle'), BoardUI.h(BoardUI.ViewTabs, {
    defs,
    value: state.view,
    /* syncHash() before the render rather than after it: the write it makes
       has to land while location.hash still names the view being left, or
       there is nothing for Back to return to. renderView() reaches syncHash()
       again through renderTabs(), finds the URL already right and does
       nothing. */
    onPick: id => { state.view = id; syncHash(true); renderView(); },
  }));
  renderPhoneChrome();
}

/* Which view the last renderView() drew, so arriving somewhere can be told
   from redrawing where you already are. Only the report list cares: it is
   re-read on arrival at Reports and not on every filter change there. */
let lastRenderedView = null;

/* Two views: the board, and the hand-written summaries from the end of the file.
   The bucket tabs and search only make sense on the board. */
function renderView(){
  // Up front, not at the end: the board case returns early, and the chip belongs
  // to the header rather than to any one view.
  updateArchiveChip();
  const defs = viewDefs();
  // Quick wins is a column of Overview and Delegate to Claude is no longer
  // drawn, so an old #quick or #delegate link lands on Overview.
  if (state.view === 'quick' || state.view === 'delegate') {
    state.view = 'overview';
  }
  // Plans was once a view. A plan is read from the review behind it
  // now, on the card, so an old #plans link lands on the board.
  if (state.view === 'plans') state.view = 'board';
  // Memory and Backups were views of their own: they are tabs of the Settings
  // page now, and anything that still names them lands there.
  if (state.view === 'memory' || state.view === 'agents' || state.view === 'backups') { settingsTab = state.view; state.view = 'settings'; }
  const isSettings = state.view === 'settings';
  // Projects has no tab, but a #projects link still draws its list.
  const isProjects = state.view === 'projects';
  if (!isSettings && !isProjects && !defs.some(d => d.id === state.view)) state.view = 'board';
  const def = isSettings ? { id:'settings', label:'Settings' }
    : isProjects ? { id:'projects', label:'Projects' }
    : defs.find(d => d.id === state.view);
  const isBoard = def.id === 'board';
  // The bulk action bar only ever means anything on the board — its own
  // check on state.view (19-drawer.js) hides it the moment a tab switch takes
  // this away from 'board', same as leaving the selection itself in place
  // rather than clearing it, so it's waiting there if the owner switches back.
  renderBulkBar();
  // Keep the URL in step with whichever tab is on screen, so a refresh (or a
  // link back to this page) lands on the same view instead of the default.
  // syncHash() (07-render-board.js) does the actual write — every branch below
  // reaches it, via renderBoard() or renderFilterBar() calling renderTabs().
  // state.view is finalised above this point, so whichever branch runs next
  // syncs the URL to the right value.

  // Arriving at Reports, rather than redrawing it: ask for the report list
  // again, since a report Claude wrote while another tab was up would
  // otherwise never show. forgetWrittenReports() only clears the cache — the
  // fetch itself is ensureWrittenReports(), from renderSections().
  if (def.id === 'reports' && lastRenderedView !== 'reports') forgetWrittenReports();
  if (lastRenderedView === 'settings' && def.id !== 'settings') leaveSettingsPage();
  lastRenderedView = def.id;
  if (def.id !== 'settings') leaveAgentsView();

  renderViewTabs(defs);

  $('#board').classList.toggle('hidden', !isBoard);
  $('#lists').classList.toggle('hidden', isBoard);
  // renderColTabs() puts it back; nothing else on any other view wants it.
  if (!isBoard) $('#colTabs').classList.add('hidden');

  if (isBoard) { renderBoard(); return; }
  // The one thing bar is a board idea specifically — pinning a card above
  // columns that don't exist anywhere else has nothing to attach to. Every
  // other control in the header (the bucket tabs, the score chip, AI,
  // urgent, search) applies the same way wherever it's shown, so it stays up
  // on every tab rather than popping in and out as the owner switches between them.
  $('#headline').classList.add('hidden');
  if (def.id === 'projects') { renderFilterBar(); renderProjectsView(); return; }
  if (def.id === 'settings') { renderSettingsPage(); return; }
  renderSections(def.id);
}

/* Re-draw whichever view is on screen. The drawer opens from the lists as well
   as the board now, so an edit has to show up where it was made — renderBoard
   alone does nothing when a list view is up. */
function refreshView(){
  if (state.view === 'board') renderBoard();
  else if (state.view === 'projects') renderProjectsView();
  else if (state.view === 'settings') refreshSettingsPage();
  else renderSections(state.view);
  updateArchiveChip();
}

/* The bar above the board. Empty it is a slim invitation, not a banner: an empty
   headline is a normal state, and the board should not shout about it. */
function renderHeadline(){
  const bar = $('#headline');
  const hl = headlineTask();
  bar.classList.toggle('hidden', state.view !== 'board' || state.locked);
  bar.classList.toggle('set', !!hl);
  if (!hl) {
    BoardUI.mountFlushed(bar, BoardUI.h(BoardUI.HeadlineBar, { model: null, onClear: () => clearHeadline(false) }));
    // Nothing to open, so the bar goes back to being a strip of text. Left set,
    // the old role and handler would survive the removal and open a stale task.
    bar.removeAttribute('role');
    bar.removeAttribute('tabindex');
    bar.onclick = null;
    bar.onkeydown = null;
    return;
  }
  const t = hl.task;
  const di = dueInfo(t.due);
  const blocks = unblockCount(t);
  const set = parseDue(t.headline);
  const age = set ? Math.round((today() - set) / 86400000) : null;

  const chips = [];
  if (t.impact) chips.push({ text: IMPACT_EMOJI[t.impact] || t.impact, title: t.impact + ' impact' });
  if (t.effort) chips.push({ text: t.effort });
  if (di) chips.push({ tone: DUE_TONE[di.cls] || 'neutral', text: di.label + (di.note ? ' · ' + di.note : '') });
  if (blocks) chips.push({ tone: 'success', text: 'frees up ' + blocks + ' other task' + (blocks > 1 ? 's' : '') });

  BoardUI.mountFlushed(bar, BoardUI.h(BoardUI.HeadlineBar, {
    model: {
      title: t.title,
      where: hl.bucket.name + ' · ' + (t.done ? DONE_COL : hl.tier.name),
      chips,
      age: age === null ? null : (age <= 0 ? 'set today' : 'set ' + age + ' day' + (age > 1 ? 's' : '') + ' ago'),
      solved: !!t.done
    },
    onClear: () => clearHeadline(false)
  }));

  /* The whole bar opens the task, like a card. Only the Remove button is carved
     out of that, or the one gesture that gets rid of the headline would open it. */
  bar.setAttribute('role', 'button');
  bar.setAttribute('tabindex', '0');
  bar.onclick = e => { if (!e.target.closest('.hlclear')) openDrawer(t.id); };
  bar.onkeydown = e => {
    if (e.target.closest('.hlclear')) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(t.id); }
  };
}

/* The bucket tabs and the score chip, and the rule that widens both past a
   single bucket — shared by the board and every list view (Overview, Matrix,
   Timeline, Reports, Backups) now, rather than a board-only idea the rest
   only tolerated. Filtering means the same thing wherever it's shown. */
function renderFilterBar(){
  renderTabs();
  renderScoreChip();
  renderAgentFilterChip();
  // Follows the strip it belongs to, and goes with it in a preview or the demo,
  // where the file behind it is not one that can be written to.
  $('#editBuckets').classList.toggle('hidden', state.locked);
  renderPhoneChrome();
}

/* The strip of column names above the board, phone only — which one is on
   screen and how many there are, neither of which a snapped one-column-wide
   board says on its own. Names rather than dots: a dot says where you are in
   the sequence, and the thing that is missing is which column that is. Six
   names do not fit across 400px, so the strip scrolls horizontally itself and
   the lit one is scrolled into view with the column it names.

   Drawn at every width and hidden by CSS above 640px — a width check here
   would be a second breakpoint to keep in step with board.css's. */
function renderColTabs(columns){
  const strip = $('#colTabs');
  if (!strip) return;
  strip.classList.remove('hidden');

  const main = $('#main');
  const cols = () => Array.from($('#board').children);
  /* Nearest left edge rather than scrollLeft divided by a column's width: the
     columns are one width today and the arithmetic would be wrong the moment
     that stops being true, and a measurement costs nothing at six columns. */
  const current = () => {
    const list = cols();
    if (!list.length) return 0;
    let best = 0, dist = Infinity;
    list.forEach((c, i) => {
      const d = Math.abs(c.offsetLeft - main.scrollLeft);
      if (d < dist) { dist = d; best = i; }
    });
    return best;
  };
  const names = columns.map(tierLabel);
  let shown = -1;
  const light = i => {
    if (i === shown) return;
    shown = i;
    BoardUI.mountFlushed(strip, BoardUI.h(BoardUI.ColTabs, {
      names, active: i,
      onPick: n => {
        const c = cols()[n];
        if (c) c.scrollIntoView({ inline:'start', block:'nearest', behavior:'smooth' });
        light(n);
      }
    }));
    const on = strip.querySelector('.coltab.on');
    if (on) on.scrollIntoView({ inline:'nearest', block:'nearest' });
  };
  /* One listener, replaced on every render rather than added to — renderBoard
     runs on every edit and addEventListener would stack them up. */
  main.onscroll = () => light(current());
  light(current());
}

function renderBoard(){
  if (state.view !== 'board') return;
  renderFilterBar();
  renderHeadline();
  const board = $('#board');
  const shown = shownBuckets();
  const many = shown.length > 1;

  const columns = boardColumns();
  board.style.setProperty('--cols', columns.length);
  const data = columns.map(name => {
    const isDone = name === DONE_COL;
    const mode = sortMode(name);
    let entries = [];
    shown.forEach(bucket => {
      const color = bucketColor(bucket.name, state.doc.buckets.indexOf(bucket));
      const label = many ? bucket.name : '';
      if (isDone) {
        /* Its own heading now, so this reads the tier like any other. What the
           tick moves there is setDone()'s job, and gatherDone() in core/todo.js
           does the same for a file written before that was true. */
        const tier = bucket.tiers.find(t => t.name === DONE_COL);
        if (tier) tier.tasks.forEach(t => {
          if (matches(t, DONE_COL)) entries.push({ t, color, label });
        });
      } else {
        const tier = bucket.tiers.find(t => t.name === name);
        if (tier) tier.tasks.forEach(t => {
          if (!t.done && matches(t, name)) entries.push({ t, color, label });
        });
      }
    });
    // Stable: equal scores keep the order the owner put them in, so the sort only ever
    // answers the question it was asked.
    if (mode === 'priority') {
      entries = entries.map((e, i) => ({ e, i }))
        .sort((a, b) => (priorityScore(b.e.t) - priorityScore(a.e.t)) || (a.i - b.i))
        .map(x => x.e);
    }
    const cards = entries.map(e => ({
      model: cardModel(e.t, { muted: name === WAIT_COL, tier: name }),
      stripe: e.color,
      bucketLabel: e.label,
      draggable: !state.locked
    }));

    /* No hint on the board. TIER_HINT is still the source of
       the sentence — the tier editor shows it, and the Plans view's own
       descriptions are the same idea — but on the board the six column names
       carry their own meaning and the subtitle beside each was saying it a
       second time in smaller type.

       The pencil the head carries, one per column. The
       sheet behind it is the one that was reached from the filter bar until
       the button there was hidden — comparative questions need every column
       in front of you — so this opens the same sheet rather than a per-column
       menu, and scrolls to the row for the column it was clicked on. Not on
       Done, which is not a row in it, and not on a locked board, which can
       write nothing. */
    return {
      // What it is called on screen; `name` stays the heading everything else
      // matches by, and is what data-tier and every lookup still use.
      tier: name,
      title: tierLabel(name),
      className: ((isDone ? 'donecol ' : '') +
                  (name === WAIT_COL ? 'waitcol ' : '') + (mode === 'priority' ? 'sorted' : '')).trim(),
      note: (n => n ? n + ' your move' : '')(entries.filter(e => !e.t.done && yourMove(e.t)).length),
      sort: isDone ? null : mode,
      canEdit: !(isDone || state.locked),
      canAdd: !(isDone || state.locked),
      cards
    };
  });

  /* Flushed, because what follows reads the columns this just drew: the phone's
     tab strip measures their offsets, and every caller that opens a card or
     checks a count straight after a render expects it to be there. */
  BoardUI.mountFlushed(board, BoardUI.h(BoardUI.BoardView, {
    columns: data,
    locked: state.locked,
    // multi is shift/cmd/ctrl on the click (TaskCard.tsx) — the board's own cue
    // to add the card to the bulk selection instead of opening it. See
    // toggleCardSelect() and the action bar it feeds, both in 19-drawer.js.
    onOpen: (id, multi) => { if (multi) toggleCardSelect(id); else openDrawer(id); },
    onDragStart: (e, id) => {
      e.dataTransfer.setData('text/plain', id);
      e.dataTransfer.effectAllowed = 'move';
      dragId = id;
    },
    onDragEnd: () => { dragId = null; },
    onHoldStart: (id, el) => { spotlight(el); onCardHoldStart(id, el); },
    onHoldEnd: (id, el) => { clearSpotlight(); onCardHoldEnd(id, el); },
    /* Says where the drop line goes, and nothing else: a sub-step drag is not a
       card, and a sorted column has no gap to drop into because its order is
       worked out. Either way the column still lights up as a valid target. The
       line reads the same cards dropTask() does — only same-bucket ones count,
       since a card can only be reordered against its own bucket's list — so it
       always marks the place the card actually goes. */
    onZoneOver: (e, tier) => {
      e.preventDefault();
      if (subDrag !== null || sortMode(tier) === 'priority') return null;
      const from = dragId ? locate(dragId) : null;
      const dragBucket = from ? from.bucket : null;
      const after = insertAfterEl(e.currentTarget, e.clientY, dragBucket, dragId);
      if (after) return after.dataset.id;
      const anchor = dragBucket ? dropLineAnchorEl(e.currentTarget, dragBucket, dragId) : null;
      return anchor ? anchor.dataset.id : '';
    },
    onZoneDrop: (e, tier) => {
      e.preventDefault();
      const id = e.dataTransfer.getData('text/plain') || dragId;
      if (id) dropTask(id, tier, e.currentTarget, e.clientY);
    },
    onAdd: tier => addTask(tier),
    onEdit: tier => openTierEditor(tier),
    onSort: tier => {
      setSortMode(tier, sortMode(tier) === 'priority' ? 'manual' : 'priority');
      renderBoard();
    }
  }));

  renderColTabs(columns);
}

/* The filter chips beside the bucket strip. The "need scoring" chip is gone
   (1 Nov 2026), so this only redraws the others; unscored() and the matrix
   still know what has no score. */
function renderScoreChip(){ renderFilterChips(); }

/* How many open tasks are delegated to an agent —
   on the task itself or on any of its sub-tasks (delegatedToAgent(),
   07-render-board.js) — across every bucket the tabs say, same reasoning as
   the score chip above. Clicking it narrows to just those. */
function renderAgentFilterChip(){ renderFilterChips(); }

function renderFilterChips(){
  const host = $('#filterChips');
  if (!host) return;
  let agentN = 0, mineN = 0;
  if (state.doc) state.doc.buckets.forEach(b => b.tiers.forEach(ti => ti.tasks.forEach(t => {
    if (t.done) return;
    if (delegatedToAgent(t)) agentN++;
    if (forMe(t)) mineN++;
  })));
  const noDoc = !state.doc;
  BoardUI.mountFlushed(host, BoardUI.h(BoardUI.FilterChips, { chips: [
    {
      id: 'agentFilterChip',
      hidden: noDoc || (agentN === 0 && !state.agentFilter),
      on: state.agentFilter,
      text: state.agentFilter ? 'Showing ' + agentN + ' delegated to an agent · show all' : agentN + ' delegated to an agent',
      title: state.agentFilter
        ? 'Back to the whole list'
        : 'Tasks handed to an agent, or with a sub-task handed to one. Click to see just those.',
      onClick: () => { state.agentFilter = !state.agentFilter; refreshView(); }
    },
    /* Signed in only: on the Mac every task is the owner's unless it says
       otherwise, so "mine" would be most of the list. */
    {
      id: 'mineChip',
      hidden: noDoc || !state.who || (mineN === 0 && !state.mineFilter),
      on: state.mineFilter,
      avatarHTML: state.who ? personAvatarHTML(state.who.email, personFullName(state.who.email), 14) : undefined,
      text: state.mineFilter ? 'Showing ' + mineN + ' mine · show all' : mineN + ' mine',
      title: state.mineFilter
        ? 'Back to the whole list'
        : 'Tasks with you in “to”, or a sub-task with you in it. Click to see just those.',
      onClick: () => { state.mineFilter = !state.mineFilter; refreshView(); }
    }
  ] }));
}

let dragId = null;
let subDrag = null;
/* Which timeline tasks the user has opened to show their steps. Every task
   starts folded on each load. Not persisted — reparsing mints fresh task ids
   (see resetUndo), so a stored id would stop matching anything by the next
   reload anyway. The chevron opens one task; the header button opens or
   folds all of them (see timelineStepIds). */
let tlExpanded = new Set();

/* Ids of every open task that has steps, for the header's show-all button. */
function timelineStepIds(){
  const { dated, undated } = timelineTasks();
  return dated.concat(undated).filter(r => r.steps.length).map(r => r.id);
}

/* A line showing where the card will land. One element, moved around the board
   rather than one per gap, so there is never more than one target on screen.
   It reads the same cards dropTask does — only same-bucket ones count, since a
   card can only be reordered against its own bucket's list — so the line always
   marks the place the card actually goes. */
let dropLine = null;
function insertAfterEl(zone, clientY, dragBucket, skipId){
  let after = null;
  zone.querySelectorAll('.tenon-card').forEach(el => {
    if (el.classList.contains('dragging') || el.dataset.id === skipId) return;
    const other = locate(el.dataset.id);
    if (!other || (dragBucket && other.bucket !== dragBucket)) return;
    const r = el.getBoundingClientRect();
    if (clientY > r.top + r.height / 2) after = el;
  });
  return after;
}
/* Where the drop line points when insertAfterEl finds no same-bucket card to
   sit under — "top of my own bucket's cards", which is only the same as "top
   of the column" when no other bucket's cards are drawn before it. Otherwise
   the line has to sit right after the last other-bucket card so it doesn't
   point above cards that are still visually there. Line-only: dropTask keeps
   using insertAfterEl on its own, since a fallback here would return a card
   from the wrong bucket's tier and misplace the drop itself. */
function dropLineAnchorEl(zone, dragBucket, skipId){
  let lastOther = null;
  const cards = zone.querySelectorAll('.tenon-card');
  for (let i = 0; i < cards.length; i++) {
    const el = cards[i];
    if (el.classList.contains('dragging') || el.dataset.id === skipId) continue;
    const other = locate(el.dataset.id);
    if (!other) continue;
    // renderBoard() groups entries one bucket at a time, so the first card of
    // the dragged bucket's own group is where its run of cards starts — any
    // other-bucket card after that belongs to a later group, not one sitting
    // above this one, so there is nothing more for the line to skip past.
    if (dragBucket && other.bucket === dragBucket) break;
    if (dragBucket && other.bucket !== dragBucket) lastOther = el;
  }
  return lastOther;
}
function hideDropLine(){ if (dropLine && dropLine.parentNode) dropLine.remove(); }

/* Dropping a card on the bar makes it the one thing. Bound once, not per render,
   since the bar itself is never replaced — only its contents are. */
(function wireHeadlineDrop(){
  const bar = $('#headline');
  bar.ondragover = e => {
    if (subDrag !== null || !dragId) return;
    e.preventDefault();
    bar.classList.add('over');
  };
  bar.ondragleave = e => { if (!bar.contains(e.relatedTarget)) bar.classList.remove('over'); };
  bar.ondrop = e => {
    e.preventDefault();
    bar.classList.remove('over');
    const id = e.dataTransfer.getData('text/plain') || dragId;
    if (id && locate(id)) setHeadline(id);
  };
})();

/* Move a task to another tier, inserting near where it was dropped.
   Cards from other buckets are ignored when working out the position. */
function dropTask(id, tierName, zone, clientY){
  if (state.locked) return;
  const loc = locate(id);
  if (!loc) return;

  // Dropping on Done ticks the task, and setDone() moves it under the heading.
  if (tierName === DONE_COL) {
    const msg = blockedMessage(allItems(), loc.task.blockedBy);
    if (msg) { showToast(msg, 'blocked'); return; }
    if (setDone(loc.task, true)) { markDirty(); refreshView(); }
    if (state.openTask === id) openDrawer(id);
    return;
  }
  // A column says where the card is, never who has it, so a drop leaves
  // `[to::]` alone.
  setDone(loc.task, false, { stay: true });       // dragged back out of Done

  const targetTier = ensureTier(loc.bucket, tierName);

  // In a sorted column the position on screen is worked out, not chosen, so
  // there is nothing to read off the drop point. Move the task into the column
  // and leave the owner's order alone — the sort will place it.
  const manual = sortMode(tierName) !== 'priority';
  const afterEl = manual ? insertAfterEl(zone, clientY, loc.bucket, id) : null;
  const after = afterEl ? (locate(afterEl.dataset.id) || {}).task : null;

  loc.tier.tasks.splice(loc.index, 1);
  let at;
  if (!manual) at = targetTier.tasks.length;
  else if (after) { const k = targetTier.tasks.indexOf(after); at = k > -1 ? k + 1 : targetTier.tasks.length; }
  else at = 0;
  targetTier.tasks.splice(at, 0, loc.task);

  markDirty(); refreshView();
  if (state.openTask === id) openDrawer(id);
}

function addTask(tierName){
  if (state.locked) return;
  const tier = ensureTier(defaultAddBucket(), tierName);
  const t = { id: uid(), done:false, title:'New task', bold:true, impact:'', effort:'', due:'', to:'',
              urgent:false, week:false, slug:'', blockedBy:[], rank:null, extra:[], body:[], raw:'', dirty:true };
  tier.tasks.push(t);
  markDirty(); refreshView(); openDrawer(t.id, true);
}

/* Taking work back off Claude has to take the prompt with it.
   Delegate to Claude is generated from `[to:: Implement agent]`, so a task
   taken back drops out of that list — but the prompt written for it would
   stay behind on the task, still reading as an instruction to hand it over. The
   next person to rebuild the section would have a prompt with nothing asking for
   it. A sub-step delegated in its own right is left alone, because it did not
   inherit the tag that just changed. Returns what was removed, so the change
   can be reported rather than happening silently. */
function stripDelegation(t){
  const removed = [];
  const out = [];
  let base = null, inherits = false;

  t.body.forEach(line => {
    const m = SUB_RE.exec(line);
    if (m && (base === null || m[1].length <= base)) {
      base = m[1].length;
      inherits = !agentOf(readField(m[3], 'to'));          // not an agent's in its own right, so it follows the parent
      let text = m[3];
      if (inherits) text = text.replace(/\s*`rank:\d+`/g, '');
      out.push(m[1] + '- [' + m[2] + '] ' + text);
      return;
    }
    const deeper = base !== null && /^\s+\S/.test(line) && leadIndent(line) > base;
    if (PROMPT_NOTE.test(line) && (!deeper || inherits)) { removed.push(line.trim()); return; }
    out.push(line);
  });

  if (removed.length || t.rank != null) {
    t.body = out;
    t.rank = null;
    t.dirty = true;
  }
  return removed;
}

