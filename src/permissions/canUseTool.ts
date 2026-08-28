import type { BuiltTool } from '../Tool.js'
import type { PermissionContext } from '../utils/permissions/permissions.js'
import { hasPermissionsToUseTool } from '../utils/permissions/permissions.js'
import { classifyYoloAction } from './classifier.js'
import type { ApiClient } from '../services/api/client.js'

async function askWithAbort(ask: (tool: BuiltTool, input: Record<string, unknown>, reason: string) => Promise<boolean>, tool: BuiltTool, input: Record<string, unknown>, reason: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false
  if (!signal) return ask(tool, input, reason)
  return new Promise(resolve => {
    let settled = false
    const finish = (value: boolean) => { if (settled) return; settled = true; signal.removeEventListener('abort', onAbort); resolve(value) }
    const onAbort = () => finish(false)
    signal.addEventListener('abort', onAbort, { once: true })
    ask(tool, input, reason).then(finish).catch(() => finish(false))
    if (signal.aborted) onAbort()
  })
}

export function createCanUseTool(permCtx: PermissionContext, options: { client?: ApiClient; smallModel?: string; cwd?: string; onAsk?: (tool: BuiltTool, input: Record<string, unknown>, reason: string) => Promise<boolean> } = {}) {
  return async (tool: BuiltTool, input: Record<string, unknown>, evaluation: { hookApproved?: boolean; signal?: AbortSignal } = {}) => {
    const context = { cwd: options.cwd ?? process.cwd(), abortController: new AbortController(), readFileState: { get: () => undefined, set: () => undefined, recordRead: () => undefined, clear: () => undefined } }
    const decision = await hasPermissionsToUseTool(tool, input, context, permCtx, evaluation)
    if (decision.behavior === 'allow') return { behavior: 'allow' as const }
    if (decision.behavior === 'deny') return { behavior: 'deny' as const, message: decision.reason }
    if (decision.hard) {
      if (options.onAsk && !permCtx.avoidPrompts) return await askWithAbort(options.onAsk, tool, input, decision.reason, evaluation.signal) ? { behavior: 'allow' as const } : { behavior: 'deny' as const, message: decision.reason }
      return { behavior: 'deny' as const, message: decision.reason }
    }
    if (permCtx.mode === 'auto' && options.client && options.smallModel) {
      const classified = await classifyYoloAction({ client: options.client, smallModel: options.smallModel, toolName: tool.name, input, cwd: options.cwd })
      return classified.shouldBlock ? { behavior: 'deny' as const, message: classified.reason ?? 'Blocked by safety classifier' } : { behavior: 'allow' as const }
    }
    if (options.onAsk && !permCtx.avoidPrompts) return await askWithAbort(options.onAsk, tool, input, decision.reason, evaluation.signal) ? { behavior: 'allow' as const } : { behavior: 'deny' as const, message: decision.reason }
    return { behavior: 'deny' as const, message: decision.reason }
  }
}
