import type { Usage } from './types.js'

export interface ModelPricing { inputPer1M: number; outputPer1M: number; cacheReadPer1M: number; cacheWritePer1M: number }
export interface ModelUsage { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; cost: number }
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  'gpt-5.5': { inputPer1M: 1.25, outputPer1M: 10, cacheReadPer1M: 0.1, cacheWritePer1M: 1.5 },
  'gpt-5.4': { inputPer1M: 1.25, outputPer1M: 10, cacheReadPer1M: 0.1, cacheWritePer1M: 1.5 },
  'gpt-5.4-mini': { inputPer1M: 0.15, outputPer1M: 0.6, cacheReadPer1M: 0.015, cacheWritePer1M: 0.18 },
  'mimo-v2.5': { inputPer1M: 0.5, outputPer1M: 2, cacheReadPer1M: 0.05, cacheWritePer1M: 0.6 },
  'mimo-v2.5-pro': { inputPer1M: 1, outputPer1M: 4, cacheReadPer1M: 0.1, cacheWritePer1M: 1.2 },
}
function pricing(model: string): ModelPricing { return DEFAULT_PRICING[model] ?? DEFAULT_PRICING['gpt-5.5']! }
export function computeCost(model: string, usage: Usage): number {
  const p = pricing(model)
  return usage.inputTokens / 1e6 * p.inputPer1M + usage.outputTokens / 1e6 * p.outputPer1M + (usage.cacheReadInputTokens ?? 0) / 1e6 * p.cacheReadPer1M + (usage.cacheCreationInputTokens ?? 0) / 1e6 * p.cacheWritePer1M
}
export function formatCost(usd: number): string { return `$${usd > 0.5 ? usd.toFixed(2) : usd.toFixed(4)}` }
export class UsageTracker {
  private byModel = new Map<string, ModelUsage>()
  private totalCost = 0
  add(model: string, usage: Usage): void {
    const previous = this.byModel.get(model) ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, cost: 0 }
    const cost = computeCost(model, usage)
    const current = { inputTokens: previous.inputTokens + usage.inputTokens, outputTokens: previous.outputTokens + usage.outputTokens, cacheReadInputTokens: previous.cacheReadInputTokens + (usage.cacheReadInputTokens ?? 0), cacheCreationInputTokens: previous.cacheCreationInputTokens + (usage.cacheCreationInputTokens ?? 0), cost: previous.cost + cost }
    this.byModel.set(model, current); this.totalCost += cost
  }
  getTotalCost(): number { return this.totalCost }
  getByModel(): Map<string, ModelUsage> { return new Map(this.byModel) }
  reset(): void { this.byModel.clear(); this.totalCost = 0 }
}
export function formatTotalCost(tracker: UsageTracker): string {
  const lines: string[] = []
  for (const [model, usage] of tracker.getByModel()) lines.push(`  ${model}: ${usage.inputTokens} in / ${usage.outputTokens} out / ${usage.cacheReadInputTokens} cache-read / ${usage.cacheCreationInputTokens} cache-write — ${formatCost(usage.cost)}`)
  lines.push(`  Total: ${formatCost(tracker.getTotalCost())}`)
  return lines.join('\n')
}
