import { describe, expect, test } from 'bun:test'
import { fmtCompact, fmtInt, totalCell } from './format.ts'

describe('token totals with omitted components', () => {
  test('a component the server omitted renders "—", never 0', () => {
    for (const v of [undefined, null]) {
      const c = totalCell(v, false)
      expect(c.missing).toBe(true)
      expect(c.text).toBe('—')
      expect(c.compact).toBe('—')
      expect(c.ge).toBe(false) // no lower-bound marker on an unknown value
    }
    expect(fmtInt(undefined)).toBe('—')
    expect(fmtCompact(undefined)).toBe('—')
  })

  test('reported values format normally; partial captures mark a lower bound', () => {
    expect(totalCell(0, false)).toMatchObject({ missing: false, text: '0', ge: false })
    expect(totalCell(925307, true)).toMatchObject({ missing: false, text: '925,307', compact: '925k', ge: true })
  })
})
