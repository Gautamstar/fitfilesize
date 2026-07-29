/**
 * The stream is the happy path, the poll is the safety net.
 *
 * These tests exist because the failure they cover is invisible: a proxy or an
 * extension can hold an event-stream open and deliver nothing, and the UI just
 * sits on "Working on it" with no error, no console message, and no way for the
 * user to tell whether the job is slow or dead.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProgressStream } from './useProgressStream'

/** Stands in for EventSource so each test decides what the stream delivers. */
class FakeEventSource {
  static last: FakeEventSource | null = null
  static created = 0

  url: string
  closed = false
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  private listeners: Record<string, ((e: MessageEvent) => void)[]> = {}

  constructor(url: string) {
    this.url = url
    FakeEventSource.last = this
    FakeEventSource.created += 1
  }

  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    ;(this.listeners[type] ??= []).push(fn)
  }

  removeEventListener() {}

  close() {
    this.closed = true
  }

  /** Deliver a default (unnamed) event, i.e. a ProgressEvent. */
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)
  }

  /** Deliver the named `state` event. */
  emitState(data: unknown) {
    for (const fn of this.listeners.state ?? []) {
      fn({ data: JSON.stringify(data) } as MessageEvent)
    }
  }

  fail() {
    this.onerror?.()
  }
}

const DONE_STATE = {
  job_id: 'j1',
  status: 'done',
  kind: 'image',
  filename: 'photo.jpg',
  size_bytes: 900_000,
  pages: 1,
  expires_in: 600,
  hit_target: true,
  final_bytes: 220_000,
  target_bytes: 300_000,
  method: 'rung:4',
  warnings: [],
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  FakeEventSource.last = null
  FakeEventSource.created = 0
  vi.stubGlobal('EventSource', FakeEventSource)

  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => DONE_STATE,
  }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useProgressStream', () => {
  it('stays idle until enabled', () => {
    renderHook(() => useProgressStream('j1', false))
    expect(FakeEventSource.created).toBe(0)
  })

  it('builds steps from stream events and resolves on done', async () => {
    const { result } = renderHook(() => useProgressStream('j1', true))

    act(() => {
      FakeEventSource.last!.emit({ stage: 'start', target_bytes: 300_000 })
      FakeEventSource.last!.emit({ stage: 'lossless', size: 880_000 })
      FakeEventSource.last!.emit({
        stage: 'rung_start',
        rung: 4,
        max_edge: 2200,
        quality: 78,
      })
      FakeEventSource.last!.emit({ stage: 'rung_result', rung: 4, size: 220_000, fits: true })
    })

    expect(result.current.steps).toHaveLength(3)
    expect(result.current.attempts).toBe(2)
    // The rung result fills in its own start line rather than adding one.
    expect(result.current.steps[2]?.text).toContain('214.8 KB')
    expect(result.current.steps[2]?.tag).toBe('under')

    act(() => {
      FakeEventSource.last!.emit({
        stage: 'done',
        hit_target: true,
        final_bytes: 220_000,
        original_bytes: 900_000,
        target_bytes: 300_000,
        method: 'rung:4',
        warnings: [],
      })
    })

    expect(result.current.result?.final_bytes).toBe(220_000)
    expect(FakeEventSource.last!.closed).toBe(true)
    // The stream answered, so the fallback never had to run.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('labels a PDF rung with DPI rather than pixel width', () => {
    const { result } = renderHook(() => useProgressStream('j1', true))
    act(() => {
      FakeEventSource.last!.emit({
        stage: 'rung_start',
        rung: 2,
        color_dpi: 200,
        mono_dpi: 400,
        jpeg_q: 80,
      })
    })
    expect(result.current.steps[0]?.text).toBe('Trying 200 DPI, JPEG quality 80')
  })

  it('marks a failed render as skipped instead of reporting a size', () => {
    const { result } = renderHook(() => useProgressStream('j1', true))
    act(() => {
      FakeEventSource.last!.emit({ stage: 'rung_start', rung: 1, max_edge: 3500, quality: 88 })
      FakeEventSource.last!.emit({ stage: 'rung_result', rung: 1, size: null, fits: false })
    })
    expect(result.current.steps[0]?.text).toContain('failed, skipping')
    expect(result.current.steps[0]?.tag).toBeUndefined()
  })

  it('polls and resolves when the stream connects but delivers nothing', async () => {
    const { result } = renderHook(() => useProgressStream('j1', true))

    // A stream that says nothing. Before the fallback existed this sat here
    // forever, which is exactly the bug this test is here to prevent.
    expect(result.current.result).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(fetchMock).not.toHaveBeenCalled()

    // Past the grace period the poll takes over.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })

    expect(fetchMock).toHaveBeenCalled()
    expect(result.current.result).not.toBeNull()
    expect(result.current.result?.final_bytes).toBe(220_000)
    expect(result.current.result?.method).toBe('rung:4')
    expect(FakeEventSource.last!.closed).toBe(true)
  })

  it('starts polling immediately when the stream errors', async () => {
    const { result } = renderHook(() => useProgressStream('j1', true))

    act(() => {
      FakeEventSource.last!.fail()
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })

    // No grace period was waited out; the error alone started the poll.
    expect(result.current.result).not.toBeNull()
  })

  it('surfaces a failed job from the poll', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ ...DONE_STATE, status: 'error', error: 'ghostscript exploded' }),
    }))

    const { result } = renderHook(() => useProgressStream('j1', true))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    expect(result.current.error).toBe('ghostscript exploded')
    expect(result.current.result).toBeNull()
  })

  it('keeps polling through a failed request rather than giving up', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce(new Error('network down'))
      .mockImplementation(async () => ({ ok: true, json: async () => DONE_STATE }))

    const { result } = renderHook(() => useProgressStream('j1', true))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000)
    })

    expect(fetchMock.mock.calls.length).toBeGreaterThan(2)
    expect(result.current.result).not.toBeNull()
  })

  it('closes the connection and stops polling on unmount', async () => {
    const { unmount } = renderHook(() => useProgressStream('j1', true))
    const es = FakeEventSource.last!

    unmount()
    expect(es.closed).toBe(true)

    const callsAtUnmount = fetchMock.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000)
    })
    expect(fetchMock.mock.calls.length).toBe(callsAtUnmount)
  })
})
