// Bundle the form presets from the website's page data, as the package's
// offline copy (src/forms-snapshot.json). The package prefers the live list
// at https://fitfilesize.com/forms.json, built by the same function.
import { readFileSync, writeFileSync } from 'node:fs'
import { formsFromPages } from '../../frontend/scripts/forms.mjs'

const data = JSON.parse(readFileSync(new URL('../../frontend/src/lib/landing-pages.json', import.meta.url)))
const forms = formsFromPages(data.pages, 'https://fitfilesize.com')
writeFileSync(
  new URL('../src/forms-snapshot.json', import.meta.url),
  `${JSON.stringify({ updated: data.updated, forms }, null, 2)}\n`,
)
console.log(`sync-forms: ${forms.length} forms`)
