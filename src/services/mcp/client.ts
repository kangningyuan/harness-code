import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { buildTool, textToolResult, type BuiltTool } from '../../Tool.js'

export interface McpServerConfig { command?: string; args?: string[]; env?: Record<string, string>; type?: 'stdio' | 'streamable-http'; url?: string; headers?: Record<string, string>; disabled?: boolean }
export interface McpConnection { name: string; client: Client; transport: Transport; tools: BuiltTool[] }
const timeoutMs = () => Number(process.env.MCP_TIMEOUT ?? 30_000)
function safeName(value: string): string { return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100) || 'unnamed' }
async function discoverTools(name: string, client: Client): Promise<BuiltTool[]> {
  try {
    const result = await client.listTools(); const used = new Set<string>()
    return result.tools.map(tool => {
      const safeServer = safeName(name); const safeTool = safeName(tool.name); let exposed = `mcp__${safeServer}__${safeTool}`; let suffix = 2
      while (used.has(exposed)) exposed = `mcp__${safeServer}__${safeTool}_${suffix++}`
      used.add(exposed)
      return buildTool<Record<string, unknown>, unknown>({ name: exposed, inputJSONSchema: tool.inputSchema as Record<string, unknown> ?? { type: 'object', properties: {} }, isMcp: true, maxResultSizeChars: 30_000, isReadOnly: () => tool.annotations?.readOnlyHint === true, isDestructive: () => tool.annotations?.destructiveHint === true, isConcurrencySafe: () => tool.annotations?.readOnlyHint === true, async call(args, context) { context.eventLogger?.record('mcp_call_start', context.correlation, { server: name, tool: tool.name }); try { const output = await client.callTool({ name: tool.name, arguments: args }); const content = Array.isArray(output.content) ? output.content.map(item => 'text' in item ? item.text : '').join('\n') : ''; context.eventLogger?.record('mcp_call_end', context.correlation, { server: name, tool: tool.name, isError: output.isError === true }); return { data: output, result: content || '[no output]', isError: output.isError === true, rawResult: content || '[no output]' } } catch (error) { context.eventLogger?.record('mcp_call_error', context.correlation, { server: name, tool: tool.name, error: error instanceof Error ? error.message : String(error) }); return { data: null, result: error instanceof Error ? error.message : String(error), isError: true } } }, description: () => String(tool.description ?? tool.name).slice(0, 2048), prompt: () => `${String(tool.description ?? tool.name)} (MCP tool from server "${name}")`.slice(0, 2048), mapToolResultToToolResultBlockParam: textToolResult, renderToolUseMessage: () => `${name}: ${tool.name}` })
    })
  } catch { return [] }
}
export async function connectToServer(name: string, config: McpServerConfig): Promise<McpConnection> {
  let transport: Transport
  if (config.type === 'streamable-http' || config.url) {
    if (!config.url) throw new Error(`MCP server ${name} requires a URL`)
    transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers }, reconnectionOptions: { maxReconnectionDelay: 30_000, initialReconnectionDelay: 500, reconnectionDelayGrowFactor: 1.5, maxRetries: 2 } })
  } else {
    if (!config.command) throw new Error(`MCP server ${name} requires a stdio command`)
    transport = new StdioClientTransport({ command: config.command, args: config.args ?? [], env: Object.fromEntries(Object.entries({ ...process.env, ...config.env }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) })
  }
  const client = new Client({ name: 'harness-code', version: '0.1.0' }, { capabilities: { roots: { listChanged: false }, elicitation: {} } })
  await Promise.race([client.connect(transport), new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`MCP server ${name} connect timeout`)), timeoutMs()))])
  return { name, client, transport, tools: await discoverTools(name, client) }
}
export async function connectAllServers(servers: Record<string, unknown>): Promise<McpConnection[]> { const enabled = Object.entries(servers).filter(([, value]) => !(value as McpServerConfig).disabled); const connections: McpConnection[] = []; for (let i = 0; i < enabled.length; i += 3) { const batch = enabled.slice(i, i + 3); const settled = await Promise.allSettled(batch.map(([name, config]) => connectToServer(name, config as McpServerConfig))); for (const result of settled) if (result.status === 'fulfilled') connections.push(result.value); else process.stderr.write(`[mcp] server connection failed: ${String(result.reason)}\n`) } return connections }
export async function disconnectAll(connections: McpConnection[]): Promise<void> { await Promise.allSettled(connections.map(connection => connection.transport.close())) }
export function collectMcpTools(connections: McpConnection[]): BuiltTool[] { return connections.flatMap(connection => connection.tools) }
