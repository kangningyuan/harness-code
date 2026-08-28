import { QueryEngine } from '../../src/QueryEngine.js'
import { buildTool } from '../../src/Tool.js'
import { ExitPlanModeTool } from '../../src/tools/ExitPlanModeTool/ExitPlanModeTool.js'
import type { ApiClient } from '../../src/services/api/client.js'

const read = buildTool<Record<string, unknown>, unknown>({ name: 'Read', inputJSONSchema: { type: 'object' }, maxResultSizeChars: 100, isReadOnly: () => true, call: async () => ({ data: 'ok' }), description: () => '', prompt: () => '', renderToolUseMessage: () => '' })
const write = buildTool<Record<string, unknown>, unknown>({ name: 'Write', inputJSONSchema: { type: 'object' }, maxResultSizeChars: 100, call: async () => ({ data: 'ok' }), description: () => '', prompt: () => '', renderToolUseMessage: () => '' })
function engine(): QueryEngine { return new QueryEngine({ client: {} as ApiClient, tools: [read, write, ExitPlanModeTool], model: 'test', smallModel: 'small', maxOutputTokens: 32, maxTurns: 1, cwd: process.cwd(), canUseTool: async () => ({ behavior: 'allow' as const }), disableSessionPersistence: true }) }
function context(planApproval?: (plan: string) => Promise<boolean>) { return { abortController: new AbortController(), cwd: process.cwd(), readFileState: { get: () => undefined, set: () => undefined, recordRead: () => undefined, clear: () => undefined }, planApproval } }

describe('plan mode', () => {
  it('filters to read-only tools and ExitPlanMode', () => {
    const queryEngine = engine()
    expect(queryEngine.toolsForCurrentMode().map(tool => tool.name)).toEqual(['Read', 'Write'])
    queryEngine.enterPlanMode()
    expect(queryEngine.toolsForCurrentMode().map(tool => tool.name)).toEqual(['Read', 'ExitPlanMode'])
  })
  it('leaves plan mode after approval and stays in plan mode after rejection', async () => {
    const approved = engine(); approved.enterPlanMode(); approved.setPlanApprovalCallback(async () => true)
    const approval = await ExitPlanModeTool.call({ plan: 'implement the change' }, context(async () => { approved.exitPlanMode(); return true }))
    expect(approval.data).toMatchObject({ approved: true })
    expect(approved.isPlanMode()).toBe(false)
    const rejected = engine(); rejected.enterPlanMode(); rejected.setPlanApprovalCallback(async () => false)
    const refusal = await ExitPlanModeTool.call({ plan: 'another plan' }, context(async () => false))
    expect(refusal.isError).toBe(true)
    expect(rejected.isPlanMode()).toBe(true)
  })
})
