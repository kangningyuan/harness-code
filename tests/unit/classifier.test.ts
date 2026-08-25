import { classifyYoloAction, clearClassifierCache } from '../../src/permissions/classifier.js'
describe('classifier', () => {
  beforeEach(clearClassifierCache)
  it('parses allow and caches it', async () => { const client = { callOnce: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"shouldBlock":false,"reason":"safe"}' }] }) }; const opts = { client: client as any, smallModel: 'small', toolName: 'Read', input: { path: 'x' } }; expect(await classifyYoloAction(opts)).toMatchObject({ shouldBlock: false }); await classifyYoloAction(opts); expect(client.callOnce).toHaveBeenCalledTimes(1) })
  it('fails closed on malformed output', async () => { const client = { callOnce: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'not json' }] }) }; expect((await classifyYoloAction({ client: client as any, smallModel: 'small', toolName: 'Write', input: {} })).shouldBlock).toBe(true) })
})
