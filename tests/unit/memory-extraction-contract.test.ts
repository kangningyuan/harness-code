import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { extractMemories } from '../../src/services/extractMemories/extract.js'

describe('memory extraction failure and validation contract', () => {
  let home: string
  let memory: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'harness-memory-contract-')); memory = join(home, 'memory'); vi.stubEnv('HARNESS_MEMORY_PATH', memory) })
  afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) })

  it.each(['not JSON', '```json\n{"memories":[}\n```', '{"memories": {}}'])('returns no writes for malformed model output: %s', async text => {
    const result = await extractMemories({ client: { callOnce: vi.fn().mockResolvedValue({ content: [{ type: 'text', text }] }) } as never, smallModel: 'small', cwd: home, messages: [{ role: 'user', content: 'conversation' }] })
    expect(result).toMatchObject({ written: [], skipped: 0 })
    expect(readdirSync(memory).filter(name => name.endsWith('.md') && name !== 'MEMORY.md')).toEqual([])
  })

  it('limits a model response to five valid memories and normalizes unknown types', async () => {
    const memories = Array.from({ length: 8 }, (_, index) => ({ name: `Fact ${index}`, description: `Description ${index}`, type: 'unknown', body: `Body ${index}` }))
    const result = await extractMemories({ client: { callOnce: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify({ memories }) }] }) } as never, smallModel: 'small', cwd: home, messages: [{ role: 'user', content: 'conversation' }] })
    expect(result.written).toHaveLength(5)
    expect(result.skipped).toBe(0)
    expect(readdirSync(memory).filter(name => name.endsWith('.md') && name !== 'MEMORY.md')).toHaveLength(5)
    expect(readFileSync(join(memory, 'fact-0.md'), 'utf8')).toContain('type: project')
  })

  it('skips empty entries and existing names case-insensitively', async () => {
    mkdirSync(memory, { recursive: true })
    writeFileSync(join(memory, 'existing.md'), '---\nname: Existing Fact\ndescription: old\n---\nold\n')
    const response = { memories: [
      { name: 'existing fact', description: 'new', body: 'new' },
      { name: 'Valid', description: '', body: 'missing description' },
      { name: 'Another', description: 'valid', body: 'body' },
    ] }
    const result = await extractMemories({ client: { callOnce: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify(response) }] }) } as never, smallModel: 'small', cwd: home, messages: [{ role: 'user', content: 'conversation' }] })
    expect(result.written).toEqual(['Another'])
    expect(result.skipped).toBe(2)
  })

  it('returns API errors without leaving a partial memory file', async () => {
    const result = await extractMemories({ client: { callOnce: vi.fn().mockRejectedValue(new Error('API unavailable')) } as never, smallModel: 'small', cwd: home, messages: [{ role: 'user', content: 'conversation' }] })
    expect(result).toMatchObject({ written: [], skipped: 0, error: 'API unavailable' })
    expect(readdirSync(memory).filter(name => name.endsWith('.md') && name !== 'MEMORY.md')).toEqual([])
  })
})
