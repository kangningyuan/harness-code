import { createServer, type Server } from 'node:http'
import { runHeadless } from '../../src/entrypoints/headless.js'

describe('headless CLI entrypoint', () => {
  let server: Server
  let baseURL: string
  const originalExitCode = process.exitCode
  beforeEach(async () => {
    server = createServer((request, response) => {
      if (request.url !== '/v1/messages') { response.writeHead(404); response.end(); return }
      let body = ''; request.on('data', chunk => { body += String(chunk) }); request.on('end', () => {
        if (body.includes('force-error')) { response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { type: 'server_error', message: 'forced error' } })); return }
        response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":2,"output_tokens":2}}')
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('server did not bind')
    baseURL = `http://127.0.0.1:${address.port}`
    process.exitCode = undefined
  })
  afterEach(async () => { process.exitCode = originalExitCode; await new Promise<void>(resolve => server.close(() => resolve())) })
  const config = () => ({ apiKey: 'test-key', baseURL, model: 'test', smallModel: 'small', maxOutputTokens: 32, timeoutMs: 5000 })
  it('prints text output without persisting a session', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const result = await runHeadless({ prompt: 'hello', cwd: process.cwd(), outputFormat: 'text', config: config() })
    expect(result.reason).toBe('completed')
    expect(write.mock.calls.map(call => String(call[0])).join('')).toContain('hello world')
    write.mockRestore()
  })
  it('prints structured stream-json events including assistant_message and result', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const result = await runHeadless({ prompt: 'hello', cwd: process.cwd(), outputFormat: 'stream-json', config: config() })
    const lines = write.mock.calls.map(call => String(call[0])).join('').trim().split('\n').map(line => JSON.parse(line))
    expect(result.reason).toBe('completed')
    expect(lines.some(line => line.type === 'assistant_message')).toBe(true)
    expect(lines.at(-1)).toMatchObject({ type: 'result', reason: 'completed' })
    write.mockRestore()
  })
  it('reports model errors and sets a nonzero exit code', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const errorWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const result = await runHeadless({ prompt: 'force-error', cwd: process.cwd(), outputFormat: 'text', config: config() })
    expect(result.reason).toBe('error')
    expect(process.exitCode).toBe(1)
    expect(errorWrite.mock.calls.map(call => String(call[0])).join('')).toContain('forced error')
    write.mockRestore(); errorWrite.mockRestore()
  })
})
