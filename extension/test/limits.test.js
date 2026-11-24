const test = require('node:test')
const assert = require('node:assert/strict')
const { readLimits, wantsJpeg, formatSize, fittedName, aimMinimum } = require('../limits.js')

const limits = (min, max, width = null, height = null) => ({ min, max, width, height })

test('reads a range the way forms write it', () => {
  assert.deepEqual(readLimits('Photograph: 20 KB to 50 KB'), limits(20000, 50000))
  assert.deepEqual(readLimits('Size of file should be between 10 KB – 20 KB'), limits(10000, 20000))
  assert.deepEqual(readLimits('Signature (10-20kb)'), limits(10000, 20000))
  assert.deepEqual(readLimits('PDF between 50 KB and 300 KB'), limits(50000, 300000))
})

test('reads a maximum in its usual phrasings', () => {
  for (const text of [
    'Max. file size: 2MB',
    'Maximum upload size is 2 MB',
    'File size should not exceed 2 MB',
    'Photo size not to exceed 2 MB',
    'Upload photo (JPG, less than 2mb)',
    'up to 2 MB',
    'less than or equal to 2 MB',
    '2 MB max',
    'File size: 2 MB',
  ]) {
    assert.deepEqual(readLimits(text), limits(null, 2000000), text)
  }
})

test('reads a minimum alongside a maximum', () => {
  assert.deepEqual(readLimits('Minimum 10 KB, maximum 20 KB'), limits(10000, 20000))
  assert.deepEqual(readLimits('at least 20 KB and not more than 200 KB'), limits(20000, 200000))
})

test('reads exact pixels next to a size', () => {
  assert.deepEqual(readLimits('Photo: 200 x 230 pixels, 20 KB to 50 KB'), limits(20000, 50000, 200, 230))
  assert.deepEqual(readLimits('Dimensions 140*60 px, max 20kb'), limits(null, 20000, 140, 60))
  assert.deepEqual(readLimits('Width: 600 px, Height: 600 px. Max 240 KB'), limits(null, 240000, 600, 600))
})

test('stays quiet when nothing is stated or the text is ambiguous', () => {
  assert.equal(readLimits('Upload your photograph'), null)
  assert.equal(readLimits('3.5 cm x 4.5 cm passport photo'), null)
  assert.equal(readLimits('Upload a maximum of 2 files'), null)
  // A section listing two fields' rules: which one applies is unknown.
  assert.equal(readLimits('Photo 20-50 KB. Signature 10-20 KB.'), null)
  assert.equal(readLimits('Photo 200 x 230 pixels, signature 140 x 60 pixels'), null)
  assert.equal(readLimits('between 50 KB and 20 KB'), null)
})

test('tells a JPEG-only form from one that takes PNG', () => {
  assert.equal(wantsJpeg('.jpg,.jpeg'), true)
  assert.equal(wantsJpeg('image/jpeg'), true)
  assert.equal(wantsJpeg('JPG or PNG, max 1 MB'), false)
  assert.equal(wantsJpeg('Max 1 MB'), false)
})

test('writes sizes the way the site does', () => {
  assert.equal(formatSize(24169), '24 KB')
  assert.equal(formatSize(8450), '8.5 KB')
  assert.equal(formatSize(1500000), '1.5 MB')
})

test('renames a file only when its format changed', () => {
  assert.equal(fittedName('photo.jpeg', 'image/jpeg'), 'photo.jpeg')
  assert.equal(fittedName('scan.PDF', 'application/pdf'), 'scan.PDF')
  assert.equal(fittedName('IMG_0042.HEIC', 'image/jpeg'), 'IMG_0042.jpg')
  assert.equal(fittedName('logo.png', 'image/png'), 'logo.png')
})

