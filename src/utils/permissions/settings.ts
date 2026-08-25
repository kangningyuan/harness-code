import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type PermissionMode = 'default' | 'auto' | 'bypassPermissions'
export type SettingsSource = 'userSettings' | 'projectSettings' | 'localSettings' | 'flagSettings' | 'policySettings'
export interface PermissionRule {
  source: SettingsSource | string
  ruleBehavior: 'allow' | 'deny' | 'ask'
  ruleValue: { toolName: string; ruleContent?: string }
  raw?: string
}
export interface Settings {
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[]; defaultMode?: PermissionMode }
  apiKey?: string; baseURL?: string; model?: string; smallModel?: string; maxOutputTokens?: number
  mcpServers?: Record<string, unknown>
  enabledPlugins?: Record<string, boolean>
  autoMemoryDirectory?: string
  hooks?: Record<string, unknown>
  permissionRules?: PermissionRule[]
}
export interface SettingsSources { user?: Settings; project?: Settings; local?: Settings; flag?: Settings; policy?: Settings }

function readSettings(path: string): Settings {
  if (!existsSync(path)) return {}
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return value && typeof value === 'object' ? value as Settings : {}
  } catch { return {} }
}

export function discoverSettings(cwd: string): SettingsSources {
  return {
    user: readSettings(join(homedir(), '.claude', 'settings.json')),
    project: readSettings(join(cwd, '.claude', 'settings.json')),
    local: readSettings(join(cwd, '.claude', 'settings.local.json')),
  }
}

function parseRule(raw: string, source: SettingsSource, behavior: 'allow'|'deny'|'ask'): PermissionRule | null {
  const m = /^([^()\\]+)(?:\\((.*)\\))?$/.exec(raw)
  if (!m) return null
  const toolName = m[1]?.trim()
  if (!toolName) return null
  let content = m[2]
  if (content === '*' || content === '') content = undefined
  return { source, ruleBehavior: behavior, ruleValue: content === undefined ? { toolName } : { toolName, ruleContent: content }, raw }
}

function rulesFor(settings: Settings, source: SettingsSource): PermissionRule[] {
  const out: PermissionRule[] = []
  for (const behavior of ['allow', 'deny', 'ask'] as const) {
    for (const raw of settings.permissions?.[behavior] ?? []) {
      const rule = parseRule(raw, source, behavior)
      if (rule) out.push(rule)
    }
  }
  return out
}

function mergeArray(...values: Array<string[] | undefined>): string[] | undefined {
  const all = values.flatMap(v => v ?? [])
  return all.length ? [...new Set(all)] : undefined
}

export function resolveSettings(sources: SettingsSources): Settings {
  const ordered: Array<[SettingsSource, Settings | undefined]> = [
    ['userSettings', sources.user], ['projectSettings', sources.project], ['localSettings', sources.local],
    ['flagSettings', sources.flag], ['policySettings', sources.policy],
  ]
  const merged: Settings = {}
  let perms: NonNullable<Settings['permissions']> = {}
  for (const [, settings] of ordered) {
    if (!settings) continue
    Object.assign(merged, settings)
    if (settings.permissions) {
      const previous = perms
      perms = {
        allow: mergeArray(previous.allow, settings.permissions.allow),
        deny: mergeArray(previous.deny, settings.permissions.deny),
        ask: mergeArray(previous.ask, settings.permissions.ask),
        defaultMode: settings.permissions.defaultMode ?? previous.defaultMode,
      }
    }
    if (settings.mcpServers) merged.mcpServers = { ...(merged.mcpServers ?? {}), ...settings.mcpServers }
    if (settings.enabledPlugins) merged.enabledPlugins = { ...(merged.enabledPlugins ?? {}), ...settings.enabledPlugins }
  }
  merged.permissions = perms
  const rules: PermissionRule[] = []
  const seen = new Set<string>()
  for (const [source, settings] of ordered) {
    for (const rule of rulesFor(settings ?? {}, source)) {
      const key = `${rule.ruleBehavior}:${rule.ruleValue.toolName}:${rule.ruleValue.ruleContent ?? ''}`
      if (!seen.has(key)) { seen.add(key); rules.push(rule) }
    }
  }
  merged.permissionRules = rules
  return merged
}

export function permissionContextFromSettings(settings: Settings, modeOverride?: PermissionMode) {
  return { mode: modeOverride ?? settings.permissions?.defaultMode ?? 'default', rules: settings.permissionRules ?? [] }
}
