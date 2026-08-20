# harness-code 架构总览

> 本文档基于 **harness-code v0.1.0** 实际源码（`src/`）整理。所有文件路径、行数、模块职责均与源码一一对应。

## 1. 整体架构

harness-code 是一个运行在终端的 AI Coding Agent，核心架构分层如下：

```
┌─────────────────────────────────────────────────────────┐
│                    用户界面层 (Ink/React)                  │
│   src/ink/App.tsx · 文本输入+光标 · banner · spinner      │
│   进度条 · 交互选择器(model/history) · 权限/计划对话框      │
│   headless 模式: src/entrypoints/headless.ts             │
├─────────────────────────────────────────────────────────┤
│                   会话管理层 (QueryEngine)                 │
│   多轮对话历史 · 模型管理(ModelManager) · plan 模式         │
│   非阻塞输入队列 · 会话持久化 · hooks 触发                  │
├─────────────────────────────────────────────────────────┤
│                   核心 Agent 循环 (query.ts)              │
│   callModel 流式累加 · runTools 并行/串行 · 错误恢复       │
│   中断协议(abort.ts) · autoCompact                        │
├─────────────────────────────────────────────────────────┤
│                   工具执行层 (tools/)                      │
│   13 个内置工具 · buildTool() 工厂 · Zod 校验             │
├─────────────────────────────────────────────────────────┤
│                   权限与安全层                             │
│   permissions.ts 决策管线 · canUseTool · classifier       │
│   bash/ AST 安全分析 · dangerousPatterns 受保护路径        │
├─────────────────────────────────────────────────────────┤
│                   服务层 (services/)                      │
│   api/(手写客户端+SSE) · compact/ · hooks/ · mcp/         │
│   session/ · extractMemories/ · memdir/ · skills/        │
└─────────────────────────────────────────────────────────┘
```

> **与 Claude Code 的关键差异：** harness-code **没有** AppState（~450 字段）/ `useSyncExternalStore` 选择器（`src/state/store.ts` 里有个极简 `createStore` 但**未被任何代码使用**，是死代码）、**没有** 定制 Ink reconciler / ScrollBox / 鼠标处理、**没有** Vim 模式、**没有** 18 上下文快捷键系统、**没有** Swarm/Coordinator 多 Agent、**没有** Bridge 远程控制 / 遥测 / OAuth、**没有** WebSearch 工具、**没有** 插件系统。UI 用**原生** Ink（`useInput`/`useApp`/`render`），状态用 React `useState`。详见各篇文档末尾的"已知边界"。

## 2. 技术栈

| 组件 | 技术选型 | 说明 |
|------|---------|------|
| 运行时 | Node.js ≥18 | 仅 Node（不支持 Bun 运行时） |
| 语言 | TypeScript | `strict: true` + `noUncheckedIndexedAccess: true` |
| 模块 | ESM | `"type": "module"`，`verbatimModuleSyntax: false` |
| 终端 UI | Ink 7 + React 19 | **原生** Ink，非定制 reconciler；Yoga flexbox |
| 状态管理 | React `useState`/`useRef` | 无外部 store；TodoWriteTool 用模块级 pub/sub |
| API 通信 | 手写 `fetch` + SSE 解析器 | **不用** `@anthropic-ai/sdk`；Anthropic 兼容代理 |
| 输入校验 | Zod 4 | 工具输入校验 + 手写 Zod→JSON schema 转换 |
| CLI | Commander 15 | 命令/选项注册 |
| MCP | `@modelcontextprotocol/sdk` | **仅 stdio** 传输 |
| 文件匹配 | fast-glob 3 | GlobTool |
| 构建 | tsup 8 | ESM 单入口 `src/main.tsx` → `dist/main.js` |
| 测试 | vitest 4 | `tests/` 下 unit + integration |

## 3. 核心数据流

