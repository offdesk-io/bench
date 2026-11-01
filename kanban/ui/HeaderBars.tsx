/* The bars around the board, drawn by React since 1 Oct 2026: the headline,
 * the bucket and theme tab strips, the two filter chips, and the phone's
 * column strip.
 *
 * renderHeadline(), renderTabs(), renderThemeTabs(), renderScoreChip(),
 * renderAgentFilterChip() and renderColTabs() keep the orchestration: they work
 * out what each bar says from state and hand it over as props, and what a click
 * does comes back as a callback. These only draw. Class names, ids and the
 * `.on` / `.hidden` hooks are the strings' own, so board.css and the suites
 * that query them read it unchanged.
 */
import { useRef, useState, type ReactNode } from 'react'
import { Button, Modal, Tag, ToggleChip, ToggleGroup, type TagTone } from '@tiagopedras/tenon'
import { InlineMd } from './InlineMd'

export interface HeadlineChip { tone?: TagTone, text: string, title?: string, className?: string }

export interface HeadlineModel {
  title: string
  where: string
  chips: HeadlineChip[]
  age: string | null
  solved: boolean
}

/** The inside of `#headline`. The bar itself stays the page's, since it carries
 *  the open-the-task click, the key handling and the `.set` / `.hidden`
 *  classes, which are orchestration. `null` is the empty invitation. */
export function HeadlineBar({ model, onClear }: { model: HeadlineModel | null, onClear: () => void }) {
  if (!model) {
    return (
      <>
        <span className="hllabel">The one thing</span>
        <span className="hlempty">
          Nothing set. Drag a card here, or open a task and press <strong>Make this the headline</strong>.
        </span>
      </>
    )
  }
  return (
    <>
      <span className="hllabel">The one thing</span>
      <div className="hlmain">
        <div className="hltitle"><InlineMd text={model.title} /></div>
        <div className="hlmeta">
          <span className="hlwhere">{model.where}</span>
          {model.chips.map((c, i) => (
            <Tag key={i} tone={c.tone || 'neutral'} className={c.className} title={c.title}>{c.text}</Tag>
          ))}
        </div>
      </div>
      <div className="hlright">
        {model.age !== null && <span className="hlage">{model.age}</span>}
        {model.solved && <span className="hldone">solved — pick the next one</span>}
        <Button
          size="sm"
          className="hlclear"
          id="hlClear"
          onClick={e => { e.stopPropagation(); onClear() }}
        >Remove</Button>
      </div>
    </>
  )
}

export interface FilterTab {
  key: string
  label: string
  on: boolean
  title: string
  /** The bucket colour, for the dot. Absent on All. */
  color?: string
  /** The grey count. Absent on a theme. */
  count?: number
  className?: string
}

/** One strip of toggle pills: the bucket tabs and the theme tabs. Several can
 *  be on at once, so it is Tenon's ToggleGroup, not a SegmentedControl. */
export function FilterTabs({ tabs, label, onToggle }: {
  tabs: FilterTab[]
  label: string
  onToggle: (key: string) => void
}) {
  return (
    <ToggleGroup
      aria-label={label}
      value={tabs.filter(t => t.on).map(t => t.key)}
      onToggle={onToggle}
      options={tabs.map(t => ({
        value: t.key, label: t.label, count: t.count, colour: t.color, title: t.title, className: t.className,
      }))}
    />
  )
}

export interface FilterChip {
  id: string, hidden: boolean, on: boolean, text: string, title: string, onClick: () => void
  /** A face before the text: the signed-in person's, on Mine. Markup from core/avatar.js. */
  avatarHTML?: string
}

/** The two chips beside the bucket strip: how many need scoring, how many are
 *  with an agent. */
