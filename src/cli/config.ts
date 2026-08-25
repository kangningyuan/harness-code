import type { ApiConfig, ModelEntry } from '../services/api/types.js'
import type { HarnessConfigFile } from './configFile.js'
import type { Settings } from '../utils/permissions/settings.js'

export const DEFAULT_BASE_URL = ''
export const DEFAULT_MODEL = 'gpt-5.5'
export const DEFAULT_SMALL_MODEL = 'gpt-5.4-mini'
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192
export const DEFAULT_TIMEOUT_MS = 600_000

function env(name: string): string | undefined {
  const value = process.env[name]
  return value === undefined || value === '' ? undefined : value
}
function numberValue(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
export interface CliConfigOverrides { apiKey?: string; baseURL?: string; model?: string; smallModel?: string; maxOutputTokens?: number }

export function resolveConfig(cli: CliConfigOverrides = {}, values: { env?: NodeJS.ProcessEnv; configFile?: HarnessConfigFile; settings?: Settings; configFilePath?: string } = {}): ApiConfig {
  const e = values.env ?? process.env
  const getEnv = (key: string) => { const v = e[key]; return v === undefined || v === '' ? undefined : v }
  const file = values.configFile ?? {}
  const settings = values.settings ?? {}
  const apiKey = cli.apiKey ?? getEnv('HARNESS_API_KEY') ?? getEnv('HARNESS_AUTH_TOKEN') ?? file.apiKey ?? settings.apiKey
  const baseURL = (cli.baseURL ?? getEnv('HARNESS_BASE_URL') ?? file.baseURL ?? settings.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const model = cli.model ?? getEnv('HARNESS_MODEL') ?? file.model ?? settings.model ?? DEFAULT_MODEL
  const smallModel = cli.smallModel ?? getEnv('HARNESS_SMALL_MODEL') ?? file.smallModel ?? settings.smallModel ?? DEFAULT_SMALL_MODEL
  const maxOutputTokens = numberValue(cli.maxOutputTokens ?? getEnv('HARNESS_MAX_OUTPUT_TOKENS') ?? file.maxOutputTokens ?? settings.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS)
  const timeoutMs = numberValue(getEnv('API_TIMEOUT_MS'), DEFAULT_TIMEOUT_MS)
  const models: ModelEntry[] | undefined = file.models
  return { apiKey, baseURL, model, smallModel, maxOutputTokens, timeoutMs, models, configFilePath: values.configFilePath }
}

export function redactApiKey(key: string | undefined): string {
  if (!key) return '(none)'
  return key.length <= 12 ? '••••' : `${key.slice(0, 8)}…${key.slice(-4)}`
}
