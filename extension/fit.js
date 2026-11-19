/**
 * The by-hand page: for drag-and-drop upload boxes and limits stated away from
 * the box. The person types the limit; the fitted file is downloaded.
 */
const { formatSize, fittedName } = globalThis.FitFileSizeLimits
const MAX_SEND = 30 * 1000 * 1000
// Forms that count 1024 bytes to a kilobyte ask for slightly more at the low end.
const KIB = 1.024

const $ = (id) => document.getElementById(id)
let file = null
let lastUrl = null

$('file').addEventListener('change', () => pick($('file').files[0]))
const drop = $('drop')
drop.addEventListener('dragover', (e) => (e.preventDefault(), drop.classList.add('over')))
drop.addEventListener('dragleave', () => drop.classList.remove('over'))
drop.addEventListener('drop', (e) => {
  e.preventDefault()
  drop.classList.remove('over')
  pick(e.dataTransfer.files[0])
})

function pick(f) {
  file = f || null
  $('picked').textContent = file ? `${file.name}, ${formatSize(file.size)}` : ''
  status('')
}

function status(text, error = false) {
  $('status').textContent = text
  $('status').className = error ? 'status error' : 'status'
}

$('form').addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!file) return status('Choose a file first.', true)
  if (file.size > MAX_SEND) return status('Files over 30 MB are too large to fit here; try fitfilesize.com.', true)
  const unit = Number($('unit').value)
  const max = Math.round(Number($('max').value) * unit)
  const min = $('min').value ? Math.round(Number($('min').value) * unit) : null
  const width = $('width').value ? Number($('width').value) : null
  const height = $('height').value ? Number($('height').value) : null
  if (min !== null && min >= max) return status('"At least" has to be smaller than "at most".', true)
  if (!width !== !height) return status('Give both a width and a height, or neither.', true)
  const jpeg = $('jpeg').checked

  $('go').disabled = true
  document.querySelector('.download')?.remove()
  status(`Fitting ${file.name}...`)
  let result
  try {
    result = await chrome.runtime.sendMessage({
      type: 'fit',
      name: file.name,
      mime: file.type,
      data: await base64(file),
      target: max,
      minimum: min && (Math.ceil(min * KIB) < max ? Math.ceil(min * KIB) : min),
      width,
      height,
      keepFormat: !jpeg,
      allowJpeg: jpeg,
    })
  } catch (error) {
    result = { error: error.message }
  } finally {
    $('go').disabled = false
  }
  if (!result || result.error) return status(result?.error || 'Something went wrong.', true)
  if (!result.fits) {
    const smallest = result.finalBytes ? ` The smallest it could get is ${formatSize(result.finalBytes)}.` : ''
    return status(`This file cannot be made that small.${smallest}`, true)
  }
  const bytes = Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0))
  const name = fittedName(file.name, result.mime)
  if (lastUrl) URL.revokeObjectURL(lastUrl)
  lastUrl = URL.createObjectURL(new Blob([bytes], { type: result.mime }))
  const pixels = width ? `, ${width} x ${height} pixels` : ''
  status(`Done: ${name} is ${formatSize(bytes.length)}${pixels}.`)
  const link = document.createElement('a')
  link.className = 'download'
  link.href = lastUrl
  link.download = name
  link.textContent = `Download ${name}`
  $('status').after(link)
  link.focus()
})

function base64(f) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] || '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(f)
  })
}
