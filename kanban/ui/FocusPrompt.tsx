/* The floating PA prompt, for the whole list or whatever a hold has put in
 * focus (hold.ts).
 *
 * Fixed at the bottom centre of the viewport on every view. Collapsed, it is
 * one "Ask the PA" button, and pressing it opens the prompt on the whole list,
 * with no chip. While a card, a sub-task or a drawer section is held it is
 * open on that. It carries `data-focus-keep`, so a press inside it does not
 * end the focus and the spotlight does not dim it.
 *
 * Four open states, from the Figma file: Idle (the chip above a box to type in),
 * Typing (the box grows with what is in it, then scrolls), Working (a status
 * card in place of the box, saying what the PA is doing) and Done (the card
 * turns green and says what the PA did). An error is Working's card with a
 * muted red line.
 *
 * Everything else is the board's, in kanban/js/10a-focus-prompt.js: when it
 * shows, what the chip says, sending the message, reading the reply and
 * applying it. This only draws what it is handed and says when Enter was
 * pressed. Mounted by that file on a node it creates in the body, never on
 * #lists.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'

export type FocusPromptPhase = 'idle' | 'working' | 'done' | 'error'

export interface FocusPromptProps {
  /** Drawn as the one "Ask the PA" button, and nothing else below is read. */
  collapsed?: boolean
  /** The "Ask the PA" button was pressed. */
  onOpen?: () => void
  /** Changes with every new focus, which empties the box. */
  focusId: number
  /** `Task`, `Subtask` or a section's name, then what it names. Null for the
   *  whole list, which has no chip. */
  chip: { label: string, title: string } | null
  placeholder: string
  phase: FocusPromptPhase
  /** The status card's line: what the PA is doing, did, or the error. */
  line: string
  /** When the message went, as the card shows it ("10:57 AM"). */
  time: string
  /** The status card is fading out, at the end of Done or an error. */
  fading: boolean
  /** The whole prompt is fading out, because the focus has ended. */
  leaving: boolean
  /** Enter, with something in the box. */
  onSend: (text: string) => void
  /** Esc in the box. A focus never sees it (hold.ts takes Esc first), so it
   *  is the whole-list prompt's way to close. */
  onClose?: () => void
}

/** Where the box stops growing and starts to scroll. */
const MAX_BOX = 240

function Hexagon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.5l5.6 3.25v6.5L8 14.5l-5.6-3.25v-6.5z" fill="#6aa0ff" />
    </svg>
  )
}

function Check() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="#aab0ba" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function FocusPrompt(p: FocusPromptProps) {
  const [text, setText] = useState('')
  const box = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => { setText('') }, [p.focusId])

  /* Keyboard focus as soon as the box is there: a new focus, or back to Idle
     after a Done. */
  useEffect(() => {
    if (p.phase === 'idle' && !p.leaving && box.current) box.current.focus({ preventScroll: true })
  }, [p.focusId, p.phase, p.leaving])

  /* Grows with its content up to MAX_BOX, then scrolls. The CSS min-height is
     the floor. */
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight + 2, MAX_BOX) + 'px'
  }, [text, p.phase])

  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    /* With a focus on, Escape never gets here: hold.ts takes it on window,
       ahead of this, and ends the focus. */
    if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (p.onClose) p.onClose()
      return
    }
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
    e.preventDefault()
    if (!text.trim()) return
    p.onSend(text)
    setText('')
  }

  if (p.collapsed) {
    return (
      <div className="focus-prompt focus-prompt--collapsed" data-focus-keep="">
        <button type="button" className="focus-prompt__open" onClick={p.onOpen}>
          <Hexagon />
          <span>Ask the PA</span>
        </button>
      </div>
    )
  }

  const status = p.phase !== 'idle'
  const about = p.chip ? p.chip.label.toLowerCase() + ' "' + p.chip.title + '"' : 'the whole list'
  return (
    <div className={'focus-prompt' + (p.leaving ? ' is-leaving' : '')} data-focus-keep="">
      {p.chip && (
        <div className="focus-prompt__chip" title={p.chip.label + ': "' + p.chip.title + '"'}>
          <i className="focus-prompt__dot" aria-hidden="true" />
          <span className="focus-prompt__chiptext"><b>{p.chip.label}:</b> {'"' + p.chip.title + '"'}</span>
        </div>
      )}
      {!status ? (
        <div className="focus-prompt__box">
          <textarea
            ref={box}
            className="focus-prompt__input"
            aria-label={'Ask the PA about ' + about}
            placeholder={p.placeholder}
            rows={1}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={key}
          />
        </div>
      ) : (
        <div
          className={'focus-prompt__status focus-prompt__status--' + p.phase + (p.fading ? ' is-fading' : '')}
          role="status"
          aria-live="polite"
        >
          <span className="focus-prompt__avatar">{p.phase === 'done' ? <Check /> : <Hexagon />}</span>
          <div className="focus-prompt__lines">
            <div className="focus-prompt__who"><span className="focus-prompt__name">PA Agent</span> {p.time}</div>
            <div className="focus-prompt__line">{p.line}</div>
          </div>
        </div>
      )}
    </div>
  )
}
