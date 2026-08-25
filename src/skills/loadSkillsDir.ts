import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
export interface Skill { name: string; description: string; argumentHint?: string; arguments?: Array<{ name: string; description?: string }>; allowedTools?: string[]; model?: string; userInvocable?: boolean; disableModelInvocation?: boolean; skillDir?: string; body: string; source: 'user'|'project'|'bundled' }
type Frontmatter = Record<string, string | string[]>
function parseFrontmatter(raw: string): Frontmatter {
  const result: Frontmatter = {}; let listKey: string | undefined
  for (const line of raw.split(/\r?\n/)) {
    const field = /^([\w-]+):\s*(.*)$/.exec(line)
    if (field?.[1]) { const key = field[1]; const value = field[2] ?? ''; if (value) result[key] = value; else result[key] = []; listKey = key; continue }
    const item = /^\s*-\s*(.*)$/.exec(line)
    if (item && listKey) { const current = result[listKey]; if (Array.isArray(current)) current.push(item[1] ?? '') }
  }
  return result
}
function scalar(value: string | string[] | undefined): string | undefined { return typeof value === 'string' ? value : undefined }
function list(value: string | string[] | undefined): string[] | undefined { if (Array.isArray(value)) return value.map(item => item.trim()).filter(Boolean); if (typeof value === 'string') return value.split(',').map(item => item.trim()).filter(Boolean); return undefined }
function parse(path: string, source: Skill['source'], dir: string): Skill | null { try { const raw = readFileSync(path, 'utf8'); const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw); const front = parseFrontmatter(match?.[1] ?? ''); const body = match?.[2] ?? raw; const argumentValues = list(front.arguments)?.map(item => { const separator = item.indexOf(':'); return separator >= 0 ? { name: item.slice(0, separator).trim(), description: item.slice(separator + 1).trim() } : { name: item } }); return { name: scalar(front.name) || basename(dir), description: scalar(front.description) ?? '', argumentHint: scalar(front['argument-hint']), arguments: argumentValues, allowedTools: list(front['allowed-tools']), model: scalar(front.model), skillDir: dir, body, userInvocable: scalar(front['user-invocable']) !== 'false', disableModelInvocation: scalar(front['disable-model-invocation']) === 'true', source } } catch { return null } }
export function loadSkillsDir(dir: string, source: Skill['source']): Skill[] { if (!existsSync(dir)) return []; return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => parse(join(dir, entry.name, 'SKILL.md'), source, join(dir, entry.name))).filter((skill): skill is Skill => skill !== null) }
export function loadAllSkills(cwd: string): Skill[] { return [...loadSkillsDir(join(homedir(), '.claude', 'skills'), 'user'), ...loadSkillsDir(join(cwd, '.claude', 'skills'), 'project')] }
function replaceLiteral(value: string, token: string, replacement: string): string { return value.replaceAll(token, () => replacement) }
export function substituteArguments(body: string, args: Record<string, string>, skillDir?: string): string { let result = replaceLiteral(body, '${CLAUDE_SKILL_DIR}', skillDir ?? ''); for (const [key, value] of Object.entries(args)) { result = replaceLiteral(result, `$${key}`, value).replaceAll(`\${${key}}`, () => value) }; return replaceLiteral(result, '$ARGUMENTS', args.ARGUMENTS ?? Object.values(args).join(' ')) }
export function parseSlashCommand(input: string): { name: string; args: string } | null { if (!input.startsWith('/')) return null; const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(input.trim()); return match?.[1] ? { name: match[1], args: match[2] ?? '' } : null }
