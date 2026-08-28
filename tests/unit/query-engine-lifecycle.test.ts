import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildTool } from '../../src/Tool.js'
import { QueryEngine } from '../../src/QueryEngine.js'
import type { ApiClient } from '../../src/services/api/client.js'
import { createHooksRegistry, emptyMatchers } from '../../src/services/hooks/index.js'
import type { HookEvent } from '../../src/services/hooks/types.js'
import { projectStateDir } from '../../src/services/session/paths.js'
import { loadSession } from '../../src/services/session/store.js'

function tool() {
  return buildTool({ name: 'Echo', inputJSONSchema: { type: 'object' }, maxResultSizeChars: 100, call: async () => ({ data: 'tool output', result: 'tool output' }), description: () => 'echo', prompt: () => 'echo', renderToolUseMessage: () => 'echo' })
}
function context(home: string): { cwd: string; cleanup: () => void } {
  const cwd = join(home, 'project')
  return { cwd, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

describe('QueryEngine lifecycle and persistence contract', () => {
  let home: string
  let cwd: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'harness-engine-contract-')); ({ cwd } = context(home)); vi.stubEnv('HOME', home) })
  afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) })

  it('runs lifecycle hooks with session/turn/tool correlation', async () => {
    const seen: Array<{ event: HookEvent; input: Record<string, unknown> }> = []
    const matchers = emptyMatchers()
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'] as HookEvent[]) {
      matchers[event] = [{ hooks: [{ type: 'function', function: ({ input }) => { seen.push({ event, input: { ...input } }); return {} } }] }]
    }
    const client = { callModel: vi.fn()
      .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 'tool-1', name: 'Echo', input: {} }], stopReason: 'tool_use' })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'finished' }], stopReason: 'end_turn' }) } as unknown as ApiClient
    const engine = new QueryEngine({ client, tools: [tool()], model: 'model', maxOutputTokens: 100, maxTurns: 3, cwd, canUseTool: async () => ({ behavior: 'allow' as const }), hooks: createHooksRegistry(matchers) })
    const result = await engine.submitMessage('run tool')
    expect(result.reason).toBe('completed')
    expect(seen.map(item => item.event)).toEqual(expect.arrayContaining(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']))
    const pre = seen.find(item => item.event === 'PreToolUse')?.input
    expect(pre).toMatchObject({ sessionId: expect.any(String), turnId: expect.any(String), toolUseId: 'tool-1' })
    await engine.shutdown()
    expect(seen.map(item => item.event)).toContain('SessionEnd')
  })

  it('appends normal turns and replaces the full snapshot after compaction', async () => {
    const client = { callModel: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' }), callOnce: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'summary' }], stopReason: 'end_turn' }) } as unknown as ApiClient
    const engine = new QueryEngine({ client, tools: [], model: 'model', smallModel: 'small', maxOutputTokens: 100, maxTurns: 2, cwd, canUseTool: async () => ({ behavior: 'allow' as const }) })
    const sessionId = engine.getSessionId()!
    await engine.submitMessage('hello')
    await engine.submitMessage('second')
    expect(loadSession(cwd, sessionId).messages).toHaveLength(4)
    const compacted = await engine.compactNow()
    expect(compacted).toContain('Compacted')
    expect(loadSession(cwd, sessionId).messages).toEqual(engine.getMessages())
    expect(loadSession(cwd, sessionId).meta?.messageCount).toBe(engine.getMessages().length)
  })

  it('keeps observability failures non-fatal and writes correlated events without secrets', async () => {
    const client = { callModel: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' }) } as unknown as ApiClient
    const engine = new QueryEngine({ client, tools: [], model: 'model', maxOutputTokens: 100, maxTurns: 1, cwd, canUseTool: async () => ({ behavior: 'allow' as const }) })
    expect((await engine.submitMessage('contains secret')).reason).toBe('completed')
    const eventDir = join(projectStateDir(cwd), 'events')
    const eventFile = readdirSync(eventDir).find(name => name.endsWith('.jsonl'))!
    const eventText = readFileSync(join(eventDir, eventFile), 'utf8')
    expect(eventText).toContain('model_request_start')
    expect(eventText).toContain('model_request_end')
    expect(eventText).not.toContain('contains secret')
    expect(eventText).not.toContain('secret')
    await engine.shutdown()
  })
})
