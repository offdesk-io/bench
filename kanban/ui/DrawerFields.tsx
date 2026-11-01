/* Fields in the task panel drawn by React, on Tenon's StepSlider and TagChip.
 *
 * The panel itself is still an HTML string rebuilt on every openDrawer(), so
 * each field leaves a host element in that string and wireStepSlider() /
 * wireTagChips() in kanban/js/19-drawer.js mount these into it after the
 * string is in the page. What a pick or an edit does stays in those functions
 * and arrives here as a callback.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  StepSlider, TagChip, TagChipAdd, Calendar, DateButton, Dropdown, DragHandle, useReorder,
  type Step, type DropdownOption,
} from '@tiagopedras/tenon'
import { InlineMd } from './InlineMd'

export interface StepFieldProps {
  steps: Step[]
  value: string
  label: string
  disabled: boolean
  /** A pick from a list rather than a scale: gets a native select on a phone. */
  select: boolean
  /** Where the handle was before the panel was rebuilt around this pick. The
   *  slider draws there first and then moves, so a pick that rebuilds the
   *  panel still slides the way one that does not always did. */
  from?: string
  onCommit: (value: string) => void
}

/** Holds the value the slider shows, so a pick lands at once even on the
 *  fields whose commit does not rebuild the panel. */
export function StepField({ steps, value, label, disabled, select, from, onCommit }: StepFieldProps) {
  const [v, setV] = useState(from ?? value)
  useEffect(() => {
    if (from === undefined || from === value) return
    // Two frames: the first paints the handle at `from`, the second moves it.
    let b = 0
    const a = requestAnimationFrame(() => { b = requestAnimationFrame(() => setV(value)) })
    return () => { cancelAnimationFrame(a); cancelAnimationFrame(b) }
  }, [])
  return (
    <StepSlider
      aria-label={label}
      steps={steps}
      value={v}
      disabled={disabled}
      selectOnNarrow={select}
      onChange={next => { setV(next); onCommit(next) }}
    />
  )
}

export interface TagModel {
  label: string
  value: string
  editable: boolean
  /** A tag nothing else on the board reads. Drawn amber. */
  unrecognised?: boolean
}

export interface TagsFieldProps {
  tags: TagModel[]
  locked: boolean
  onCommit: (index: number, value: string) => void
  /** Returns a refusal message, or nothing once the tag is written. */
  onAdd: (key: string, value: string) => string | void
  onRefuse: (message: string) => void
  /** Where the add control is drawn, when it sits in the field's title row
   *  rather than after the last chip. */
  addHost?: Element | null
}

export function TagsField({ tags, locked, onCommit, onAdd, onRefuse, addHost }: TagsFieldProps) {
  const add = locked ? null : <TagChipAdd onAdd={onAdd} onRefuse={onRefuse} />
  return (
    <>
      {tags.map((t, i) => (
        <TagChip
          key={i}
          label={t.label}
          value={t.value}
          tone={t.unrecognised ? 'warning' : 'neutral'}
          readOnly={locked || !t.editable}
          onCommit={v => onCommit(i, v)}
        />
      ))}
      {addHost ? (add && createPortal(add, addHost)) : add}
    </>
  )
}

export interface DateFieldModel {
  key: string
  label: string
  value: string
  /** The date as the page words it: "Fri 3 Oct 2026", "Any time". */
  text: string
  empty: boolean
  /** The value comes from the task, not this item. Draws the quieter field. */
  inherited?: boolean
  /** What the quieter field says after "From the task." */
  hint?: string
}

export interface DateFieldsProps {
  idPrefix: string
  fields: DateFieldModel[]
  disabled: boolean
  /** Today as YYYY-MM-DD, so the page's own clock decides what today is. */
  today: string
  onPick: (key: string, value: string) => void
  /** The time of day beside Due, HH:MM or empty. Left out where there is none. */
  time?: { value: string; disabled: boolean; onChange: (value: string) => void }
}

/** Can start and Due: two date buttons side by side, and one calendar that
 *  opens in the flow under whichever was pressed. A due time sits after them. */
