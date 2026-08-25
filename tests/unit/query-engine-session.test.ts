import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { QueryEngine } from '../../src/QueryEngine.js'

describe('QueryEngine startup session lifecycle', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'harness-engine-home-')); vi.stubEnv('HOME', home) })
  afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) })
  it('creates a new session when no sessionId is supplied', () => {
    const options = { client: {} as any, tools: [], model: 'test', smallModel: 'small', maxOutputTokens: 32, maxTurns: 1, cwd: join(home, 'project'), canUseTool: async () => ({ behavior: 'allow' as const }) }
    const first = new QueryEngine(options)
    const second = new QueryEngine(options)
    expect(first.getSessionId()).toBeTruthy()
    expect(second.getSessionId()).toBeTruthy()
    expect(second.getSessionId()).not.toBe(first.getSessionId())
  })
  it('only resumes when an explicit sessionId is supplied', () => {
    const options = { client: {} as any, tools: [], model: 'test', smallModel: 'small', maxOutputTokens: 32, maxTurns: 1, cwd: join(home, 'project'), canUseTool: async () => ({ behavior: 'allow' as const }) }
    const first = new QueryEngine(options)
    const resumed = new QueryEngine({ ...options, sessionId: first.getSessionId()! })
    expect(resumed.getSessionId()).toBe(first.getSessionId())
  })
  it('returns null rather than reading an invalid session path', () => {
    const engine = new QueryEngine({ client: {} as any, tools: [], model: 'test', smallModel: 'small', maxOutputTokens: 32, maxTurns: 1, cwd: join(home, 'project'), canUseTool: async () => ({ behavior: 'allow' as const }) })
    expect(engine.resumeSession('../outside')).toBeNull()
  })
})
