import type { ModelEntry } from '../services/api/types.js'

export class ModelManager {
  private current: string
  constructor(private readonly models: ModelEntry[] = [], initial: string) { this.current = initial }
  getModel(): string { return this.current }
  listModels(): ModelEntry[] { return [...this.models] }
  setModel(id: string): string | null {
    if (this.models.length && !this.models.some(model => model.id === id)) return null
    this.current = id; return id
  }
  getMaxOutputTokens(defaultValue: number): number { return this.models.find(model => model.id === this.current)?.maxOutputTokens ?? defaultValue }
}
