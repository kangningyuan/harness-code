import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, parse, resolve } from 'node:path'
import type { BuiltTool } from './Tool.js'
import type { SystemBlock } from './services/api/types.js'
import { loadMemoryPrompt } from './memdir/memdir.js'

export function getDefaultSystemPrompt(tools: BuiltTool[], _verbose = false): string {
  const toolSection = tools.map(tool => `## ${tool.name}\n${tool.prompt()}`).join('\n\n')
  return `You are harness code, an interactive CLI agent that helps users with software engineering tasks. You operate in a terminal and have access to tools.\n\n# Core principles\n- Read files before editing them.\n- Make precise, minimal edits.\n- Verify changes.\n- Fail closed when unsure.\n\n# Available tools\n${toolSection}`
}
function findClaudeMdFiles(cwd: string, extraDirs: string[] = []): string[] {
  if (process.env.HARNESS_DISABLE_CLAUDE_MDS === '1') return []
  const found: string[] = []; const seen = new Set<string>()
  for (const start of [cwd, ...extraDirs]) {
    let current = resolve(start)
    for (let depth = 0; depth < 64; depth++) {
      for (const name of ['CLAUDE.md', 'HARNESS.md']) {
        const path = join(current, name)
        if (existsSync(path)) { const canonical = realpathSync(path); if (!seen.has(canonical)) { seen.add(canonical); found.push(canonical) } }
      }
      const parent = dirname(current); if (parent === current) break; current = parent
    }
  }
  const global = join(homedir(), '.claude', 'CLAUDE.md')
  if (existsSync(global)) { const canonical = realpathSync(global); if (!seen.has(canonical)) found.push(canonical) }
  return found
}
function gitStatus(cwd: string): string | null {
  try {
    const branch = execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 3000 }).trim()
    const status = execFileSync('git', ['-C', cwd, '--no-optional-locks', 'status', '--short'], { encoding: 'utf8', timeout: 5000 }).trim()
    const log = execFileSync('git', ['-C', cwd, 'log', '--oneline', '-n', '5'], { encoding: 'utf8', timeout: 5000 }).trim()
    return `Branch: ${branch}\nStatus:\n${status}\nRecent commits:\n${log}`.slice(0, 2000)
  } catch { return null }
}
export interface ContextOptions { cwd: string; tools: BuiltTool[]; customSystemPrompt?: string; appendSystemPrompt?: string; extraDirs?: string[]; memorySettings?: { autoMemoryDirectory?: string } }
export function fetchSystemPromptParts(options: ContextOptions): SystemBlock[] {
  const blocks: SystemBlock[] = [{ type: 'text', text: options.customSystemPrompt ?? getDefaultSystemPrompt(options.tools), cache_control: { type: 'ephemeral' } }]
  const files = findClaudeMdFiles(options.cwd, options.extraDirs)
  if (files.length) blocks.push({ type: 'text', text: `# Project context (CLAUDE.md)\n\n${files.map(path => `# ${path}\n\n${readFileSync(path, 'utf8')}`).join('\n\n')}` })
  blocks.push({ type: 'text', text: `Today's date is ${new Date().toISOString().slice(0, 10)}.` })
  const status = gitStatus(options.cwd); if (status) blocks.push({ type: 'text', text: `# Git status\n\n${status}` })
  if (options.appendSystemPrompt) blocks.push({ type: 'text', text: options.appendSystemPrompt })
  const memory = loadMemoryPrompt(options.cwd, options.memorySettings); if (memory) blocks.push({ type: 'text', text: memory })
  return blocks
}