export function FilterChips({ chips }: { chips: FilterChip[] }) {
  return (
    <>
      {chips.map(c => (
        <ToggleChip
          key={c.id}
          id={c.id}
          pressed={c.on}
          hidden={c.hidden}
          title={c.title}
          onClick={c.onClick}
        >{c.avatarHTML ? <span className="chipface" dangerouslySetInnerHTML={{ __html: c.avatarHTML }} /> : null}{c.text}</ToggleChip>
      ))}
    </>
  )
}

/** The phone's strip of column names. `active` is the column nearest the left
 *  edge; the page works that out from the scroll position and calls again. */
export function ColTabs({ names, active, onPick }: {
  names: string[]
  active: number
  onPick: (i: number) => void
}) {
  return (
    <>
      {names.map((n, i) => (
        <button
          key={i}
          type="button"
          className={'coltab' + (i === active ? ' on' : '')}
          data-coli={i}
          onClick={() => onPick(i)}
        >{n}</button>
      ))}
    </>
  )
}

/* ---------------------------------------------------------------------------
 * The phone's chrome, below 640px: a one-row top bar, a sticky filter row and
 * a bottom tab bar, with the sheets they open. Drawn at every width and hidden
 * by board.css above 640px, as the column strip is, so there is no second
 * breakpoint in here.
 *
 * Nothing in this half owns a behaviour. Every action comes back as a callback,
 * and renderPhoneChrome() (kanban/js/30-phone-chrome.js) answers each by
 * clicking the control the desktop header already has, so the two cannot drift.
 * Tenon has no bottom sheet, so a sheet is its Modal docked to the bottom edge
 * by board.css (.phonesheet): the focus trap, Escape and aria-modal come with
 * it, and the swipe down is added here.
 * ------------------------------------------------------------------------- */

export interface PhoneAction { id: string, label: string, disabled?: boolean, danger?: boolean, run: () => void }
export interface PhoneBoard { id: string, label: string, current: boolean }
export interface PhoneView { id: string, label: string }
export interface PhoneBucket { key: string, label: string, on: boolean, count?: number, colour?: string }
export interface PhoneToggle { id: string, label: string, on: boolean, disabled?: boolean, onClick: () => void }

export interface PhoneChromeProps {
  hidden: boolean
  /** The list's name in "Bench · <name>". Empty leaves the bare title. */
  board: string
  /** Read when the board sheet opens. Fewer than two means there is nothing to switch to. */
  boards: () => PhoneBoard[]
  onBoard: (id: string) => void
  /** The signed-in person's face, markup from core/avatar.js. Absent draws a plain one. */
  avatarHTML?: string
  accountName: string
  /** The account sheet's actions, read when it opens. */
  actions: () => PhoneAction[]
  /** The status line, "edited 2h ago", read when the account sheet opens. */
  status: () => string
  views: PhoneView[]
  view: string
  onView: (id: string) => void
  showFilters: boolean
  query: string
  onSearch: (q: string) => void
  /** The bucket strip as it stands, read at every render. */
  buckets: () => PhoneBucket[]
  onBucket: (key: string) => void
  /** The score and mine toggles, then the buckets editor. */
  toggles: () => PhoneToggle[]
  onEditBuckets: (() => void) | null
}

const VIEW_ICONS: Record<string, ReactNode> = {
  overview: <path d="M4 5h7v6H4zM13 5h7v3h-7zM13 10h7v9h-7zM4 13h7v6H4z" />,
  board: <path d="M4 4h4.5v16H4zM9.75 4h4.5v10h-4.5zM15.5 4H20v13h-4.5z" />,
  matrix: <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />,
  timeline: <path d="M4 7h10v3H4zM8 12h12v3H8zM6 17h8v3H6z" />,
  projects: <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />,
  agents: <path d="M12 3a3 3 0 0 1 3 3v1h2a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h2V6a3 3 0 0 1 3-3zM9.5 12a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm5 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2z" />,
}
function Icon({ children }: { children: ReactNode }) {
  return <svg className="phicon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">{children}</svg>
}

