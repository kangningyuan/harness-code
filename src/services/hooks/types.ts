export type HookEvent = 'PreToolUse'|'PostToolUse'|'UserPromptSubmit'|'SessionStart'|'SessionEnd'|'Stop'|'PreCompact'|'PostCompact'
export type HookType = 'command'|'function'|'http'|'prompt'|'agent'
export interface HookInput { cwd: string; toolName?: string; input?: Record<string, unknown>; toolResult?: unknown; isError?: boolean; messages?: unknown[]; reason?: string }
export interface HookOutcome { decision?: 'block'|'approve'; reason?: string }
export interface HookCommand { type: HookType; command?: string; function?: (ctx: { input: HookInput; event: HookEvent }) => unknown | Promise<unknown>; timeout?: number }
export interface HookMatcher { matcher?: string; hooks: HookCommand[] }
export interface HooksRegistry { matchers: Record<HookEvent, HookMatcher[]> }
