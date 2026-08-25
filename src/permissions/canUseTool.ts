import type { BuiltTool } from '../Tool.js'
import type { PermissionContext } from '../utils/permissions/permissions.js'
import { hasPermissionsToUseTool } from '../utils/permissions/permissions.js'
import { classifyYoloAction } from './classifier.js'
import type { ApiClient } from '../services/api/client.js'
export function createCanUseTool(permCtx: PermissionContext, options: { client?: ApiClient; smallModel?: string; cwd?: string; onAsk?: (tool: BuiltTool, input: Record<string, unknown>, reason: string) => Promise<boolean> } = {}) {
  return async (tool: BuiltTool, input: Record<string, unknown>) => {
    const context = { cwd: options.cwd ?? process.cwd(), abortController: new AbortController(), readFileState: { get: () => undefined, set: () => undefined, recordRead: () => undefined, clear: () => undefined } }
    const decision = await hasPermissionsToUseTool(tool, input, context, permCtx)
    if (decision.behavior === 'allow') return { behavior: 'allow' as const }
    if (decision.behavior === 'deny') return { behavior: 'deny' as const, message: decision.reason }
    if (permCtx.mode === 'auto' && options.client && options.smallModel) {
      const classified = await classifyYoloAction({ client: options.client, smallModel: options.smallModel, toolName: tool.name, input })
      return classified.shouldBlock ? { behavior: 'deny' as const, message: classified.reason ?? 'Blocked by safety classifier' } : { behavior: 'allow' as const }
    }
    if (options.onAsk && !permCtx.avoidPrompts) return await options.onAsk(tool, input, decision.reason) ? { behavior: 'allow' as const } : { behavior: 'deny' as const, message: decision.reason }
    return { behavior: 'deny' as const, message: decision.reason }
  }
}
