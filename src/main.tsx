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
import { createTaskService } from './services/tasks/service.js'
import { createTaskTools } from './tools/TaskTools.js'
import { createWorktreeService } from './services/worktree/service.js'
import { createWorktreeTools } from './tools/WorktreeTools.js'
import { AgentManager, type AgentRunRequest, type AgentResult } from './services/agents/agentManager.js'
import { createAgentTool } from './tools/AgentTool/AgentTool.js'
import type { BuiltTool } from './Tool.js'
import { MessageBus, ProtocolRequestStore } from './services/protocol/index.js'
import { TeammateManager } from './services/agents/teammateManager.js'
import { createProtocolTools } from './tools/ProtocolTools.js'
import { McpRegistry } from './services/mcp/registry.js'

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
  const permCtx = permissionContextFromSettings(settings, mode)
  const taskService = createTaskService(cwd)
  const recoveredTasks = taskService.reconcile()
  const worktreeService = createWorktreeService(cwd, undefined, taskService)
  const orphanedWorktrees = worktreeService.reconcile()
  if (recoveredTasks.length) process.stderr.write(`[tasks] recovered ${recoveredTasks.length} expired lease(s)\n`)
  if (orphanedWorktrees.length) process.stderr.write(`[worktrees] found ${orphanedWorktrees.length} orphaned record(s)\n`)
  const client = new ApiClient(config)
  const hooks = createHooksRegistry(loadHooksFromSettings(settings.hooks))
  const mcpRegistry = new McpRegistry()
  const mcpTools = await mcpRegistry.connect(settings.mcpServers)
  const messageBus = new MessageBus(cwd)
  const requestStore = new ProtocolRequestStore(cwd)
  let toolPool: BuiltTool[] = []
  let teammateManager: TeammateManager | undefined
  const agentManager: AgentManager = new AgentManager(async (request: AgentRunRequest): Promise<Omit<AgentResult, 'agentId'>> => {
    const childTools = toolPool.filter(tool => tool.name !== 'AgentTool')
    const childPermissions = { mode: permCtx.mode, rules: [...permCtx.rules], avoidPrompts: true }
    const child = new QueryEngine({
      client, tools: childTools, model: config.model, smallModel: config.smallModel, models: config.models,
      fallbackModel: config.fallbackModel, retryPolicy: { maxAttempts: config.maxRetries, baseDelayMs: config.retryBaseDelayMs },
      agentId: request.agentId, scopeSessionId: request.parentSessionId, maxOutputTokens: config.maxOutputTokens, maxTurns: request.maxTurns ?? 20,
      cwd: request.cwd, incomingMessages: () => messageBus.consume(request.agentId ?? 'unknown', request.parentSessionId ?? 'ephemeral').map(message => ({ role: 'user' as const, content: `<inbox message_id="${message.messageId}" type="${message.type}">\n${message.payload}\n</inbox>` })), beforeModel: () => teammateManager?.waitIfPaused(request.agentId ?? '') ?? Promise.resolve(), taskService, worktreeService, permCtx: childPermissions,
      canUseTool: createCanUseTool(childPermissions, { cwd: request.cwd, client, smallModel: config.smallModel }),
      systemPrompt: () => fetchSystemPromptParts({ cwd: request.cwd, tools: childTools, memorySettings: { autoMemoryDirectory: settings.autoMemoryDirectory } }),
      hooks, loadBackgroundTasks: false, disableSessionPersistence: true,
    })
    const onAbort = () => child.interrupt()
    request.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const result = await child.submitMessage(request.prompt)
      const summary = child.getFinalText() || (result.reason === 'completed' ? 'Agent completed without a text summary.' : '')
      return { status: result.reason === 'completed' ? 'completed' : request.signal?.aborted ? 'cancelled' : 'failed', summary, error: result.error }
    } finally {
      request.signal?.removeEventListener('abort', onAbort)
      await child.shutdown()
    }
  })
  teammateManager = new TeammateManager(agentManager, messageBus, requestStore, worktreeService)
  const tools = getBuiltinTools([...createTaskTools(taskService), ...createWorktreeTools(worktreeService), ...createProtocolTools(teammateManager!), ...mcpTools], { agentTool: createAgentTool({ agentManager, worktreeService }) })
  toolPool = tools
  const memorySettings = { autoMemoryDirectory: settings.autoMemoryDirectory }
  if (options.print || promptArg) {
    if (!promptArg) { process.stderr.write('--print requires a prompt argument.\n'); process.exitCode = 1; return }
    await runHeadless({ prompt: promptArg, cwd, outputFormat, maxTurns: options.maxTurns as number | undefined, permissionMode: mode, permissionContext: permCtx, memorySettings, taskService, worktreeService, agentManager, teammateManager, messageBus, mcpRegistry, config })
    return
  }
  const permAskHolder: { cb?: (tool: string, input: unknown, reason: string) => Promise<boolean> } = {}
  if (typeof options.resume === 'string' && !listSessions(cwd).some(session => session.id === options.resume)) { process.stderr.write(`Session not found: ${options.resume}\n`); process.exitCode = 1; return }
  const requestedSessionId = options.resume === undefined ? undefined : typeof options.resume === 'string' ? options.resume : listSessions(cwd)[0]?.id
  let parentEngine: QueryEngine | undefined
  const engine = new QueryEngine({
    client, tools, model: config.model, smallModel: config.smallModel, models: config.models, maxOutputTokens: config.maxOutputTokens,
    fallbackModel: config.fallbackModel, retryPolicy: { maxAttempts: config.maxRetries, baseDelayMs: config.retryBaseDelayMs },
    maxTurns: (options.maxTurns as number | undefined) ?? 50, cwd, incomingMessages: () => messageBus.consume('lead', parentEngine?.getSessionId() ?? requestedSessionId ?? 'ephemeral').map(message => ({ role: 'user' as const, content: `<inbox message_id="${message.messageId}" type="${message.type}">\n${message.payload}\n</inbox>` })), permCtx,
    canUseTool: createCanUseTool(permCtx, { cwd, client, smallModel: config.smallModel, onAsk: (tool, input, reason) => permAskHolder.cb?.(tool.name, input, reason) ?? Promise.resolve(false) }),
    systemPrompt: () => fetchSystemPromptParts({ cwd, tools, memorySettings }), hooks,
    memorySettings, taskService, worktreeService, backgroundManager: undefined, agentManager, messageBus, teammateManager, startInPlanMode: options.plan === true, sessionId: requestedSessionId,
  })
  parentEngine = engine
  launchRepl(engine, cwd, engine.getUsageTracker(), config, permAskHolder, memorySettings)
})

program.parseAsync(process.argv).catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
