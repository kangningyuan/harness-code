import React from 'react'
import { render } from 'ink-testing-library'
import { App } from '../../src/ink/App.js'
import { UsageTracker } from '../../src/services/api/usage.js'
import { deferred } from '../support/fakes.js'
import { waitFor } from '../support/fixtures.js'

function makeEngine(withPlan = false) {
  const modelManager = { getModel: () => 'test-model', listModels: () => [], setModel: vi.fn(() => null), getMaxOutputTokens: () => 32 }
  return {
    getContextTokens: () => 100,
    getModelManager: () => modelManager,
    getPermissionMode: () => 'default' as const,
    isPlanMode: () => false,
    getMessages: () => [],
    getSessionId: () => 'session-1',
    submitMessage: vi.fn(async (_prompt: string, callbacks?: { onPlanPresented?: (plan: string) => Promise<boolean> }) => {
      if (withPlan && callbacks?.onPlanPresented) await callbacks.onPlanPresented('plan text')
      return { reason: 'completed' as const, messages: [{ role: 'assistant' as const, content: [{ type: 'text' as const, text: 'done' }] }] }
    }),
    clearConversation: vi.fn(), compactNow: vi.fn(async () => 'Compacted'), extractMemories: vi.fn(async () => 'No new memories to save.'),
    setModel: vi.fn(() => null), enterPlanMode: vi.fn(), setPermissionMode: vi.fn(), newConversation: vi.fn(), resumeSession: vi.fn(() => null), interrupt: vi.fn(), shutdown: vi.fn(async () => undefined),
  }
}
function props(engine: ReturnType<typeof makeEngine>, permAskHolder?: { cb?: (tool: string, input: unknown, reason: string) => Promise<boolean> }) {
  const base = { engine: engine as any, cwd: '/tmp/project', costTracker: new UsageTracker(), config: { apiKey: 'secret', baseURL: 'https://example.test', model: 'test-model', smallModel: 'small-model', maxOutputTokens: 32, timeoutMs: 1_000 } }
  return permAskHolder ? { ...base, permAskHolder } : base
}

async function typeAndSubmit(app: ReturnType<typeof render>, text: string): Promise<void> {
  app.stdin.write(text); await new Promise(resolve => setTimeout(resolve, 10)); app.stdin.write('\r'); await new Promise(resolve => setTimeout(resolve, 20))
}

describe('Ink interaction contract', () => {
  it('submits input, renders the assistant response, and clears loading state', async () => {
    const engine = makeEngine(); const app = render(<App {...props(engine)} />)
    await typeAndSubmit(app, 'hello')
    await waitFor(() => engine.submitMessage.mock.calls.length === 1)
    expect(engine.submitMessage).toHaveBeenCalledWith('hello', expect.any(Object))
    expect(app.lastFrame()).toContain('done')
    expect(app.lastFrame()).toContain('/help for commands')
    app.unmount()
  })

  it('resolves an interactive permission prompt with n', async () => {
    const engine = makeEngine(); const holder: { cb?: (tool: string, input: unknown, reason: string) => Promise<boolean> } = {}
    const app = render(<App {...props(engine, holder)} />)
    await waitFor(() => holder.cb !== undefined)
    const pending = holder.cb!('Write', { file_path: 'x' }, 'confirm write')
    await waitFor(() => app.lastFrame()?.includes('Permission requested: Write') === true)
    app.stdin.write('n')
    await expect(pending).resolves.toBe(false)
    expect(app.lastFrame()).not.toContain('Permission requested: Write')
    app.unmount()
  })

  it('resolves a plan prompt with y and removes the plan gate', async () => {
    const engine = makeEngine(true); const app = render(<App {...props(engine)} />)
    // Exercise the callback through a submitted query so the dialog is user-visible.
    const pending = typeAndSubmit(app, 'work')
    await waitFor(() => engine.submitMessage.mock.calls.length === 1)
    await waitFor(() => app.lastFrame()?.includes('Proposed plan') === true)
    app.stdin.write('y')
    await pending
    await waitFor(() => app.lastFrame()?.includes('done') === true)
    expect(engine.submitMessage).toHaveBeenCalledOnce()
    app.unmount()
  })

  it('interrupts a busy request on /stop without submitting the command to the model', async () => {
    const engine = makeEngine(); const gate = deferred<void>()
    engine.submitMessage.mockImplementationOnce(async () => { await gate.promise; return { reason: 'aborted_streaming', messages: [] } as never })
    const app = render(<App {...props(engine)} />)
    app.stdin.write('long task'); await new Promise(resolve => setTimeout(resolve, 10)); app.stdin.write('\r'); await waitFor(() => engine.submitMessage.mock.calls.length === 1)
    app.stdin.write('/stop'); await new Promise(resolve => setTimeout(resolve, 10)); app.stdin.write('\r'); await new Promise(resolve => setTimeout(resolve, 10))
    expect(engine.interrupt).toHaveBeenCalledOnce()
    expect(engine.submitMessage).toHaveBeenCalledTimes(1)
    gate.resolve(undefined); await new Promise(resolve => setTimeout(resolve, 10)); app.unmount()
  })
})
