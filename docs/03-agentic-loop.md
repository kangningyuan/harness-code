# 核心 Agent 循环

> 基于 `src/query.ts` (~275 行) + `src/query/runTools.ts` (~254 行) + `src/query/abort.ts` (~51 行) + `src/QueryEngine.ts` (~413 行) 实际源码。

## 1. 架构分层

Agent 循环分两层：

```
QueryEngine (会话级，src/QueryEngine.ts)
   ├── 持有 messages[]、modelManager、permCtx、hooks、sessionId
   ├── submitMessage(prompt, callbacks)  ← 每个用户消息触发一次
   │     ├── 追加 user message
   │     ├── UserPromptSubmit hook
   │     ├── 注入 plan 审批 UI 回调
   │     ├── 调用 query(messages, deps)
   │     ├── 采纳 result.messages，持久化新消息
   │     ├── Stop hook
   │     └── 回调 onExit
   │
   └── query() (单轮级，src/query.ts)
         └── while(true) ReAct 循环
```

- **QueryEngine**：跨多轮对话的编排器。管理历史、模型切换、plan 模式、会话持久化、非阻塞输入队列、hooks 触发。
- **query()**：单次 `submitMessage` 内的 ReAct while 循环。流式 callModel → 累加 → 无 tool_use 则返回 → 有则 runTools → 追加 → 继续。

> **与 Claude Code 差异：** 工具在流式完成后才执行（**无** StreamingToolExecutor / 无 streaming tool use）。并发安全工具仍在 `runTools` 内并行，但整体是"先流完再跑工具"——正确性优先于性能。源码 `query.ts` 头部注释明确："v1 note: tools run AFTER the stream completes (no StreamingToolExecutor) — correctness over performance."

## 2. `query()` 主循环

```typescript
export async function query(initialMessages: Message[], deps: QueryDeps): Promise<QueryResult> {
  let messages = [...initialMessages]
  let turnCount = 0
  let maxOutputTokenRecoveries = 0
  let maxOutputTokensOverride: number | undefined

  while (true) {
    // [1] turn 守卫
    if (turnCount >= deps.maxTurns) return { reason: 'max_turns', messages }

    // [2] autoCompact（阈值满足则压缩）
    if (deps.autoCompact) {
      const compacted = await deps.autoCompact(messages).catch(() => null)
      if (compacted) messages = compacted
    }

    // [3] 注入排队用户消息（非阻塞输入）
    if (deps.injectMessages) {
      const queued = deps.injectMessages()
      if (queued.length > 0) messages = [...messages, ...queued]
    }

    // [4] callModel（流式）
    let result
    try {
      result = await deps.client.callModel(
        {
          model: deps.model,
          messages,
          system: deps.systemPrompt,
          tools: deps.tools.map(t => ({ name: t.name, description: t.prompt(), input_schema: t.jsonSchema })),
          max_tokens: maxOutputTokensOverride ?? deps.maxOutputTokens,
        },
        {
          onEvent: (e) => {
            deps.onStreamEvent?.(e)
            if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') {
              deps.onTextDelta?.(e.delta.text)   // → UI 实时流式文本
            }
          },
          signal: deps.context.abortController.signal,
        },
      )
    } catch (e) {
      // [4a] 错误恢复（见 §4）
    }

    turnCount++

    // [5] 上报本轮 usage（→ UsageTracker → /cost + footer）
    if (result.usage) deps.onUsage?.(deps.model, result.usage)

    // [6] 追加 assistant turn（丢弃 thinking/redacted 块）
    const assistantBlocks = result.content
    const nextTurnBlocks = assistantBlocksForNextTurn(assistantBlocks)  // 只留 text + tool_use
    messages = [...messages, { role: 'assistant', content: nextTurnBlocks }]

    // [7] 收集 tool_use 块
    const toolUseBlocks = assistantBlocks.filter(b => b.type === 'tool_use')

    // [8] 无 tool_use → 判 stop_reason 返回
    if (toolUseBlocks.length === 0) {
      if (result.stopReason === 'end_turn' || result.stopReason === 'stop_sequence') {
        return { reason: 'completed', messages }
      }
      if (result.stopReason === 'max_tokens') {
        // 模型未说完；注入 "Continue" 重试（≤3 次）
        if (maxOutputTokenRecoveries < MAX_OUTPUT_TOKEN_RECOVERIES) {
          maxOutputTokenRecoveries++
          messages = [...messages, { role: 'user', content: 'Continue from where you left off.' }]
          continue
        }
        return { reason: 'completed', messages }
      }
      return { reason: 'completed', messages }   // pause_turn 或 null
    }

    // [9] 执行工具
    let toolResultMessages: Message[]
    try {
      toolResultMessages = await runTools(toolUseBlocks, deps.tools, deps.context, runToolsOptions)
    } catch (e) {
      // [9a] 中断 / 工具错误：合成缺失 tool_result（见 §5）
    }

    // [10] 追加 tool_result，继续循环
    messages = [...messages, ...toolResultMessages]
  }
}
```

