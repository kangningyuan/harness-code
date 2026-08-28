import { clearClassifierCache, classifyYoloAction, parseClassifierJson } from '../../src/permissions/classifier.js'

describe('automatic permission classifier contract', () => {
  afterEach(() => clearClassifierCache())

  it.each([
    ['{"shouldBlock":false,"reason":"read-only"}', { shouldBlock: false, reason: 'read-only' }],
    ['```json\n{"shouldBlock":true,"reason":"destructive"}\n```', { shouldBlock: true, reason: 'destructive' }],
    ['prefix {"shouldBlock":false} suffix', { shouldBlock: false }],
  ])('parses model output %s', (text, expected) => { expect(parseClassifierJson(text)).toEqual(expected) })

  it.each(['', 'not json', '{bad}'])('fails closed for malformed output %s', text => {
    expect(() => parseClassifierJson(text)).toThrow()
  })

  it('fails closed when the model omits shouldBlock', () => {
    expect(parseClassifierJson('{"reason":"missing flag"}')).toMatchObject({ shouldBlock: true })
  })

  it('caches by model/tool/cwd/input and fails closed on API errors', async () => {
    const callOnce = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"shouldBlock":false}' }] })
    const client = { callOnce } as never
    await expect(classifyYoloAction({ client, smallModel: 'small', toolName: 'Read', input: { path: 'x' }, cwd: '/one' })).resolves.toMatchObject({ shouldBlock: false })
    await classifyYoloAction({ client, smallModel: 'small', toolName: 'Read', input: { path: 'x' }, cwd: '/one' })
    await classifyYoloAction({ client, smallModel: 'small', toolName: 'Read', input: { path: 'x' }, cwd: '/two' })
    expect(callOnce).toHaveBeenCalledTimes(2)
    clearClassifierCache()
    const failed = await classifyYoloAction({ client: { callOnce: vi.fn().mockRejectedValue(new Error('classifier offline')) } as never, smallModel: 'small', toolName: 'Write', input: {}, cwd: '/one' })
    expect(failed).toMatchObject({ shouldBlock: true, failed: true, reason: 'classifier offline' })
  })

  it('evicts old entries after the bounded cache size', async () => {
    const callOnce = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"shouldBlock":false}' }] })
    for (let index = 0; index < 205; index++) await classifyYoloAction({ client: { callOnce } as never, smallModel: 'small', toolName: 'Read', input: { index }, cwd: '/one' })
    await classifyYoloAction({ client: { callOnce } as never, smallModel: 'small', toolName: 'Read', input: { index: 0 }, cwd: '/one' })
    expect(callOnce.mock.calls.length).toBe(206)
  })
})
