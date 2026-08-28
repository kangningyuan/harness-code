import { z } from 'zod'
import { buildTool, textToolResult, type BuiltTool, type ToolUseContext } from '../Tool.js'
import type { WorktreeService } from '../services/worktree/service.js'

function actor(context: ToolUseContext): string { return context.correlation?.agentId ?? context.agentId ?? 'lead' }
function session(context: ToolUseContext): string | undefined { return context.correlation?.sessionId }
function wrapped(value: unknown): { data: unknown; result: string; isError?: boolean } { const error = value && typeof value === 'object' && 'ok' in value && (value as { ok?: boolean }).ok === false ? (value as { error?: string }).error : undefined; return { data: value, result: error ? `Worktree error: ${error}` : JSON.stringify(value), isError: Boolean(error) } }
function tool(name: string, schema: z.ZodTypeAny, prompt: string, readOnly: boolean, call: (input: Record<string, unknown>, context: ToolUseContext) => unknown, destructive = false): BuiltTool { return buildTool({ name, inputSchema: schema, maxResultSizeChars: 10_000, isReadOnly: () => readOnly, isDestructive: () => destructive, isConcurrencySafe: () => readOnly, async call(input, context) { return wrapped(call(input, context)) }, description: input => `${name} ${JSON.stringify(input).slice(0, 80)}`, prompt: () => prompt, mapToolResultToToolResultBlockParam: textToolResult, renderToolUseMessage: input => JSON.stringify(input) }) }

export function createWorktreeTools(service: WorktreeService): BuiltTool[] {
  return [
    tool('WorktreeCreateTool', z.object({ name: z.string().min(1), task_id: z.string().optional() }), 'Create an isolated Git worktree for a task.', false, (input, context) => service.create(String(input.name), { owner: actor(context), sessionId: session(context), taskId: typeof input.task_id === 'string' ? input.task_id : undefined })),
    tool('WorktreeStatusTool', z.object({ name: z.string().optional() }), 'List or inspect isolated Git worktrees.', true, (input, context) => input.name ? service.get(String(input.name)) ?? { ok: false, error: 'Worktree not found' } : service.list(session(context))),
    tool('WorktreeKeepTool', z.object({ name: z.string().min(1) }), 'Keep a worktree for review instead of deleting it.', false, (input, context) => service.keep(String(input.name), actor(context))),
    tool('WorktreeRemoveTool', z.object({ name: z.string().min(1), discard_changes: z.boolean().optional() }), 'Remove a clean worktree; discarding changes requires explicit approval.', false, (input, context) => service.remove(String(input.name), { owner: actor(context), discardChanges: input.discard_changes === true }), true),
  ]
}
