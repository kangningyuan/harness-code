import { createHooksRegistry, emptyMatchers, runHooks } from '../../src/services/hooks/index.js'

describe('HTTP hooks', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('sends correlation context and returns a decision', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"decision":"approve"}', { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    const matchers = emptyMatchers(); matchers.PreToolUse = [{ matcher: 'Write', hooks: [{ type: 'http', url: 'https://hook.test/check' }] }]
    const result = await runHooks(createHooksRegistry(matchers), 'PreToolUse', { cwd: '/tmp', toolName: 'Write', input: { apiKey: 'secret', path: 'x' }, sessionId: 's', requestId: 'r' }, { failClosed: true })
    expect(result).toMatchObject({ decision: 'approve' })
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))
    expect(body.requestId).toBe('r')
    expect(body.input.apiKey).toBe('[redacted]')
  })

  it('fails closed on an invalid response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not-json', { status: 200 })))
    const matchers = emptyMatchers(); matchers.PreToolUse = [{ hooks: [{ type: 'http', url: 'https://hook.test/check' }] }]
    expect(await runHooks(createHooksRegistry(matchers), 'PreToolUse', { cwd: '/tmp' }, { failClosed: true })).toMatchObject({ decision: 'block' })
  })
})
