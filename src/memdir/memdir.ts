import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getAutoMemPath, getMemoryIndexPath } from './paths.js'
export { getAutoMemPath, getMemoryIndexPath } from './paths.js'

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'
export interface MemoryFile { path: string; name: string; description: string; type: MemoryType; body: string; mtimeMs: number }
function parseFrontmatter(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) { const match = /^\s*([\w-]+):\s*(.*)$/.exec(line); if (match?.[1]) out[match[1]] = match[2] ?? '' }
  return out
}
export function parseMemoryFile(path: string): MemoryFile | null {
  try {
    const raw = readFileSync(path, 'utf8'); const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw)
    if (!match) return null
    const front = parseFrontmatter(match[1] ?? ''); const type = ['user','feedback','project','reference'].includes(front.type ?? '') ? front.type as MemoryType : 'project'
    return { path, name: front.name ?? '', description: front.description ?? '', type, body: match[2] ?? '', mtimeMs: statSync(path).mtimeMs }
  } catch { return null }
}
export function scanMemoryFiles(memDir: string): MemoryFile[] {
  if (!existsSync(memDir)) return []
  return readdirSync(memDir).filter(name => name.endsWith('.md') && name !== 'MEMORY.md').map(name => parseMemoryFile(join(memDir, name))).filter((file): file is MemoryFile => file !== null)
}
export function buildMemoryIndex(files: MemoryFile[]): string {
  const lines = files.slice(0, 200).map(file => `- [${file.name}](${file.path}) — ${file.description}`)
  let text = lines.join('\n') + (lines.length ? '\n' : '')
  if (Buffer.byteLength(text) > 25_000) { text = text.slice(0, 24_900) + '\n<!-- index truncated -->\n' }
  return text
}
export function ensureMemoryDir(memDir: string): void {
  mkdirSync(memDir, { recursive: true }); const index = getMemoryIndexPath(memDir)
  if (!existsSync(index)) writeFileSync(index, '# Memory Index\n\n', 'utf8')
}
export function loadMemoryPrompt(cwd: string, settings?: { autoMemoryDirectory?: string }): string | null {
  const dir = getAutoMemPath(cwd, settings); if (!existsSync(dir)) return null
  const indexPath = getMemoryIndexPath(dir)
  const index = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '# Memory Index\n\n'
  return `# Auto memory\n\n${index}\nSave only non-obvious durable facts; do not duplicate code, git, or CLAUDE.md.\n`
}
