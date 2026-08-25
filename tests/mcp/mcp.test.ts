import { buildTool } from '../../src/Tool.js'
import { collectMcpTools, connectAllServers, disconnectAll } from '../../src/services/mcp/client.js'

describe('MCP client helpers', () => {
  it('skips disabled servers without starting a process', async () => {
    await expect(connectAllServers({ disabled: { command: 'node', disabled: true } })).resolves.toEqual([])
  })
  it('collects tools from successful connections and disconnects an empty set', async () => {
    const tool = buildTool<Record<string, unknown>, unknown>({ name: 'mcp__server__tool', inputJSONSchema: { type: 'object' }, maxResultSizeChars: 100, call: async () => ({ data: 'ok' }), description: () => '', prompt: () => '', renderToolUseMessage: () => '' })
    expect(collectMcpTools([{ name: 'server', client: {} as any, transport: {} as any, tools: [tool] }])).toEqual([tool])
    await expect(disconnectAll([])).resolves.toBeUndefined()
  })
})
