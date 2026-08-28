import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createToolResultStore, formatToolResultReference } from '../../src/services/tool-results/store.js'

describe('tool result artifact contract', () => {
  let cwd: string
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'harness-artifact-contract-')) })
  afterEach(() => rmSync(cwd, { recursive: true, force: true }))

  it('does not persist at the threshold and persists above it with byte-accurate metadata', () => {
    const store = createToolResultStore(cwd, 'session', 10)
    expect(store.persist('0123456789', { toolUseId: 'u', toolName: 'Tool' })).toBeNull()
    const content = '0123456789é'.repeat(10)
    const reference = store.persist(content, { toolUseId: 'u', toolName: 'Tool' })!
    expect(reference).toMatchObject({ byteLength: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') })
    expect(readFileSync(join(cwd, reference.relativePath), 'utf8')).toBe(content)
    expect(statSync(join(cwd, reference.relativePath)).mode & 0o777).toBe(0o600)
    expect(statSync(join(cwd, join('.harness-code', 'tool-results'))).mode & 0o777).toBe(0o700)
  })

  it('uses deterministic IDs and previews head and tail while retaining the artifact', () => {
    const content = 'h'.repeat(2_000) + 'tail'
    const one = createToolResultStore(cwd, 'same', 1).persist(content, { toolUseId: 'u', toolName: 'Tool' })!
    const two = createToolResultStore(cwd, 'same', 1).persist(content, { toolUseId: 'u', toolName: 'Tool' })!
    expect(two).toEqual(one)
    expect(one.preview).toContain('preview truncated')
    expect(one.preview.startsWith('h'.repeat(1_500))).toBe(true)
    expect(one.preview.endsWith('tail')).toBe(true)
    expect(formatToolResultReference(one)).toContain(`<persisted-tool-result>`)
  })

  it('avoids returning a reference when an existing deterministic path contains different data', () => {
    const store = createToolResultStore(cwd, 'session', 1)
    const first = store.persist('first'.repeat(100), { toolUseId: 'u', toolName: 'Tool' })!
    expect(first).not.toBeNull()
    const path = join(cwd, first.relativePath)
    chmodSync(path, 0o600)
    // Simulate a collision/corruption at the deterministic artifact path.
    writeFileSync(path, 'different')
    expect(store.persist('first'.repeat(100), { toolUseId: 'u', toolName: 'Tool' })).toBeNull()
    expect(existsSync(path)).toBe(true)
  })
})
