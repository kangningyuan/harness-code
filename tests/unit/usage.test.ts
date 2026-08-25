import { UsageTracker, computeCost, formatCost } from '../../src/services/api/usage.js'

describe('usage', () => {
  it('computes known and fallback model costs', () => {
    expect(computeCost('gpt-5.5', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(1.25)
    expect(computeCost('unknown', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(1.25)
  })
  it('tracks totals per model', () => {
    const tracker = new UsageTracker(); tracker.add('gpt-5.4-mini', { inputTokens: 10, outputTokens: 20 })
    expect(tracker.getByModel().get('gpt-5.4-mini')).toMatchObject({ inputTokens: 10, outputTokens: 20 })
    expect(tracker.getTotalCost()).toBeGreaterThan(0); tracker.reset(); expect(tracker.getTotalCost()).toBe(0)
  })
  it('formats small and large costs', () => { expect(formatCost(0.12345)).toBe('$0.1235'); expect(formatCost(1.234)).toBe('$1.23') })
})
