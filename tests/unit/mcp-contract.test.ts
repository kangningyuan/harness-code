import { buildTool } from '../../src/Tool.js'

class FakeTransport {
  readonly options: unknown
  closed = false
  constructor(options: unknown) { this.options = options }
  async close(): Promise<void> { this.closed = true }
}
class FakeStdioTransport extends FakeTransport {}
class FakeHttpTransport extends FakeTransport {}
class FakeClient {
  static tools: Array<Record<string, unknown>> = []
  static callResult: Record<string, unknown> = { content: [{ type: 'text', text: 'ok' }] }
  static connectError = false
  transport: unknown
  constructor(_info: unknown, _options: unknown) {}
  async connect(transport: unknown): Promise<void> { this.transport = transport; if (FakeClient.connectError || (transport instanceof FakeStdioTransport && (transport as FakeStdioTransport).options && typeof (transport as FakeStdioTransport).options === 'object' && ((transport as FakeStdioTransport).options as { command?: string }).command === 'fail')) throw new Error('connect failed') }
  async listTools(): Promise<{ tools: Array<Record<string, unknown>> }> { return { tools: FakeClient.tools } }
  async callTool(_input: unknown): Promise<Record<string, unknown>> { return FakeClient.callResult }
}

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: FakeClient }))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: FakeStdioTransport }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: FakeHttpTransport }))

const { connectAllServers, connectToServer, disconnectAll } = await import('../../src/services/mcp/client.js')
const { McpRegistry, normalizeMcpConfig } = await import('../../src/services/mcp/registry.js')

describe('MCP client and registry contract', () => {
  beforeEach(() => { FakeClient.tools = []; FakeClient.callResult = { content: [{ type: 'text', text: 'ok' }] }; FakeClient.connectError = false })

  it('normalizes only valid stdio and HTTP server configurations', () => {
    expect(normalizeMcpConfig({ stdio: { command: 'node', args: ['server.js'] }, http: { url: 'https://mcp.test' }, bad: { port: 1 }, null: null })).toEqual({
      stdio: { command: 'node', args: ['server.js'] }, http: { url: 'https://mcp.test' },
    })
  })

  it('connects stdio servers, sanitizes collisions, preserves schemas, and maps annotations', async () => {
    FakeClient.tools = [
      { name: 'read-file', description: 'read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, annotations: { readOnlyHint: true } },
      { name: 'read-file', description: 'write', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
    ]
    const connection = await connectToServer('my server', { command: 'node', args: ['fixture.js'], env: { FOO: 'bar' } })
    expect(connection.tools.map(tool => tool.name)).toEqual(['mcp__my_server__read-file', 'mcp__my_server__read-file_2'])
    expect(connection.tools[0]?.isReadOnly?.({})).toBe(true)
    expect(connection.tools[0]?.isConcurrencySafe?.({})).toBe(true)
    expect(connection.tools[1]?.isDestructive?.({})).toBe(true)
    expect(connection.tools[0]?.jsonSchema).toEqual({ type: 'object', properties: { path: { type: 'string' } } })
    const result = await connection.tools[0]!.call({ path: 'x' }, { abortController: new AbortController(), cwd: '/tmp', readFileState: { get: () => undefined, set: () => undefined, recordRead: () => undefined, clear: () => undefined }, correlation: { sessionId: 's', turnId: 't' } })
    expect(result).toMatchObject({ result: 'ok', isError: false })
  })

  it('maps MCP errors and no-output responses to bounded tool errors', async () => {
    FakeClient.tools = [{ name: 'tool', inputSchema: { type: 'object' } }]
    const connection = await connectToServer('server', { command: 'node' })
    FakeClient.callResult = { content: [], isError: true }
    await expect(connection.tools[0]!.call({}, { abortController: new AbortController(), cwd: '/tmp', readFileState: { get: () => undefined, set: () => undefined, recordRead: () => undefined, clear: () => undefined } })).resolves.toMatchObject({ result: '[no output]', isError: true })
    const call = vi.spyOn(FakeClient.prototype, 'callTool').mockRejectedValueOnce(new Error('MCP unavailable'))
    await expect(connection.tools[0]!.call({}, { abortController: new AbortController(), cwd: '/tmp', readFileState: { get: () => undefined, set: () => undefined, recordRead: () => undefined, clear: () => undefined } })).resolves.toMatchObject({ result: 'MCP unavailable', isError: true })
    call.mockRestore()
  })

  it('supports streamable HTTP configuration and isolates failed servers', async () => {
    FakeClient.tools = [{ name: 'http-tool', inputSchema: { type: 'object' } }]
    const http = await connectToServer('remote', { type: 'streamable-http', url: 'https://mcp.test', headers: { authorization: 'Bearer token' } })
    expect(http.transport).toBeInstanceOf(FakeHttpTransport)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const connections = await connectAllServers({ good: { command: 'node' }, bad: { command: 'fail' }, disabled: { command: 'fail', disabled: true } })
    expect(connections).toHaveLength(1)
    expect(connections[0]?.name).toBe('good')
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('[mcp] server connection failed'))
    stderr.mockRestore()
  })

  it('registry replaces snapshots on refresh and closes all transports', async () => {
    FakeClient.tools = [{ name: 'tool', inputSchema: { type: 'object' } }]
    const registry = new McpRegistry()
    expect(await registry.connect({ one: { command: 'node' } })).toHaveLength(1)
    expect(registry.getConnections()).toHaveLength(1)
    FakeClient.tools = []
    expect(await registry.refresh({})).toEqual([])
    expect(registry.getTools()).toEqual([])
    await registry.disconnect()
    expect(registry.getConnections()).toEqual([])
  })

  it('disconnectAll is best effort', async () => {
    const transport = { close: vi.fn().mockRejectedValue(new Error('close failed')) }
    await expect(disconnectAll([{ name: 'x', client: {}, transport, tools: [] } as never])).resolves.toBeUndefined()
    expect(transport.close).toHaveBeenCalledOnce()
  })
})