```
用户输入 (终端 Ink useInput / headless --print)
    │
    ▼
App.tsx useInput() / handleSubmit()   ← 光标编辑、history、slash 解析
    │
    ├─ /stop (运行中) → engine.interrupt()，立即中断
    ├─ /cmd (运行中) → 延迟到 idle
    ├─ 普通文本 (运行中) → engine.enqueueUserMessage()，下一轮注入
    ├─ exit/quit → engine.shutdown() + exit()
    ├─ /命令 → commands.ts findCommand → 本地处理或注入 prompt
    │
    └─ 普通查询 → QueryEngine.submitMessage(prompt, callbacks)
                      │
                      ├─ UserPromptSubmit hook (observe-only)
                      │
                      ▼
                  query() 核心 while 循环  (src/query.ts)
                      │
                      ├─ turnCount 守卫 / autoCompact 阈值检查
                      ├─ injectMessages()  ← 注入排队输入
                      │
                      ├─ client.callModel()  ← 流式 SSE (services/api/)
                      │     │  onTextDelta → UI 实时流式文本
                      │     └─ StreamAccumulator 累加 content blocks
                      │
                      ├─ 无 tool_use + end_turn → 返回 completed
                      │
                      ├─ runTools(tool_use blocks)  (query/runTools.ts)
                      │      ├─ validateWithSchema (Zod)
                      │      ├─ validateInput (工具自定义)
                      │      ├─ PreToolUse hooks → block/approve
                      │      ├─ canUseTool()  ← 权限管线
                      │      ├─ tool.call()  ← 实际执行
                      │      ├─ PostToolUse hooks (observe-only)
                      │      └─ 结果截断 (maxResultSizeChars)
                      │
                      ├─ 错误恢复: prompt_too_long→压缩 / max_output→64k+3次恢复
                      │
                      └─ append assistant + tool_result，继续循环
                      │
                      ▼ (返回)
                  QueryEngine 持久化新消息到 session JSONL
                  触发 Stop hook，回调 onExit
```

## 4. 主要模块职责

### 4.1 入口层

| 文件 | 职责 |
|------|------|
| `src/main.tsx` (~176 行) | CLI 入口，Commander 命令注册，配置加载，headless/REPL 分支 |
| `src/entrypoints/headless.ts` (~117 行) | `--print` 无 TUI 模式，流式输出到 stdout，支持 `stream-json` NDJSON |
| `src/shims/react-devtools-core.ts` (~5 行) | **必须创建**：no-op shim，供 `tsup.config.ts` 的 esbuild alias 解析 `react-devtools-core`（Ink 条件 import，本项目不用 devtools；不建此文件构建失败）。内容：`export default undefined` + `export const connect = () => undefined` |

> **注意：** 没有 `src/setup.ts`（环境初始化逻辑直接在 `main.tsx` 的 `action()` 里）。没有 SDK/print 独立入口——headless 即 print。
>
> **构建配置（`tsup.config.ts`，复现必须原样）：** 入口 `src/main.tsx`，ESM，`target: node18`，`banner.js: '#!/usr/bin/env node'`，`splitting: false`，`sourcemap: false`，`clean: true`，`minify: false`。`external` 列表（这些依赖不打进 bundle，运行时从 node_modules 解析）：`zod commander @modelcontextprotocol/sdk fast-glob gray-matter lodash-es ink react react-reconciler yoga-layout react-devtools-core`。`esbuildOptions.alias` 把 `react-devtools-core` → `src/shims/react-devtools-core.ts`（见上）。

### 4.2 核心 Agent 引擎

| 文件 | 职责 |
|------|------|
| `src/QueryEngine.ts` (~413 行) | 会话级编排器：多轮历史、模型管理、plan 模式、会话持久化、hooks 触发、非阻塞输入队列 |
| `src/query.ts` (~275 行) | 核心 `while(true)` 循环：流式 callModel、工具执行、错误恢复、中断处理 |
| `src/query/runTools.ts` (~254 行) | 工具批量执行：并发分区、校验、hooks、权限、结果序列化 |
| `src/query/abort.ts` (~51 行) | 中断协议：为孤儿 tool_use 合成 error tool_result |
| `src/Tool.ts` (~278 行) | `ToolDefinition` 接口 + `buildTool()` 工厂 + Zod→JSON schema |
| `src/tools.ts` (~77 行) | 内置工具注册表 + `assembleToolPool`（字母序 + 去重） |

### 4.3 工具系统（13 个内置工具）

