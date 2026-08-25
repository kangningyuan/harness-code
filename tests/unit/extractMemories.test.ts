import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { extractMemories } from '../../src/services/extractMemories/extract.js'

describe('extractMemories', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-memory-extract-')); vi.stubEnv('HARNESS_MEMORY_PATH', dir) })
  afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }) })
  it('writes validated memories and rebuilds the index', async () => {
    const client = { callOnce: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Here is the result:\n```json\n{"memories":[{"name":"User preference","description":"Prefers concise output","type":"user","body":"Keep responses concise."}]}\n```' }] }) }
    const result = await extractMemories({ client: client as any, smallModel: 'small', cwd: join(dir, 'project'), messages: [{ role: 'user', content: 'Please be concise.' }] })
    expect(result.written).toEqual(['User preference'])
    expect(existsSync(join(dir, 'user-preference.md'))).toBe(true)
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toContain('[User preference]')
  })
  it('skips duplicate names and slug collisions in one run', async () => {
    const client = { callOnce: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"memories":[{"name":"Same fact","description":"one","body":"one"},{"name":"Same-fact","description":"two","body":"two"}]}' }] }) }
    const result = await extractMemories({ client: client as any, smallModel: 'small', cwd: dir, messages: [{ role: 'user', content: 'fact' }] })
    expect(result.written).toHaveLength(1)
    expect(result.skipped).toBe(1)
    expect(readdirSync(dir).filter(name => name.endsWith('.md'))).toHaveLength(2)
  })
  it('returns a useful error for an empty conversation', async () => {
    const result = await extractMemories({ client: {} as any, smallModel: 'small', cwd: dir, messages: [] })
    expect(result.error).toContain('No conversation')
  })
})
