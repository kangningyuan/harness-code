import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildMemoryIndex, loadMemoryPrompt, parseMemoryFile, scanMemoryFiles } from '../../src/memdir/memdir.js'

describe('memory directory', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-memory-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  it('parses and scans memory files', () => {
    const file = join(dir, 'fact.md'); writeFileSync(file, '---\nname: fact\ndescription: A fact\ntype: user\n---\nbody\n')
    expect(parseMemoryFile(file)).toMatchObject({ name: 'fact', type: 'user', body: 'body\n' })
    expect(scanMemoryFiles(dir)).toHaveLength(1)
  })
  it('builds an index', () => { mkdirSync(dir, { recursive: true }); const file = join(dir, 'fact.md'); writeFileSync(file, '---\nname: fact\ndescription: A fact\n---\nbody'); const parsed = parseMemoryFile(file)!; expect(buildMemoryIndex([parsed])).toContain('[fact]') })
  it('loads a safe empty prompt when MEMORY.md is missing', () => {
    const memoryDir = join(dir, 'memory'); mkdirSync(memoryDir)
    vi.stubEnv('HARNESS_MEMORY_PATH', memoryDir)
    expect(loadMemoryPrompt(dir)).toContain('# Memory Index')
    expect(existsSync(join(memoryDir, 'MEMORY.md'))).toBe(false)
    vi.unstubAllEnvs()
  })
})