| 目录 | 工具 | 说明 |
|------|------|------|
| `src/tools/FileReadTool/` | FileReadTool | 文件读取（cat -n）、图像/PDF/Notebook，去重 stub |
| `src/tools/FileEditTool/` | FileEditTool | 精确字符串替换，原子写，读前写+mtime 校验 |
| `src/tools/FileWriteTool/` | FileWriteTool | 全文件覆盖，LF 行尾，读前写 |
| `src/tools/NotebookEditTool/` | NotebookEditTool | Jupyter 单元格 replace/insert/delete |
| `src/tools/BashTool/` | BashTool | shell 执行，超时，AST 只读分类 |
| `src/tools/GlobTool/` | GlobTool | fast-glob 文件匹配 |
| `src/tools/GrepTool/` | GrepTool | ripgrep 封装 + Node fallback，三种输出模式 |
| `src/tools/TodoWriteTool/` | TodoWriteTool | todo 列表（模块级 pub/sub，UI 订阅） |
| `src/tools/AskUserQuestionTool/` | AskUserQuestionTool | 澄清问题（headless 自动选默认） |
| `src/tools/WebFetchTool/` | WebFetchTool | URL 抓取 + HTML→text（无 Haiku 摘要） |
| `src/tools/AgentTool/` | AgentTool | 子 Agent（**当前未接线，见 doc 08**） |
| `src/tools/SkillTool/` | SkillTool | 模型按名调用 skill |
| `src/tools/ExitPlanModeTool/` | ExitPlanMode | plan 模式提交计划等审批 |

> **无 WebSearchTool、无 MCPTool 存根**（MCP 工具运行时由 `services/mcp/client.ts` 动态包装）。

### 4.4 权限与安全

| 文件 | 职责 |
|------|------|
| `src/utils/permissions/permissions.ts` (~198 行) | 核心决策管线 `hasPermissionsToUseTool` |
| `src/utils/permissions/permissionRuleParser.ts` (~138 行) | 规则字符串解析 `"Tool(content)"` |
| `src/utils/permissions/shellRuleMatching.ts` (~111 行) | Bash exact/prefix/wildcard 匹配 |
| `src/utils/permissions/dangerousPatterns.ts` (~50 行) | 受保护路径（.git/.claude/.vscode/shell 配置） |
| `src/utils/permissions/settings.ts` (~167 行) | settings 多源合并（user/project/local/flag/policy） |
| `src/permissions/canUseTool.ts` (~68 行) | 把管线接进 `runTools`，处理 ask/auto/bypass |
| `src/permissions/classifier.ts` (~125 行) | auto 模式 AI 安全分类器（带缓存） |
| `src/utils/bash/bashParser.ts` (~492 行) | 手写 Bash 解析器（lexer→parser） |
| `src/utils/bash/ast.ts` (~469 行) | AST 安全遍历器，产出可信 argv[] |
| `src/utils/bash/lexer.ts` (~437 行) | Bash 词法分析 |
| `src/utils/bash/types.ts` (~219 行) | AST 节点类型定义 |

### 4.5 上下文与记忆

| 文件 | 职责 |
|------|------|
| `src/context.ts` (~219 行) | 系统提示组装：默认 prompt + CLAUDE.md + git status + 日期 + memory |
| `src/memdir/memdir.ts` (~138 行) | 自动记忆目录：扫描/解析/索引 |
| `src/memdir/paths.ts` (~56 行) | 记忆目录路径解析（git root → `~/.claude/projects/<sanitized>/memory`） |
| `src/services/compact/compact.ts` (~220 行) | 上下文压缩（阈值 + 摘要 + 断路器） |
| `src/services/extractMemories/extract.ts` (~213 行) | `/memory save` LLM 抽取（**非**自动后台抽取） |

> **无 SessionMemory 临时笔记模块。**

### 4.6 MCP 集成

| 文件 | 职责 |
|------|------|
| `src/services/mcp/client.ts` (~158 行) | MCP stdio 客户端，连接/发现/包装工具，批量并发 3 |

> **仅 stdio 传输**，无 SSE/HTTP/WS，无 OAuth。

### 4.7 多 Agent 系统

| 文件 | 真实状态 |
|------|---------|
| `src/tools/AgentTool/AgentTool.ts` | **已注册但未接线**：`configureAgentTool()` 从未被调用，`_deps` 永远 undefined，调用即返回 "AgentTool not configured with deps" 错误 |
| `src/tools/ExitPlanModeTool/` | plan 模式（只读研究 → 提交计划等审批）——这是唯一真正可用的"多步"机制 |

