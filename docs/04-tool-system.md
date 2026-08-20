# 工具系统

> 基于 `src/Tool.ts` (~278 行) + `src/tools.ts` (~77 行) + `src/query/runTools.ts` + 各 `src/tools/*` 实际源码。

## 1. 工具接口设计

每个工具实现 `ToolDefinition<I, O>` 接口（`src/Tool.ts`），通过 `buildTool()` 工厂创建。`buildTool` 注入 fail-closed 默认值并把 Zod schema 转成 JSON schema：

```typescript
export interface ToolDefinition<I = Record<string, unknown>, O = unknown> {
  name: string
  aliases?: string[]

  inputSchema?: ZodTypeAny           // 内置工具用 Zod（与 inputJSONSchema 互斥）
  inputJSONSchema?: Record<string, unknown>  // MCP 工具用原始 JSON schema

  maxResultSizeChars: number         // 超长结果截断阈值；Infinity = 永不截断

  call(args: I, context: ToolUseContext): Promise<ToolResult<O>>       // 核心执行
  description(args: I, options?: { toolUseId?: string }): string        // 短描述（tool-use UI）
  prompt(options?: { verbose?: boolean }): string                       // 长提示（注入系统提示）

  checkPermissions?(args: I, context: ToolUseContext): Promise<PermissionResult>
  mapToolResultToToolResultBlockParam(result: ToolResult<O>, toolUseId: string): ToolResultBlock[]
  renderToolUseMessage(args: I): string                                 // tool-use 消息渲染

  // fail-closed 安全分类（buildTool 注入默认值）
  isReadOnly?(args: I): boolean          // 默认 false
  isDestructive?(args: I): boolean       // 默认 false
  isConcurrencySafe?(args: I): boolean   // 默认 false

  // 行为控制
  validateInput?(args: I, context: ToolUseContext): Promise<ValidationResult>
  isEnabled?(): boolean                  // 默认 () => true
  isMcp?: boolean
  shouldDefer?: boolean
  alwaysLoad?: boolean
  userFacingName?(args?: I): string      // 默认 () => def.name
}

export type BuiltTool<I, O> = ToolDefinition<I, O> & {
  readonly jsonSchema: Record<string, unknown>   // 转换后的 JSON schema
}
```

### 1.1 `ToolResult`

```typescript
interface ToolResult<T = unknown> {
  data: T
  result?: string       // 人类/agent 可读结果；字符串则成 tool_result text 块
  isError?: boolean
}
```

### 1.2 `PermissionResult`

```typescript
type PermissionResult =
  | { behavior: 'allow' }
  | { behavior: 'deny'; message?: string }
  | { behavior: 'ask'; message?: string }
  | { behavior: 'passthrough' }   // 延交给权限管线其余部分
```

### 1.3 `ToolUseContext`

```typescript
interface ToolUseContext {
  abortController: AbortController
  readFileState: FileStateCache
  cwd: string
  messages?: unknown[]
  agentId?: string                          // 仅子 agent 设置
  addNotification?: (msg: string) => void   // 声明但从不填充（未实现）
  sendOSNotification?: (msg: string) => void // 声明但从不填充（未实现）
  permissionContext?: unknown
}
```

### 1.4 `buildTool()` 工厂

```typescript
export function buildTool<I, O>(def: ToolDefinition<I, O>): BuiltTool<I, O> {
  const withDefaults = {
    isEnabled: () => true,
    isConcurrencySafe: () => false,    // ← fail-closed：默认串行
    isReadOnly: () => false,           // ← fail-closed：默认当写操作
    isDestructive: () => false,
    checkPermissions: async () => ({ behavior: 'passthrough' as const }),
    userFacingName: () => def.name,
    ...def,
  }
  const jsonSchema = def.inputJSONSchema ?? zodToJsonSchema(def.inputSchema)
  return { ...withDefaults, jsonSchema }
}
```

### 1.5 Zod → JSON schema 转换

手写 `zodNodeToJson`（`Tool.ts` 内），支持 Zod v4（`_def.type` 小写字符串）和 v3（`_def.typeName` `ZodXxx`）。处理：object/string/number/boolean/array/enum/optional/nullable/literal/union/default/record。optional 字段不进 `required`。失败兜底 `{ type:'object', properties:{} }`。

`textToolResult(result, toolUseId)` 辅助：把 `ToolResult` 转成单个 text `tool_result` 块。

## 2. 工具注册表 (`src/tools.ts`)