### 2.1 `QueryDeps`

```typescript
interface QueryDeps {
  client: ApiClient
  tools: BuiltTool[]
  systemPrompt: MessageCreateParams['system']   // SystemBlock[]（首块带 cache_control）
  model: string
  maxOutputTokens: number
  maxTurns: number                               // 默认 REPL 50 / headless 30
  context: ToolUseContext                        // abortController + readFileState + cwd + messages
  canUseTool: CanUseTool
  autoCompact?: (messages: Message[]) => Promise<Message[] | null>
  hooks?: HooksRegistry
  hooksCwd?: string
  hooksLog?: (msg: string) => void
  onStreamEvent?: (event: unknown) => void
  onTextDelta?: (text: string) => void           // UI 实时文本
  onToolStart?: (toolName: string, input: unknown) => void
  onToolEnd?: (toolName: string, input: unknown, result: unknown, isError: boolean) => void
  onUsage?: (model: string, usage: Usage) => void
  injectMessages?: () => Message[]               // 非阻塞输入注入
}
```

### 2.2 退出原因

```typescript
type QueryExitReason =
  | 'completed'
  | 'aborted_streaming'    // 流式中断
  | 'aborted_tools'        // 工具执行中中断
  | 'max_turns'
  | 'prompt_too_long'
  | 'error'

interface QueryResult { reason: QueryExitReason; messages: Message[]; error?: string }
```

### 2.3 `getFinalText`

```typescript
export function getFinalText(messages: Message[]): string {
  // 从末尾往前找第一个 assistant 消息，返回其 text 块拼接
}
```

## 3. `runTools()` — 工具批量执行

```typescript
export async function runTools(blocks: ToolUseBlock[], tools: BuiltTool[], context: ToolUseContext, options: RunToolsOptions): Promise<Message[]>
```

### 3.1 并发分区（fail-closed）

```typescript
const resolved = blocks.map(b => ({ block: b, tool: findTool(tools, b.name) }))
const unknowns = resolved.filter(r => !r.tool)                    // 未知工具
const known = resolved.filter(r => r.tool)
const safe = known.filter(r => r.tool.isConcurrencySafe?.(r.block.input) ?? false)   // 并行
const unsafe = known.filter(r => !(r.tool.isConcurrencySafe?.(r.block.input) ?? false))  // 串行
```

- `isConcurrencySafe` 默认 `false`（`buildTool` 注入）→ 除非工具显式返回 true，否则串行。
- 未知工具：立即生成 error tool_result `Unknown tool: <name>`。
- safe 工具：`Promise.all` 并行。
- unsafe 工具：按顺序串行。
- 最后按原始 block 顺序重排结果（确定性输出）。

返回**单个** user message，content 为所有 tool_result 块数组（API 接受一轮多个 tool_result）。

### 3.2 `executeOne` — 单工具执行流水线

```
validateWithSchema (Zod safeParse)         ← 失败 → error tool_result
   │ (MCP 工具用 inputJSONSchema，跳过 Zod)
   ▼
tool.validateInput (工具自定义)             ← 失败 → error tool_result
   ▼
PreToolUse hooks
   ├── decision='block'  → error tool_result "Blocked by PreToolUse hook: <reason>"
   └── decision='approve' → hookApproved=true（跳过权限 ask）
   ▼
权限检查 (canUseTool)                       ← hookApproved 时跳过
   └── deny → error tool_result "Permission denied: <reason>"
   ▼
onToolStart(name, input)                    ← UI 回调
   ▼
tool.call(input, context)                   ← try/catch，异常转 error result
   ▼
onToolEnd(name, input, result, isError)     ← UI 回调
   ▼
PostToolUse hooks (observe-only, .catch 吞错)
   ▼
结果截断 (maxResultSizeChars)               ← Infinity 表示永不截断
   │ Number.isFinite 守卫：超长则截断 + "... (truncated, N chars omitted)"
   ▼
tool.mapToolResultToToolResultBlockParam(result, block.id)
```

