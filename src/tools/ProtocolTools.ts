import { z } from 'zod'
import { buildTool, textToolResult, type BuiltTool, type ToolUseContext } from '../Tool.js'
import type { TeammateManager } from '../services/agents/teammateManager.js'

function actor(context: ToolUseContext): string { return context.correlation?.agentId ?? context.agentId ?? 'lead' }
function session(context: ToolUseContext): string { return context.correlation?.sessionId ?? 'ephemeral' }
function wrap(value: unknown): { data: unknown; result: string; isError?: boolean } { const error = value && typeof value === 'object' && 'error' in value ? (value as { error?: unknown }).error : undefined; return { data: value, result: error ? `Protocol error: ${String(error)}` : JSON.stringify(value), isError: Boolean(error) } }
function tool(name: string, schema: z.ZodTypeAny, prompt: string, readOnly: boolean, call: (input: Record<string, unknown>, context: ToolUseContext) => unknown): BuiltTool { return buildTool({ name, inputSchema: schema, maxResultSizeChars: 10_000, isReadOnly: () => readOnly, isConcurrencySafe: () => readOnly, async call(input, context) { return wrap(call(input, context)) }, description: input => `${name} ${JSON.stringify(input).slice(0, 80)}`, prompt: () => prompt, mapToolResultToToolResultBlockParam: textToolResult, renderToolUseMessage: input => JSON.stringify(input) }) }

export function createProtocolTools(manager: TeammateManager): BuiltTool[] {
  return [
    tool('TeammateSpawnTool', z.object({ name: z.string().min(1), role: z.string().min(1), prompt: z.string().min(1), task_id: z.string().optional(), worktree_id: z.string().optional() }), 'Spawn an isolated teammate agent.', false, (input, context) => manager.spawn({ name: String(input.name), role: String(input.role), prompt: String(input.prompt), sessionId: session(context), cwd: context.cwd, taskId: typeof input.task_id === 'string' ? input.task_id : undefined, worktreeId: typeof input.worktree_id === 'string' ? input.worktree_id : undefined })),
    tool('SendMessageTool', z.object({ to: z.string().min(1), content: z.string().min(1) }), 'Send a correlated message to another agent.', false, (input, context) => { const target = manager.resolveId(String(input.to), session(context)) ?? String(input.to); return manager.send(actor(context), target, session(context), String(input.content)) }),
    tool('CheckInboxTool', z.object({}), 'Read and acknowledge messages for the current agent.', true, (_input, context) => manager.consume(actor(context), session(context))),
    tool('RequestPlanTool', z.object({ teammate: z.string().min(1), task: z.string().min(1) }), 'Request a teammate plan for a task.', false, (input, context) => { const target = manager.resolveId(String(input.teammate), session(context)); if (!target) return { error: 'Teammate not found' }; return manager.requestPlan(actor(context), target, session(context), String(input.task)) }),
    tool('SubmitPlanTool', z.object({ plan: z.string().min(1), to: z.string().optional() }), 'Submit a plan to an agent for explicit approval.', false, (input, context) => manager.submitPlan(actor(context), String(input.to ?? 'lead'), session(context), String(input.plan))),
    tool('ReviewPlanTool', z.object({ request_id: z.string().min(1), approve: z.boolean(), feedback: z.string().optional() }), 'Approve or reject a teammate plan request.', false, (input, context) => manager.reviewPlan(String(input.request_id), actor(context), session(context), input.approve === true, String(input.feedback ?? '')) ?? { error: 'Request not found, mismatched, or already resolved' }),
    tool('RequestShutdownTool', z.object({ teammate: z.string().min(1) }), 'Request a teammate to stop and cancel its work.', false, (input, context) => { const target = manager.resolveId(String(input.teammate), session(context)); if (!target) return { error: 'Teammate not found' }; return manager.requestShutdown(actor(context), target, session(context)) }),
  ]
}
