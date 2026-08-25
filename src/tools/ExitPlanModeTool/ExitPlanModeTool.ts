import { z } from 'zod'
import { buildTool, textToolResult } from '../../Tool.js'
let approvalHandler: ((plan: string) => Promise<boolean>) | null = null
export function setPlanApprovalHandler(handler: ((plan: string) => Promise<boolean>) | null): void { approvalHandler = handler }
export const ExitPlanModeTool = buildTool<Record<string, unknown>, unknown>({ name: 'ExitPlanMode', inputSchema: z.object({ plan: z.string().min(1) }), maxResultSizeChars: 10_000, isReadOnly: () => true,
  async call(input) { const plan = String(input.plan); if (!approvalHandler) { process.stderr.write(`[plan]${plan}[/plan]\n(no approval handler — rejecting)\n`); return { data: { approved: false }, result: 'Plan rejected: no approval handler', isError: true } } const approved = await approvalHandler(plan); return approved ? { data: { approved: true }, result: 'Plan approved. You may now implement it using all available tools.' } : { data: { approved: false }, result: 'Plan rejected by the user. Revise the plan and call ExitPlanMode again.', isError: true } },
  description: () => 'present plan', prompt: () => 'Submit a plan for user approval before implementation.', mapToolResultToToolResultBlockParam: textToolResult, renderToolUseMessage: () => 'present plan'
})
