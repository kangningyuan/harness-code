# harness-code 源码技术文档

> 本文档集基于 **harness-code v0.1.0**（`/Users/ykn/harness-code`，`package.json` name=`harness-code`）的实际源码反向整理撰写。
> 目标：当任何 coding agent 拿到本 `docs/` 文件夹时，能够 **百分百完整复现** 当前 harness-code 项目的代码实现——包括 CLI 的 UI 交互细节（光标逻辑、logo 显示、信息显示等）、工具系统、权限管线、Bash 安全分析、MCP 集成、会话持久化等。
>
> **重要前提：** 本项目**不是** Anthropic 官方 Claude Code。它是一个独立实现的终端 Coding Agent，参考了 Claude Code 的整体设计，但在很多子系统上是刻意简化的实现。文档中凡涉及"未实现 / 占位 / disabled / deferred"的说明，都是源码里真实存在的状态——复现时必须原样保留这些行为，**不要**补全成 Claude Code 的完整形态。每篇文档末尾都有"已知边界/未实现项"小节。

## 技术栈（以 `package.json` 为准）

```jsonc
{
  "name": "harness-code",
  "version": "0.1.0",
  "type": "module",            // ESM
  "bin": { "harness-code": "dist/main.js" },
  "engines": { "node": ">=18" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",  // MCP 客户端（stdio）
    "commander": "^15.0.0",                  // CLI 参数解析
    "fast-glob": "^3.3.3",                   // GlobTool
    "gray-matter": "^4.0.3",                 // （依赖声明，源码中未直接使用；见下）
    "ink": "^7.1.0",                         // 终端 React 渲染
    "lodash-es": "^4.18.1",                  // （依赖声明，源码中未直接使用）
    "react": "^19.2.7",
    "react-reconciler": "^0.33.0",           // ink 的依赖
    "yoga-layout": "^3.2.1",                 // ink 的 flexbox 布局
    "zod": "^4.4.3"                          // 工具输入校验 + JSON schema 生成
  }
}
```

构建工具：`tsup`（ESM 单入口打包，`src/main.tsx` → `dist/main.js`，加 `#!/usr/bin/env node` banner）。测试：`vitest`。类型检查：`tsc --noEmit`（`tsconfig.json`，`strict: true` + `noUncheckedIndexedAccess: true`）。

> **关于 `gray-matter` / `lodash-es`：** 这两个在 `package.json` 里声明了依赖，但源码里**没有**直接 import（frontmatter 解析是手写的，见 `memdir/memdir.ts` 和 `skills/loadSkillsDir.ts`）。`tsup.config.ts` 的 `external` 列表里也没有它们。复现时保留依赖声明即可，不要为了"用上"而改写解析逻辑。

## 文档目录

| 文档 | 内容 |
|------|------|
| [01 - 架构总览](./01-architecture-overview.md) | 整体架构、模块职责、数据流、目录结构、设计原则 |
| [02 - 启动与初始化](./02-startup-and-initialization.md) | Commander 命令注册、配置解析优先级、会话恢复、headless/REPL 分支 |
| [03 - 核心 Agent 循环](./03-agentic-loop.md) | `query()` while 循环、流式累加、工具执行、错误恢复、中断协议 |
| [04 - 工具系统](./04-tool-system.md) | `Tool` 接口、`buildTool()` 工厂、13 个内置工具逐一详解 |
| [05 - 权限与 Hooks](./05-permission-and-hooks.md) | 权限决策管线、规则匹配、三种模式、Hooks 类型与执行 |
| [06 - 上下文与记忆](./06-context-and-memory.md) | 系统提示组装、CLAUDE.md 发现、自动记忆目录、会话记忆 |
| [07 - MCP 集成](./07-mcp-integration.md) | stdio 传输、连接流程、工具发现与包装、批量并发 |
| [08 - 多 Agent 系统](./08-multi-agent-system.md) | AgentTool 子代理、Plan 模式（含真实状态：AgentTool 当前未接线） |
| [09 - 技能与插件](./09-skills-and-plugins.md) | SKILL.md 加载、Slash 命令注册表、SkillTool（无插件系统） |
| [10 - UI 与状态管理](./10-ui-and-state.md) | Ink REPL、光标逻辑、banner、spinner、进度条、交互选择器、成本追踪 |
| [11 - 安全机制](./11-security-and-bash-safety.md) | Bash AST 安全分析、文件系统安全、受保护路径、读前写 |
| [12 - 会话持久化](./12-session-bridge.md) | JSONL 会话存储、`/resume` `/history`、meta sidecar（**无远程桥接**） |

