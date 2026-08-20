# 多 Agent 系统

> 基于 `src/tools/AgentTool/AgentTool.ts` (~108 行) + `src/tools/ExitPlanModeTool/ExitPlanModeTool.ts` (~79 行) + `src/QueryEngine.ts` (plan 模式部分) 实际源码。
>
> **关键事实：** harness-code **没有** Claude Code 的 Swarm/Coordinator/LocalAgentTask/RemoteAgentTask/worktree 隔离等多 Agent 系统。唯一的"多步/子代理"设计是 `AgentTool`（子代理）和 `ExitPlanMode`（plan 模式）。其中 **AgentTool 已注册但完全未接线**（`configureAgentTool` 从不调用，调用即报错），**plan 模式是唯一真正可用的多步机制**。

## 1. 架构概览

| 机制 | 状态 | 说明 |
|------|------|------|
| AgentTool（子代理） | **未接线** | `configureAgentTool` 从不调用；`call` 返回 "AgentTool not configured with deps" |
| Plan 模式（ExitPlanMode） | **可用** | 只读研究 → 提交计划等审批 → approve 后全工具集执行 |
| Coordinator/Swarm | 不存在 | 无 `coordinator/`、`swarm/` 目录 |
| LocalAgentTask/RemoteAgentTask | 不存在 | 无 `tasks/` 目录、无后台异步 agent |
| worktree 隔离 | 不存在 | 无 `EnterWorktree`/worktree 创建 |

## 2. AgentTool — 子代理（未接线）

### 2.1 设计意图

```typescript
const inputSchema = z.object({
  description: z.string().min(1),
  prompt: z.string().min(1),
  subagent_type: z.string().optional(),
})

interface AgentToolDeps {
  client: ApiClient
  tools: BuiltTool[]
  model: string
  maxOutputTokens: number
  maxTurns: number
  systemPrompt: SystemBlock[] | string
  permCtx: PermissionContext
}
```

设计上 `configureAgentTool(deps)` 把依赖挂到 `AgentTool._deps`，`call` 用 `query()` 跑一个隔离消息历史的子循环：

```typescript
async call(input, context) {
  const deps = (this as any)._deps
  if (!deps) {
    return { data: { result: '' }, result: 'AgentTool not configured with deps', isError: true }  // ← 实际总是走这里
  }

  const subContext: ToolUseContext = {
    abortController: new AbortController(),
    readFileState: createFileStateCache(),   // 独立读状态
    cwd: context.cwd,
    agentId: 'subagent',
  }

  const messages: Message[] = [{ role: 'user', content: input.prompt }]
  const result = await query(messages, {
    client: deps.client, tools: deps.tools, systemPrompt: deps.systemPrompt,
    model: deps.model, maxOutputTokens: deps.maxOutputTokens, maxTurns: deps.maxTurns,
    context: subContext,
    canUseTool: subAgentCanUseTool(deps.permCtx, context.cwd),   // 复用父权限上下文
  })

  const finalText = getFinalText(result.messages)
  return { data: { result: finalText }, result: finalText || `[sub-agent exited: ${result.reason}]` }
}
```

`subAgentCanUseTool(permCtx, cwd)`：用父 `PermissionContext` 调 `hasPermissionsToUseTool`，allow → allow，其他 → deny（**子代理不弹交互 ask**，直接 deny）。

### 2.2 未接线事实

- `configureAgentTool(deps)` **从不被调用**（grep 全源码：`main.tsx`/`QueryEngine.ts`/`tools.ts` 均无调用）。
- `tools.ts` 的 `getBuiltinTools()` 直接导出 `AgentTool`（未配置），注册进工具池。
- 模型调用 AgentTool 时 → `_deps` undefined → 立即返回 error `AgentTool not configured with deps`。
- **无 AgentTool 测试**（`tests/` 无相关）。

### 2.3 安全分类

```typescript
isReadOnly: () => false,
isConcurrencySafe: () => false,
maxResultSizeChars: 30_000,
```

> 复现时：保留 `AgentTool` 完整代码（含 `configureAgentTool`、`subAgentCanUseTool`、`query()` 调用），注册进 `getBuiltinTools()`，但**不要**在 `main.tsx`/`QueryEngine` 里调 `configureAgentTool`。这是当前真实状态。

## 3. Plan 模式 — 唯一可用的多步机制

### 3.1 状态与切换

```typescript
// QueryEngine
private planMode: boolean   // 构造时 = !!opts.startInPlanMode

enterPlanMode(): void { this.planMode = true }          // /plan 或 --plan
exitPlanMode(): void { this.planMode = false }           // approve 后内部调用
isPlanMode(): boolean
```