```typescript
export function getBuiltinTools(): BuiltTool[] {
  return [
    FileReadTool, FileEditTool, FileWriteTool, NotebookEditTool,
    BashTool, GlobTool, GrepTool, TodoWriteTool,
    AskUserQuestionTool, WebFetchTool, AgentTool, SkillTool, ExitPlanModeTool,
  ]
}
```

13 个内置工具，**按定义顺序**返回（非字母序）。

### 2.1 `assembleToolPool`（存在但**未被调用**）

```typescript
export function assembleToolPool(builtin: BuiltTool[], mcp: BuiltTool[] = []): BuiltTool[] {
  // 内置字母序 ++ MCP 字母序，按 name 去重（内置胜）
}
export function toolsToApiDefs(tools: BuiltTool[]): Record<string, unknown>[] {
  // 转成 API tool definitions
}
```

> **重要：** 这两个函数在源码里**从未被调用**。实际传给 `query()` 的 `tools` 是 `getBuiltinTools()` 的原序 13 个工具（QueryEngine 在 plan 模式下过滤）。MCP 工具从不接入工具池（`connectAllServers`/`collectMcpTools` 也未被调用，见 [07](./07-mcp-integration.md)）。复现时保留这些死代码函数，但不要把它们接上。

## 3. 13 个内置工具逐一详解

### 3.1 FileReadTool (`tools/FileReadTool/`, 251 行)

读取文件，返回带行号内容（`cat -n` 风格）。

| 属性 | 值 |
|------|-----|
| `inputSchema` | `{ file_path: string, offset?: int+, limit?: int+, pages?: string }` |
| `maxResultSizeChars` | `Infinity`（永不截断） |
| `isReadOnly` | `true` |
| `isConcurrencySafe` | `true` |

**`validateInput`**（先于 call）：
- 拒绝 UNC 路径（`\\server\share`，NTLM 凭证泄漏风险）
- 拒绝设备路径：`/dev/zero`、`/dev/random`、`/dev/urandom`、`/dev/stdin`、`/dev/tty`、`/proc/self/fd/{0,1,2}`
- 拒绝二进制扩展名：`.exe .bin .dll .so .dylib .o .a .class .jar .war .pyc .pyo .wasm .obj .lib .pdb`
- `pages` 参数仅对 `.pdf` 有效

**`call` 流程**：
1. `canonicalPath`（realpath）规范化
2. `stat` → 不存在/非文件 → error
3. **去重**：若之前有完整读且 mtime 未变 → 返回 `FILE_UNCHANGED_STUB`（`<system-reminder>File content unchanged since last read</system-reminder>`）
4. 图像（`.png .jpg .jpeg .gif .webp .bmp`）→ base64 `<image src="data:...;base64,..."/>`（>2MiB 拒绝）
5. Notebook（`.ipynb`）→ 解析 JSON，输出 `<cell id="cN" type="...">` 包裹的单元格源
6. 文本：>2MiB 拒绝（提示用 offset/limit 或 GrepTool）；`offset`（1-indexed）/`limit` 切片；行号 `padStart(6)` + tab
7. 记录读状态：覆盖整个文件（start=0 且 end≥总行数）→ `recordRead`（full read）；否则 `set({ offset, limit, mtimeMs })`

header 格式：`cat -n <path> (<N> lines)` 或 `cat -n <path> (lines A-B of N)`。

> **PDF `pages` 参数声明但未真正解析 PDF**——`validateInput` 只校验扩展名，实际读取走文本分支（PDF 当文本读）。

### 3.2 FileEditTool (`tools/FileEditTool/`, 227 行)

精确字符串替换，原子写。

| 属性 | 值 |
|------|-----|
| `inputSchema` | `{ file_path, old_string, new_string, replace_all?: boolean }` |
| `maxResultSizeChars` | `10_000` |
| `isReadOnly` | `false` |
| `isConcurrencySafe` | `false` |

**`validateInput`**：UNC 拒绝；`old_string === new_string` → error。

**`call` 流程**（14 步简化版）：
1. 文件不存在 + `old_string === ''` → **创建新文件**（`writeFileSync(new_string)`，记录读状态，返回 `Created`）
2. 文件不存在 + `old_string !== ''` → error（提示设 `old_string=""` 创建）
3. 存在文件：`readFileState.get` 必须有 full read（`isFullRead`）→ 否则 error `Must read the file ... before editing`
4. `stat` → size > 1 GiB 拒绝
5. **mtime 新鲜度**：`fileStat.mtimeMs !== prev.mtimeMs` → error `File was modified since last read`
6. 同步读 → `countOccurrences`（引号归一化匹配）
7. 0 次 → error `old_string not found`
8. >1 次且 `replace_all` 非 true → error `found N times, set replace_all=true`
9. `applyEdit`（引号归一化替换）→ `writeFileSync`
10. 更新读状态到新 mtime（同轮再编辑可用）

