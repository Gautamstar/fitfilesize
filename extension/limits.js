/**
 * Reads the upload limit a form states in its own words: "Max 50 KB",
 * "10 KB to 20 KB", "200 x 230 pixels". Pure text in, numbers out, so the
 * content script and the Node tests share it.
 *
 * Sizes come back in 1000-byte kilobytes, like the API's units. A form that
 * counts 1024 is checked against the stricter reading when the file is judged.
 */
;(function (root) {
  const NUM = String.raw`(\d+(?:\.\d+)?)`
  const UNIT = String.raw`(kb|mb|kilobytes?|megabytes?)\b`
  const OPT_UNIT = String.raw`(kb|mb|kilobytes?|megabytes?)?`

  const RANGE = new RegExp(
    String.raw`(?:between\s+)?${NUM}\s*${OPT_UNIT}\s*(?:-|to|and)\s*${NUM}\s*${UNIT}`,
    'g',
  )
  // A few words may sit between the cue and the number: "Maximum upload size
  // is 5 MB", "Max. file size: 2MB".
  const GAP = String.raw`(?:\s+[a-z.]+){0,4}?\s*(?:is|of|:|-)?\s*`
  const MAX_BEFORE = new RegExp(
    String.raw`(?:max(?:imum)?\.?${GAP}|(?:up\s*to|(?<!\bnot\s+(?:be\s+)?)less\s+than(?:\s+or\s+equal\s+to)?|` +
      String.raw`under|below|not\s+(?:be\s+)?(?:more|greater)\s+than|no\s+more\s+than|` +
      String.raw`not\s+(?:be\s+|to\s+)?exceed(?:s|ing)?|within|limit(?:ed)?\s+(?:of|to)|<=?|≤)\s*[:\-]?\s*)${NUM}\s*${UNIT}`,
    'g',
  )
  const MAX_AFTER = new RegExp(String.raw`${NUM}\s*${UNIT}\s*(?:max(?:imum)?|or\s+less|and\s+below)\b`, 'g')
  const MIN_BEFORE = new RegExp(
    String.raw`(?:min(?:imum)?\.?${GAP}|(?:at\s+least|more\s+than|greater\s+than|` +
      String.raw`not\s+(?:be\s+)?less\s+than|no\s+less\s+than|>=?|≥)\s*[:\-]?\s*)${NUM}\s*${UNIT}`,
    'g',
  )
  const MIN_AFTER = new RegExp(String.raw`${NUM}\s*${UNIT}\s*(?:min(?:imum)?|or\s+more)\b`, 'g')
  // "Size: 50 KB" with nothing else said: forms mean it as the most allowed.
  const BARE_SIZE = new RegExp(String.raw`size\s*(?:limit)?\s*[:\-]?\s*${NUM}\s*${UNIT}`, 'g')

  const PIXELS = /(\d{2,4})\s*(?:x|×|\*|by)\s*(\d{2,4})\s*(?:px|pixels?)\b/g
  const PIXELS_WORDS =
    /width\s*[:=]?\s*(\d{2,4})\s*(?:px|pixels?)?[^\d]{1,40}?height\s*[:=]?\s*(\d{2,4})\s*(?:px|pixels?)?/g

  function toBytes(n, unit) {
    return Math.round(parseFloat(n) * (unit && unit[0] === 'm' ? 1e6 : 1e3))
  }

  function normalise(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[–—]/g, '-')
      .replace(/\s+/g, ' ')
  }

  /** Every match of a pattern, as [start, end, groups]. */
  function each(re, text) {
    re.lastIndex = 0
    const out = []
    for (let m; (m = re.exec(text)); ) out.push([m.index, m.index + m[0].length, m])
    return out
  }

  /** One value, or null when the text names several different ones. */
  function single(values) {
    const set = [...new Set(values)]
    return set.length === 1 ? set[0] : null
  }

  /**
   * The limits stated in one piece of text: {min, max, width, height}, each
   * null when not stated. Returns null when nothing is stated, or when the text
   * names conflicting limits (a section listing the photo and the signature
   * rules together), since guessing the wrong one is worse than staying quiet.
   */
  function readLimits(raw) {
    const text = normalise(raw)
    // "50 kb & 20 kb respectively": several fields' limits in one sentence.
    if (/\brespectively\b/.test(text)) return null
    const mins = []
    const maxes = []
    const taken = []
    for (const [a, b, m] of each(RANGE, text)) {
      const unit = m[2] || m[4]
      const lo = toBytes(m[1], unit)
      const hi = toBytes(m[3], m[4])
      if (lo < hi) {
        mins.push(lo)
        maxes.push(hi)
        taken.push([a, b])
      }
    }
    const free = ([a, b]) => !taken.some(([x, y]) => a < y && b > x)
    for (const hit of [...each(MAX_BEFORE, text), ...each(MAX_AFTER, text)]) {
      if (free(hit)) maxes.push(toBytes(hit[2][1], hit[2][2])), taken.push(hit)
    }
    for (const hit of [...each(MIN_BEFORE, text), ...each(MIN_AFTER, text)]) {
      if (free(hit)) mins.push(toBytes(hit[2][1], hit[2][2])), taken.push(hit)
    }
    if (!maxes.length) {
      for (const hit of each(BARE_SIZE, text)) {
        if (free(hit)) maxes.push(toBytes(hit[2][1], hit[2][2]))
      }
    }
    const sizes = [...each(PIXELS, text), ...each(PIXELS_WORDS, text)].map(
      ([, , m]) => `${+m[1]}x${+m[2]}`,
    )

    if (!mins.length && !maxes.length && !sizes.length) return null
    const max = maxes.length ? single(maxes) : null
    const min = mins.length ? single(mins) : null
    const pixels = sizes.length ? single(sizes) : null
    if ((maxes.length && max === null) || (mins.length && min === null) || (sizes.length && pixels === null)) {
      return null
    }
    if (min !== null && max !== null && min >= max) return null
    const [width, height] = pixels ? pixels.split('x').map(Number) : [null, null]
    return { min, max, width, height }
  }

  /** Whether the text says the form wants a JPEG and not a PNG. */
  function wantsJpeg(raw) {
    const text = normalise(raw)
    return /\bjpe?g\b|image\/jpeg/.test(text) && !/\bpng\b|image\/png/.test(text)
  }

  /** Bytes as the site writes them: 1000-based, "24 KB", "1.5 MB". */
  function formatSize(n) {
    if (n < 1e6) {
      const kb = n / 1000
      return `${kb < 10 ? Math.round(kb * 10) / 10 : Math.round(kb)} KB`
    }
    return `${Math.round(n / 1e5) / 10} MB`
  }

  const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'image/tiff': 'tif', 'image/bmp': 'bmp', 'application/pdf': 'pdf' }

  /** The fitted file's name: the original, with a new extension only if the format changed. */
  function fittedName(name, mime) {
    const ext = EXT[mime]
    if (!ext) return name
    const stem = name.replace(/\.[^.]+$/, '')
    const old = (name.match(/\.([^.]+)$/) || [])[1] || ''
    // Keep "photo.jpeg" as it was; only a changed format gets a new extension.
    if (old.toLowerCase().replace('jpeg', 'jpg').replace('tiff', 'tif') === ext) return name
    return `${stem}.${ext}`
  }

  /**
   * The minimum to aim for. A form that counts 1024 bytes to a kilobyte asks
   * for 2.4% more than its number says, and a result that lands exactly on
   * the line reads as borderline ("20 KB" for "20 KB to 50 KB"), so aim 5%
   * inside when the range leaves room.
   */
  function aimMinimum(min, max) {
    for (const aim of [Math.ceil(min * 1.05), Math.ceil(min * 1.024), min]) {
      if (!max || aim < max) return aim
    }
    return min
  }

  const api = { readLimits, wantsJpeg, formatSize, fittedName, aimMinimum }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.FitFileSizeLimits = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
