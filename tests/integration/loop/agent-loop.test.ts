import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { QueryEngine } from '../../../src/QueryEngine.js'
import { FileEditTool } from '../../../src/tools/FileEditTool/FileEditTool.js'
import { FileReadTool } from '../../../src/tools/FileReadTool/FileReadTool.js'
import type { ApiClient } from '../../../src/services/api/client.js'

describe('agent loop end-to-end with local model fixture', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-agent-loop-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  it('reads and edits a file across a complete tool loop', async () => {
    const target = join(dir, 'counter.txt'); writeFileSync(target, 'count = 0\n')
    const callModel = vi.fn()
      .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 'call_read', name: 'FileReadTool', input: { file_path: target } }], stopReason: 'tool_use' })
      .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 'call_edit', name: 'FileEditTool', input: { file_path: target, old_string: 'count = 0', new_string: 'count = 1' } }], stopReason: 'tool_use' })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Updated the counter.' }], stopReason: 'end_turn' })
    const engine = new QueryEngine({ client: { callModel } as unknown as ApiClient, tools: [FileReadTool, FileEditTool], model: 'test', smallModel: 'small', maxOutputTokens: 256, maxTurns: 5, cwd: dir, disableSessionPersistence: true, canUseTool: async () => ({ behavior: 'allow' as const }) })
    const result = await engine.submitMessage('Read the counter and change it to one.')
    expect(result.reason).toBe('completed')
    expect(readFileSync(target, 'utf8')).toContain('count = 1')
    expect(callModel).toHaveBeenCalledTimes(3)
    const lastToolResult = result.messages.find(message => message.role === 'user' && Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result'))
    expect(lastToolResult).toBeDefined()
  })
})
