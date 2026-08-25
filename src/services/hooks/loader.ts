import type { HookCommand, HookEvent, HookMatcher } from './types.js'
const events: HookEvent[] = ['PreToolUse','PostToolUse','UserPromptSubmit','SessionStart','SessionEnd','Stop','PreCompact','PostCompact']
export function emptyMatchers(): Record<HookEvent, HookMatcher[]> { return Object.fromEntries(events.map(event => [event, []])) as unknown as Record<HookEvent, HookMatcher[]> }
export function loadHooksFromSettings(raw: Record<string, unknown> | undefined): Record<HookEvent, HookMatcher[]> {
  const result = emptyMatchers(); if (!raw || typeof raw !== 'object') return result
  for (const event of events) { const entries = raw[event]; if (!Array.isArray(entries)) continue; result[event] = entries.flatMap(entry => { if (!entry || typeof entry !== 'object') return []; const value = entry as Record<string, unknown>; const hooks = Array.isArray(value.hooks) ? value.hooks.filter((hook): hook is HookCommand => Boolean(hook && typeof hook === 'object' && typeof (hook as Record<string, unknown>).type === 'string')) : []; return [{ matcher: typeof value.matcher === 'string' ? value.matcher : undefined, hooks }] }) }
  return result
}
export function mergeHooks(a: Record<HookEvent, HookMatcher[]>, b: Record<HookEvent, HookMatcher[]>): Record<HookEvent, HookMatcher[]> { return Object.fromEntries(events.map(event => [event, [...a[event], ...b[event]]])) as Record<HookEvent, HookMatcher[]> }
