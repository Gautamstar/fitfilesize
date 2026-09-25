/**
 * The rung search, drawn as it happens.
 *
 * One column per compression setting, gentlest on the left, plus the original
 * file. Each setting that has been tried grows a bar to the size it produced,
 * against a line at the visitor's limit: green with a tick when it fits, amber
 * with a cross when it is too big. Sizes only shrink down the ladder, so every
 * result rules out a whole side: a fit rules out everything stronger (not
 * needed), a miss everything gentler (would be too big). Those columns fade,
 * and the band that is still possible narrows until one setting is left, the
 * gentlest that fits.
 *
 * Height is a log scale: sizes run from a few KB to many MB, and on a linear
 * scale every small result would be a sliver. Status is never colour alone:
 * each tried bar also carries a tick or a cross, the narration says it in
 * words, and a table view lists every number.
 */

import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { RungPoint, SearchState } from '../hooks/useProgressStream'
import { fmt } from '../lib/format'
import { narrate, searchRange, statusOf, type RungStatus } from '../lib/search'

interface SearchLadderProps {
  search: SearchState
  originalBytes: number
  /** The setting the finished run kept, from the result's method ("rung:N"). */
  chosenRung?: number | null
}

const H = 250
const PLOT_H = H - 18 - 44

export function SearchLadder({ search, originalBytes, chosenRung }: SearchLadderProps) {
  const [hover, setHover] = useState<number | null>(null)
  const tableId = useId()
  // Laid out at the width it is shown at, not scaled: a fixed viewBox shrunk
  // onto a phone halves every label. 640 until measured (and in tests, where
  // there is no ResizeObserver).
  const plotRef = useRef<HTMLDivElement>(null)
  const [W, setW] = useState(640)
  useLayoutEffect(() => {
    const el = plotRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = () => setW(Math.max(280, Math.round(el.getBoundingClientRect().width)))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const n = search.rungs
  if (n === null || search.target === null) return null
  const target = search.target
  const { lo, hi, settled } = searchRange(search)
  const narrow = W < 480
  const M = { top: 18, right: 10, bottom: 44, left: narrow ? 48 : 52 }
  const PLOT_W = W - M.left - M.right
  const BASE = M.top + PLOT_H

  // Log scale over everything drawn: the original, the limit and every result.
  const sizes = Object.values(search.points)
    .map((p) => p.size)
    .filter((s): s is number => s !== null)
  const yMax = Math.max(originalBytes, target, ...sizes) * 1.25
  const yMin = Math.min(target, ...sizes) / 1.8
  const y = (v: number) =>
    M.top + PLOT_H * (1 - (Math.log(v) - Math.log(yMin)) / (Math.log(yMax) - Math.log(yMin)))

  const cols = n + 1 // the original, then every rung
  const cw = PLOT_W / cols
  const bw = Math.min(cw * 0.58, 26)
  const cx = (col: number) => M.left + cw * (col + 0.5)

  // Round sizes in the same 1024-based units fmt() prints, so ticks read
  // "100 KB" and "1 MB" rather than "97.7 KB" and "976.6 KB".
  const ticks = [1, 10, 100, 1024, 10240, 102400]
    .map((kb) => kb * 1024)
    .filter((t) => t > yMin && t < yMax)
  const tickLabel = (t: number) => fmt(t).replace('.0 ', ' ')

  // Direct labels only where they earn their place: the newest result and the
  // setting that was kept. The caption and the table carry every number.
  const newest = Object.values(search.points)
    .filter((p) => !p.known)
    .sort((a, b) => (b.order ?? 0) - (a.order ?? 0))[0]?.rung
  const limitY = y(target)
  const labelY = (top: number) => {
    const at = top - 6
    // Keep clear of the limit line and its label: sit just above it instead.
    return Math.abs(at - limitY) < 14 ? Math.min(at, limitY - 16) : at
  }

  const bar = (x: number, top: number, w: number) => {
    const r = Math.min(4, w / 2, (BASE - top) / 2)
    return `M${x},${BASE} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${BASE} Z`
  }

  const rows = Array.from({ length: n }, (_, rung) => ({
    rung,
    status: statusOf(rung, search, lo, hi),
    point: search.points[rung] as RungPoint | undefined,
  }))
  const hovered = hover === null ? null : hover === -1 ? 'original' : rows[hover]
  const tried = Object.values(search.points)
    .filter((p) => !p.known)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const known = Object.values(search.points).filter((p) => p.known)

  const describe = (status: RungStatus) =>
    ({
      fit: 'Fits under your limit',
      over: 'Too big',
      failed: 'Could not be made at this setting',
      trying: 'Trying now...',
      open: 'Not tried yet',
      'too-big': 'Skipped: would be too big',
      'not-needed': 'Skipped: stronger than needed',
    })[status]

  return (
    <figure className={`ladder${settled ? ' settled' : ''}`}>
      <div className="ladder-legend" aria-hidden="true">
        <span><i className="swatch fit" /> Fits</span>
        <span><i className="swatch over" /> Too big</span>
        <span><i className="swatch skipped" /> Skipped</span>
        <span><i className="swatch limit" /> Your limit</span>
      </div>
      <div className="ladder-plot" ref={plotRef} onMouseLeave={() => setHover(null)}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-labelledby={`${tableId}-cap`}
          aria-describedby={tableId}
        >
          {/* Recessive grid: a few round sizes on the log scale. */}
          {ticks.map((t) => (
            <g key={t} className="ladder-grid">
              <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} />
              <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
                {tickLabel(t)}
              </text>
            </g>
          ))}

          {/* The still-possible band: where the answer must be. */}
          {!settled && lo <= hi ? (
            <rect
              className="ladder-band"
              x={M.left + cw * (lo + 1)}
              y={M.top}
              width={cw * (hi - lo + 1)}
              height={PLOT_H}
            />
          ) : null}

          {/* Original file */}
          <path className="ladder-bar original" d={bar(cx(0) - bw / 2, y(originalBytes), bw)} />
          <text className="ladder-value" x={cx(0)} y={y(originalBytes) - 6} textAnchor="middle">
            {fmt(originalBytes)}
          </text>

          {rows.map(({ rung, status, point }) => {
            const x = cx(rung + 1)
            const hasBar = point && point.size !== null
            const top = hasBar ? y(point.size as number) : BASE
            const chosen = chosenRung === rung
            return (
              <g key={rung} className={`ladder-col ${status}${point?.known ? ' known' : ''}${chosen ? ' chosen' : ''}`}>
                {status === 'trying' ? (
                  <rect className="ladder-trying" x={x - cw / 2 + 1} y={M.top} width={cw - 2} height={PLOT_H} rx="4" />
                ) : null}
                {hasBar ? (
                  <path className="ladder-bar" d={bar(x - bw / 2, top, bw)} />
                ) : (
                  <line className="ladder-stub" x1={x - bw / 2} x2={x + bw / 2} y1={BASE - 1} y2={BASE - 1} />
                )}
                {hasBar && (chosen || (chosenRung === undefined && rung === newest)) ? (
                  <text className="ladder-value" x={x} y={labelY(top)} textAnchor="middle">
                    {fmt(point.size as number)}
                  </text>
                ) : null}
                {status === 'fit' || status === 'over' || status === 'failed' ? (
                  <text className={`ladder-mark ${status}`} x={x} y={BASE + 16} textAnchor="middle" aria-hidden="true">
                    {status === 'fit' ? '✓' : status === 'over' ? '✗' : '!'}
                  </text>
                ) : null}
                <text className="ladder-rung" x={x} y={BASE + 32} textAnchor="middle">
                  {rung + 1}
                </text>
              </g>
            )
          })}

          {/* The limit: a solid line, labelled directly. */}
          <line className="ladder-limit" x1={M.left} x2={W - M.right} y1={y(target)} y2={y(target)} />
          <text className="ladder-limit-label" x={W - M.right} y={y(target) - 6} textAnchor="end">
            {narrow ? fmt(target) : `Your limit ${fmt(target)}`}
          </text>

          <text className="ladder-axis" x={cx(0)} y={BASE + 32} textAnchor="middle">
            {/* A column is ~20px on a phone: "Original" would run into "1". */}
            {narrow ? 'File' : 'Original'}
          </text>
          <text className="ladder-axis" x={cx(1) - cw / 2} y={H - 2} textAnchor="start">
            Gentle
          </text>
          <text className="ladder-axis" x={W - M.right} y={H - 2} textAnchor="end">
            Strong
          </text>

          {/* Hover targets: whole columns, far bigger than the marks. */}
          {Array.from({ length: cols }, (_, col) => (
            <rect
              key={col}
              className="ladder-hit"
              x={M.left + cw * col}
              y={M.top}
              width={cw}
              height={PLOT_H + M.bottom}
              onMouseEnter={() => setHover(col - 1)}
            />
          ))}
        </svg>

        {hovered ? (
          <div
            className="ladder-tip"
            style={{ left: `${((M.left + cw * ((hover ?? 0) + 1.5)) / W) * 100}%` }}
            role="status"
          >
            {hovered === 'original' ? (
              <>
                <strong>Your file</strong>
                <span>{fmt(originalBytes)}</span>
              </>
            ) : (
              <>
                <strong>Setting {hovered.rung + 1}</strong>
                {hovered.point?.label ? <span>{hovered.point.label}</span> : null}
                {hovered.point && hovered.point.size !== null ? <span>{fmt(hovered.point.size)}</span> : null}
                <span className={`tip-status ${hovered.status}`}>
                  {hovered.point?.known ? 'Measured while reading your file. ' : ''}
                  {describe(hovered.status)}
                </span>
              </>
            )}
          </div>
        ) : null}
      </div>

      <figcaption id={`${tableId}-cap`} className="ladder-caption" aria-live="polite">
        {narrate(search, chosenRung)}
      </figcaption>

      <details className="ladder-table">
        <summary>Show as a table</summary>
        <table id={tableId}>
          <thead>
            <tr>
              <th scope="col">Try</th>
              <th scope="col">Setting</th>
              <th scope="col">Size</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {known.map((p) => (
              <tr key={`k${p.rung}`}>
                <td>Before</td>
                <td>{p.rung + 1} of {n}, strongest</td>
                <td>{p.size === null ? 'n/a' : fmt(p.size)}</td>
                <td>{p.fits ? 'Fits' : 'Too big'} (measured while reading your file)</td>
              </tr>
            ))}
            {tried.map((p) => (
              <tr key={p.rung} className={chosenRung === p.rung ? 'chosen' : undefined}>
                <td>{p.order}</td>
                <td>
                  {p.rung + 1} of {n}
                  {p.label ? `, ${p.label}` : ''}
                </td>
                <td>{p.size === null ? 'n/a' : fmt(p.size)}</td>
                <td>
                  {p.size === null ? 'Could not be made' : p.fits ? 'Fits' : 'Too big'}
                  {chosenRung === p.rung ? ', kept' : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  )
}