export function DateFields({ idPrefix, fields, disabled, today, onPick, time }: DateFieldsProps) {
  const [open, setOpen] = useState<string | null>(null)
  const active = fields.find(f => f.key === open)
  const [at, setAt] = useState(time?.value ?? '')
  const given = time?.value ?? ''
  useEffect(() => { setAt(given) }, [given])
  return (
    <>
      <div className="grid2">
        {fields.map(f => (
          <div key={f.key} className={'field' + (f.inherited ? ' inherited' : '')}>
            <span>{f.label}</span>
            <DateButton
              id={idPrefix + '-' + f.key}
              empty={f.empty}
              open={open === f.key}
              disabled={disabled}
              onClick={() => setOpen(open === f.key ? null : f.key)}
            >{f.text}</DateButton>
            {f.inherited && <span className="help">{f.hint ? f.hint : 'From the task. Pick one here to give this its own.'}</span>}
          </div>
        ))}
        {time && (
          <div className="field">
            <span>Due time</span>
            <input
              type="time"
              id={idPrefix + '-time'}
              aria-label="Due time"
              value={at}
              disabled={disabled || time.disabled}
              onChange={e => { setAt(e.target.value); time.onChange(e.target.value) }}
            />
          </div>
        )}
      </div>
      {active && !disabled && (
        <Calendar
          key={active.key}
          id={idPrefix + '-cal-' + active.key}
          value={active.value}
          today={today}
          onChange={v => { setOpen(null); onPick(active.key, v) }}
        />
      )}
    </>
  )
}

export interface PickOption {
  value: string
  label: string
  group?: string
  /** Markup for an icon drawn before the label, such as an avatar. */
  iconHtml?: string
  /** A coloured dot before the label, such as a bucket's colour. */
  dot?: string
}

export interface PickFieldProps {
  id: string
  label: string
  options: PickOption[]
  value: string
  disabled: boolean
  onPick: (value: string) => void
}

function HtmlIcon({ html }: { html: string }) {
  return <span dangerouslySetInnerHTML={{ __html: html }} style={{ display: 'contents' }} />
}

function Dot({ colour }: { colour: string }) {
  return <i aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: colour }} />
}

/** A pick from a list in the task panel, on Tenon's Dropdown: Delegate to and
 *  Assigned to (each agent's avatar beside its name, which an <option> cannot
 *  hold), Bucket (its colour dot) and Theme. */
export function PickField({ id, label, options, value, disabled, onPick }: PickFieldProps) {
  const [v, setV] = useState(value)
  const opts: DropdownOption[] = options.map(o => ({
    value: o.value, label: o.label, group: o.group,
    icon: o.iconHtml ? <HtmlIcon html={o.iconHtml} /> : o.dot ? <Dot colour={o.dot} /> : undefined,
  }))
  return (
    <Dropdown
      id={id + '-dd'}
      aria-label={label}
      options={opts}
      value={v}
      disabled={disabled}
      onChange={next => { setV(next); onPick(next) }}
    />
  )
}

export interface SubRowModel {
  /** The line in the task's body this step is written on. */
  line: number
  done: boolean
  /** Already has an id of its own, so its row can be opened. */
  stableId: string
  opens: boolean
  /** An agent's avatar as markup, or empty for a person. */
  avatarHtml: string
  /** The step's text, inline Markdown. */
  title: string
  due?: { label: string, cls: string }
  hasNote: boolean
  /** Doing, or an agent's run state. Absent for To do and Done, which the tick shows. */
  status?: { label: string, tone: string }
}

export interface SubRowsProps {
  rows: SubRowModel[]
  locked: boolean
  /** The line being typed into, if any: a step just added. */
  editLine: number | null
  /** The step's text as the field should start, for the line being edited. */
  editText: string
  /** Enter inside a new step keeps going: the next one opens in turn. */
  chain: boolean
  onOpen: (row: SubRowModel) => void
  onToggle: (line: number, checked: boolean) => void
  onDelete: (line: number) => void
  onMove: (from: number, to: number) => void
  /** `save` false is Escape. `more` is Enter on a non-empty step that is part of a run. */
  onEditDone: (line: number, text: string, save: boolean, more: boolean) => void
  /** A drag of a step is live, so the board's own drop zones ignore it. */
  onDragState: (live: boolean) => void
}

