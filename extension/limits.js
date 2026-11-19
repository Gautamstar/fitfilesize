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
    String.raw`(?:max(?:imum)?\.?${GAP}|(?:up\s*to|less\s+than(?:\s+or\s+equal\s+to)?|under|below|` +
      String.raw`not\s+(?:more|greater)\s+than|no\s+more\s+than|(?:should|must|shall)\s+not\s+exceed|` +
      String.raw`not\s+exceed(?:ing)?|within|limit(?:ed)?\s+(?:of|to)|<=?|≤)\s*[:\-]?\s*)${NUM}\s*${UNIT}`,
    'g',
  )
  const MAX_AFTER = new RegExp(String.raw`${NUM}\s*${UNIT}\s*(?:max(?:imum)?|or\s+less|and\s+below)\b`, 'g')
  const MIN_BEFORE = new RegExp(
    String.raw`(?:min(?:imum)?\.?${GAP}|(?:at\s+least|more\s+than|greater\s+than|` +
      String.raw`not\s+less\s+than|no\s+less\s+than|>=?|≥)\s*[:\-]?\s*)${NUM}\s*${UNIT}`,
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

  const api = { readLimits, wantsJpeg }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.FitFileSizeLimits = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
