import { buildTool, type BuiltTool } from '../../src/Tool.js'
import { runTools } from '../../src/query/runTools.js'
import type { ToolUseContext } from '../../src/Tool.js'

function context(): ToolUseContext {
  return {
    abortController: new AbortController(),
    cwd: process.cwd(),
    readFileState: { get: () => undefined, set: () => undefined, recordRead: () => undefined, clear: () => undefined },
  }
}
function block(name: string, input: unknown = {}, id = 'call_1') { return { type: 'tool_use' as const, id, name, input: input as Record<string, unknown> } }

describe('runTools', () => {
  it('validates JSON-schema-only builtin inputs before calling the tool', async () => {
    const call = vi.fn().mockResolvedValue({ data: 'called', result: 'called' })
    const tool = buildTool<Record<string, unknown>, unknown>({ name: 'Example', inputJSONSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }, maxResultSizeChars: 100, call, description: () => '', prompt: () => '', renderToolUseMessage: () => '' })
    const result = await runTools([block('Example')], [tool], context())
    expect(call).not.toHaveBeenCalled()
    expect(result[0]?.content).toMatchObject([{ type: 'tool_result', is_error: true }])
    expect((result[0]?.content as Array<{ content?: string }>)[0]?.content).toContain('value is required')
  })

  it('converts permission failures into a paired tool result', async () => {
    const tool = buildTool<Record<string, unknown>, unknown>({ name: 'Example', inputJSONSchema: { type: 'object' }, maxResultSizeChars: 100, call: async () => ({ data: 'called' }), description: () => '', prompt: () => '', renderToolUseMessage: () => '' })
    const result = await runTools([block('Example')], [tool], context(), { canUseTool: async () => { throw new Error('classifier unavailable') } })
    expect((result[0]?.content as Array<{ is_error?: boolean; content?: string }>)[0]).toMatchObject({ is_error: true })
    expect((result[0]?.content as Array<{ content?: string }>)[0]?.content).toContain('Permission check failed')
  })

  it('does not let hook approval bypass a hard permission denial', async () => {
    const call = vi.fn().mockResolvedValue({ data: 'called', result: 'called' })
    const tool = buildTool<Record<string, unknown>, unknown>({ name: 'Write', inputJSONSchema: { type: 'object' }, maxResultSizeChars: 100, call, description: () => '', prompt: () => '', renderToolUseMessage: () => '' })
    const result = await runTools([block('Write')], [tool], context(), { onPreToolUse: async () => ({ decision: 'approve' }), canUseTool: async () => ({ behavior: 'deny', message: 'protected' }) })
    expect(call).not.toHaveBeenCalled()
    expect((result[0]?.content as Array<{ content?: string }>)[0]?.content).toContain('Permission denied')
  })

  it('keeps a tool whose concurrency classifier throws in the serial path', async () => {
    const order: string[] = []
    const safe = buildTool<Record<string, unknown>, unknown>({ name: 'Safe', inputJSONSchema: { type: 'object' }, maxResultSizeChars: 100, isConcurrencySafe: () => { throw new Error('unknown') }, call: async () => { order.push('safe'); return { data: 'ok', result: 'ok' } }, description: () => '', prompt: () => '', renderToolUseMessage: () => '' })
    const other = buildTool<Record<string, unknown>, unknown>({ name: 'Other', inputJSONSchema: { type: 'object' }, maxResultSizeChars: 100, call: async () => { order.push('other'); return { data: 'ok', result: 'ok' } }, description: () => '', prompt: () => '', renderToolUseMessage: () => '' })
    await runTools([block('Safe', {}, 'one'), block('Other', {}, 'two')], [safe, other], context(), { canUseTool: async () => ({ behavior: 'allow' }) })
    expect(order).toEqual(['safe', 'other'])
  })
})
