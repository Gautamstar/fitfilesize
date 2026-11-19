const test = require('node:test')
const assert = require('node:assert/strict')
const { readLimits, wantsJpeg, formatSize, fittedName } = require('../limits.js')

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
