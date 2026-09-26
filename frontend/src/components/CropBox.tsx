/**
 * The part of the picture an exact-size crop keeps, drawn over the picture,
 * for the visitor to drag where they want it.
 *
 * The box always fills the picture along one side, so it only ever moves
 * along the other. Its position is the same fraction ImageOps.fit takes as
 * `centering` on the server: 0 keeps the left (or top) edge, 1 the right (or
 * bottom). Pixels never leave the browser for this; the preview is the file
 * the visitor dropped, read locally.
 */

import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { cropFrame, type Focus } from '../lib/crop'

const clamp = (n: number) => Math.min(1, Math.max(0, n))

interface CropBoxProps {
  src: string
  width: number
  height: number
  focus: Focus
  onChange: (focus: Focus) => void
}

export function CropBox({ src, width, height, focus, onChange }: CropBoxProps) {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [broken, setBroken] = useState(false)
  const frameRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ start: number; from: number } | null>(null)

  // A format the browser cannot show (TIFF outside Safari): no preview, and
  // the server's default crop applies.
  if (broken) return null

  const frame = natural ? cropFrame(natural.w, natural.h, width, height) : null
  const axis = frame?.axis ?? 'x'
  const value = focus[axis]
  const free = frame ? 1 - (axis === 'x' ? frame.w : frame.h) : 0

  const move = (next: number) => onChange({ ...focus, [axis]: clamp(next) })

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { start: axis === 'x' ? e.clientX : e.clientY, from: value }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const rect = frameRef.current?.getBoundingClientRect()
    if (!drag.current || !rect || free <= 0) return
    const span = (axis === 'x' ? rect.width : rect.height) * free
    const moved = (axis === 'x' ? e.clientX : e.clientY) - drag.current.start
    move(drag.current.from + moved / span)
  }
  const onPointerUp = () => {
    drag.current = null
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const back = axis === 'x' ? 'ArrowLeft' : 'ArrowUp'
    const forward = axis === 'x' ? 'ArrowRight' : 'ArrowDown'
    const step = e.shiftKey ? 0.2 : 0.05
    if (e.key === back) move(value - step)
    else if (e.key === forward) move(value + step)
    else if (e.key === 'Home') move(0)
    else if (e.key === 'End') move(1)
    else return
    e.preventDefault()
  }

  return (
    // Hidden until the picture has loaded and turns out to need a crop. A
    // hidden image still loads, which is what sets `natural`.
    <div className="crop" hidden={!frame}>
      <p className="crop-note">Drag the box to choose what is kept at {width} x {height}.</p>
      <div className="crop-frame" ref={frameRef}>
        <img
          src={src}
          alt=""
          decoding="async"
          draggable={false}
          onLoad={(e) =>
            setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
          }
          onError={() => setBroken(true)}
        />
        {frame ? (
          <div
            className="crop-box"
            role="slider"
            tabIndex={0}
            aria-label={axis === 'x' ? 'Crop position, left to right' : 'Crop position, top to bottom'}
            aria-orientation={axis === 'x' ? 'horizontal' : 'vertical'}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(value * 100)}
            style={{
              width: `${frame.w * 100}%`,
              height: `${frame.h * 100}%`,
              left: `${(1 - frame.w) * focus.x * 100}%`,
              top: `${(1 - frame.h) * focus.y * 100}%`,
              cursor: axis === 'x' ? 'ew-resize' : 'ns-resize',
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={onKeyDown}
          />
        ) : null}
      </div>
    </div>
  )
}
