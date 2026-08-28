import type { BuiltTool, FileStateCache, ToolResultStore, ToolUseContext } from './Tool.js'
import { assistantBlocksForNextTurn } from './Tool.js'
import type { ApiClient } from './services/api/client.js'
import type { Message, SystemBlock, Usage } from './services/api/types.js'
import { UsageTracker } from './services/api/usage.js'
import { ModelManager } from './cli/modelManager.js'
import type { CanUseTool } from './query/runTools.js'
import type { PermissionContext } from './utils/permissions/permissions.js'
import type { PermissionMode } from './utils/permissions/settings.js'
import { createFileStateCache } from './utils/file/readFileState.js'
import type { HooksRegistry } from './services/hooks/types.js'
import { emptyRegistry, runHooks } from './services/hooks/index.js'
import { appendMessages, createSession, loadSession, replaceMessages } from './services/session/store.js'
import { compactConversation, reactiveCompactConversation, createAutoCompact, DEFAULT_CONTEXT_WINDOW, type CompactOptions, type CompactionState } from './services/compact/compact.js'
import { extractMemories } from './services/extractMemories/extract.js'
import { query, getFinalText, type QueryResult } from './query.js'
import { estimateContextTokens, prepareContext as prepareMessages } from './services/context/budget.js'
import { createToolResultStore } from './services/tool-results/store.js'

export interface QueryCallbacks {
  onTextDelta?: (text: string) => void
  onToolStart?: (name: string, input: unknown) => void
  onToolEnd?: (name: string, input: unknown, result: unknown, isError: boolean) => void
  onUsage?: (model: string, usage: Usage) => void
  onPlanPresented?: (plan: string) => Promise<boolean>
  onUserMessage?: (message: Message) => void
}
export interface QueryEngineOptions {
  client: ApiClient; tools: BuiltTool[]; systemPrompt?: string | SystemBlock[] | (() => string | SystemBlock[]); model: string; smallModel?: string; models?: Array<{ id: string; name?: string; maxOutputTokens?: number }>
  fallbackModel?: string; retryPolicy?: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number; jitterRatio?: number; retryStatuses?: readonly number[] }
  maxOutputTokens: number; maxTurns?: number; cwd: string; canUseTool: CanUseTool; createFileStateCache?: () => FileStateCache
  disableSessionPersistence?: boolean; sessionId?: string; startInPlanMode?: boolean
  hooks?: HooksRegistry; permCtx?: PermissionContext; memorySettings?: { autoMemoryDirectory?: string }; autoCompact?: (messages: Message[]) => Promise<Message[] | null>
}

function defaultFileState(): FileStateCache { return createFileStateCache() }

