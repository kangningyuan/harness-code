import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventLogger } from '../../src/services/observability/events.js'
import { createHooksRegistry, emptyMatchers, runHooks } from '../../src/services/hooks/index.js'
import { projectStateDir } from '../../src/services/session/paths.js'

describe('observability and remote hook contract', () => {
  let home: string
  let cwd: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'harness-observe-contract-')); cwd = join(home, 'project'); vi.stubEnv('HOME', home) })
  afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) })

  it('redacts sensitive event data, bounds values, and preserves correlation', () => {
    const logger = new EventLogger(cwd)
    logger.record('test', { sessionId: 'session-1', turnId: 'turn-1', requestId: 'request-1' }, {
      apiKey: 'secret', authorization: 'Bearer secret', nested: { password: 'pw', content: 'private' },
      long: 'x'.repeat(600), list: Array.from({ length: 30 }, (_, index) => index), deep: { a: { b: { c: { d: 'too deep' } } } },
    })
    const dir = join(projectStateDir(cwd), 'events')
    const file = readdirSync(dir).find(name => name.endsWith('.jsonl'))
    expect(file).toBeDefined()
    expect(existsSync(join(dir, file!))).toBe(true)
    const line = JSON.parse(readFileSync(join(dir, file!), 'utf8')) as Record<string, unknown>
    expect(line.correlation).toEqual({ sessionId: 'session-1', turnId: 'turn-1', requestId: 'request-1' })
    const data = line.data as Record<string, unknown>
    expect(data.apiKey).toBe('[redacted]')
    expect((data.nested as Record<string, unknown>).password).toBe('[redacted]')
    expect(data.long).toMatch(/^x{500}…$/)
    expect(data.list).toHaveLength(20)
    expect((data.deep as Record<string, unknown>).a).toBeDefined()
    expect(JSON.stringify(data)).not.toContain('secret')
  })

  it('does not throw when event persistence encounters a write failure', () => {
    const logger = new EventLogger(cwd)
    const path = join(logger.dir, createHash('sha256').update('s').digest('hex').slice(0, 32) + '.jsonl')
    mkdirSync(path)
    expect(() => logger.record('safe', { sessionId: 's', turnId: 't' })).not.toThrow()
    expect(existsSync(path)).toBe(true)
  })

  it('redacts nested hook inputs and fails closed for HTTP errors and invalid decisions', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('server error', { status: 500 }))
      .mockResolvedValueOnce(new Response('{"decision":"invalid"}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const matchers = emptyMatchers(); matchers.PreToolUse = [{ hooks: [{ type: 'http', url: 'https://hook.test/check', headers: { 'x-hook': 'yes' } }] }]
    const input = { cwd, toolName: 'Write', input: { nested: { token: 'secret', value: 'ok' } } }
    expect(await runHooks(createHooksRegistry(matchers), 'PreToolUse', input, { failClosed: true })).toMatchObject({ decision: 'block' })
    expect(await runHooks(createHooksRegistry(matchers), 'PreToolUse', input, { failClosed: true })).toMatchObject({ decision: 'block' })
    const options = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect((options.headers as Record<string, string>)['x-hook']).toBe('yes')
    expect(String(options.body)).toContain('[redacted]')
    expect(String(options.body)).not.toContain('secret')
  })

  it('treats PostToolUse hook failures as observe-only when failClosed is false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const matchers = emptyMatchers(); matchers.PostToolUse = [{ hooks: [{ type: 'http', url: 'https://hook.test/check' }] }]
    expect(await runHooks(createHooksRegistry(matchers), 'PostToolUse', { cwd, toolName: 'Write' })).toEqual({})
  })
})
