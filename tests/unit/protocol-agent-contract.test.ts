import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentManager } from '../../src/services/agents/agentManager.js'
import { MessageBus } from '../../src/services/protocol/mailbox.js'
import { ProtocolRequestStore } from '../../src/services/protocol/requests.js'
import { projectStateDir } from '../../src/services/session/paths.js'
import { TeammateManager } from '../../src/services/agents/teammateManager.js'

function setup(): { home: string; cwd: string } {
  const home = mkdtempSync(join(tmpdir(), 'harness-protocol-contract-'))
  vi.stubEnv('HOME', home)
  return { home, cwd: join(home, 'project') }
}

describe('protocol and agent contract', () => {
  let home: string
  let cwd: string
  beforeEach(() => { ({ home, cwd } = setup()) })
  afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) })

  it('delivers only valid, matching-session messages once and preserves metadata copies', () => {
    const bus = new MessageBus(cwd)
    const sent = bus.send({ sessionId: 's', from: 'lead', to: 'worker', type: 'message', payload: 'hello', metadata: { nested: 'value' } })
    sent.metadata!.nested = 'changed'
    const path = join(projectStateDir(cwd), 'mailboxes', 'worker.jsonl')
    appendFileSync(path, '{bad-json}\n')
    bus.send({ sessionId: 'other', from: 'lead', to: 'worker', type: 'message', payload: 'not this session' })
    const messages = bus.consume('worker', 's')
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ messageId: expect.any(String), payload: 'hello', metadata: { nested: 'value' } })
    expect(bus.consume('worker', 's')).toEqual([])
    expect(bus.consume('worker', 'other')).toHaveLength(1)
  })

  it('sanitizes mailbox agent names without allowing path traversal', () => {
    const bus = new MessageBus(cwd)
    bus.send({ sessionId: 's', from: 'lead', to: '../worker', type: 'message', payload: 'safe' })
    expect(bus.consume('../worker', 's')).toHaveLength(1)
    expect(bus.dir).toContain(join('state', 'mailboxes'))
  })

  it('requires exact protocol request identity and is idempotent after resolution', () => {
    const requests = new ProtocolRequestStore(cwd)
    const request = requests.create('s', 'plan_approval', 'worker', 'lead', 'plan')
    expect(requests.resolve(request.requestId, { sessionId: 'wrong', sender: 'worker', target: 'lead', type: 'plan_approval', approve: true })).toBeNull()
    expect(requests.get(request.requestId)?.status).toBe('pending')
    const resolved = requests.resolve(request.requestId, { sessionId: 's', sender: 'worker', target: 'lead', type: 'plan_approval', approve: true })
    expect(resolved).toMatchObject({ status: 'approved', resolvedAt: expect.any(Number) })
    expect(requests.resolve(request.requestId, { sessionId: 's', sender: 'worker', target: 'lead', type: 'plan_approval', approve: false })).toBeNull()
  })

  it('ignores malformed protocol request records while retaining the file', () => {
    const requests = new ProtocolRequestStore(cwd)
    const path = join(projectStateDir(cwd), 'requests', 'bad.json')
    writeFileSync(path, '{not-json')
    expect(requests.list()).toEqual([])
  })

  it('handles agent pre-cancellation, runner failure, and defensive result copies', async () => {
    const controller = new AbortController(); controller.abort()
    const runner = vi.fn().mockRejectedValue(new Error('runner failed'))
    const manager = new AgentManager(runner)
    const cancelled = await manager.run({ prompt: 'ignored', cwd, signal: controller.signal })
    expect(cancelled).toMatchObject({ status: 'cancelled', summary: 'Agent cancelled before start' })
    expect(runner).not.toHaveBeenCalled()
    const failed = await manager.run({ agentId: 'agent-1', prompt: 'run', cwd })
    expect(failed).toMatchObject({ agentId: 'agent-1', status: 'failed', error: 'runner failed' })
    failed.error = 'mutated'
    expect(manager.get('agent-1')?.error).toBe('runner failed')
  })

  it('enforces teammate name/session validation and plan gate resolution', async () => {
    const agents = new AgentManager(async () => ({ status: 'completed', summary: 'done' }))
    const bus = new MessageBus(cwd)
    const requests = new ProtocolRequestStore(cwd)
    const teammates = new TeammateManager(agents, bus, requests)
    expect(() => teammates.spawn({ name: '../bad', role: 'worker', prompt: 'x', sessionId: 's', cwd })).toThrow('Invalid teammate name')
    const teammate = teammates.spawn({ name: 'worker', role: 'tester', prompt: 'work', sessionId: 's', cwd })
    expect(() => teammates.spawn({ name: 'worker', role: 'tester', prompt: 'again', sessionId: 's', cwd })).toThrow('Teammate name already exists')
    const request = teammates.submitPlan(teammate.id, 'lead', 's', 'plan')
    let released = false
    const waiting = teammates.waitIfPaused(teammate.id).then(() => { released = true })
    await Promise.resolve()
    expect(released).toBe(false)
    expect(teammates.reviewPlan(request.requestId, 'wrong', 's', true)).toBeNull()
    expect(released).toBe(false)
    expect(teammates.reviewPlan(request.requestId, 'lead', 's', true)).not.toBeNull()
    await waiting
    expect(released).toBe(true)
  })
})
