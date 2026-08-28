import { z } from 'zod'
import { buildTool, textToolResult, type BuiltTool, type ToolUseContext } from '../../Tool.js'
import type { AgentManager } from '../../services/agents/agentManager.js'
import type { WorktreeService } from '../../services/worktree/service.js'

export interface AgentToolDeps { agentManager: AgentManager; worktreeService?: WorktreeService }
export function createAgentTool(deps: AgentToolDeps): BuiltTool {
  return buildTool<Record<string, unknown>, unknown>({ name: 'AgentTool', inputSchema: z.object({ description: z.string().min(1), prompt: z.string().min(1), subagent_type: z.string().optional(), worktree_id: z.string().optional() }), maxResultSizeChars: 30_000,
    async call(input, context) { const requestedWorktree = typeof input.worktree_id === 'string' ? deps.worktreeService?.get(input.worktree_id) : null; if (typeof input.worktree_id === 'string' && !requestedWorktree) return { data: null, result: 'Worktree not found or not accessible', isError: true }; const result = await deps.agentManager.run({ prompt: String(input.prompt ?? input.description), cwd: requestedWorktree?.path ?? context.cwd, parentSessionId: context.correlation?.sessionId, taskId: context.correlation?.taskId, worktreeId: requestedWorktree?.id ?? context.correlation?.worktreeId, signal: context.abortController.signal }); return { data: result, result: result.status === 'completed' ? result.summary : `Agent ${result.status}: ${result.error ?? result.summary}`, isError: result.status !== 'completed' } },
    description: input => String(input.description ?? input.prompt ?? '').slice(0, 60), prompt: () => 'Delegate a bounded task to an isolated sub-agent.', mapToolResultToToolResultBlockParam: textToolResult, renderToolUseMessage: input => String(input.description ?? '')
  })
}

/** @deprecated Prefer createAgentTool with explicit dependency injection. */
export const AgentTool = buildTool<Record<string, unknown>, unknown>({ name: 'AgentTool', inputSchema: z.object({ description: z.string().min(1), prompt: z.string().min(1), subagent_type: z.string().optional(), worktree_id: z.string().optional() }), maxResultSizeChars: 30_000,
  async call() { return { data: null, result: 'AgentTool is not configured in this execution context', isError: true } },
  description: input => String(input.description ?? input.prompt ?? '').slice(0, 60), prompt: () => 'Delegate a task to a sub-agent.', mapToolResultToToolResultBlockParam: textToolResult, renderToolUseMessage: input => String(input.description ?? '')
})