**引号归一化**（`normalizeQuotes`）：`‘’→'`、`“”→"`、`–→-`、`—→--`。`countOccurrences`/`applyEdit` 用归一化比较。

### 3.3 FileWriteTool (`tools/FileWriteTool/`, 97 行)

全文件覆盖。

| 属性 | 值 |
|------|-----|
| `inputSchema` | `{ file_path, content }` |
| `maxResultSizeChars` | `10_000` |
| `isReadOnly` | `false` |
| `isConcurrencySafe` | `false` |

**`call`**：
- UNC 拒绝
- 存在文件：要求 full read + mtime 新鲜度（同 FileEdit）
- **总是 LF 行尾**：`content.replace(/\r\n/g,'\n').replace(/\r/g,'\n')`
- 新文件跳过读要求
- 记录读状态到新 mtime

### 3.4 NotebookEditTool (`tools/NotebookEditTool/`, 132 行)

编辑 Jupyter 单元格。

| 属性 | 值 |
|------|-----|
| `inputSchema` | `{ notebook_path, cell_id?, cell_number?, new_source, edit_mode?: 'replace'|'insert'|'delete' = 'replace' }` |
| `maxResultSizeChars` | `10_000` |
| `isReadOnly` | `false` |
| `isConcurrencySafe` | `false` |

**`call`**：canonicalPath → 存在性 → full read + mtime 新鲜度 → 解析 JSON → 按 `cell_id`（`metadata.id`）或 `cell_number` 定位 → `delete`/`insert`/`replace` → `writeFileSync(JSON.stringify(nb, null, 1))` → 更新读状态。

### 3.5 BashTool (`tools/BashTool/`, 154 行)

执行 shell 命令。

| 属性 | 值 |
|------|-----|
| `inputSchema` | `{ command: string min1, timeout?: int+, description?: string, run_in_background?: boolean }` |
| `maxResultSizeChars` | `30_000` |
| `isReadOnly` | `(input) => classifyReadOnly(input.command)`（AST 判定） |
| `isConcurrencySafe` | `false` |

**`runBash`**：`spawn(command, { shell: true, cwd, env, stdio: ['ignore','pipe','pipe'] })`。
- 默认超时 `120_000`ms；超时 SIGTERM，2s 后升 SIGKILL
- abort signal 监听 → SIGTERM
- stdout/stderr 各自捕获，上限 `64 * 1024 * 1024`（64 MiB）
- 输出拼接：stdout + `[stderr]\n` + stderr + 超时/退出码标注
- `isError = timedOut || exitCode !== 0`

**`classifyReadOnly(command)`** → `isReadOnlyCommand`（`utils/bash/ast.ts`）：调 `analyzeBashSafety`，全部 simple_command 必须是已知只读工具且无写重定向。只读命令集：`ls cat head tail grep egrep fgrep rg find wc stat file echo printf pwd whoami date env printenv which type uname df du ps top node rustc gcc` + git 只读子命令（`status log diff branch show remote rev-parse ls-files blame`）。有 `>|>>|&>` 写重定向 → 非只读。

> **`run_in_background` 参数声明但 `runBash` 未实现后台逻辑**——始终前台等待。`BashRunResult.backgrounded` 恒为 `false`。

### 3.6 GlobTool (`tools/GlobTool/`, 55 行)

fast-glob 文件匹配。

| 属性 | 值 |
|------|-----|
| `inputSchema` | `{ pattern: string, path?: string }` |
| `maxResultSizeChars` | `30_000` |
| `isReadOnly` | `true` |
| `isConcurrencySafe` | `true` |

`fg(pattern, { cwd, dot: false, ignore: ['**/node_modules/**','**/.git/**'], onlyFiles: true, absolute: false })`，排序后取前 500。

### 3.7 GrepTool (`tools/GrepTool/`, 141 行)

ripgrep 封装 + Node fallback。

| 属性 | 值 |
|------|-----|
| `inputSchema` | `{ pattern, path?, output_mode?: 'content'|'files_with_matches'|'count', '-i'?, '-n'? }` |
| `maxResultSizeChars` | `30_000` |
| `isReadOnly` | `true` |
| `isConcurrencySafe` | `true` |