> **无 coordinator/、无 swarm/、无 LocalAgentTask、无 RemoteAgentTask、无 worktree 隔离。** 详见 [08-multi-agent-system.md](./08-multi-agent-system.md)。

### 4.8 技能与插件

| 目录 | 职责 |
|------|------|
| `src/skills/loadSkillsDir.ts` (~143 行) | SKILL.md 加载（`~/.claude/skills` + `.claude/skills`）+ slash 解析 + 参数替换 |
| `src/commands.ts` (~370 行) | 20 个内置 slash 命令注册表 |

> **无插件系统**（`enabledPlugins` 在 settings 类型里声明，但无 `plugins/` 目录、无加载逻辑）。详见 [09-skills-and-plugins.md](./09-skills-and-plugins.md)。

### 4.9 UI 与状态

| 文件 | 职责 |
|------|------|
| `src/ink/App.tsx` (~743 行) | Ink REPL 根组件：输入/光标/transcript/spinner/banner/进度条/选择器/对话框 |
| `src/ink/barGlyph.ts` (~30 行) | 进度条渐变字符渲染（`renderBar`） |
| `src/state/store.ts` (~36 行) | 极简 pub/sub `createStore<T>`（`setState(prev=>next)` + `Object.is` 短路 + `subscribe`）——**存在但未被任何代码 import（死代码）** |

> **无 AppState（~450 字段）、无 `useSyncExternalStore` 选择器、无 keybindings/、无 vim/、无 ScrollBox。** 实际状态全在 `App.tsx` 的 `useState`/`useRef`；唯一在用的 pub/sub 是 `TodoWriteTool` 的模块级 store。`src/state/store.ts` 是遗留死代码（文件头自称 "docs §10.1.1"，但无 import 者）——复现时可建空文件保留，或直接不建（不影响构建/运行）。详见 [10-ui-and-state.md](./10-ui-and-state.md)。

### 4.10 服务层

| 目录 | 职责 |
|------|------|
| `src/services/api/` | 手写 Anthropic 兼容客户端（client/stream/types/usage），**单后端**（可配 baseURL） |
| `src/services/compact/` | 上下文压缩 |
| `src/services/hooks/` | Hooks 系统（types/loader/runner/index） |
| `src/services/mcp/` | MCP stdio 客户端 |
| `src/services/session/` | JSONL 会话持久化（store/paths/index） |
| `src/services/extractMemories/` | LLM 记忆抽取 |

> **无 analytics/、无 oauth/、无 bridge/。** 详见 [12-session-bridge.md](./12-session-bridge.md)（该篇实际讲会话持久化，非远程桥接）。

## 5. 无 Feature Flag 体系

harness-code **没有**编译时 feature flag、**没有** GrowthBook 运行时 flag。所有功能在源码中静态决定。环境变量（`HARNESS_*`）仅用于配置覆盖，不剪枝代码路径。

相关环境变量（见 `cli/config.ts`、`memdir/paths.ts`、`context.ts`、`services/mcp/client.ts`）：
- `HARNESS_API_KEY` / `HARNESS_AUTH_TOKEN` — API key
- `HARNESS_BASE_URL` — API base URL
- `HARNESS_MODEL` / `HARNESS_SMALL_MODEL` / `HARNESS_MAX_OUTPUT_TOKENS` — 模型覆盖
- `HARNESS_MEMORY_PATH` / `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` — 记忆目录覆盖
- `HARNESS_DISABLE_CLAUDE_MDS=1` — 禁用 CLAUDE.md 加载
- `API_TIMEOUT_MS` — 请求超时
- `MCP_TIMEOUT` — MCP 连接超时（默认 30s）
- `RUN_API_TESTS=1` — 运行 API 集成测试

## 6. 关键设计原则

### 6.1 Fail-Closed 安全
权限默认拒绝。Bash AST 遍历器遇到未显式处理的节点类型 → `too-complex`（要求确认）。auto 分类器出错 → `shouldBlock=true`。Hooks 出错 → 无决策（仅显式 `block` 拦截）。

### 6.2 读前写原则
`FileEditTool`/`FileWriteTool`/`NotebookEditTool` 强制先 `FileReadTool` 完整读取（`readFileState` 缓存验证 `isFullRead`），并检测 mtime 变化。`canonicalPath` 用 realpath 规范化避免缓存键失配。