export class QueryEngine {
  private messages: Message[] = []
  private pendingQueue: Message[] = []
  private readonly modelManager: ModelManager
  private readonly usageTracker = new UsageTracker()
  private readonly readFileState: FileStateCache
  private readonly hooks: HooksRegistry
  private readonly autoCompact: (messages: Message[]) => Promise<Message[] | null>
  private readonly compactionState: CompactionState = { consecutiveFailures: 0 }
  private planMode: boolean
  private abortController = new AbortController()
  private planCallback?: (plan: string) => Promise<boolean>
  private turnSequence = 0
  private sessionId: string | null = null
  private resultStore: ToolResultStore
  constructor(private readonly opts: QueryEngineOptions) {
    this.modelManager = new ModelManager(opts.models, opts.model)
    this.readFileState = opts.createFileStateCache?.() ?? defaultFileState()
    this.hooks = opts.hooks ?? emptyRegistry()
    this.planMode = opts.startInPlanMode === true
    this.autoCompact = opts.autoCompact ?? createAutoCompact({ client: opts.client, model: opts.smallModel ?? opts.model, contextWindow: DEFAULT_CONTEXT_WINDOW, state: this.compactionState, hooks: this.compactHooks(), estimate: messages => estimateContextTokens(messages, typeof opts.systemPrompt === 'function' ? opts.systemPrompt() : opts.systemPrompt, opts.tools.map(tool => ({ name: tool.name, schema: tool.jsonSchema }))) })
    if (!opts.disableSessionPersistence) {
      if (opts.sessionId) { this.sessionId = opts.sessionId; this.messages = loadSession(opts.cwd, opts.sessionId).messages }
      else this.sessionId = createSession(opts.cwd, opts.model).id
    }
    this.resultStore = createToolResultStore(opts.cwd, this.sessionId ?? 'ephemeral')
    void runHooks(this.hooks, 'SessionStart', { cwd: opts.cwd }).catch(() => undefined)
  }
  private compactHooks(): CompactOptions['hooks'] {
    return {
      pre: async messages => { await runHooks(this.hooks, 'PreCompact', { cwd: this.opts.cwd, messages }) },
      post: async messages => { await runHooks(this.hooks, 'PostCompact', { cwd: this.opts.cwd, messages }) },
    }
  }
  private compactOptions(): CompactOptions { return { client: this.opts.client, model: this.opts.smallModel ?? this.modelManager.getModel(), state: this.compactionState, hooks: this.compactHooks() } }
  getMessages(): Message[] { return [...this.messages] }
  getContextTokens(): number { return JSON.stringify(this.messages).length / 4 }
  getUsageTracker(): UsageTracker { return this.usageTracker }
  getModelManager(): ModelManager { return this.modelManager }
  getSessionId(): string | null { return this.sessionId }
  async compactNow(): Promise<string> { const compacted = await compactConversation(this.messages, this.compactOptions()); if (!compacted) return 'Compaction failed or not enough conversation.'; const previous = this.messages.length; this.messages = compacted; if (this.sessionId) { try { replaceMessages(this.opts.cwd, this.sessionId, this.messages) } catch { /* persistence is non-fatal */ } } return `Compacted ${previous} messages → ${compacted.length}.` }
  async extractMemories(settings?: { autoMemoryDirectory?: string }): Promise<string> { const result = await extractMemories({ client: this.opts.client, smallModel: this.opts.smallModel ?? this.opts.model, messages: this.messages, cwd: this.opts.cwd, settings: settings ?? this.opts.memorySettings }); if (result.error) return `Memory extraction failed: ${result.error}`; return result.written.length ? `Wrote ${result.written.length} memor${result.written.length === 1 ? 'y' : 'ies'}: ${result.written.join(', ')}` : 'No new memories to save.' }
  getPermissionMode(): PermissionMode | null { return this.opts.permCtx?.mode ?? null }
  setPermissionMode(mode: PermissionMode): void { if (this.opts.permCtx) this.opts.permCtx.mode = mode }
  isPlanMode(): boolean { return this.planMode }
  enterPlanMode(): void { this.planMode = true }
  exitPlanMode(): void { this.planMode = false }
  setPlanApprovalCallback(callback?: (plan: string) => Promise<boolean>): void { this.planCallback = callback }
  toolsForCurrentMode(): BuiltTool[] {
    if (!this.planMode) return this.opts.tools.filter(tool => tool.name !== 'ExitPlanMode')
    return this.opts.tools.filter(tool => tool.name === 'ExitPlanMode' || (() => { try { return tool.isReadOnly?.({} as Record<string, unknown>) === true } catch { return false } })())
  }
  enqueueUserMessage(text: string): void { this.pendingQueue.push({ role: 'user', content: text }) }
  injectMessages(): Message[] { return this.pendingQueue.splice(0) }
  interrupt(): void { this.abortController.abort() }
  async submitMessage(prompt: string, callbacks: QueryCallbacks = {}): Promise<QueryResult> {
    const previousLength = this.messages.length
    this.abortController = new AbortController()
    try {
      const turnId = `${this.sessionId ?? 'ephemeral'}:${++this.turnSequence}`
      this.messages = [...this.messages, { role: 'user', content: prompt }]
      await runHooks(this.hooks, 'UserPromptSubmit', { cwd: this.opts.cwd, messages: this.messages, sessionId: this.sessionId, turnId }).catch(() => undefined)
      this.setPlanApprovalCallback(callbacks.onPlanPresented)
      const context: ToolUseContext = { abortController: this.abortController, readFileState: this.readFileState, cwd: this.opts.cwd, messages: this.messages, permissionContext: this.opts.permCtx, resultStore: this.resultStore, planApproval: async plan => { const approved = this.planCallback ? await this.planCallback(plan) : false; if (approved) this.planMode = false; return approved } }
      const result = await query(this.messages, {
        client: this.opts.client, tools: this.toolsForCurrentMode(), systemPrompt: this.opts.systemPrompt ?? [], model: this.modelManager.getModel(), fallbackModel: this.opts.fallbackModel, retryPolicy: this.opts.retryPolicy, maxOutputTokens: this.modelManager.getMaxOutputTokens(this.opts.maxOutputTokens), maxTurns: this.opts.maxTurns ?? 50, context, canUseTool: this.opts.canUseTool, autoCompact: this.autoCompact, reactiveCompact: messages => reactiveCompactConversation(messages, this.compactOptions()), compact: messages => compactConversation(messages, this.compactOptions()), prepareContext: messages => prepareMessages(messages),
        onTextDelta: callbacks.onTextDelta, onToolStart: callbacks.onToolStart, onToolEnd: callbacks.onToolEnd,
        onPreToolUse: async (name, input, toolUseId) => { const outcome = await runHooks(this.hooks, 'PreToolUse', { cwd: this.opts.cwd, toolName: name, input, sessionId: this.sessionId, turnId, toolUseId }, { failClosed: true }); return outcome },
        onPostToolUse: async (name, input, result, isError, toolUseId) => { await runHooks(this.hooks, 'PostToolUse', { cwd: this.opts.cwd, toolName: name, input, toolResult: result, isError, sessionId: this.sessionId, turnId, toolUseId }) },
        onUsage: (model, usage) => { this.usageTracker.add(model, usage); callbacks.onUsage?.(model, usage) },
        injectMessages: () => { const queued = this.injectMessages(); if (callbacks.onUserMessage) queued.forEach(callbacks.onUserMessage); return queued },
      })
      this.messages = result.messages
      if (this.sessionId) { try { if (result.contextCompacted) replaceMessages(this.opts.cwd, this.sessionId, this.messages); else appendMessages(this.opts.cwd, this.sessionId, this.messages.slice(previousLength)) } catch { /* persistence is non-fatal */ } }
      await runHooks(this.hooks, 'Stop', { cwd: this.opts.cwd, messages: this.messages, reason: result.reason }).catch(() => undefined)
      return result
    } finally {
      this.abortController = new AbortController()
    }
  }
  getFinalText(): string { return getFinalText(this.messages) }
  setModel(id: string): string | null { return this.modelManager.setModel(id) }
  clearConversation(): void { this.messages = []; this.pendingQueue = []; this.readFileState.clear(); this.compactionState.consecutiveFailures = 0; this.compactionState.lastFailure = undefined }
  newConversation(): void { this.clearConversation(); if (!this.opts.disableSessionPersistence) this.sessionId = createSession(this.opts.cwd, this.modelManager.getModel()).id; this.resultStore = createToolResultStore(this.opts.cwd, this.sessionId ?? 'ephemeral') }
  resumeSession(id: string): { count: number } | null { try { const loaded = loadSession(this.opts.cwd, id); if (!loaded.meta && loaded.messages.length === 0) return null; this.messages = loaded.messages; this.sessionId = id; this.resultStore = createToolResultStore(this.opts.cwd, id); this.compactionState.consecutiveFailures = 0; this.compactionState.lastFailure = undefined; this.readFileState.clear(); return { count: this.messages.length } } catch { return null } }
  async shutdown(): Promise<void> { await runHooks(this.hooks, 'SessionEnd', { cwd: this.opts.cwd, messages: this.messages }).catch(() => undefined) }
}
