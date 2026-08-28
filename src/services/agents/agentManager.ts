import { newAgentId } from '../protocol/ids.js'

export interface AgentRunRequest {
  agentId?: string
  prompt: string
  cwd: string
  parentSessionId?: string
  taskId?: string
  worktreeId?: string
  maxTurns?: number
  signal?: AbortSignal
}

export interface AgentResult {
  agentId: string
  status: 'completed' | 'failed' | 'cancelled'
  summary: string
  error?: string
}

export type AgentRunner = (request: AgentRunRequest & { agentId: string }) => Promise<Omit<AgentResult, 'agentId'>>

export class AgentManager {
  private readonly records = new Map<string, AgentResult>()
  constructor(private readonly runner: AgentRunner) {}
  list(): AgentResult[] { return [...this.records.values()].map(result => ({ ...result })) }
  get(agentId: string): AgentResult | null { const result = this.records.get(agentId); return result ? { ...result } : null }
  async run(request: AgentRunRequest): Promise<AgentResult> {
    const agentId = request.agentId ?? newAgentId()
    if (request.signal?.aborted) { const result = { agentId, status: 'cancelled' as const, summary: 'Agent cancelled before start' }; this.records.set(agentId, result); return result }
    try {
      const result = await this.runner({ ...request, agentId })
      const completed = { agentId, ...result }
      this.records.set(agentId, completed)
      return { ...completed }
    } catch (error) {
      const result: AgentResult = { agentId, status: request.signal?.aborted ? 'cancelled' : 'failed', summary: '', error: error instanceof Error ? error.message : String(error) }
      this.records.set(agentId, result)
      return { ...result }
    }
  }
}
