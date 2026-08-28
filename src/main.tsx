import { Command } from 'commander'
import { resolve } from 'node:path'
import { discoverConfigFile, writeTemplateConfig } from './cli/configFile.js'
import { resolveConfig } from './cli/config.js'
import { discoverSettings, resolveSettings, permissionContextFromSettings, type PermissionMode } from './utils/permissions/settings.js'
import { ApiClient } from './services/api/client.js'
import { getBuiltinTools } from './tools.js'
import { QueryEngine } from './QueryEngine.js'
import { createCanUseTool } from './permissions/canUseTool.js'
import { runHeadless } from './entrypoints/headless.js'
import { launchRepl } from './ink/App.js'
import { fetchSystemPromptParts } from './context.js'
import { createHooksRegistry, loadHooksFromSettings } from './services/hooks/index.js'
import { listSessions } from './services/session/store.js'

const program = new Command()
  .name('harness-code')
  .description('A full-featured terminal coding agent')
  .version('0.1.0')
  .argument('[prompt]', 'optional prompt')
  .option('-p, --print', 'run in headless mode')
  .option('--output-format <format>', 'text or stream-json', 'text')
  .option('--model <model>')
  .option('--api-key <key>')
  .option('--base-url <url>')
  .option('--max-turns <n>', 'max turns', value => Number.parseInt(value, 10))
  .option('--permission-mode <mode>')
  .option('--dangerously-skip-permissions')
  .option('-r, --resume [id]')
  .option('--plan')
  .option('--init-config')

program.action(async (promptArg: string | undefined, options: Record<string, unknown>) => {
  const cwd = resolve(process.cwd())
  if (options.initConfig) { process.stdout.write(`Wrote ${writeTemplateConfig(cwd)}\n`); return }
  const file = discoverConfigFile(cwd)
  const settings = resolveSettings(discoverSettings(cwd))
  const config = resolveConfig({ apiKey: options.apiKey as string | undefined, baseURL: options.baseUrl as string | undefined, model: options.model as string | undefined }, { configFile: file.config, configFilePath: file.path, settings })
  if (!config.apiKey) { process.stderr.write('Error: no API key.\n'); process.exitCode = 1; return }
  const outputFormatValue = options.outputFormat as string
  if (outputFormatValue !== 'text' && outputFormatValue !== 'stream-json') { process.stderr.write(`Invalid output format: ${outputFormatValue}\n`); process.exitCode = 1; return }
  const outputFormat = outputFormatValue as 'text' | 'stream-json'
  const requestedPermissionMode = options.permissionMode as string | undefined
  if (requestedPermissionMode && !['default', 'auto', 'bypassPermissions'].includes(requestedPermissionMode)) { process.stderr.write(`Invalid permission mode: ${requestedPermissionMode}\n`); process.exitCode = 1; return }
  const mode: PermissionMode = options.dangerouslySkipPermissions ? 'bypassPermissions' : (requestedPermissionMode as PermissionMode | undefined) ?? settings.permissions?.defaultMode ?? 'default'
  if (options.print || promptArg) {
    if (!promptArg) { process.stderr.write('--print requires a prompt argument.\n'); process.exitCode = 1; return }
    await runHeadless({ prompt: promptArg, cwd, outputFormat, maxTurns: options.maxTurns as number | undefined, permissionMode: mode, permissionContext: permissionContextFromSettings(settings, mode), memorySettings: { autoMemoryDirectory: settings.autoMemoryDirectory }, config })
    return
  }
  const client = new ApiClient(config)
  const tools = getBuiltinTools()
  const permCtx = permissionContextFromSettings(settings, mode)
  const permAskHolder: { cb?: (tool: string, input: unknown, reason: string) => Promise<boolean> } = {}
  if (typeof options.resume === 'string' && !listSessions(cwd).some(session => session.id === options.resume)) { process.stderr.write(`Session not found: ${options.resume}\n`); process.exitCode = 1; return }
  const requestedSessionId = options.resume === undefined ? undefined : typeof options.resume === 'string' ? options.resume : listSessions(cwd)[0]?.id
  const engine = new QueryEngine({
    client, tools, model: config.model, smallModel: config.smallModel, models: config.models, maxOutputTokens: config.maxOutputTokens,
    fallbackModel: config.fallbackModel, retryPolicy: { maxAttempts: config.maxRetries, baseDelayMs: config.retryBaseDelayMs },
    maxTurns: (options.maxTurns as number | undefined) ?? 50, cwd, permCtx,
    canUseTool: createCanUseTool(permCtx, { cwd, client, smallModel: config.smallModel, onAsk: (tool, input, reason) => permAskHolder.cb?.(tool.name, input, reason) ?? Promise.resolve(false) }),
    systemPrompt: () => fetchSystemPromptParts({ cwd, tools, memorySettings: { autoMemoryDirectory: settings.autoMemoryDirectory } }), hooks: createHooksRegistry(loadHooksFromSettings(settings.hooks)),
    memorySettings: { autoMemoryDirectory: settings.autoMemoryDirectory }, startInPlanMode: options.plan === true, sessionId: requestedSessionId,
  })
  launchRepl(engine, cwd, engine.getUsageTracker(), config, permAskHolder, { autoMemoryDirectory: settings.autoMemoryDirectory })
})

program.parseAsync(process.argv).catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
