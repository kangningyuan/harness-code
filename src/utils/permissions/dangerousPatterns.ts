import { isAbsolute, resolve } from 'node:path'
import { canonicalPath } from '../file/canonicalPath.js'
export const SAFETY_CHECK_PATHS = ['.git/', '.claude/', '.vscode/', '.bashrc', '.zshrc', '.profile', '.bash_profile', '.zprofile', '.config/fish/config.fish']
export function isSafetyCheckPath(path: string, cwd: string): boolean {
  const value = canonicalPath(path, cwd); const root = canonicalPath(cwd, cwd)
  const relative = value.startsWith(root) ? value.slice(root.length).replace(/^[/\\]/, '') : value
  return SAFETY_CHECK_PATHS.some(pattern => pattern.endsWith('/') ? relative.startsWith(pattern) : relative === pattern || relative.endsWith('/' + pattern))
}
export function bashCommandTouchesSafetyPath(command: string): boolean {
  return /(?:>|>>|&>|\b(?:tee|cp|mv|rm|mkdir|touch)\b)/.test(command) && SAFETY_CHECK_PATHS.some(path => command.includes(path.replace(/\/$/, '')))
}