`--plan` CLI flag → `startInPlanMode: true`；`/plan` 命令 → `ctx.enterPlanMode()`。

### 3.2 工具集过滤 (`toolsForCurrentMode`)

```typescript
if (!this.planMode) {
  return this.opts.tools.filter(t => t.name !== 'ExitPlanMode')   // 全模式：排除 ExitPlanMode
}
// plan 模式：只读工具 + ExitPlanMode
return this.opts.tools.filter(t => {
  if (t.name === 'ExitPlanMode') return true
  try { return t.isReadOnly?.({}) ?? false }   // 输入相关；无输入时 fail-closed（throw → false）
  catch { return false }
})
```

plan 模式下模型只能用只读工具（FileRead/Glob/Grep/WebFetch/Skill/ExitPlanMode/AskUserQuestion）+ ExitPlanMode。写工具（FileEdit/FileWrite/Bash 写操作/TodoWrite/NotebookEdit/Agent）被过滤掉。

> `isReadOnly` 是输入相关的（BashTool 看命令），但这里传 `{}` 无输入，BashTool 的 `isReadOnly({})` 会因 `command` undefined 而在 `classifyReadOnly` 里被 AST 分析判为非只读（fail-closed）。

### 3.3 ExitPlanModeTool 审批协议

模块级 `approvalHandler`：

```typescript
let approvalHandler: ((plan: string) => Promise<boolean>) | null = null
export function setPlanApprovalHandler(handler): void
```

`call(plan)`：
- 有 handler → `await approvalHandler(plan)`：
  - approve → `{ data: { approved: true }, result: 'Plan approved. You may now implement it using all available tools.' }`
  - reject → `{ data: { approved: false }, result: 'Plan rejected by the user. Revise the plan and call ExitPlanMode again, or clarify.', isError: true }`
- 无 handler（headless）→ 计划打印到 stderr `[plan]...[/plan]\n(no approval handler — rejecting)` + 返回 error（**无审批则不执行**）。

### 3.4 QueryEngine 审批 handler 注册

```typescript
// 构造时
private registerPlanApprovalHandler(): void {
  setPlanApprovalHandler(async (plan) => {
    const cb = (this as any).__planCb     // UI 回调（submitMessage 时设置）
    if (!cb) return false
    const approved = await cb(plan)
    if (approved) this.planMode = false    // ← approve 后退出 plan 模式，下一轮全工具集
    return approved
  })
}

setPlanApprovalCallback(cb): void { (this as any).__planCb = cb }
```

`submitMessage` 时把 UI 的 `callbacks.onPlanPresented` 接到 `setPlanApprovalCallback`。该回调返回 `Promise<boolean>`——在 REPL 里是 `App.tsx` 的 `pendingPlan` y/n 对话框（`[y] yes / [n] no`）。

### 3.5 Plan 模式完整流程

```
用户: /plan（或 --plan 启动）
  → engine.enterPlanMode()；transcript 提示 "Entered plan mode..."
  → 下一轮 query() 用 toolsForCurrentMode() 过滤后的只读工具集

模型用只读工具研究 → 调 ExitPlanModeTool(plan)
  → approvalHandler(plan) → __planCb(plan) → REPL 弹 pendingPlan 对话框
  → 用户按 y/n:
     y → approve → planMode=false → ExitPlanMode 返回成功 → 下一轮全工具集（可编辑/执行）
     n → reject → 留在 plan 模式 → ExitPlanMode 返回 error → 模型修订计划再调 ExitPlanMode
```

## 4. 已知边界 / 未实现项

- **AgentTool 完全未接线**（`configureAgentTool` 从不调用，调用即 error）。子代理、并行探索、任务委派均不可用。
- **无 Swarm/Coordinator/team/mailbox**。
- **无 LocalAgentTask/InProcessTeammateTask/RemoteAgentTask**（无 `tasks/` 目录、无 AsyncLocalStorage 隔离）。
- **无 worktree 隔离**（无 `EnterWorktree`/`createWorktreeForSession`）。
- **子代理无独立权限 ask**（设计上 `subAgentCanUseTool` 直接 deny 非 allow 的——但因未接线无意义）。
- **plan 模式是唯一可用的"多步"机制**：只读研究 → 审批 → 执行。这是复现时必须保留的可用功能。
- `ExitPlanMode` 在非 plan 模式下被 `toolsForCurrentMode` 过滤掉（模型调不到）。