`spawn('rg', args)`，args 含 `--hidden --exclude-dir=.git --exclude-dir=node_modules --max-columns 500`，按 mode 加 `-l`/`-c`/`-n`。模式以 `-` 开头则加 `-e`。rg 不可用（exitCode>1 或 spawn error）→ `grepWithNode` fallback（手写遍历，排除 `.git/node_modules/.svn/.hg`，文件 <1MB）。

### 3.8 TodoWriteTool (`tools/TodoWriteTool/`, 68 行)

更新 todo 列表。**模块级 pub/sub**（非 ToolUseContext/AppState）。

| 属性 | 值 |
|------|-----|
| `inputSchema` | `{ todos: Array<{ content, status: 'pending'|'in_progress'|'completed', activeForm }> }` |
| `maxResultSizeChars` | `5_000` |
| `isReadOnly` | `false` |
| `isConcurrencySafe` | `false` |

```typescript
let currentTodos: TodoList = { todos: [] }
const subscribers = new Set<(todos: TodoList) => void>()
export function subscribeTodos(fn): () => void   // Ink UI 订阅
export function getCurrentTodos(): TodoList
```

`call`：替换 `currentTodos`，通知所有订阅者，返回 `[x/*/ ] content` 列表。UI（`App.tsx`）`useEffect` 订阅以渲染固定 todo 面板。

### 3.9 AskUserQuestionTool (`tools/AskUserQuestionTool/`, 67 行)

澄清问题。

| 属性 | 值 |
|------|-----|
| `inputSchema` | `{ questions: Array<{ question, header(max12), options: Array<{label,description}> min2 max4, multiSelect }> min1 max4 }` |
| `maxResultSizeChars` | `5_000` |
| `isReadOnly` | `true` |
| `isConcurrencySafe` | `false` |

`setAskHandler(handler)` 注册交互 handler（**REPL 从不调用**）。无 handler（headless）→ 每题自动选第一个 option。返回 `Record<string,string>` 答案。

> **未接线：** REPL 的交互问答是手写 y/n 对话框（`pendingPerm`/`pendingPlan`），**不**走这个工具。模型调它时在 REPL 里也走 headless 默认（自动选第一项）。

### 3.10 WebFetchTool (`tools/WebFetchTool/`, 95 行)

URL 抓取 + HTML→text。

| 属性 | 值 |
|------|-----|
| `inputSchema` | `{ url: string(url), prompt?: string }` |
| `maxResultSizeChars` | `30_000` |
| `isReadOnly` | `true` |
| `isConcurrencySafe` | `true` |

`fetch(url, { headers: { 'user-agent': 'harness-code/0.1.0' }, redirect: 'follow' })`，HTML 经 `htmlToText`（去 script/style、剥标签、解码实体、塌缩空白），>50_000 字符截断。

`PREAPPROVED_HOSTS`：github/raw.githubusercontent/api.github/registry.npmjs/pypi/docs.python/nodejs/developer.mozilla.org/stackoverflow/json-schema/modelcontextprotocol/spec.modelcontextprotocol（`isPreapprovedHost` 导出但权限管线未用它——见 [05](./05-permission-and-hooks.md)）。

> **`prompt` 参数声明但未用于摘要**——只抓取内容，无 Haiku/小模型二次摘要。

### 3.11 AgentTool (`tools/AgentTool/`, 108 行) — **未接线**

| 属性 | 值 |
|------|-----|
| `inputSchema` | `{ description: string min1, prompt: string min1, subagent_type?: string }` |
| `maxResultSizeChars` | `30_000` |
| `isReadOnly` | `false` |
| `isConcurrencySafe` | `false` |

设计上：`configureAgentTool(deps)` 注入 `{ client, tools, model, maxOutputTokens, maxTurns, systemPrompt, permCtx }`，`call` 用 `query()` 跑一个隔离消息历史的子循环，`subAgentCanUseTool` 复用父权限上下文，返回 `getFinalText`。

> **关键：** `configureAgentTool` **从未被调用**（`main.tsx`/`QueryEngine`/`tools.ts` 都不调它）。`_deps` 永远 undefined，`call` 第一行就返回 `{ result: 'AgentTool not configured with deps', isError: true }`。子代理功能实际不可用。详见 [08-multi-agent-system.md](./08-multi-agent-system.md)。

### 3.12 SkillTool (`tools/SkillTool/`, 53 行)

模型按名调用 skill。

| 属性 | 值 |
|------|-----|
| `inputSchema` | `{ skill: string min1, args?: string }` |
| `maxResultSizeChars` | `30_000` |
| `isReadOnly` | `true` |
| `isConcurrencySafe` | `true` |

