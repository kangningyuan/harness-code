import { newAgentId } from '../protocol/ids.js'
import { MessageBus } from '../protocol/mailbox.js'
import { ProtocolRequestStore } from '../protocol/requests.js'
import type { ProtocolMessage, ProtocolRequest } from '../protocol/types.js'
import type { AgentManager, AgentResult } from './agentManager.js'
import type { WorktreeService } from '../worktree/service.js'

export type TeammateStatus = 'created' | 'working' | 'waiting_plan' | 'stopping' | 'stopped' | 'completed' | 'failed'
export interface TeammateRecord { id: string; name: string; role: string; sessionId: string; cwd: string; status: TeammateStatus; taskId?: string; worktreeId?: string; createdAt: number; updatedAt: number; result?: AgentResult }

export class TeammateManager {
  private readonly teammates = new Map<string, TeammateRecord>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly planWaiters = new Map<string, Promise<void>>()
  private readonly planResolvers = new Map<string, () => void>()
  constructor(private readonly agents: AgentManager, readonly bus: MessageBus, readonly requests: ProtocolRequestStore, private readonly worktrees?: WorktreeService) {}
  list(sessionId?: string): TeammateRecord[] { return [...this.teammates.values()].filter(item => !sessionId || item.sessionId === sessionId).map(item => ({ ...item, result: item.result ? { ...item.result } : undefined })) }
  get(id: string): TeammateRecord | null { const item = this.teammates.get(id); return item ? { ...item, result: item.result ? { ...item.result } : undefined } : null }
  resolveId(idOrName: string, sessionId: string): string | null { return this.list(sessionId).find(item => item.id === idOrName || item.name === idOrName)?.id ?? null }
  waitIfPaused(agentId: string): Promise<void> { return this.planWaiters.get(agentId) ?? Promise.resolve() }
  spawn(options: { name: string; role: string; prompt: string; sessionId: string; cwd: string; taskId?: string; worktreeId?: string; maxTurns?: number }): TeammateRecord {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(options.name)) throw new Error('Invalid teammate name')
    if ([...this.teammates.values()].some(item => item.sessionId === options.sessionId && item.name === options.name && !['stopped', 'completed', 'failed'].includes(item.status))) throw new Error('Teammate name already exists')
    const requestedWorktree = options.worktreeId ? this.worktrees?.get(options.worktreeId) : null
    if (options.worktreeId && !requestedWorktree) throw new Error('Worktree not found or not accessible')
    const cwd = requestedWorktree?.path ?? options.cwd
    const id = newAgentId(); const now = Date.now(); const record: TeammateRecord = { id, name: options.name, role: options.role, sessionId: options.sessionId, cwd, taskId: options.taskId, worktreeId: options.worktreeId, status: 'created', createdAt: now, updatedAt: now }; this.teammates.set(id, record)
    const controller = new AbortController(); this.controllers.set(id, controller); record.status = 'working'; record.updatedAt = Date.now()
    const inbox = this.consume(id, options.sessionId).map(message => `[inbox:${message.type}] ${message.payload}`).join('\n')
    void this.agents.run({ agentId: id, prompt: `${options.prompt}${inbox ? `\n\nInitial teammate inbox:\n${inbox}` : ''}`, cwd, parentSessionId: options.sessionId, taskId: options.taskId, worktreeId: options.worktreeId, maxTurns: options.maxTurns, signal: controller.signal }).then(result => { const current = this.teammates.get(id); if (!current) return; current.result = result; current.status = result.status === 'completed' ? 'completed' : result.status === 'cancelled' ? 'stopped' : 'failed'; current.updatedAt = Date.now() }).finally(() => this.controllers.delete(id))
    return { ...record }
  }
  send(from: string, to: string, sessionId: string, payload: string, type: ProtocolMessage['type'] = 'message', requestId?: string): ProtocolMessage { const target = to === 'lead' ? null : this.teammates.get(to); if (to !== 'lead' && (!target || target.sessionId !== sessionId)) throw new Error('Teammate not found in this session'); return this.bus.send({ sessionId, requestId, from, to, type, payload }) }
  consume(agentId: string, sessionId: string): ProtocolMessage[] { return this.bus.consume(agentId, sessionId) }
  requestPlan(from: string, target: string, sessionId: string, task: string): ProtocolMessage { return this.send(from, target, sessionId, `Please submit a plan for: ${task}`, 'message') }
  submitPlan(from: string, target: string, sessionId: string, plan: string): ProtocolRequest { const request = this.requests.create(sessionId, 'plan_approval', from, target, plan); this.send(from, target, sessionId, plan, 'plan_approval_request', request.requestId); const record = this.teammates.get(from); if (record) { record.status = 'waiting_plan'; record.updatedAt = Date.now() }; let resolve: () => void = () => undefined; const waiting = new Promise<void>(done => { resolve = done }); this.planWaiters.set(from, waiting); this.planResolvers.set(from, resolve); return request }
  reviewPlan(requestId: string, reviewer: string, sessionId: string, approve: boolean, feedback = ''): ProtocolRequest | null { const request = this.requests.get(requestId); if (!request) return null; const resolved = this.requests.resolve(requestId, { sessionId, sender: request.sender, target: reviewer, type: 'plan_approval', approve }); if (!resolved) return null; this.send(reviewer, request.sender, sessionId, feedback || (approve ? 'Plan approved' : 'Plan rejected'), 'plan_approval_response', requestId); const record = this.teammates.get(request.sender); if (record && record.status === 'waiting_plan') { record.status = 'working'; record.updatedAt = Date.now() }; this.planResolvers.get(request.sender)?.(); this.planResolvers.delete(request.sender); this.planWaiters.delete(request.sender); return resolved }
  requestShutdown(from: string, target: string, sessionId: string): ProtocolRequest { const request = this.requests.create(sessionId, 'shutdown', from, target, 'Shutdown requested'); this.send(from, target, sessionId, request.payload, 'shutdown_request', request.requestId); const record = this.teammates.get(target); if (record) { record.status = 'stopping'; record.updatedAt = Date.now() } this.controllers.get(target)?.abort(); return request }
  acknowledgeShutdown(requestId: string, target: string, sessionId: string, approve = true): ProtocolRequest | null { const request = this.requests.get(requestId); if (!request) return null; const resolved = this.requests.resolve(requestId, { sessionId, sender: request.sender, target, type: 'shutdown', approve }); if (resolved) this.send(target, request.sender, sessionId, 'Shutdown acknowledged', 'shutdown_response', requestId); return resolved }
  shutdownAll(sessionId?: string): void { for (const record of this.teammates.values()) if (!sessionId || record.sessionId === sessionId) this.controllers.get(record.id)?.abort() }
}
