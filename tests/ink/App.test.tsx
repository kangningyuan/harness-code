import React from 'react'
import { render } from 'ink-testing-library'
import { App } from '../../src/ink/App.js'
import { UsageTracker } from '../../src/services/api/usage.js'

describe('Ink App', () => {
  function makeEngine() {
    const modelManager = { getModel: () => 'test-model', listModels: () => [], setModel: vi.fn(() => null), getMaxOutputTokens: () => 32 }
    return {
      getContextTokens: () => 100,
      getModelManager: () => modelManager,
      getPermissionMode: () => 'default' as const,
      isPlanMode: () => false,
      getMessages: () => [],
      getSessionId: () => 'session-1',
      submitMessage: vi.fn(async () => ({ reason: 'completed' as const, messages: [{ role: 'assistant' as const, content: [{ type: 'text' as const, text: 'done' }] }] })),
      clearConversation: vi.fn(),
      compactNow: vi.fn(async () => 'Compacted'),
      extractMemories: vi.fn(async () => 'No new memories to save.'),
      setModel: vi.fn(() => null),
      enterPlanMode: vi.fn(),
      setPermissionMode: vi.fn(),
      newConversation: vi.fn(),
      resumeSession: vi.fn(() => null),
      interrupt: vi.fn(),
      shutdown: vi.fn(async () => undefined),
    }
  }
  function props(engine: ReturnType<typeof makeEngine>) {
    return { engine: engine as any, cwd: '/tmp/project', costTracker: new UsageTracker(), config: { apiKey: 'secret', baseURL: 'https://example.test', model: 'test-model', smallModel: 'small-model', maxOutputTokens: 32, timeoutMs: 1000 } }
  }
  it('renders the footer below the input and accepts Unicode-safe input', async () => {
    const engine = makeEngine(); const app = render(<App {...props(engine)} />)
    expect(app.lastFrame()).toContain('ctx:')
    expect(app.lastFrame()).toContain('❯')
    app.stdin.write('你好')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(app.lastFrame()).toContain('你好')
    const frame = app.lastFrame() ?? ''
    expect(frame.indexOf('ctx:')).toBeGreaterThan(frame.indexOf('❯ 你好'))
    app.unmount()
  })
  it('keeps a clean initial transcript and exposes the command hint', () => {
    const engine = makeEngine(); const app = render(<App {...props(engine)} />)
    expect(app.lastFrame()).toContain('/help for commands')
    expect(engine.submitMessage).not.toHaveBeenCalled()
    app.unmount()
  })
})