// Wording copied from official notices and bulletins (SBI, IBPS, SSC, RRB,
// UPSC, NTA, state commissions, universities, visa and job sites); see
// growth/form-wording.md for sources.
test('reads the wording real application forms use', () => {
  const cases = [
    ['Dimensions 200 x 230 pixels (preferred) Size of file should be between 20 kb–50 kb', limits(20000, 50000, 200, 230)],
    ['Ensure that size of the scanned image is not more than 50kb.', limits(null, 50000)],
    ['Dimensions: 240 x 240 pixels in 200 DPI (Preferred for required quality) i.e. 3 cm x 3 cm (Width x Height). File Size: 20 kb – 50 kb', limits(20000, 50000, 240, 240)],
    ['Dimensions: 800 x 400 pixels in 200 DPI i.e. 10cm x 5 cm (Width x Height) File size: 50 kb- 100 kb', limits(50000, 100000, 800, 400)],
    ['Page size of the document to be A4. iii. Size of the file should not be exceeding 500 KB.', limits(null, 500000)],
    ['Size of file should be between 10kb – 20kb', limits(10000, 20000)],
    ['इमेज फाइल का साइज 20kb – 50 kb के बीच रहे।', limits(20000, 50000)],
    ['passport size photograph in JPEG format (20 KB to 50 KB). Image dimension of the photograph should be about 3.5 cm (width) x 4.5 cm (height).', limits(20000, 50000)],
    ['Scanned signature in JPEG format (10 to 20 KB).', limits(10000, 20000)],
    ['File size: Between 30KB and 49KB', limits(30000, 49000)],
    ['Minimum 140 pixels ( width ) × 60 pixels ( height ) , 30 KB to 49 KB in JPG / JPEG format .', limits(30000, 49000)],
    ['The caste certificate should be up to 400 KB in PDF format.', limits(null, 400000)],
    ['File size: 20 KB – 100 KB Image dimensions: 350 - 500 pixels', limits(20000, 100000)],
    ['each file should not exceed 300 KB each and must not be less than 20 KB in size for the photograph and signature.', limits(20000, 300000)],
    ['Size of the photograph should be between 10 kB to 200 kB and in JPG/JPEG format (clearly legible).', limits(10000, 200000)],
    ['the photo image should be of 165 x 125 pixels and 30 kb – 40 kb size', limits(30000, 40000, 165, 125)],
    ['Photograph size (breadth 3.5 cm* height 4.5 cm) Maximum size 50KB.', limits(null, 50000)],
    ['Passport size photograph in JPG format of minimum 4kb to 40 kb.', limits(4000, 40000)],
    ['format between ranges of 20 kb to 50kb', limits(20000, 50000)],
    ['Passport size photograph (scanned) in jpeg or jpg formats only with size less than 1MB', limits(null, 1000000)],
    ['Size of Image – Minimum 10 KB – Maximum 300 KB', limits(10000, 300000)],
    ['The minimum dimensions are 350 pixels (width) x 350 pixels (height). The maximum file size is 60 kB (kilo bytes).', limits(null, 60000)],
    ['Equal to or less than 240 kB (kilobytes) in file size', limits(null, 240000)],
    ['at least 50KB and no more than 10MB', limits(50000, 10000000)],
  ]
  for (const [text, want] of cases) assert.deepEqual(readLimits(text), want, text)
  // Two fields' limits in one sentence, or sizes that are not limits.
  assert.equal(readLimits('obtain photo and signature in .jpeg format not exceeding 50 kb & 20 kb respectively'), null)
  assert.equal(readLimits('Image dimensions: Minimum140pixels(width)×60pixels (height)'), null)
  assert.equal(readLimits('Ideal pixel resolution for JPG: 320 x 240.'), null)
})

test('aims a little inside a minimum when the range leaves room', () => {
  assert.equal(aimMinimum(20000, 50000), 21000)
  assert.equal(aimMinimum(30000, 31000), 30720) // 5% would pass the maximum
  assert.equal(aimMinimum(30000, 30500), 30000)
})
