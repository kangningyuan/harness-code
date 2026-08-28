import { createServer, type Server } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runHeadless } from '../../src/entrypoints/headless.js'

function sse(events: unknown[]): string { return events.map(event => `data: ${JSON.stringify(event)}\n`).join('\n') }

describe('headless tool loop contract', () => {
  let home: string
  let cwd: string
  let server: Server
  let baseURL: string
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'harness-headless-home-')); cwd = join(home, 'project');
    mkdirSync(cwd, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd })
    execFileSync('git', ['config', 'user.name', 'Harness Test'], { cwd })
    writeFileSync(join(cwd, 'README.md'), 'fixture project\n')
    execFileSync('git', ['add', 'README.md'], { cwd })
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd })
    writeFileSync(join(home, 'fixture.txt'), 'fixture content')
    server = createServer((request, response) => {
      let body = ''; request.on('data', chunk => { body += String(chunk) }); request.on('end', () => {
        const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: unknown }> }
        const hasToolResult = parsed.messages?.some(message => message.role === 'user' && Array.isArray(message.content) && (message.content as Array<{ type?: string }>).some(block => block.type === 'tool_result'))
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        if (!hasToolResult) {
          response.end(sse([
            { type: 'message_start', message: { usage: { input_tokens: 1 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'read-1', name: 'FileReadTool', input: {} } },
            { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: join(home, 'fixture.txt') }) } },
            { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
            { type: 'message_stop' },
          ]))
        } else {
          response.end(sse([
            { type: 'message_start', message: { usage: { input_tokens: 3 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'read complete' } },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
            { type: 'message_stop' },
          ]))
        }
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('server did not bind')
    baseURL = `http://127.0.0.1:${address.port}`
    vi.stubEnv('HOME', home)
  })
  afterEach(async () => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); await new Promise<void>(resolve => server.close(() => resolve())) })

  it('executes a model tool-use, returns the paired result, and emits ordered NDJSON', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const result = await runHeadless({ prompt: 'read fixture', cwd, outputFormat: 'stream-json', permissionContext: { mode: 'bypassPermissions', rules: [] }, config: { apiKey: 'test', baseURL, model: 'test', smallModel: 'small', maxOutputTokens: 128, timeoutMs: 2_000 } })
    expect(result.reason).toBe('completed')
    const lines = write.mock.calls.map(call => String(call[0])).join('').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(lines.map(line => line.type)).toEqual(expect.arrayContaining(['tool_use', 'tool_result', 'assistant_message', 'result']))
    expect(lines.at(-1)).toMatchObject({ type: 'result', reason: 'completed' })
    expect(lines.find(line => line.type === 'tool_result')).toMatchObject({ isError: false })
    expect(lines.find(line => line.type === 'assistant_message')).toBeDefined()
    write.mockRestore()
  })
})
