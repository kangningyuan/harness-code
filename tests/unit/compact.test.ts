import { compactConversation, createAutoCompact, estimateTokens, reactiveCompactConversation, resetCompactionState, shouldAutoCompact } from '../../src/services/compact/compact.js'

describe('compact', () => {
  beforeEach(resetCompactionState)
  it('estimates tokens and threshold', () => { const messages = [{ role: 'user' as const, content: 'a'.repeat(400) }]; expect(estimateTokens(messages)).toBe(100); expect(shouldAutoCompact(messages, 100)).toBe(true) })
  it('summarizes old messages and keeps recent ones', async () => {
    const client = { callOnce: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'summary' }] }) }
    const result = await compactConversation([{ role: 'user', content: 'old' }, { role: 'assistant', content: 'old answer' }, { role: 'user', content: 'recent' }], { client: client as any, model: 'small' })
    expect(result).toHaveLength(3); expect(result?.[0]?.content).toContain('summary')
  })
  it('fires pre and post hooks with the summarized and compacted messages', async () => {
    const calls: string[] = []
    const client = { callOnce: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'summary' }] }) }
    const result = await compactConversation([{ role: 'user', content: 'old' }, { role: 'assistant', content: 'recent' }, { role: 'user', content: 'latest' }], {
      client: client as any,
      model: 'small',
      hooks: {
        pre: async messages => { calls.push(`pre:${messages.length}`) },
        post: async messages => { calls.push(`post:${messages.length}`) },
      },
    })
    expect(result).not.toBeNull()
    expect(calls).toEqual(['pre:1', 'post:3'])
  })
  it('reactively compacts while retaining a larger recent tail', async () => {
    const client = { callOnce: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'recovery summary' }] }) }
    const messages = Array.from({ length: 8 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: `message-${index}` }))
    const result = await reactiveCompactConversation(messages, { client: client as any, model: 'small' })
    expect(result).toHaveLength(6)
    expect(result?.[0]?.content).toContain('recovery summary')
    expect(result?.at(-1)?.content).toBe('message-7')
  })
  it('does not compact below the automatic threshold', async () => {
    const client = { callOnce: vi.fn() }
    const auto = createAutoCompact({ client: client as any, model: 'small', contextWindow: 1000 })
    expect(await auto([{ role: 'user', content: 'short' }])).toBeNull()
    expect(client.callOnce).not.toHaveBeenCalled()
  })
})
