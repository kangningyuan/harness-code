import { buildTool, textToolResult } from '../../Tool.js'
export type AskHandler = (questions: unknown[]) => Promise<Record<string, string>>
let handler: AskHandler | undefined
export function setAskHandler(value?: AskHandler): void { handler = value }
export const AskUserQuestionTool = buildTool<Record<string, unknown>, unknown>({ name: 'AskUserQuestionTool', inputJSONSchema: { type: 'object', properties: { questions: { type: 'array' } }, required: ['questions'] }, maxResultSizeChars: 5_000, isReadOnly: () => true,
  async call(input) { const questions = Array.isArray(input.questions) ? input.questions as Array<{ question?: string; options?: Array<{ label?: string }> }> : []; if (handler) { const answers = await handler(questions); return { data: answers, result: JSON.stringify(answers) } }; const answers: Record<string, string> = {}; questions.forEach((question, index) => { answers[String(index + 1)] = question.options?.[0]?.label ?? '' }); return { data: answers, result: JSON.stringify(answers) } },
  description: () => 'ask user', prompt: () => 'Ask the user clarifying questions.', mapToolResultToToolResultBlockParam: textToolResult, renderToolUseMessage: () => 'questions'
})
