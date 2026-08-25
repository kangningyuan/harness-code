import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ApiClient } from '../api/client.js'
import type { Message } from '../api/types.js'
import { buildMemoryIndex, ensureMemoryDir, getMemoryIndexPath, getAutoMemPath, scanMemoryFiles } from '../../memdir/memdir.js'
export interface ProposedMemory { name: string; description: string; type?: 'user'|'feedback'|'project'|'reference'; body: string }
export interface ExtractResult { written: string[]; skipped: number; error?: string }
function transcript(messages: Message[]): string { return messages.map(message => `[${message.role}] ${typeof message.content === 'string' ? message.content.slice(0, 1500) : JSON.stringify(message.content).slice(0, 1500)}`).join('\n\n').slice(0, 60_000) }
function balancedObject(text: string): string | null {
  const start = text.indexOf('{'); if (start < 0) return null
  let depth = 0; let quote = false; let escaped = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (quote) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quote = false; continue }
    if (char === '"') { quote = true; continue }
    if (char === '{') depth++
    else if (char === '}' && --depth === 0) return text.slice(start, index + 1)
  }
  return null
}
function parseJson(text: string): ProposedMemory[] { const object = balancedObject(text.replace(/```(?:json)?/gi, '')); if (!object) return []; try { const value = JSON.parse(object) as { memories?: ProposedMemory[] }; return Array.isArray(value.memories) ? value.memories : [] } catch { return [] } }
function slugify(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'memory' }
function render(memory: ProposedMemory): string { const type = ['user','feedback','project','reference'].includes(memory.type ?? '') ? memory.type : 'project'; return `---\nname: ${memory.name}\ndescription: ${memory.description}\nmetadata:\n  type: ${type}\n---\n\n${memory.body.trim()}\n` }
export async function extractMemories(options: { client: ApiClient; smallModel: string; messages: Message[]; cwd: string; settings?: { autoMemoryDirectory?: string } }): Promise<ExtractResult> { if (!options.messages.length) return { written: [], skipped: 0, error: 'No conversation to extract from.' }; const dir = getAutoMemPath(options.cwd, options.settings); ensureMemoryDir(dir); const existing = new Set(scanMemoryFiles(dir).flatMap(file => [file.name.toLowerCase(), slugify(file.name)])); const usedPaths = new Set<string>(); const index = existsSync(getMemoryIndexPath(dir)) ? readFileSync(getMemoryIndexPath(dir), 'utf8') : ''; try { const response = await options.client.callOnce({ model: options.smallModel, max_tokens: 2048, system: 'Extract durable non-obvious memories. Return only JSON: {"memories":[{"name","description","type","body"}]}. Maximum 5.', messages: [{ role: 'user', content: `Existing index:\n${index}\n\nConversation:\n${transcript(options.messages)}` }] }); const proposed = parseJson(response.content.filter(block => block.type === 'text').map(block => block.text).join('')); const written: string[] = []; let skipped = 0; for (const memory of proposed.slice(0, 5)) { const name = String(memory.name ?? '').trim(); const description = String(memory.description ?? '').trim(); const body = String(memory.body ?? '').trim(); const slug = slugify(name); const path = join(dir, `${slug}.md`); if (!name || !description || !body || existing.has(name.toLowerCase()) || existing.has(slug) || usedPaths.has(path)) { skipped++; continue } try { writeFileSync(path, render({ ...memory, name, description, body }), 'utf8'); existing.add(name.toLowerCase()); existing.add(slug); usedPaths.add(path); written.push(name) } catch { skipped++ } } if (written.length) { const refreshed = scanMemoryFiles(dir); writeFileSync(getMemoryIndexPath(dir), '# Memory Index\n\n' + buildMemoryIndex(refreshed), 'utf8') } return { written, skipped } } catch (error) { return { written: [], skipped: 0, error: error instanceof Error ? error.message : String(error) } } }
