import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentManager } from '../../src/services/agents/agentManager.js'
import { TeammateManager } from '../../src/services/agents/teammateManager.js'
import { MessageBus } from '../../src/services/protocol/mailbox.js'
import { ProtocolRequestStore } from '../../src/services/protocol/requests.js'
import { createAgentTool } from '../../src/tools/AgentTool/AgentTool.js'

describe('agent and protocol services', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'harness-agent-')); vi.stubEnv('HOME', home) })
  afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) })

  it('runs an isolated agent through the injected manager', async () => {
    const manager = new AgentManager(async request => ({ status: 'completed', summary: `completed: ${request.prompt}` }))
    const tool = createAgentTool({ agentManager: manager })
    const result = await tool.call({ description: 'delegate', prompt: 'inspect tests' }, { cwd: '/tmp', abortController: new AbortController(), readFileState: { get: () => undefined, set: () => undefined, recordRead: () => undefined, clear: () => undefined }, correlation: { sessionId: 's', turnId: 't', agentId: 'lead' } })
    expect(result.isError).toBe(false)
    expect(result.result).toContain('inspect tests')
    expect(manager.list()).toHaveLength(1)
  })

  it('delivers mailbox messages exactly once per session', () => {
    const bus = new MessageBus(join(home, 'project'))
    bus.send({ sessionId: 's', from: 'lead', to: 'agent', type: 'message', payload: 'hello' })
    expect(bus.consume('agent', 'other')).toEqual([])
    const first = bus.consume('agent', 's')
    expect(first).toHaveLength(1)
    expect(bus.consume('agent', 's')).toEqual([])
  })

  it('requires matching request identity to resolve a plan', () => {
    const agents = new AgentManager(async () => ({ status: 'completed', summary: 'done' }))
    const bus = new MessageBus(join(home, 'project'))
    const requests = new ProtocolRequestStore(join(home, 'project'))
    const teammates = new TeammateManager(agents, bus, requests)
    const teammate = teammates.spawn({ name: 'worker', role: 'tester', prompt: 'work', sessionId: 's', cwd: join(home, 'project') })
    const request = teammates.submitPlan(teammate.id, 'lead', 's', 'plan')
    expect(teammates.reviewPlan(request.requestId, 'wrong-reviewer', 's', true)).toBeNull()
    expect(requests.get(request.requestId)?.status).toBe('pending')
  })

  it('pauses a teammate until the plan request is resolved', async () => {
    const agents = new AgentManager(async () => ({ status: 'completed', summary: 'done' }))
    const bus = new MessageBus(join(home, 'project'))
    const requests = new ProtocolRequestStore(join(home, 'project'))
    const teammates = new TeammateManager(agents, bus, requests)
    const teammate = teammates.spawn({ name: 'worker', role: 'tester', prompt: 'work', sessionId: 's', cwd: join(home, 'project') })
    const request = teammates.submitPlan(teammate.id, 'lead', 's', 'plan')
    let released = false
    const waiting = teammates.waitIfPaused(teammate.id).then(() => { released = true })
    await Promise.resolve()
    expect(released).toBe(false)
    expect(teammates.reviewPlan(request.requestId, 'lead', 's', true)).not.toBeNull()
    await waiting
    expect(released).toBe(true)
  })
})
