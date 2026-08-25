import type { PermissionRule, SettingsSource } from './settings.js'
export function parsePermissionRuleString(raw: string, source: SettingsSource | string, behavior: 'allow'|'deny'|'ask'): PermissionRule | null {
  const match = /^([^()\\]+)(?:\((.*)\))?$/.exec(raw.trim())
  if (!match?.[1]) return null
  let content = match[2]
  if (content === undefined || content === '' || content === '*') return { source, ruleBehavior: behavior, ruleValue: { toolName: match[1].trim() }, raw }
  content = content.replaceAll('\\(', '(').replaceAll('\\)', ')').replaceAll('\\\\', '\\')
  return { source, ruleBehavior: behavior, ruleValue: { toolName: match[1].trim(), ruleContent: content }, raw }
}
export function parsePermissionRules(values: string[], source: SettingsSource | string, behavior: 'allow'|'deny'|'ask'): PermissionRule[] {
  const seen = new Set<string>(); const result: PermissionRule[] = []
  for (const value of values) { if (seen.has(value)) continue; seen.add(value); const rule = parsePermissionRuleString(value, source, behavior); if (rule) result.push(rule) }
  return result
}
