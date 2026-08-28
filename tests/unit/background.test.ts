import { buildTool } from '../../src/Tool.js'
import { runTools } from '../../src/query/runTools.js'
import { BackgroundTaskManager } from '../../src/services/background/manager.js'

describe('background tasks', () => {
  it('runs a task and emits exactly one completion notification', async () => {
    const manager = new BackgroundTaskManager()
    const events: string[] = []
    manager.subscribe(event => events.push(event.type))
    const task = manager.start({
      correlation: { sessionId: 'session', turnId: 'turn', toolUseId: 'call-1' },
      toolName: 'BashTool', cwd: process.cwd(), command: 'test',
      run: async () => { await new Promise(resolve => setTimeout(resolve, 5)); return { result: { data: 'done', result: 'done' } } },
    })
    expect(task.status).toBe('running')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(manager.get(task.id)?.status).toBe('completed')
    expect(events).toEqual(['started', 'completed'])
    const first = manager.drainNotifications('session')
    expect(first).toHaveLength(1)
    expect(manager.drainNotifications('session')).toEqual([])
  })

  it('cancels a running task', async () => {
    const manager = new BackgroundTaskManager()
    const task = manager.start({ correlation: { sessionId: 'session', turnId: 'turn' }, toolName: 'BashTool', cwd: process.cwd(), run: async signal => {
      await new Promise(resolve => setTimeout(resolve, 30))
      return { result: { data: signal.aborted ? 'aborted' : 'done', result: signal.aborted ? 'aborted' : 'done' } }
    } })
    expect(manager.cancel(task.id)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(manager.get(task.id)?.status).toBe('cancelled')
  })

  it('returns a paired placeholder and executes Bash in the manager', async () => {
    const manager = new BackgroundTaskManager()
    const call = vi.fn(async () => ({ data: 'done', result: 'done' }))
    const tool = buildTool({ name: 'BashTool', inputJSONSchema: { type: 'object', properties: { run_in_background: { type: 'boolean' } } }, maxResultSizeChars: 100, isConcurrencySafe: () => false, call, description: () => '', prompt: () => '', renderToolUseMessage: () => '' })
    const result = await runTools([{ type: 'tool_use', id: 'call-bg', name: 'BashTool', input: { run_in_background: true } }], [tool], { abortController: new AbortController(), cwd: process.cwd(), readFileState: { get: () => undefined, set: () => undefined, recordRead: () => undefined, clear: () => undefined }, correlation: { sessionId: 'session', turnId: 'turn' } }, { backgroundManager: manager, canUseTool: async () => ({ behavior: 'allow' as const }) })
    const block = (result[0]?.content as Array<{ content?: string }>)[0]
    expect(block?.content).toContain('Background task')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(call).toHaveBeenCalledTimes(1)
  })
})
