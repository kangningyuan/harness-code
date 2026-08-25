import { isAbsolute, resolve } from 'node:path'
import type { BuiltTool, ToolUseContext } from '../../Tool.js'
import { canonicalPath } from '../file/canonicalPath.js'
import { bashCommandTouchesSafetyPath, isSafetyCheckPath } from './dangerousPatterns.js'
import { findMatchingShellRule } from './shellRuleMatching.js'
import type { PermissionRule, PermissionMode } from './settings.js'

export interface PermissionContext { mode: PermissionMode; rules: PermissionRule[]; avoidPrompts?: boolean }
export type PermissionDecision = { behavior: 'allow'|'deny'|'ask'; reason: string }

function inputPath(input: Record<string, unknown>): string | undefined { for (const key of ['file_path','notebook_path','path']) if (typeof input[key] === 'string') return input[key] }
function normalizePath(value: string): string { return value.replaceAll('\\', '/').replace(/\/+/g, '/') }
function pathPattern(pattern: string, cwd: string): string {
  const normalized = normalizePath(pattern)
  return normalizePath(isAbsolute(normalized) ? normalized : resolve(cwd, normalized))
}
function pathMatchesPattern(pattern: string, candidate: string, cwd: string): boolean {
  const normalizedPattern = pathPattern(pattern, cwd).replace(/\/$/, '')
  const normalizedCandidate = normalizePath(candidate).replace(/\/$/, '')
  if (!normalizedPattern.includes('*')) return normalizedCandidate === normalizedPattern
  if (normalizedPattern.endsWith('/**')) {
    const prefix = normalizedPattern.slice(0, -3).replace(/\/$/, '')
    return normalizedCandidate === prefix || normalizedCandidate.startsWith(`${prefix}/`)
  }
  if (normalizedPattern.endsWith('/*')) {
    const prefix = normalizedPattern.slice(0, -2).replace(/\/$/, '')
    const rest = normalizedCandidate.startsWith(`${prefix}/`) ? normalizedCandidate.slice(prefix.length + 1) : ''
    return Boolean(rest) && !rest.includes('/')
  }
  const escaped = normalizedPattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('**', '__HARNESS_DOUBLE_STAR__').replaceAll('*', '[^/]*').replaceAll('__HARNESS_DOUBLE_STAR__', '.*')
  return new RegExp(`^${escaped}$`).test(normalizedCandidate)
}
function rulePriority(behavior: PermissionDecision['behavior']): number { return behavior === 'deny' ? 3 : behavior === 'ask' ? 2 : 1 }
function matchingToolRules(tool: BuiltTool, rules: PermissionRule[]): PermissionRule[] { return rules.filter(rule => rule.ruleValue.toolName === tool.name || tool.aliases?.includes(rule.ruleValue.toolName)) }
function matchingPathRule(tool: BuiltTool, input: Record<string, unknown>, context: ToolUseContext, rules: PermissionRule[]): PermissionRule | null {
  const path = inputPath(input)
  if (!path) return null
  const candidate = normalizePath(canonicalPath(path, context.cwd))
  return rules
    .filter(rule => rule.ruleValue.ruleContent && matchingToolRules(tool, [rule]).length > 0)
    .filter(rule => pathMatchesPattern(rule.ruleValue.ruleContent!, candidate, context.cwd))
    .sort((a, b) => rulePriority(b.ruleBehavior) - rulePriority(a.ruleBehavior))[0] ?? null
}

export async function hasPermissionsToUseTool(tool: BuiltTool, input: Record<string, unknown>, context: ToolUseContext, permCtx: PermissionContext): Promise<PermissionDecision> {
  const rules = matchingToolRules(tool, permCtx.rules)
  const deny = rules.find(rule => rule.ruleBehavior === 'deny' && !rule.ruleValue.ruleContent)
  if (deny) return { behavior: 'deny', reason: 'Denied by tool-level rule' }
  const toolAsk = rules.find(rule => rule.ruleBehavior === 'ask' && !rule.ruleValue.ruleContent)
  const own = await tool.checkPermissions?.(input, context).catch(() => ({ behavior: 'passthrough' as const })) ?? { behavior: 'passthrough' as const }
  if (own.behavior === 'deny') return { behavior: 'deny', reason: own.message ?? 'Tool denied the action' }
  if (own.behavior === 'allow') return { behavior: 'allow', reason: 'Tool allowed the action' }
  const path = inputPath(input)
  let isReadOnly = false
  try { isReadOnly = tool.isReadOnly?.(input) === true } catch { isReadOnly = false }
  if (!isReadOnly && ((path && isSafetyCheckPath(path, context.cwd)) || ((tool.name === 'BashTool' || tool.name === 'Bash') && typeof input.command === 'string' && bashCommandTouchesSafetyPath(input.command)))) return { behavior: 'ask', reason: 'Protected path requires confirmation' }
  if (toolAsk) return { behavior: 'ask', reason: 'Asking per tool-level ask rule' }
  if (own.behavior === 'ask') return { behavior: 'ask', reason: own.message ?? 'Tool requires confirmation' }
  if ((tool.name === 'BashTool' || tool.name === 'Bash') && typeof input.command === 'string') {
    const match = findMatchingShellRule(permCtx.rules, input.command)
    if (match) return { behavior: match.ruleBehavior, reason: `Matched Bash rule: ${match.ruleBehavior}` }
  }
  if (path) {
    const pathRule = matchingPathRule(tool, input, context, rules)
    if (pathRule) return { behavior: pathRule.ruleBehavior, reason: `Matched path rule: ${pathRule.ruleBehavior}` }
  }
  if (permCtx.mode === 'bypassPermissions') return { behavior: 'allow', reason: 'Bypass permissions mode' }
  if (isReadOnly) return { behavior: 'allow', reason: 'Allowed (read-only)' }
  if (permCtx.avoidPrompts) return { behavior: 'deny', reason: 'No matching allow rule (headless)' }
  return { behavior: 'ask', reason: 'No matching rule; asking user' }
}
