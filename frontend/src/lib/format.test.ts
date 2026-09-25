import { describe, expect, it } from 'vitest'
import { fmtLimit, savedPercent, sentence } from './format'

describe('fmtLimit', () => {
  it('keeps a round limit as the visitor chose it', () => {
    expect(fmtLimit(50_000)).toBe('50 KB')
    expect(fmtLimit(2_000_000)).toBe('2 MB')
    expect(fmtLimit(1_500_000)).toBe('1.5 MB')
  })

  it('formats any other size as usual', () => {
    expect(fmtLimit(51_234)).toBe('50.0 KB')
  })
})

describe('savedPercent', () => {
  it('never claims 100 percent for a file that still has bytes', () => {
    expect(savedPercent(16_644, 5_001_765)).toBe(99)
  })

  it('never claims 0 percent for a file that got smaller', () => {
    expect(savedPercent(998, 1000)).toBe(1)
  })

  it('rounds normally in between', () => {
    expect(savedPercent(48_700, 113_967)).toBe(57)
  })
})

describe('sentence', () => {
  it('capitalises and ends an API message', () => {
    expect(sentence('that file is not a readable PDF or image')).toBe(
      'That file is not a readable PDF or image.',
    )
  })

  it('leaves a finished sentence alone', () => {
    expect(sentence('Done!')).toBe('Done!')
  })
})
