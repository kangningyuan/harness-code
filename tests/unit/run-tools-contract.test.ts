import { buildTool, type BuiltTool, type ToolUseContext } from '../../src/Tool.js'
import { runTools } from '../../src/query/runTools.js'
import type { ToolResultReference } from '../../src/Tool.js'

function context(): ToolUseContext {
  return { abortController: new AbortController(), cwd: process.cwd(), readFileState: { get: () => undefined, set: () => undefined, recordRead: () => undefined, clear: () => undefined } }
}
function block(name: string, id: string, input: Record<string, unknown> = {}) { return { type: 'tool_use' as const, id, name, input } }
function tool(name: string, options: Partial<Parameters<typeof buildTool>[0]> = {}): BuiltTool {
  return buildTool({ name, inputJSONSchema: { type: 'object' }, maxResultSizeChars: 100, call: async () => ({ data: 'ok', result: 'ok' }), description: () => name, prompt: () => name, renderToolUseMessage: () => name, ...options })
}

function text(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content) ?? ''
  return content.map((block: { content?: unknown }) => typeof block.content === 'string' ? block.content : JSON.stringify(block.content)).join('\n')
}

describe('runTools execution contract', () => {
  it('supports aliases, preserves result order, and invokes observers without letting them break execution', async () => {
    const calls: string[] = []
    const one = tool('One', { aliases: ['alias'], call: async () => { calls.push('one'); return { data: 'one', result: 'one' } } })
    const two = tool('Two', { call: async () => { calls.push('two'); return { data: 'two', result: 'two' } } })
    const result = await runTools([block('alias', '1'), block('Two', '2')], [one, two], context(), { canUseTool: async () => ({ behavior: 'allow' }), onPostToolUse: async () => { throw new Error('observer') } })
    expect(calls).toEqual(['one', 'two'])
    expect(text(result[0]!.content)).toContain('one')
    expect(text(result[0]!.content)).toContain('two')
    expect((result[0]!.content as Array<{ tool_use_id: string }>).map(item => item.tool_use_id)).toEqual(['1', '2'])
  })

  it('runs concurrency-safe tools in parallel while serializing unsafe tools', async () => {
    let active = 0; let maxActive = 0
    const safe = tool('Safe', { isConcurrencySafe: () => true, call: async () => { active++; maxActive = Math.max(maxActive, active); await new Promise(resolve => setTimeout(resolve, 15)); active--; return { data: 'safe', result: 'safe' } } })
    await runTools([block('Safe', '1'), block('Safe', '2')], [safe], context(), { canUseTool: async () => ({ behavior: 'allow' }) })
    expect(maxActive).toBe(2)
    active = 0; maxActive = 0
    const unsafe = tool('Unsafe', { call: async () => { active++; maxActive = Math.max(maxActive, active); await new Promise(resolve => setTimeout(resolve, 15)); active--; return { data: 'unsafe', result: 'unsafe' } } })
    await runTools([block('Unsafe', '1'), block('Unsafe', '2')], [unsafe], context(), { canUseTool: async () => ({ behavior: 'allow' }) })
    expect(maxActive).toBe(1)
  })

  it('returns bounded errors for mapper failures and oversized results', async () => {
    const oversized = tool('Large', { maxResultSizeChars: 5, call: async () => ({ data: '123456789', result: '123456789' }) })
    const largeResult = await runTools([block('Large', 'large')], [oversized], context())
    expect(text(largeResult[0]!.content)).toContain('truncated')
    const mapper = tool('Mapper', { mapToolResultToToolResultBlockParam: () => { throw new Error('cannot serialize') } })
    const mapped = await runTools([block('Mapper', 'mapper')], [mapper], context())
    expect(mapped[0]!.content).toMatchObject([{ tool_use_id: 'mapper', is_error: true }])
  })

  it('persists oversized output as a reference before truncation and propagates tool correlation', async () => {
    const reference: ToolResultReference = { id: 'artifact', relativePath: 'artifact.txt', byteLength: 100, sha256: 'hash', preview: 'preview' }
    let seen: ToolUseContext | undefined
    const large = tool('Large', { call: async (_input, received) => { seen = received; return { data: 'large', result: 'large', rawResult: 'large' } } })
    const result = await runTools([block('Large', 'tool-1')], [large], { ...context(), correlation: { sessionId: 's', turnId: 't' }, resultStore: { persist: vi.fn(() => reference) } })
    expect(result[0]!.content).toMatchObject([{ tool_use_id: 'tool-1', content: expect.stringContaining('artifact') }])
    expect(seen?.correlation).toMatchObject({ sessionId: 's', turnId: 't', toolUseId: 'tool-1' })
  })
})