### 6.3 提示缓存优化
系统提示首个 block 带 `cache_control: { type: 'ephemeral' }`；工具列表 `assembleToolPool` 按字母序 + 去重。`assistantBlocksForNextTurn()` 丢弃 thinking/redacted 块（代理 quirk）。

### 6.4 渐进式降级
- `prompt_too_long`(413) → 尝试压缩一次 → 放弃返回 `prompt_too_long`
- `max_output_tokens` → 升级到 64k → 最多 3 次 "Continue" 恢复 → 当作 completed
- 中断 → `yieldMissingToolResultBlocks` 合成 error tool_result → 返回 `aborted_*`

### 6.5 代理感知
手写客户端防御代理 quirk：`call_` 前缀 tool id、空 signature thinking 块、额外 usage 字段。**不**回退 `ANTHROPIC_*` env。默认模型 `gpt-5.5` / small `gpt-5.4-mini`。

### 6.6 非阻塞输入
Agent 运行时用户仍可输入：`/stop` 立即中断；其他 `/` 延迟；普通文本 `enqueueUserMessage` 排队，下一轮 `injectMessages` 注入（不打断当前轮）。

## 7. 模块依赖关系图

```
main.tsx (Commander)
  ├── cli/config.ts          (resolveConfig)
  ├── cli/configFile.ts      (~/.harness-code/config.json)
  ├── utils/permissions/settings.ts (discoverSettings/resolveSettings)
  ├── services/hooks/        (loadHooksFromSettings + createHooksRegistry)
  ├── services/session/      (--resume 会话列举)
  ├── entrypoints/headless.ts (--print 分支)
  ├── QueryEngine.ts
  │     ├── context.ts               (fetchSystemPromptParts)
  │     │     └── memdir/            (loadMemoryPrompt)
  │     ├── cli/modelManager.ts      (运行时 /model 切换)
  │     ├── query.ts                 (核心循环)
  │     │     ├── services/api/      (callModel + stream)
  │     │     ├── query/runTools.ts  (runTools)
  │     │     │     └── services/hooks/ (PreToolUse/PostToolUse)
  │     │     ├── query/abort.ts     (中断合成)
  │     │     └── services/compact/  (autoCompact)
  │     ├── services/session/        (createSession/appendMessages/loadSession)
  │     ├── services/extractMemories/ (/memory save)
  │     └── tools/ExitPlanModeTool/  (plan 审批 handler)
  ├── tools.ts              (getBuiltinTools: 13 个工具)
  ├── permissions/canUseTool.ts (createCanUseTool)
  │     ├── utils/permissions/permissions.ts (决策管线)
  │     └── permissions/classifier.ts (auto 模式)
  └── ink/App.tsx           (launchRepl)
        ├── ink/barGlyph.ts (renderBar)
        ├── commands.ts     (getBuiltinCommands)
        ├── skills/loadSkillsDir.ts (parseSlashCommand/loadAllSkills)
        ├── services/session/ (listSessions)
        ├── memdir/memdir.ts (loadMemoryPrompt)
        └── tools/TodoWriteTool/ (subscribeTodos)
```

## 8. 已知边界 / 未实现项（复现时必须保留）

- **AgentTool 未接线**：注册了但 `configureAgentTool` 从不调用，子代理不可用。
- **AskUserQuestionTool 交互 UI 未接线**：`setAskHandler` 从不调用，REPL 不拦截，headless 自动选第一个选项。REPL 里 `pendingPerm`/`pendingPlan` 的 y/n 对话框是手写的，不走 AskUserQuestionTool。
- **`addNotification`/`sendOSNotification`** 在 `ToolUseContext` 声明但从不填充/调用。
- **无 PushNotification 工具**（系统提示里提到的 PushNotification 在 `getBuiltinTools()` 里不存在）。
- **无 bridge/远程控制/遥测/OAuth/插件/Swarm/coordinator/Vim/ScrollBox/keybindings**。
- **WebFetchTool 无 Haiku 摘要**（只抓取 + HTML→text 截断）。
- **MCP 仅 stdio**。
- **`gray-matter`/`lodash-es` 声明依赖但源码未用**（frontmatter 解析手写）。
