/* The top bar, drawn with Tenon's AppHeader since 19 Nov 2026: the bar, the
 * tab pill, the page background (`tenon-app-page` on <body>) and Sign out all
 * come from Tenon's classes rather than board.css. It was the view tabs alone,
 * on SegmentedControl, from 26 Sep 2026, which is why the file and the
 * `ViewTabs` name are still what renderViewTabs() in kanban/js/18-timeline.js
 * mounts into #viewToggle: that script is untouched.
 *
 * The bar's other parts are still static HTML in index.html, because the
 * classic scripts bind them by id as they load, a script tag before this
 * bundle exists. They sit in #hdrStash until this first draws, and are then
 * moved, not copied, into the brand and actions slots, so every id, listener
 * and class the scripts set survives. React never renders into those two
 * slots, so a redraw leaves them alone.
 *
 * Tabs are plain links to the hash URLs the board already uses; the
 * `hashchange` listener in 25-archiving.js switches the view. That replaced
 * the old radiogroup, so the arrow keys no longer move between views, and the
 * hairline between Reports and Board went with the pill, which has none.
 * `data-view` stays on each link because the phone's tab bar clicks
 * `#viewToggle [data-view=...]`.
 */
import { useLayoutEffect, useRef } from 'react'
import { AppHeader, type AppTab } from '@tiagopedras/tenon'

export interface ViewTabDef {
  id: string
  label?: string
  sep?: boolean
}

export interface ViewTabsProps {
  defs: ViewTabDef[]
  value: string
  /* Kept so renderViewTabs() need not change. Picking a view is a hash change
     now, which the board already listens to. */
  onPick?: (id: string) => void
}

/* A slot React leaves empty, which the page's own nodes are moved into. */
function Slot({ from, id }: { from: string; id: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const stash = document.getElementById('hdrStash')
    const src = stash && stash.querySelector(from)
    if (el && src) el.appendChild(src)
  }, [])
  return <div id={id} ref={ref} style={{ display: 'contents' }} />
}

export function ViewTabs({ defs, value }: ViewTabsProps) {
  const tabs: AppTab[] = defs
    .filter(d => !d.sep)
    .map(d => ({ to: '#' + d.id, label: d.label ?? d.id, current: d.id === value }))
  /* Sign out shows when the board has heard who is signed in (loadWhoami(),
     21-datasets.js, un-hides #whoami and then redraws the view), so the Mac
     board, which has no /auth/ route, does not offer a button that 404s. */
  const who = document.getElementById('whoami')
  const signedIn = !!who && !who.classList.contains('hidden')
  return (
    <AppHeader
      brand={<Slot from="#hdrBrand" id="hdrBrandSlot" />}
      tabs={tabs}
      renderLink={({ tab, className, current, children }) => (
        <a href={tab.to} className={className} data-view={tab.to.slice(1)} aria-current={current ? 'page' : undefined}>
          {children}
        </a>
      )}
      actions={<Slot from="#hdrActions" id="hdrActionsSlot" />}
      signOut={signedIn}
    />
  )
}
