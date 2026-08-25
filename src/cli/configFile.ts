import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ModelEntry } from '../services/api/types.js'

export interface HarnessConfigFile {
  apiKey?: string
  baseURL?: string
  model?: string
  smallModel?: string
  maxOutputTokens?: number
  models?: ModelEntry[]
}

export function configFilePaths(cwd: string): { user: string; project: string } {
  return { user: join(homedir(), '.harness-code', 'config.json'), project: join(cwd, '.harness-code', 'config.json') }
}

function readConfig(path: string): HarnessConfigFile {
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed as HarnessConfigFile : {}
  } catch { return {} }
}

export function discoverConfigFile(cwd: string): { config: HarnessConfigFile; path?: string } {
  const paths = configFilePaths(cwd)
  const user = readConfig(paths.user)
  const project = readConfig(paths.project)
  const config: HarnessConfigFile = { ...user, ...project, models: project.models ?? user.models }
  return { config, path: existsSync(paths.project) ? paths.project : existsSync(paths.user) ? paths.user : undefined }
}

export function writeTemplateConfig(cwd: string): string {
  const dir = join(cwd, '.harness-code')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'config.json')
  const template: HarnessConfigFile = {
    apiKey: 'replace-me', baseURL: 'https://api.example.com/anthropic', model: 'gpt-5.5',
    smallModel: 'gpt-5.4-mini', maxOutputTokens: 8192,
    models: [
      { id: 'gpt-5.5', name: 'Default' },
      { id: 'gpt-5.4', name: 'General' },
      { id: 'gpt-5.4-mini', name: 'Small' },
      { id: 'mimo-v2.5', name: 'Mimo' },
      { id: 'mimo-v2.5-pro', name: 'Mimo Pro' },
    ],
  }
  writeFileSync(path, JSON.stringify(template, null, 2) + '\n', 'utf8')
  return path
}
