import { z } from 'zod'
import { buildTool, textToolResult } from '../../Tool.js'
export interface AgentToolDeps { [key: string]: unknown }
let deps: AgentToolDeps | undefined
export function configureAgentTool(value: AgentToolDeps): void { deps = value }
export const AgentTool = buildTool<Record<string, unknown>, unknown>({ name: 'AgentTool', inputSchema: z.object({ description: z.string().min(1), prompt: z.string().min(1), subagent_type: z.string().optional() }), maxResultSizeChars: 30_000,
  async call() { if (!deps) return { data: { result: '' }, result: 'AgentTool not configured with deps', isError: true }; return { data: { result: '' }, result: 'AgentTool not configured with deps', isError: true } },
  description: input => String(input.description ?? input.prompt ?? '').slice(0, 60), prompt: () => 'Delegate a task to a sub-agent.', mapToolResultToToolResultBlockParam: textToolResult, renderToolUseMessage: input => String(input.description ?? '')
})