/** The sub-task list in the task panel: grip, tick, avatar, title, delete and
 *  chevron, one row each, reordered by the grip. The whole row opens the
 *  sub-task; the tick, grip, delete, a link and a step being typed into keep
 *  their own click. */
export function SubRows(p: SubRowsProps) {
  const { item, listProps } = useReorder({
    keys: p.rows.map((_, i) => String(i)),
    onMove: (key, before) => p.onMove(Number(key), before == null ? p.rows.length : Number(before)),
  })
  return (
    <div
      className="substeps"
      id="f-subs"
      onDragStart={() => p.onDragState(true)}
      onDragEnd={() => p.onDragState(false)}
      {...listProps}
    >
      {p.rows.map((s, i) => {
        const it = item(String(i))
        const guard = (e: { target: EventTarget }) =>
          (e.target as HTMLElement).closest('input, button, a, [data-tenon-grip], .subedit')
        return (
          <div
            key={s.line}
            className={'sub' + (s.done ? ' checked' : '') + (s.opens ? ' opens' : '')}
            data-line={s.line}
            data-sub={s.stableId || undefined}
            role={s.opens ? 'button' : undefined}
            tabIndex={s.opens ? 0 : undefined}
            title={s.opens ? 'Open this sub-task' : undefined}
            {...it.itemProps}
            onClick={s.opens ? e => { if (!guard(e)) p.onOpen(s) } : undefined}
            onKeyDown={s.opens ? e => {
              if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
              e.preventDefault()
              p.onOpen(s)
            } : undefined}
          >
            {!p.locked && <DragHandle {...it.handleProps} />}
            <input
              type="checkbox"
              data-line={s.line}
              checked={s.done}
              disabled={p.locked}
              onChange={e => p.onToggle(s.line, e.target.checked)}
            />
            {s.avatarHtml && <HtmlIcon html={s.avatarHtml} />}
            {p.editLine === s.line
              ? <SubEdit line={s.line} text={p.editText} chain={p.chain} onDone={p.onEditDone} />
              : (
                <span className="subtext" data-line={s.line}>
                  <InlineMd text={s.title} />
                  {s.due && <em className={'mini ' + s.due.cls}>{s.due.label}</em>}
                  {s.status && <em className={'substatus ' + s.status.tone}>{s.status.label}</em>}
                  {s.hasNote && <em className="subnotemark" title="Has a note">note</em>}
                </span>
              )}
            {!p.locked && (
              <button type="button" className="subdel" data-line={s.line} title="Delete this subtask"
                onClick={e => { e.stopPropagation(); p.onDelete(s.line) }}>×</button>
            )}
            {s.opens && <span className="subchev" aria-hidden="true">›</span>}
          </div>
        )
      })}
    </div>
  )
}

/** A step's text as a field. Clearing it and leaving removes the step, so
 *  there is no separate delete control for a step just added. */
function SubEdit({ line, text, chain, onDone }: {
  line: number, text: string, chain: boolean, onDone: SubRowsProps['onEditDone'],
}) {
  const ref = useRef<HTMLInputElement>(null)
  const settled = useRef(false)
  useEffect(() => { ref.current?.focus(); ref.current?.select() }, [])
  const finish = (save: boolean, more = false) => {
    if (settled.current) return
    settled.current = true
    onDone(line, ref.current?.value ?? '', save, more)
  }
  return (
    <input
      ref={ref}
      type="text"
      className="subedit"
      defaultValue={text}
      onBlur={() => finish(true)}
      onKeyDown={e => {
        if (e.key === 'Enter') {
          e.preventDefault()
          // An empty step ends the run instead of adding another blank one.
          finish(true, chain && !!e.currentTarget.value.trim())
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(false)
        }
      }}
    />
  )
}
