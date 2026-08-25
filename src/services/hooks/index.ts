import { emptyMatchers } from './loader.js'
import type { HookEvent, HookInput, HookMatcher, HookOutcome, HooksRegistry } from './types.js'
import { runHooks } from './runner.js'
export function createHooksRegistry(matchers?: Record<HookEvent, HookMatcher[]>): HooksRegistry { return { matchers: matchers ?? emptyMatchers() } }
export function emptyRegistry(): HooksRegistry { return createHooksRegistry() }
export { runHooks }
export { emptyMatchers, loadHooksFromSettings, mergeHooks } from './loader.js'
export type { HookEvent, HookInput, HookOutcome, HookMatcher, HooksRegistry }
