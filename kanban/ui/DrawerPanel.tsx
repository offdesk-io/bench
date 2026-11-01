/* The task drawer's frame, drawn by React: the head's left half and the two
 * columns of the body.
 *
 * openDrawer() (kanban/js/19-drawer.js) used to join the whole panel into one
 * HTML string and assign it to #dbody, then reach into it by id. The structure
 * is JSX now, with the same ids, classNames and nesting, so board.css and the
 * 31 places that query #drawer or #dbody read what they always read.
 *
 * What stays a string is the interior of the pieces that already had a
 * renderer of their own (the step sliders, the Delegate and Theme selects, the
 * tag chips, the agenda and suggestion lists). They arrive as HTML and are
 * inserted into the element React drew for them, with no wrapper node, because
 * rules such as `.field > span` and `.dcol > details` match direct children.
 * React never renders children into those elements, so what the classic
 * scripts write into them later (the History and Files boxes, the Description
 * rendering) is not overwritten.
 *
 * The caller mounts a body with a new `key` every time, so React replaces the
 * old panel rather than patching it, as assigning innerHTML always did.
 */
import { useLayoutEffect, useRef } from 'react'

/* HTML placed inside an element React has drawn empty. `where` follows
   insertAdjacentHTML: the summary of a <details> comes first, so the body goes
   at its end; a column's extra sections go at its start. */
function useHTML(html: string | undefined, where: InsertPosition = 'beforeend') {
  const ref = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    if (html && ref.current) ref.current.insertAdjacentHTML(where, html)
  }, [])
  return ref as React.RefObject<any>
}

export interface DrawerHeadLeadProps {
  title: string
  help: string
  /** The headline pin. Null hides it, as a project panel does. */
  headline: { on: boolean; label: string; hint: string; disabled: boolean; onClick?: () => void } | null
  /** Open project folder. Null hides it. */
  folder: { onClick: () => void } | null
}

export function DrawerHeadLead(p: DrawerHeadLeadProps) {
  return (
    <>
      <strong id="drawerTitle">{p.title}</strong>
      <span className="help" id="dheadHelp" title={p.help}>{p.help}</span>
      <span className="spacer" />
      <button
        type="button" id="dheadHl"
        className={'hlpin' + (p.headline ? (p.headline.on ? ' on' : '') : ' hidden')}
        title={p.headline ? p.headline.hint : undefined}
        disabled={p.headline ? p.headline.disabled : false}
        onClick={p.headline ? p.headline.onClick : undefined}
      >{p.headline ? p.headline.label : 'Make headline'}</button>
      <button
        type="button" id="dheadProj"
        className={'hlpin' + (p.folder ? '' : ' hidden')}
        onClick={p.folder ? p.folder.onClick : undefined}
      >Open project folder</button>
    </>
  )
}

/* An element whose whole interior is HTML from a string renderer. */
function HTMLBox({ as: Tag = 'div', html, ...rest }: { as?: any; html: string; [k: string]: any }) {
  return <Tag {...rest} dangerouslySetInnerHTML={{ __html: html }} />
}

/* One collapsible section of the side column, the structure sideSection()
   builds as a string. The body is HTML (children are for the few that are
   plain), and `sub` marks a subsection with no rule above it. */
function SideSection(p: {
  label: string; id: string; count?: number; sub?: boolean
  /** Overrides the 'sugg:<id>' collapse key, for a section whose stored state predates it. */
  collapseKey?: string
  /** Extra class on the <details>. */
  className?: string
  open: (key: string) => boolean; html?: string
  /** Buttons in the title bar, on the right (sideSection()'s `action`). */
  action?: React.ReactNode
  children?: React.ReactNode
}) {
  const key = p.collapseKey || 'sugg:' + p.id
  const ref = useHTML(p.html)
  return (
    <>
      {p.sub ? null : <hr className="dsep" />}
      <details
        ref={ref} className={'field sugg' + (p.sub ? ' subsec' : '') + (p.className ? ' ' + p.className : '')}
        data-collapse={key} open={p.open(key)}
      >
        <summary>
          {p.label}
          {p.count && p.count > 1 ? <> <em className="sublabel">{p.count}</em></> : null}
          {p.action ? <span className="sumaction">{p.action}</span> : null}
        </summary>
        {p.children}
      </details>
    </>
  )
}