### 3.3 `CanUseTool` 回调

```typescript
type CanUseTool = (tool: BuiltTool, input: Record<string, unknown>) => Promise<CanUseToolResult>
interface CanUseToolResult { behavior: 'allow' | 'deny'; message?: string }
```

由 `permissions/canUseTool.ts` 的 `createCanUseTool` 创建，封装权限决策管线（见 [05-permission-and-hooks.md](./05-permission-and-hooks.md)）。`ask` 在 auto 模式走分类器，在 default 模式走交互 `onAsk` 回调（REPL 的 y/n 对话框）。

## 4. 错误恢复（渐进式降级）

`callModel` catch 块：

```typescript
catch (e) {
  if (e instanceof RequestAbortedError) {
    return { reason: 'aborted_streaming', messages }   // 流式前中断
  }
  if (e instanceof ApiError) {
    if (e.isPromptTooLong) {                            // 413 / prompt_too_long
      if (deps.autoCompact) {
        const compacted = await deps.autoCompact(messages).catch(() => null)
        if (compacted) { messages = compacted; continue }   // 压缩后重试一次
      }
      return { reason: 'prompt_too_long', messages, error: e.message }
    }
    if (e.isMaxOutputTokens) {                          // max_output_tokens / output_length
      if (maxOutputTokensOverride === undefined) {
        maxOutputTokensOverride = 64_000                // 第一次：升级到 64k
        continue
      }
      if (maxOutputTokenRecoveries < 3) {
        maxOutputTokenRecoveries++
        messages = [...messages, { role: 'user', content: 'Continue from where you left off.' }]
        continue                                        // 最多 3 次 mid-thought 恢复
      }
    }
    return { reason: 'error', messages, error: e.message }
  }
  return { reason: 'error', messages, error: (e as Error).message }
}
```

常量：
```typescript
const MAX_OUTPUT_TOKENS_ESCALATION = 64_000
const MAX_OUTPUT_TOKEN_RECOVERIES = 3
```

> **与 Claude Code 差异：** `prompt_too_long` 只尝试压缩**一次**就放弃（无 context collapse / 无 reactive compact 多级）。`max_output_tokens` 升级到 64k 后最多 3 次 "Continue" 恢复。

## 5. 中断协议 (`query/abort.ts`)

Anthropic API 要求每个 `tool_use` 在下一轮有配对的 `tool_result`。中断时模型可能已发出孤儿 `tool_use`。

### 5.1 流式中断 (`aborted_streaming`)

`callModel` 在流被 abort 时，若已累积了部分内容，**返回部分结果**（`StreamAccumulator.finalize()`）而非抛错；若未产出可用内容则抛 `RequestAbortedError`。`query()` catch 到 `RequestAbortedError` 直接返回 `aborted_streaming`（此时无 tool_use 需配对）。

### 5.2 工具执行中断 (`aborted_tools`)

```typescript
catch (e) {
  if (e instanceof RequestAbortedError || deps.context.abortController.signal.aborted) {
    const synth = yieldMissingToolResultBlocks(assistantBlocks, [])
    if (synth) messages = [...messages, synth]
    return { reason: 'aborted_tools', messages }
  }
  // 工具执行错误（非中断）：合成 error 结果，继续循环
  const synth = yieldMissingToolResultBlocks(assistantBlocks, [])
  if (synth) messages = [...messages, synth]
  continue
}
```

### 5.3 `yieldMissingToolResultBlocks`

```typescript
export function yieldMissingToolResultBlocks(
  assistantContent: ContentBlock[],
  existingResults: ToolResultBlock[] = [],
): Message | null {
  // 找出 assistantContent 里没有配对 tool_result 的 tool_use 块
  // 为每个孤儿合成 { type:'tool_result', tool_use_id, content:'Interrupted', is_error:true }
  // 返回 { role:'user', content: synthesized[] }，或 null（无孤儿）
}
```

