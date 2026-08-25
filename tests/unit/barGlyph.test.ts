import { renderBar } from '../../src/ink/barGlyph.js'
describe('renderBar', () => {
  it('renders fixed width', () => expect(renderBar(50, 0)).toHaveLength(20))
  it('clamps values', () => { expect(renderBar(-10, 0)).toBe(renderBar(0, 0)); expect(renderBar(110, 0)).toBe(renderBar(100, 0)) })
  it('animates shine and dot', () => { expect(renderBar(50, 0)).not.toBe(renderBar(50, 1)) })
  it('supports custom width', () => expect(renderBar(50, 0, 4)).toHaveLength(6))
  it('returns brackets', () => expect(renderBar(0, 0).startsWith('[') && renderBar(0, 0).endsWith(']')).toBe(true))
})
