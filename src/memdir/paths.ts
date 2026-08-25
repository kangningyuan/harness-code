import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function sanitizeProjectPath(path: string): string {
  const sanitized = path.replaceAll('/', '-').replace(/[^a-zA-Z0-9._-]/g, '').replace(/^-+/, '').slice(0, 200)
  return sanitized || 'default'
}
export function findCanonicalGitRoot(cwd: string): string | null {
  try { return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 3000 }).trim() || null } catch { return null }
}
export function getAutoMemPath(cwd: string, settings?: { autoMemoryDirectory?: string }): string {
  const override = process.env.HARNESS_MEMORY_PATH || process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  if (override) return override
  if (settings?.autoMemoryDirectory) return settings.autoMemoryDirectory
  const root = findCanonicalGitRoot(cwd) ?? cwd
  return join(homedir(), '.claude', 'projects', sanitizeProjectPath(root), 'memory')
}
export function getMemoryIndexPath(memDir: string): string { return join(memDir, 'MEMORY.md') }