`collectToolResults(content)` 是配套辅助：从 user message content 里抽 tool_result 块。

## 6. QueryEngine 的非阻塞输入

`QueryEngine` 持有 `pendingQueue: Message[]`。`enqueueUserMessage(text)` 把消息推进队列。`submitMessage` 把 `injectMessages` 回调传给 `query()`：

```typescript
injectMessages: () => {
  if (this.pendingQueue.length === 0) return []
  const queued = this.pendingQueue.splice(0)
  for (const m of queued) callbacks.onUserMessage?.(m)   // 通知 UI
  return queued
}
```

`query()` 在每轮 `callModel` **前**调用 `injectMessages()`，把排队消息追加到 `messages`。**不打断当前轮**——排队消息等到上一轮的 tool_result 追加后（配对完整）才注入。

UI 侧（`App.tsx` `handleSubmit`）：运行中输入普通文本 → `engine.enqueueUserMessage(prompt)` + transcript 显示 "(queued — will be sent on the next turn)"。

## 7. Plan 模式

`QueryEngine.planMode` 标志。`toolsForCurrentMode()`：

```typescript
if (!this.planMode) {
  return this.opts.tools.filter(t => t.name !== 'ExitPlanMode')   // 全模式：排除 ExitPlanMode
}
// plan 模式：只读工具 + ExitPlanMode
return this.opts.tools.filter(t => {
  if (t.name === 'ExitPlanMode') return true
  try { return t.isReadOnly?.({}) ?? false }   // 输入相关；无输入时 fail-closed
  catch { return false }
})
```

`ExitPlanModeTool.call(plan)` 阻塞等审批：
- QueryEngine 构造时 `setPlanApprovalHandler` 注册 handler，包装 UI 回调（`__planCb`）
- approve → 返回成功 + `planMode = false`（下一轮恢复全工具集）
- reject → 返回 error result，agent 留在 plan 模式修订
- 无 handler（headless）→ 计划打印到 stderr + 自动拒绝

`submitMessage` 把 `callbacks.onPlanPresented` 接到 `setPlanApprovalCallback`，该回调返回 `Promise<boolean>`（REPL 的 y/n 对话框）。

## 8. 会话持久化（`submitMessage` 末尾）

```typescript
const prevLen = this.messages.length
// ... query() 运行 ...
this.messages = result.messages

if (this.sessionId) {
  const newMessages = this.messages.slice(prevLen)   // 本轮新增
  try { appendMessages(this.opts.cwd, this.sessionId, newMessages) }
  catch { /* 持久化失败非致命 */ }
}
```

`appendMessages` 追加 JSONL + 更新 meta sidecar。详见 [12-session-bridge.md](./12-session-bridge.md)。

## 9. Hooks 触发点

| 事件 | 触发位置 | 是否影响决策 |
|------|---------|-------------|
| `SessionStart` | QueryEngine 构造时 fire-and-forget | observe-only |
| `UserPromptSubmit` | `submitMessage` 追加 user message 后 | observe-only |
| `PreToolUse` | `executeOne` 权限检查前 | **block** / **approve** / 无决策 |
| `PostToolUse` | `executeOne` tool.call 后 | observe-only |
| `PreCompact` | `compactConversation` 摘要前 | observe-only |
| `PostCompact` | `compactConversation` 摘要后 | observe-only |
| `Stop` | `submitMessage` 末尾 | observe-only |
| `SessionEnd` | `engine.shutdown()`（REPL 退出时） | observe-only |

## 10. 已知边界 / 未实现项

- **无** StreamingToolExecutor（工具流式执行）。工具在流完成后才跑。
- **无** context collapse / reactive compact 多级压缩。`prompt_too_long` 只压缩一次。
- **无** mid-thought 之外的恢复机制；`max_output_tokens` 恢复仅靠 "Continue" 注入。
- **无** 并发工具预热（streaming tool use）。
- `assistantBlocksForNextTurn` 丢弃 thinking 块——源码注释"proxy quirks; thinking isn't re-sent"。mimo 代理会发空 signature 的 thinking 块。
- `tools` 传给 `query()` 的始终是 `getBuiltinTools()` 的 13 个内置工具（`assembleToolPool`/MCP 工具从不接入，见 [07](./07-mcp-integration.md)）；plan 模式下进一步过滤。
