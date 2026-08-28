import type { BuiltTool } from '../../Tool.js'
import { connectAllServers, disconnectAll, type McpConnection, type McpServerConfig } from './client.js'

export class McpRegistry {
  private connections: McpConnection[] = []
  async connect(servers: Record<string, unknown> = {}): Promise<BuiltTool[]> {
    this.connections = await connectAllServers(normalizeMcpConfig(servers))
    const tools: BuiltTool[] = []; const names = new Set<string>()
    for (const connection of this.connections) for (const tool of connection.tools) if (!names.has(tool.name)) { names.add(tool.name); tools.push(tool) }
    return tools
  }
  getConnections(): McpConnection[] { return [...this.connections] }
  getTools(): BuiltTool[] { return this.connections.flatMap(connection => connection.tools) }
  async disconnect(): Promise<void> { const connections = this.connections; this.connections = []; await disconnectAll(connections) }
  async refresh(servers: Record<string, unknown> = {}): Promise<BuiltTool[]> { await this.disconnect(); return this.connect(servers) }
}

export function normalizeMcpConfig(value: Record<string, unknown> | undefined): Record<string, McpServerConfig> { return Object.fromEntries(Object.entries(value ?? {}).filter(([, config]) => { if (!config || typeof config !== 'object') return false; const item = config as Record<string, unknown>; return typeof item.command === 'string' || typeof item.url === 'string' }).map(([name, config]) => [name, config as McpServerConfig])) }
