import { BashTool } from '../../src/tools/BashTool/BashTool.js'
import { runTools } from '../../src/query/runTools.js'
import { BackgroundTaskManager } from '../../src/services/background/manager.js'

describe('Bash background execution', () => {
  it('returns a paired placeholder while the process runs', async () => {
    const manager = new BackgroundTaskManager()
    const result = await runTools([{ type: 'tool_use', id: 'call-bg-real', name: 'BashTool', input: { command: 'sleep 0.05; printf done', run_in_background: true } }], [BashTool], { abortController: new AbortController(), cwd: process.cwd(), readFileState: { get: () => undefined, set: () => undefined, recordRead: () => undefined, clear: () => undefined }, correlation: { sessionId: 's', turnId: 't' } }, { backgroundManager: manager, canUseTool: async () => ({ behavior: 'allow' as const }) })
    expect(String((result[0]?.content as Array<{ content?: unknown }>)[0]?.content)).toContain('Background task')
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(manager.list('s').some(task => task.status === 'completed' && task.summary?.includes('done'))).toBe(true)
  })
})
