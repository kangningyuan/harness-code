import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareContext, snipCompact, toolResultBudget } from '../../src/services/context/budget.js'
import { createToolResultStore, formatToolResultReference } from '../../src/services/tool-results/store.js'

describe('context budget', () => {
  it('compacts older tool results while retaining recent results', () => {
    const messages = [{ role: 'user' as const, content: [
      { type: 'tool_result' as const, tool_use_id: 'one', content: 'a'.repeat(100) },
      { type: 'tool_result' as const, tool_use_id: 'two', content: 'b'.repeat(100) },
      { type: 'tool_result' as const, tool_use_id: 'three', content: 'c'.repeat(100) },
    ] }]
    const result = toolResultBudget(messages, 150, 1)
    const content = result[0]?.content
    expect(JSON.stringify(content)).toContain('Earlier tool result compacted')
    expect(JSON.stringify(content)).toContain('c'.repeat(100))
    expect(JSON.stringify(messages)).toContain('a'.repeat(100))
  })

  it('snips message history without losing the head and tail', () => {
    const messages = Array.from({ length: 60 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: `message-${index}` }))
    const result = snipCompact(messages, 10)
    expect(result.length).toBeLessThanOrEqual(10)
    expect(JSON.stringify(result)).toContain('message-0')
    expect(JSON.stringify(result)).toContain('message-59')
    expect(JSON.stringify(result)).toContain('snipped')
  })

  it('persists large output and returns a bounded reference', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-tool-results-'))
    try {
      const store = createToolResultStore(dir, 'session', 10)
      const content = '0123456789abcdef'.repeat(1_000)
      const reference = store.persist(content, { toolUseId: 'call-1', toolName: 'BashTool' })
      expect(reference).not.toBeNull()
      expect(existsSync(join(dir, reference!.relativePath))).toBe(true)
      expect(readFileSync(join(dir, reference!.relativePath), 'utf8')).toBe(content)
      expect(formatToolResultReference(reference!).length).toBeLessThan(content.length)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('prepareContext is safe below its message limit', () => {
    const messages = [{ role: 'user' as const, content: 'hello' }]
    expect(prepareContext(messages)).toEqual(messages)
  })
})
