import { QueryEngine } from '../../src/QueryEngine.js'
import type { ApiClient } from '../../src/services/api/client.js'

describe('QueryEngine orchestration', () => {
  it('uses the configured automatic compaction callback before a model turn', async () => {
    const autoCompact = vi.fn().mockResolvedValue([{ role: 'user' as const, content: 'compacted context' }])
    const callModel = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' })
    const engine = new QueryEngine({
      client: { callModel } as unknown as ApiClient,
      tools: [],
      model: 'test',
      smallModel: 'small',
      maxOutputTokens: 32,
      maxTurns: 1,
      cwd: process.cwd(),
      canUseTool: async () => ({ behavior: 'allow' as const }),
      disableSessionPersistence: true,
      autoCompact,
    })
    const result = await engine.submitMessage('hello')
    expect(result.reason).toBe('completed')
    expect(autoCompact).toHaveBeenCalledWith([{ role: 'user', content: 'hello' }])
    expect(callModel.mock.calls[0]?.[0].messages).toEqual([{ role: 'user', content: 'compacted context' }])
  })
})
