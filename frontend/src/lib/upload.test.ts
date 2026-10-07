/**
 * The upload names the page it came from, for the server's usage counts, and
 * nothing else about the visit.
 */

import { afterEach, expect, it, vi } from 'vitest'
import { uploadFile } from './api'

let sent: FormData | null = null

class FakeXhr {
  status = 200
  responseText = JSON.stringify({ job_id: 'j1' })
  upload = {}
  onload: (() => void) | null = null
  open() {}
  send(body: FormData) {
    sent = body
    this.onload?.()
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  window.history.pushState({}, '', '/')
  sent = null
})

it('sends the landing page slug with the file', async () => {
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
  window.history.pushState({}, '', '/neet-photo/')
  await uploadFile(new File(['x'], 'photo.jpg', { type: 'image/jpeg' }))
  expect(sent?.get('page')).toBe('neet-photo')
  expect([...sent!.keys()].sort()).toEqual(['file', 'page'])
})

it('sends an empty page from the home page', async () => {
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
  await uploadFile(new File(['x'], 'photo.jpg', { type: 'image/jpeg' }))
  expect(sent?.get('page')).toBe('')
})
