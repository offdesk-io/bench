/* Overview, Reports, Matrix and Timeline — the three views `renderSections()` in
 * `kanban/js/18-timeline.js` composes, as components. `refSection()`'s job —
 * wrapping a section in the same `Column` every board column already is —
 * moves here; `$('#lists').innerHTML = '<div class="lists ...">' + html +
 * '</div>' + the trailing note` does too.
 *
 * The shell only. Each section's body is its own component, built from data
 * the section builders in kanban/js/ return: `RefSection` and `ContextBody`
 * for Overview, `MatrixBody` and `ChainBody` for the Matrix, and
 * `TimelineBody` for the Timeline, whose drags are props on it. What still
 * arrives as `{ __html }` goes through `SectionBody.bodyHTML` below.
 *
 * What *is* real here: every title and hint is written once, in this file,
 * rather than concatenated in `refSection()`'s caller — the six of them never
 * vary, so there was no prop to be made of them. A `` `week` `` in a hint is a
 * real `<code>` now rather than something `mdInline()` had to be asked to
 * make one.
 */
import type { ReactNode, CSSProperties } from 'react'
import { Column } from '@tiagopedras/tenon'
import {
  TasksFinishedColumn, WrittenReportsColumn, type ReportsColumnsProps,
} from './ReportsColumns'

/* A body a section builder already rendered — `{ html, n, filters, sort }`
   from `matrixSection()`, or a plainer version of the same shape from the
   Overview and Timeline builders. */
export interface SectionBody {
  /** The body as markup a builder rendered, or as nodes. A section is one or
   *  the other; the Matrix has moved to nodes and the rest have not. */
  bodyHTML?: string
  body?: ReactNode
  count?: number | null
  sortHTML?: string
  sort?: ReactNode
  filtersHTML?: string
  filters?: ReactNode
}

/* One column, built the way every one of the eight below is: a hardcoded
   title and hint, a body a section builder already rendered, and whether it
   is open — Overview's own five remember that per section, Matrix's two and
   the Timeline's one are always open (see refSection() in 18-timeline.js,
   before this port, for why). */
function Section(props: {
  title: string
  hint: ReactNode
  body: SectionBody
  collapsible?: boolean
  collapseKey?: string
  open?: boolean
}) {
  const { title, hint, body, collapsible, collapseKey, open } = props
  return (
    <Column
      titleAs="h3"
      title={title}
      desc={hint}
      count={body.count != null ? body.count : null}
      sort={body.sort ?? (body.sortHTML ? <span dangerouslySetInnerHTML={{ __html: body.sortHTML }} /> : null)}
      filters={body.filters ?? (body.filtersHTML ? <span dangerouslySetInnerHTML={{ __html: body.filtersHTML }} /> : null)}
      className="refcol prose"
      collapsible={collapsible}
      collapseKey={collapseKey}
      open={open}
      children={body.body ?? <span dangerouslySetInnerHTML={{ __html: body.bodyHTML ?? '' }} />}
    />
  )
}

/* Below the grid on every one of these three views — generated from the
   tags on the tasks, never hand-kept, so it is the same line regardless of
   which of the three is showing. */
function ListNote() {
  return (
    <p className="help listnote">
      Generated from the tags on the tasks, so every card here is a real task. Open one to change
      it, then Save.
    </p>
  )
}

/* ---- Overview ---- */

export interface OverviewViewProps {
  bigRocks: SectionBody & { open: boolean }
  thisWeek: SectionBody & { open: boolean }
  quickWins: SectionBody & { open: boolean }
}

/* Three reference columns, each on its own track with a 380px floor. The row
   fills the window evenly at desktop width and scrolls sideways below the floor
   (and snaps one column per screen on a phone, see board.css). Context moved to
   the Memory page and Delegate to Claude is no longer drawn, so nothing else
   shares the row. */
const REF_TRACK = { css: 'minmax(380px,1fr)', min: 394 }

export function OverviewView(props: OverviewViewProps) {
  const { bigRocks, thisWeek, quickWins } = props
  const tracks = [REF_TRACK, REF_TRACK, REF_TRACK]
  const gridStyle: CSSProperties = {
    gridTemplateColumns: tracks.map(t => t.css).join(' '),
    minWidth: tracks.reduce((n, t) => n + t.min, 0) + 'px',
  }

  return (
    <>
      <div className="lists split" style={gridStyle}>
        <Section title="Big rocks" hint="High impact, L effort. Needs protected time."
          body={bigRocks} collapsible collapseKey="ov:Big rocks" open={bigRocks.open} />
        <Section title="This week" hint={<>Everything tagged <code>week</code>, soonest first.</>}
          body={thisWeek} collapsible collapseKey="ov:This week" open={thisWeek.open} />
        <Section title="Quick wins"
          hint={<>Yours to do: meeting agendas, <code>effort:S</code> and written messages.</>}
          body={quickWins} collapsible collapseKey="ov:Quick wins" open={quickWins.open} />
      </div>
      <ListNote />
    </>
  )
}

/* ---- Reports ---- */

export interface ReportsViewProps {
  /** null before a document is loaded: there is nothing to count yet. */
  reports: ReportsColumnsProps | null
}

/* Tasks finished is two reference columns wide, exactly: 380 twice plus the
   14px gap between them, and it grows twice as fast, 2fr against Written
   reports' 1fr, so the pair fills the window. */
const FINISHED_TRACK = { css: 'minmax(774px,2fr)', min: 788 }
const WRITTEN_TRACK = { css: 'minmax(420px,1fr)', min: 434 }

export function ReportsView({ reports }: ReportsViewProps) {
  if (!reports) return null
  const gridStyle: CSSProperties = {
    gridTemplateColumns: FINISHED_TRACK.css + ' ' + WRITTEN_TRACK.css,
    minWidth: FINISHED_TRACK.min + WRITTEN_TRACK.min + 'px',
  }
  return (
    <div className="lists split" style={gridStyle}>
      <TasksFinishedColumn {...reports} />
      <WrittenReportsColumn {...reports} />
    </div>
  )
}

/* ---- Matrix ---- */

export interface MatrixViewProps {
  impactEffort: SectionBody
  dependencyChain: SectionBody
}

export function MatrixView({ impactEffort, dependencyChain }: MatrixViewProps) {
  return (
    <>
      <div className="lists mview">
        <Section title="Impact against effort"
          hint={<>Every open task by its two scores, except the ones parked in Backlog. One dot per
            task, coloured by bucket — <span className="hoverword">hover</span>
            <span className="tapword">tap</span> for the title, then open it from the card. Faded
            dots are waiting on a review or on another task.</>}
          body={impactEffort} />
        <Section title="Dependency chain" hint={<>Built from every <code>blocked-by:</code> tag.</>}
          body={dependencyChain} />
      </div>
      <ListNote />
    </>
  )
}

/* ---- Timeline ---- */

export interface TimelineViewProps {
  timeline: SectionBody
}

export function TimelineView({ timeline }: TimelineViewProps) {
  return (
    <>
      <div className="lists tview">
        <Section title="Timeline"
          hint={<>Open top-level tasks as bars and milestones across their <code>start:</code>/
            <code>due:</code> dates, one lane per bucket. A <code>due:</code> with no{' '}
            <code>start:</code> draws as a diamond rather than a guessed bar. An undated task has an
            empty row — click it to give it a due date.</>}
          body={timeline} />
      </div>
      <ListNote />
    </>
  )
}