## 核心概念速查

### 关键文件（以源码实际行数为准）

```
src/main.tsx                ← CLI 入口（Commander 注册，~176 行）
src/QueryEngine.ts          ← 会话编排器（~413 行）
src/query.ts                ← 核心 Agent while 循环（~275 行）
src/query/runTools.ts       ← 工具批量执行（~254 行）
src/query/abort.ts          ← 中断协议：合成缺失的 tool_result（~51 行）
src/Tool.ts                 ← 工具接口 + buildTool() + Zod→JSON schema（~278 行）
src/tools.ts                ← 工具注册表 + assembleToolPool（~77 行）
src/commands.ts             ← Slash 命令注册表（~371 行）
src/context.ts              ← 系统提示组装 + CLAUDE.md/git status（~219 行）
src/ink/App.tsx             ← Ink REPL 根组件（~743 行，UI 核心）
src/ink/barGlyph.ts         ← 进度条渐变字符渲染（~30 行）
src/entrypoints/headless.ts ← --print 无 TUI 模式（~117 行）
```

### 关键服务

```
src/services/api/client.ts      ← 手写 Anthropic 兼容 API 客户端（~230 行）
src/services/api/stream.ts      ← SSE 流解析 + StreamAccumulator（~330 行）
src/services/api/types.ts       ← 消息/内容块/Usage 类型（~119 行）
src/services/api/usage.ts       ← token 用量 + 成本追踪（~101 行）
src/services/compact/compact.ts ← 上下文压缩（~220 行）
src/services/extractMemories/   ← /memory save LLM 抽取（extract.ts ~213 行）
src/services/hooks/             ← Hooks 系统（types/loader/runner）
src/services/mcp/client.ts      ← MCP stdio 客户端（~158 行）
src/services/session/           ← JSONL 会话持久化（store.ts ~189 行）
src/memdir/                     ← 自动记忆目录（memdir.ts + paths.ts）
src/skills/loadSkillsDir.ts     ← SKILL.md 加载（~143 行）
src/cli/config.ts               ← 配置解析（~119 行）
src/cli/configFile.ts           ← ~/.harness-code/config.json（~108 行）
src/cli/modelManager.ts         ← 运行时模型切换（~95 行）
```

### 关键安全文件

```
src/utils/permissions/permissions.ts      ← 权限决策管线（~198 行）
src/utils/permissions/permissionRuleParser.ts ← 规则字符串解析（~138 行）
src/utils/permissions/shellRuleMatching.ts ← Bash 命令规则匹配（~111 行）
src/utils/permissions/dangerousPatterns.ts ← 受保护路径（.git/.claude 等）（~50 行）
src/utils/permissions/settings.ts         ← settings 合并（~167 行）
src/permissions/canUseTool.ts             ← 把管线接进 runTools（~68 行）
src/permissions/classifier.ts             ← auto 模式 AI 分类器（~125 行）
src/utils/bash/bashParser.ts              ← 手写 Bash 解析器（~492 行）
src/utils/bash/ast.ts                     ← AST 安全遍历器（~469 行）
src/utils/bash/lexer.ts                   ← Bash 词法分析（~437 行）
src/utils/bash/types.ts                   ← AST 节点类型（~219 行）
```

## 设计哲学

### 1. Fail-Closed 安全
所有安全相关决策默认拒绝：
- Bash AST 分析：未显式处理的节点类型 → `too-complex`（要求用户确认）
- 工具并发：`isConcurrencySafe` 默认 `false`（串行执行）
- 权限检查：`isReadOnly` 默认 `false`（当作写操作处理）
- auto 模式分类器出错/超时/非 JSON → `shouldBlock=true`（拒绝）
- Hooks 出错/超时 → 记日志 + 当作无决策（只有显式 `block` 才拦截）

