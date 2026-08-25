import type { PermissionRule } from './settings.js'
export type ShellRule = { kind: 'exact'|'prefix'|'wildcard'; value: string; regex?: RegExp }
export function parseShellRule(ruleContent: string): ShellRule {
  if (ruleContent.endsWith(':*')) return { kind: 'prefix', value: ruleContent.slice(0, -2) }
  const wildcard = /(^|[^\\])\*/.test(ruleContent)
  if (!wildcard) return { kind: 'exact', value: ruleContent }
  const pattern = '^' + ruleContent.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('\\*', '\\u0000').replaceAll('*', '.*').replaceAll('\\u0000', '\\*') + (ruleContent.endsWith(' *') ? '( .*)?' : '') + '$'
  return { kind: 'wildcard', value: ruleContent, regex: new RegExp(pattern) }
}
function matches(rule: ShellRule, command: string): boolean { return rule.kind === 'exact' ? command === rule.value : rule.kind === 'prefix' ? command === rule.value || command.startsWith(rule.value + ' ') : rule.regex?.test(command) === true }
export function isCompoundCommand(command: string): boolean { return /&&|\|\||[;|]/.test(command) }
export function findMatchingShellRule(rules: PermissionRule[], command: string): PermissionRule | null {
  const matchesFound = rules.filter(rule => (rule.ruleValue.toolName === 'Bash' || rule.ruleValue.toolName === 'BashTool') && rule.ruleValue.ruleContent && matches(parseShellRule(rule.ruleValue.ruleContent), command))
  return matchesFound.sort((a, b) => ({ deny: 3, ask: 2, allow: 1 }[b.ruleBehavior] ?? 0) - ({ deny: 3, ask: 2, allow: 1 }[a.ruleBehavior] ?? 0))[0] ?? null
}
