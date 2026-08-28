import { createHash } from 'node:crypto'
import type { ApiClient } from '../services/api/client.js'
export interface ClassifierResult { shouldBlock: boolean; reason?: string; failed?: boolean }
const cache = new Map<string, ClassifierResult>()
export function clearClassifierCache(): void { cache.clear() }
function parseJson(text: string): ClassifierResult {
  const clean = text.replace(/```(?:json)?/gi, '').replace(/```/g, '')
  const start = clean.indexOf('{'); const end = clean.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('No JSON classifier result')
  const parsed: unknown = JSON.parse(clean.slice(start, end + 1)); if (!parsed || typeof parsed !== 'object') throw new Error('Invalid classifier result')
  const value = parsed as Record<string, unknown>; return { shouldBlock: value.shouldBlock !== false, reason: typeof value.reason === 'string' ? value.reason : undefined }
}
export async function classifyYoloAction(options: { client: ApiClient; smallModel: string; toolName: string; input: Record<string, unknown>; cwd?: string }): Promise<ClassifierResult> {
  const hash = createHash('sha256').update(JSON.stringify({ cwd: options.cwd ?? '', input: options.input })).digest('hex').slice(0, 16); const key = `${options.smallModel}:${options.toolName}:${hash}`; const hit = cache.get(key); if (hit) return hit
  let result: ClassifierResult
  try {
    const response = await options.client.callOnce({ model: options.smallModel, max_tokens: 256, system: 'Classify tool actions for safety. BLOCK destructive, irreversible, dangerous, protected-path, or data-exfiltration actions. When uncertain BLOCK. Return only JSON {"shouldBlock": boolean, "reason": string}.', messages: [{ role: 'user', content: `Tool: ${options.toolName}\nInput: ${JSON.stringify(options.input).slice(0, 4000)}` }] })
    const text = response.content.filter(block => block.type === 'text').map(block => block.text).join(''); result = parseJson(text)
  } catch (error) { result = { shouldBlock: true, failed: true, reason: error instanceof Error ? error.message : 'Classifier failed' } }
  cache.set(key, result); if (cache.size > 200) cache.delete(cache.keys().next().value!)
  return result
}
export { parseJson as parseClassifierJson }