/** A bottom sheet: Tenon's Modal, docked by board.css. A swipe down on the
 *  body closes it, unless the list inside has been scrolled. */
function Sheet({ title, subtitle, onClose, children }: {
  title: string, subtitle?: string, onClose: () => void, children: ReactNode
}) {
  const from = useRef<number | null>(null)
  const dy = useRef(0)
  return (
    <Modal open onClose={onClose} title={title} subtitle={subtitle} size="sm" className="phonesheet">
      <div
        className="phonesheet__inner"
        onTouchStart={e => {
          const body = e.currentTarget.parentElement
          from.current = body && body.scrollTop > 0 ? null : e.touches[0].clientY
          dy.current = 0
        }}
        onTouchMove={e => { if (from.current !== null) dy.current = e.touches[0].clientY - from.current }}
        onTouchEnd={() => { if (from.current !== null && dy.current > 60) onClose(); from.current = null }}
      >
        <div className="phonesheet__grip" aria-hidden="true" />
        {children}
      </div>
    </Modal>
  )
}

type SheetName = 'board' | 'account' | 'bucket' | 'filters' | null

export function PhoneChrome(p: PhoneChromeProps) {
  const [sheet, setSheet] = useState<SheetName>(null)
  const [searching, setSearching] = useState(false)
  if (p.hidden) return null
  const close = () => setSheet(null)
  /* Sheets close before the action runs, so the modal an action opens (Settings,
     Backups) is not fought over by this one handing focus back to its opener. */
  const then = (run: () => void) => () => { close(); window.setTimeout(run, 40) }

  const buckets = p.buckets()
  const all = buckets.find(b => b.key === '__all__')
  const picked = buckets.filter(b => b.on && b.key !== '__all__')
  const bucketLabel = !picked.length
    ? 'All' + (all && all.count !== undefined ? ' · ' + all.count : '')
    : picked.length === 1
      ? picked[0].label + (picked[0].count !== undefined ? ' · ' + picked[0].count : '')
      : picked.length + ' buckets'
  const toggles = p.toggles()
  const active = toggles.filter(t => t.on).length
  const boards = sheet === 'board' ? p.boards() : []

  return (
    <>
      <div className="phtop" id="phTop">
        {p.board ? (
          <button type="button" className="phboard" id="phBoard" aria-haspopup="dialog" onClick={() => setSheet('board')}>
            <span className="phbrand">Bench</span><span className="phdot" aria-hidden="true">·</span>
            <span className="phname">{p.board}</span><span aria-hidden="true">▾</span>
          </button>
        ) : <span className="phbrand">Bench</span>}
        <button type="button" className="phavatar" id="phAvatar" aria-haspopup="dialog"
                aria-label={'Account and options' + (p.accountName ? ', ' + p.accountName : '')}
                onClick={() => setSheet('account')}>
          {p.avatarHTML
            ? <span dangerouslySetInnerHTML={{ __html: p.avatarHTML }} />
            : <Icon><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-3.3 0-8 1.7-8 5v1h16v-1c0-3.3-4.7-5-8-5z" /></Icon>}
        </button>
      </div>

      {p.showFilters && (
        <div className={'phfilters' + (searching ? ' searching' : '')} id="phFilters">
          {searching ? (
            <>
              <input type="search" id="phSearch" className="phsearch" placeholder="Search tasks…"
                     aria-label="Search tasks" autoFocus value={p.query}
                     onChange={e => p.onSearch(e.target.value)} />
              <button type="button" className="phcancel" id="phCancel"
                      onClick={() => { p.onSearch(''); setSearching(false) }}>Cancel</button>
            </>
          ) : (
            <>
              <button type="button" className={'phiconbtn' + (p.query ? ' on' : '')} id="phSearchBtn"
                      aria-label={p.query ? 'Search tasks, searching for ' + p.query : 'Search tasks'}
                      onClick={() => setSearching(true)}>
                <Icon><path d="M10.5 4a6.5 6.5 0 1 0 4 11.6l4.4 4.4 1.4-1.4-4.4-4.4A6.5 6.5 0 0 0 10.5 4zm0 2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z" /></Icon>
              </button>
              <button type="button" className="phbucket" id="phBucket" aria-haspopup="dialog" onClick={() => setSheet('bucket')}>
                <span>{bucketLabel}</span><span aria-hidden="true">▾</span>
              </button>
              <button type="button" className="phfilterbtn" id="phFilterBtn" aria-haspopup="dialog" onClick={() => setSheet('filters')}>
                <span>Filters</span>
                {active > 0 && <span className="phbadge" aria-label={active + ' active'}>{active}</span>}
              </button>
            </>
          )}
        </div>
      )}

      <nav className="phtabs" id="phTabs" aria-label="Views">
        {p.views.map(v => (
          <button key={v.id} type="button" className={'phtab' + (v.id === p.view ? ' on' : '')} data-view={v.id}
                  aria-current={v.id === p.view ? 'page' : undefined} onClick={() => p.onView(v.id)}>
            <Icon>{VIEW_ICONS[v.id] || VIEW_ICONS.board}</Icon>
            <span>{v.label}</span>
          </button>
        ))}
      </nav>

      {sheet === 'board' && (
        <Sheet title="Switch list" onClose={close}>
          <div className="phrows">
            {boards.map(b => (
              <button key={b.id} type="button" className="phrow" data-board={b.id}
                      aria-current={b.current ? 'true' : undefined}
                      onClick={b.current ? close : then(() => p.onBoard(b.id))}>
                <span>{b.label}</span>{b.current && <span aria-hidden="true">✓</span>}
              </button>
            ))}
          </div>
        </Sheet>
      )}

      {sheet === 'account' && (
        <Sheet title={p.accountName || 'Bench'} subtitle={p.status()} onClose={close}>
          <div className="phrows">
            {p.actions().map(a => (
              <button key={a.id} type="button" className={'phrow' + (a.danger ? ' danger' : '')} data-action={a.id}
                      disabled={a.disabled} onClick={then(a.run)}>{a.label}</button>
            ))}
          </div>
        </Sheet>
      )}

      {sheet === 'bucket' && (
        <Sheet title="Buckets" onClose={close}>
          <div className="phrows">
            {buckets.map(b => (
              <button key={b.key} type="button" className="phrow" data-bucket={b.key}
                      aria-current={b.on ? 'true' : undefined} onClick={() => p.onBucket(b.key)}>
                {b.colour ? <i className="phdotc" style={{ background: b.colour }} aria-hidden="true" /> : <i className="phdotc none" aria-hidden="true" />}
                <span className="phlabel">{b.label}</span>
                {b.count !== undefined && <span className="phcount">{b.count}</span>}
                <span className="phtick" aria-hidden="true">{b.on ? '✓' : ''}</span>
              </button>
            ))}
          </div>
          <button type="button" className="phdone" onClick={close}>Done</button>
        </Sheet>
      )}

      {sheet === 'filters' && (
        <Sheet title="Filters" onClose={close}>
          <div className="phrows">
            {toggles.map(t => (
              <button key={t.id} type="button" className="phrow" data-filter={t.id} aria-pressed={t.on}
                      disabled={t.disabled} onClick={t.onClick}>
                <span className="phlabel">{t.label}</span><span className="phtick" aria-hidden="true">{t.on ? '✓' : ''}</span>
              </button>
            ))}
            {p.onEditBuckets && (
              <button type="button" className="phrow" data-filter="edit-buckets" onClick={then(p.onEditBuckets)}>
                <span className="phlabel">Edit buckets</span>
              </button>
            )}
          </div>
          <button type="button" className="phdone" onClick={close}>Done</button>
        </Sheet>
      )}
    </>
  )
}
