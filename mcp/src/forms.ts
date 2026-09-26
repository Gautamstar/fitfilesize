/**
 * Form presets: a form's size limit, minimum and exact pixels, by name.
 *
 * The live list at https://fitfilesize.com/forms.json is preferred, so a form
 * added to the website reaches the package without a release. The copy
 * bundled at build time is used when the site cannot be reached.
 */

import snapshot from './forms-snapshot.json' with { type: 'json' }

export interface Form {
  id: string
  name: string
  kind: 'pdf' | 'image'
  requirements: string[]
  limit_bytes: number
  min_bytes?: number
  width?: number
  height?: number
  source: string
  checked: string
  page: string
}

export const FORMS_URL = 'https://fitfilesize.com/forms.json'

function isForm(f: unknown): f is Form {
  const x = f as Form
  return (
    typeof x?.id === 'string' &&
    typeof x.name === 'string' &&
    (x.kind === 'pdf' || x.kind === 'image') &&
    typeof x.limit_bytes === 'number' &&
    Array.isArray(x.requirements)
  )
}

let cached: Promise<Form[]> | null = null

/** The form list: live if it answers within a few seconds, else the bundled copy. */
export function loadForms(fetchImpl: typeof fetch = fetch, url = FORMS_URL): Promise<Form[]> {
  cached ??= (async () => {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(4000) })
      if (res.ok) {
        const body = (await res.json()) as { forms?: unknown[] }
        const forms = (body.forms ?? []).filter(isForm)
        if (forms.length > 0) return forms
      }
    } catch {
      // Offline or slow: the bundled copy below.
    }
    return snapshot.forms as Form[]
  })()
  return cached
}

/** For tests: forget the cached list. */
export function resetForms(): void {
  cached = null
}

/** A form by id or name, ignoring case and punctuation ("IBPS photo", "ibps-photo"). */
export function findForm(forms: Form[], query: string): Form | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const q = norm(query)
  return forms.find((f) => norm(f.id) === q || norm(f.name) === q)
}