`call`：`loadAllSkills(cwd)` 找到 skill → `substituteArguments(body, argMap, skillDir)`（`$ARGUMENTS`、`$1`/`$2`、`${CLAUDE_SKILL_DIR}` 替换）→ 返回替换后 body。找不到 → error + 列出可用 skill。

### 3.13 ExitPlanModeTool (`tools/ExitPlanModeTool/`, 79 行)

plan 模式提交计划等审批。

| 属性 | 值 |
|------|-----|
| `inputSchema` | `{ plan: string min1 }` |
| `maxResultSizeChars` | `10_000` |
| `isReadOnly` | `true` |
| `isConcurrencySafe` | `false` |

模块级 `approvalHandler`（`setPlanApprovalHandler` 注册，QueryEngine 构造时调用）。`call`：
- 有 handler → 阻塞等 `approved`；approve 返回成功，reject 返回 error（agent 留在 plan 模式修订）
- 无 handler（headless）→ 计划打印到 stderr `[plan]...[/plan]` + 自动拒绝

## 4. 工具结果序列化

每个工具实现 `mapToolResultToToolResultBlockParam(result, toolUseId): ToolResultBlock[]`。除 FileReadTool（图像返回特殊块）外，几乎所有工具用 `textToolResult`：

```typescript
function textToolResult(result, toolUseId): ToolResultBlock[] {
  const text = result.result ?? (typeof result.data === 'string' ? result.data : JSON.stringify(result.data))
  return [{ type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: result.isError }]
}
```

## 5. 结果大小预算

`runTools` 的 `executeOne` 末尾截断：

```typescript
const resultText = result.result ?? (typeof result.data === 'string' ? result.data : JSON.stringify(result.data))
if (Number.isFinite(tool.maxResultSizeChars) && resultText.length > tool.maxResultSizeChars) {
  const truncated = resultText.slice(0, tool.maxResultSizeChars)
  return [{ type: 'tool_result', tool_use_id, content: truncated + `\n... (truncated, ${len - max} chars omitted)`, is_error }]
}
return tool.mapToolResultToToolResultBlockParam(result, block.id)
```

`Number.isFinite` 守卫：`Infinity`（FileReadTool）永不截断。源码注释提到"persist to temp file and return a stub"是未来计划，当前是简单内联截断。

## 6. 工具分类汇总表

| 工具 | 只读 | 并发安全 | maxResultSizeChars | 特殊 |
|------|:----:|:-------:|:------------------:|------|
| FileReadTool | ✓ | ✓ | ∞ | 去重 stub、图像/PDF/Notebook |
| FileEditTool | ✗ | ✗ | 10k | 读前写+mtime、引号归一化、创建新文件 |
| FileWriteTool | ✗ | ✗ | 10k | 读前写、LF 行尾 |
| NotebookEditTool | ✗ | ✗ | 10k | 单元格 replace/insert/delete |
| BashTool | AST判定 | ✗ | 30k | 超时+SIGKILL、64MiB cap |
| GlobTool | ✓ | ✓ | 30k | fast-glob，前 500 |
| GrepTool | ✓ | ✓ | 30k | rg + Node fallback |
| TodoWriteTool | ✗ | ✗ | 5k | 模块级 pub/sub |
| AskUserQuestionTool | ✓ | ✗ | 5k | **交互未接线** |
| WebFetchTool | ✓ | ✓ | 30k | HTML→text，无摘要 |
| AgentTool | ✗ | ✗ | 30k | **未接线** |
| SkillTool | ✓ | ✓ | 30k | 参数替换 |
| ExitPlanMode | ✓ | ✗ | 10k | 阻塞等审批 |

## 7. 已知边界 / 未实现项

- **AgentTool 未接线**（`configureAgentTool` 从不调用）。
- **AskUserQuestionTool 交互 handler 未接线**（`setAskHandler` 从不调用）。
- **`assembleToolPool`/`toolsToApiDefs` 死代码**（从不调用）；MCP 工具从不进池。
- **BashTool `run_in_background` 未实现**（恒前台）。
- **WebFetchTool `prompt` 未用于摘要**（无二次模型调用）。`PREAPPROVED_HOSTS`/`isPreapprovedHost` 导出但权限管线未用。
- **FileReadTool PDF 未真正解析**（当文本读）。
- **`addNotification`/`sendOSNotification`** 在 `ToolUseContext` 声明但从不填充。
- **无 WebSearchTool、无 MCPTool 存根、无 Task 后台任务类型。**
- 工具列表传给 API 时**不**按字母序（`assembleToolPool` 未用）——这是与 Claude Code 提示缓存设计的一个偏离点（源码注释声称字母序，但实际 `getBuiltinTools` 原序）。
