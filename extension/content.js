/**
 * Watches file inputs. When a picked file breaks the limit the form states
 * next to it, offers to fit it; the file leaves the page only on "Fit it".
 */
;(function () {
  const { readLimits, wantsJpeg, formatSize, fittedName, aimMinimum } = globalThis.FitFileSizeLimits
  const MAX_SEND = 30 * 1000 * 1000
  const KINDS = /\.(pdf|jpe?g|png|webp|gif|heic|heif|tiff?|bmp)$/i
  const ANCESTORS = 6
  const TEXT_LIMIT = 1500
  // Forms that count 1024 bytes to a kilobyte ask for slightly more at the
  // low end; aim above that so either reading is met.
  const KIB = 1.024

  let swapping = false
  let enabled = true
  chrome.storage?.local.get({ enabled: true }).then((s) => (enabled = s.enabled), () => {})
  chrome.storage?.onChanged.addListener((c) => {
    if (c.enabled) enabled = c.enabled.newValue
  })

  window.addEventListener('change', onChange, true)

  async function onChange(event) {
    const input = event.target
    if (swapping || !enabled || !(input instanceof HTMLInputElement) || input.type !== 'file') return
    if (!input.files || input.files.length !== 1) return
    const file = input.files[0]
    if (!KINDS.test(file.name)) return
    const found = limitsFor(input)
    if (!found) return
    const { limits, text } = found
    const isImage = /\.(jpe?g|png|webp|gif|bmp)$/i.test(file.name)
    const pixels = isImage && limits.width ? await dimensions(file) : null
    const problem = check(file, limits, pixels)
    if (!problem) return
    offer(input, file, limits, problem, wantsJpeg(`${input.accept} ${text}`))
  }

  /** The limits stated nearest the input, and the text they came from. */
  function limitsFor(input) {
    const texts = []
    for (const label of input.labels || []) texts.push(label.innerText)
    for (const id of (input.getAttribute('aria-describedby') || '').split(/\s+/)) {
      const el = id && document.getElementById(id)
      if (el) texts.push(el.innerText)
    }
    if (input.title) texts.push(input.title)
    let el = input.parentElement
    for (let i = 0; el && i < ANCESTORS; i++, el = el.parentElement) {
      const text = el.innerText || ''
      if (text.length > TEXT_LIMIT) break
      texts.push(text)
    }
    for (const text of texts) {
      const limits = readLimits(text)
      if (limits) return { limits, text }
    }
    return null
  }

  async function dimensions(file) {
    try {
      const bitmap = await createImageBitmap(file)
      const size = { width: bitmap.width, height: bitmap.height }
      bitmap.close()
      return size
    } catch {
      return null
    }
  }

  /** What is wrong with the file for this form, or null when nothing is. */
  function check(file, limits, pixels) {
    const wrong = []
    if (limits.max && file.size > limits.max) wrong.push('size')
    if (limits.min && file.size < limits.min * KIB) wrong.push('size')
    if (pixels && (pixels.width !== limits.width || pixels.height !== limits.height)) wrong.push('pixels')
    if (!wrong.length) return null
    let has = `This file is ${formatSize(file.size)}`
    if (wrong.includes('pixels')) has += `, ${pixels.width} x ${pixels.height} pixels`
    return `${has}. The form asks for ${describe(limits)}.`
  }

  function describe(limits) {
    const parts = []
    if (limits.min && limits.max) parts.push(`${formatSize(limits.min)} to ${formatSize(limits.max)}`)
    else if (limits.max) parts.push(`at most ${formatSize(limits.max)}`)
    else if (limits.min) parts.push(`at least ${formatSize(limits.min)}`)
    if (limits.width) parts.push(`${limits.width} x ${limits.height} pixels`)
    return parts.join(', ')
  }

  function offer(input, file, limits, problem, jpeg) {
    if (file.size > MAX_SEND) {
      toast(`${problem} Files over 30 MB are too large to fit here; try fitfilesize.com.`)
      return
    }
    toast(problem, [
      ['Fit it', () => fitInto(input, file, limits, jpeg)],
      ['Not now', close],
    ], 'Sends the file to fitfilesize.com. It is deleted from the server once fitted.')
  }

  async function fitInto(input, file, limits, jpeg) {
    toast(`Fitting ${file.name}...`)
    let target = limits.max || Math.max(file.size, 2e6)
    let minimum = null
    if (limits.min) {
      minimum = aimMinimum(limits.min, target)
    }
    let result
    try {
      result = await chrome.runtime.sendMessage({
        type: 'fit',
        name: file.name,
        mime: file.type,
        data: await base64(file),
        target,
        minimum,
        width: limits.width,
        height: limits.height,
        keepFormat: !jpeg,
        allowJpeg: jpeg,
      })
    } catch {
      result = { error: 'The extension was updated. Reload the page and pick the file again.' }
    }
    if (!result || result.error) {
      toast(result?.error || 'Something went wrong. Your file is unchanged.')
      return
    }
    if (!result.fits) {
      const smallest = result.finalBytes ? ` The smallest it could get is ${formatSize(result.finalBytes)}.` : ''
      toast(`This file cannot be made that small.${smallest} Your file is unchanged.`)
      return
    }
    const bytes = Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0))
    const fitted = new File([bytes], fittedName(file.name, result.mime), { type: result.mime })
    const dt = new DataTransfer()
    dt.items.add(fitted)
    swapping = true
    try {
      input.files = dt.files
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    } finally {
      swapping = false
    }
    const pixels = limits.width ? `, ${limits.width} x ${limits.height} pixels` : ''
    toast(`Done: ${fitted.name} is ${formatSize(fitted.size)}${pixels}.`)
    const shown = host
    setTimeout(() => host === shown && close(), 8000)
  }

  function base64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result).split(',', 2)[1] || '')
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
  }

  // The prompt lives in a shadow root so the page's styles cannot reach it.
  let host = null
  function toast(message, actions = [], note = '') {
    close()
    host = document.createElement('fitfilesize-prompt')
    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML = `
      <style>
        .box { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; max-width: 340px;
          background: #fff; color: #1e293b; border: 1px solid #c9d5fb; border-left: 4px solid #2451e0;
          border-radius: 10px; box-shadow: 0 8px 24px rgba(15, 23, 42, .15); padding: 14px 16px;
          font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
        .title { font-weight: 600; color: #1d43c2; font-size: 12px; margin-bottom: 4px; }
        .note { color: #64748b; font-size: 12px; margin-top: 8px; }
        .row { display: flex; gap: 8px; margin-top: 10px; }
        button { font: inherit; border-radius: 6px; padding: 6px 14px; cursor: pointer;
          border: 1px solid #2451e0; background: #fff; color: #2451e0; }
        button:first-child { background: #2451e0; color: #fff; }
        button:focus-visible { outline: 2px solid #c9d5fb; outline-offset: 2px; }
      </style>
      <div class="box" role="status">
        <div class="title">FitFileSize</div>
        <div class="msg"></div>
      </div>`
    const box = root.querySelector('.box')
    root.querySelector('.msg').textContent = message
    if (actions.length) {
      const row = document.createElement('div')
      row.className = 'row'
      for (const [label, run] of actions) {
        const button = document.createElement('button')
        button.textContent = label
        button.addEventListener('click', run)
        row.append(button)
      }
      box.append(row)
    }
    if (note) {
      const p = document.createElement('div')
      p.className = 'note'
      p.textContent = note
      box.append(p)
    }
    document.documentElement.append(host)
  }

  function close() {
    host?.remove()
    host = null
  }
})()