export interface DrawerBodyProps {
  ro: boolean
  title: string
  /** Inner HTML of the Theme field, or null when the bucket has no themes. */
  themeHTML: string | null
  /** Whether a section is open, by its data-collapse key. */
  open: (key: string) => boolean
  /** Inner HTML of the Column, Impact, Effort and Delegate fields. */
  columnHTML: string
  impactHTML: string
  effortHTML: string
  delegateHTML: string
  repeat: { label: string; next: string; loose: boolean } | null
  /** Start after due. */
  dateWarn: boolean
  /** "Hidden from Quick wins until …", or empty. */
  dateNote: string
  urgent: boolean
  /** Inner HTML of the Tags field. */
  tagsHTML: string
  subCount: number
  canCompleteAll: boolean
  /** The Outputs subsections, as HTML. */
  outputsHTML: string
  /** Chats and Dependencies, as HTML; empty while DRAWER_HIDDEN has them off. */
  extraSideHTML: string
  historyHTML: string
}

export function DrawerBody(p: DrawerBodyProps) {
  const { ro } = p
  const side = useHTML(p.extraSideHTML, 'afterbegin')
  const noteOpen = p.open('notes')
  return (
    <div className="dcols">
      <div className="dcol dcol-main">
        <SideSection label="Title" id="title" open={p.open}>
          <input type="text" id="f-title" defaultValue={p.title} disabled={ro} />
        </SideSection>
        <SideSection label="Details" id="details" collapseKey="details" className="dgroup" open={p.open}>
          <div className="field"><span>Bucket</span><div data-pick-host="f-bucket" /></div>
          {p.themeHTML != null ? <HTMLBox className="field" html={'<span>Theme</span>' + p.themeHTML} /> : null}
          <details className="field sugg subsec" data-collapse="notes" open={noteOpen}>
            <summary>Description</summary>
            <div id="f-body-view" className="repdoc noteview" title={ro ? undefined : 'Click to edit'} />
            <div id="f-body-mount" />
          </details>
          <HTMLBox className="field" html={'<span>Column</span>' + p.columnHTML} />
          <div className="grid2">
            <HTMLBox className="field" html={'<span>Impact</span>' + p.impactHTML} />
            <HTMLBox className="field" html={'<span>Effort</span>' + p.effortHTML} />
          </div>
          <HTMLBox className="field" html={'<span>Delegate to</span>' + p.delegateHTML} />
          <div id="f-dates" />
          {p.repeat ? (
            <>
              <div className="field">
                <span>Repeats</span>
                <span className="dpbtn" style={{ cursor: 'default' }}>{p.repeat.label}</span>
              </div>
              <span className="help">Next: {p.repeat.next}</span>
              {p.repeat.loose ? <span className="help">Usual shape, not a fixed rule — the date moves around it.</span> : null}
            </>
          ) : null}
          {p.dateWarn ? <p className="datewarn">This cannot start until after it is due. One of the two dates is wrong.</p> : null}
          {p.dateNote ? <p className="datenote">{p.dateNote}</p> : null}
          <div className="field">
            <span>Flags</span>
            <label className="toggle">
              <input type="checkbox" id="f-urgent" defaultChecked={p.urgent} disabled={ro} /> urgent
            </label>
          </div>
          <HTMLBox className="field" html={p.tagsHTML} />
        </SideSection>
        <SideSection
          label="Subtasks" id="subtasks" count={p.subCount} open={p.open}
          action={ro && !p.canCompleteAll ? undefined : (
            <>
              {p.canCompleteAll ? <button type="button" className="btn outline small" id="f-completeall">Complete all</button> : null}
              {ro ? null : <button type="button" className="btn outline small" id="f-addsub" title="Enter keeps adding, blank Enter stops">Add sub-task…</button>}
            </>
          )}
        >
          <div id="f-subs-host" />
        </SideSection>
      </div>
      <div className="dcol dcol-side" ref={side}>
        <SideSection label="Outputs" id="outputs" open={p.open} html={p.outputsHTML} />
        <SideSection label="History" id="history" open={p.open} html={p.historyHTML} />
      </div>
    </div>
  )
}
