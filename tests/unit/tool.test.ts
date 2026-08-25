import { z } from 'zod'
import { buildTool } from '../../src/Tool.js'

describe('buildTool', () => {
  it('injects fail-closed defaults and schema', () => {
    const tool = buildTool({ name: 'Example', inputSchema: z.object({ name: z.string(), count: z.number().optional() }), maxResultSizeChars: 100, call: async () => ({ data: 'ok' }), description: () => 'x', prompt: () => 'x', mapToolResultToToolResultBlockParam: () => [], renderToolUseMessage: () => 'x' })
    expect(tool.isReadOnly?.({})).toBe(false)
    expect(tool.isConcurrencySafe?.({})).toBe(false)
    expect(tool.jsonSchema).toMatchObject({ type: 'object', required: ['name'] })
  })
})
