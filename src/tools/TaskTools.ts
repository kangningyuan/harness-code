import { z } from 'zod'
import { buildTool, textToolResult, type BuiltTool, type ToolUseContext } from '../Tool.js'
import type { TaskMutationResult } from '../services/tasks/types.js'
import type { TaskService } from '../services/tasks/service.js'

function actor(context: ToolUseContext): string { return context.correlation?.agentId ?? context.agentId ?? 'lead' }
function session(context: ToolUseContext): string | undefined { return context.correlation?.sessionId }
function result(value: TaskMutationResult | unknown): { data: unknown; result: string; isError?: boolean } {
  const error = value && typeof value === 'object' && 'ok' in value && (value as TaskMutationResult).ok === false ? (value as TaskMutationResult).error : undefined
  return { data: value, result: error ? `Task error: ${error}` : JSON.stringify(value), isError: Boolean(error) }
}
function tool(name: string, inputSchema: z.ZodTypeAny, prompt: string, readOnly: boolean, call: (input: Record<string, unknown>, context: ToolUseContext) => unknown): BuiltTool {
  return buildTool({ name, inputSchema, maxResultSizeChars: 10_000, isReadOnly: () => readOnly, isConcurrencySafe: () => readOnly, async call(input, context) { return result(call(input, context)) }, description: input => `${name} ${JSON.stringify(input).slice(0, 80)}`, prompt: () => prompt, mapToolResultToToolResultBlockParam: textToolResult, renderToolUseMessage: input => JSON.stringify(input) })
}

export function createTaskTools(service: TaskService): BuiltTool[] {
  return [
    tool('TaskCreateTool', z.object({ subject: z.string().min(1), description: z.string().optional(), blockedBy: z.array(z.string()).optional() }), 'Create a durable task with optional completed-task dependencies.', false, (input, context) => service.create(String(input.subject), String(input.description ?? ''), Array.isArray(input.blockedBy) ? input.blockedBy.map(String) : [], session(context))),
    tool('TaskListTool', z.object({}), 'List durable tasks visible to this session.', true, (_input, context) => service.list(session(context))),
    tool('TaskGetTool', z.object({ task_id: z.string().min(1) }), 'Get one durable task by id.', true, (input, _context) => service.get(String(input.task_id)) ?? { ok: false, error: 'Task not found' }),
    tool('TaskClaimTool', z.object({ task_id: z.string().min(1) }), 'Claim a pending task when all dependencies are completed.', false, (input, context) => service.claim(String(input.task_id), actor(context), session(context))),
    tool('TaskCompleteTool', z.object({ task_id: z.string().min(1) }), 'Complete a task owned by this agent.', false, (input, context) => service.complete(String(input.task_id), actor(context))),
    tool('TaskFailTool', z.object({ task_id: z.string().min(1), error: z.string().min(1) }), 'Mark a task failed with a diagnostic error.', false, (input, context) => service.fail(String(input.task_id), actor(context), String(input.error))),
    tool('TaskCancelTool', z.object({ task_id: z.string().min(1) }), 'Cancel a task owned by this agent.', false, (input, context) => service.cancel(String(input.task_id), actor(context))),
  ]
}
