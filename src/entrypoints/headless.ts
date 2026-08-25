import type { ApiConfig } from '../services/api/types.js'
import { ApiClient } from '../services/api/client.js'
import { QueryEngine } from '../QueryEngine.js'
import { getBuiltinTools } from '../tools.js'
import { createCanUseTool } from '../permissions/canUseTool.js'
import type { PermissionMode } from '../utils/permissions/settings.js'
import type { Message } from '../services/api/types.js'
export async function runHeadless(options: { prompt: string; cwd: string; outputFormat?: 'text'|'stream-json'; maxTurns?: number; permissionMode?: PermissionMode; config: ApiConfig }): Promise<{ reason: string; error?: string }> {
  const client = new ApiClient(options.config)
  const engine = new QueryEngine({ client, tools: getBuiltinTools(), model: options.config.model, smallModel: options.config.smallModel, models: options.config.models, maxOutputTokens: options.config.maxOutputTokens, maxTurns: options.maxTurns ?? 30, cwd: options.cwd, canUseTool: createCanUseTool({ mode: options.permissionMode ?? 'auto', rules: [], avoidPrompts: true }, { cwd: options.cwd, client, smallModel: options.config.smallModel }), disableSessionPersistence: true })
  const output = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n')
  const result = await engine.submitMessage(options.prompt, {
    onTextDelta: text => { if (options.outputFormat === 'stream-json') output({ type: 'stream_event', subtype: 'text_delta', text }); else process.stdout.write(text) },
    onToolStart: (name, input) => { if (options.outputFormat === 'stream-json') output({ type: 'tool_use', name, input }) },
    onToolEnd: (name, input, value, isError) => { if (options.outputFormat === 'stream-json') output({ type: 'tool_result', name, input, result: value, isError }) },
  })
  if (options.outputFormat === 'stream-json') {
    const assistant = [...result.messages].reverse().find(message => message.role === 'assistant') as Message | undefined
    if (assistant) output({ type: 'assistant_message', message: assistant })
    output({ type: 'result', reason: result.reason, error: result.error })
  } else {
    process.stdout.write('\n')
    if (result.reason === 'error' || result.reason === 'prompt_too_long') { process.stderr.write(`Error: ${result.error ?? result.reason}\n`); process.exitCode = 1 }
  }
  return result
}