### 2. 读前写原则（Read-Before-Write）
`FileEditTool`、`FileWriteTool`、`NotebookEditTool` 强制要求先 `FileReadTool` 完整读取文件，并检测 mtime 变化（防止覆盖外部修改）。新建文件跳过读要求。路径经 `canonicalPath`（realpath）规范化，避免 `/var` vs `/private/var` 导致缓存键失配。

### 3. 提示缓存优化
系统提示首个 block 带 `cache_control: { type: 'ephemeral' }`；工具列表按字母序排列（`assembleToolPool`）。`assistantBlocksForNextTurn()` 在下一轮丢弃 thinking/redacted_thinking 块（代理代理 quirk：mimo 会发空 signature 的 thinking 块，不回传）。

### 4. 渐进式降级
错误恢复链：`prompt_too_long`(413) → 尝试压缩一次 → 放弃；`max_output_tokens` → 升级到 64k → 最多 3 次 "Continue from where you left off" 恢复 → 报错/当作完成；中断 → 合成缺失的 tool_result 块。

### 5. 代理感知（Proxy-Aware）
API 客户端是手写的 `fetch` + SSE 解析器，**不**用 `@anthropic-ai/sdk`。目标端点是 Anthropic 兼容代理（非真 Anthropic），需防御代理 quirk：
- tool_use id 用 `call_` 前缀（非 `toolu_`）→ 当不透明字符串处理
- mimo 发空 signature 的 thinking 块即使未请求 → 透传但不回传
- usage 可能含额外 `claude_cache_*` 字段 → 只读标准字段
- 默认模型是 `gpt-5.5`，small 模型 `gpt-5.4-mini`（**不**硬编码 Claude 模型 id）
- **故意不**回退到 `ANTHROPIC_*` 环境变量（会误用开发者的 Claude Code shell env）

### 6. 非阻塞输入
Agent 运行时，用户仍可输入：`/stop` 立即中断；其他 `/` 命令延迟到 idle；普通文本排队，在下一轮 `callModel` 前 `injectMessages` 注入（不打断当前轮）。

## 实现指南

若要基于此文档复现 harness-code，建议的实现顺序（对应 docs 各篇）：

1. **类型与配置** → `services/api/types.ts`（消息/块/Usage）+ `cli/config.ts`（配置优先级）
2. **工具接口** → `Tool.ts` 的 `ToolDefinition` + `buildTool()` + Zod→JSON schema 转换
3. **API 客户端** → `services/api/client.ts` + `stream.ts`（手写 SSE）
4. **核心循环** → `query.ts` 的 `while(true)` + `query/runTools.ts` + `query/abort.ts`
5. **会话编排** → `QueryEngine.ts`（多轮历史、模型管理、plan 模式、会话持久化）
6. **上下文** → `context.ts`（系统提示 + CLAUDE.md + git status + memory）
7. **权限** → `permissions.ts` 决策管线 + `canUseTool.ts` + `classifier.ts`
8. **Bash 安全** → `utils/bash/`（lexer → parser → ast 安全遍历）
9. **内置工具** → 13 个工具（FileRead/Edit/Write, Bash, Glob, Grep, Todo, Ask, WebFetch, Notebook, Agent, Skill, ExitPlanMode）
10. **Hooks** → `services/hooks/`（command + function 两种类型）
11. **MCP** → `services/mcp/client.ts`（stdio，批量并发 3）
12. **会话存储** → `services/session/`（JSONL + meta sidecar）
13. **记忆** → `memdir/` + `services/extractMemories/`
14. **UI** → `ink/App.tsx`（Ink REPL，光标/spinner/banner/进度条/选择器）+ `ink/barGlyph.ts`
15. **Slash 命令** → `commands.ts`（21 个命令）
16. **入口** → `main.tsx`（Commander）+ `entrypoints/headless.ts`

## 项目来源与许可

harness-code 是一个独立的开源终端 Coding Agent（MIT 许可，`package.json` `license: "MIT"`）。本项目源码位于 `/Users/ykn/harness-code`。本文档集基于该实际源码整理，用于让其他 agent 能完整复现本项目。
