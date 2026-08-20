# 启动与初始化流程

> 基于 `src/main.tsx` (~176 行) + `src/cli/config.ts` + `src/cli/configFile.ts` + `src/utils/permissions/settings.ts` + `src/entrypoints/headless.ts` 实际源码。

## 1. 启动序列概览

harness-code 的启动**没有**并发预热、**没有** MDM/Keychain 预读取、**没有**配置迁移、**没有** setup() 函数。整个过程是 `main.tsx` 顶层一个 Commander `program` 定义 + 一个 `.action()` handler，同步顺序执行：

```
进程启动 (dist/main.js, #!/usr/bin/env node)
   │
   ▼
main.tsx 模块加载
   ├── import { Command } from 'commander'
   ├── const program = new Command()
   └── program.name('harness-code').version('0.1.0')...  ← 注册命令/选项
   │
   ▼
program.parseAsync(process.argv)  ← Commander 解析 argv，调用 .action()
   │
   ▼
.action(async (promptArg, opts) => { ... })  ← 全部初始化逻辑在此
   │
   ├─ [1] --init-config → 写模板配置文件并退出
   ├─ [2] 加载配置文件 (discoverConfigFile) + settings (discoverSettings)
   ├─ [3] resolveConfig 合并 (CLI flag > env > configFile > settings > defaults)
   ├─ [4] 校验 API key（无则报错退出）
   ├─ [5] 解析 permission mode (bypass flag / --permission-mode / settings)
   ├─ [6] 构建 hooks registry (loadHooksFromSettings + createHooksRegistry)
   ├─ [7] --resume [id] → 列举会话，选最新或校验指定 id
   ├─ [8] 分支:
   │      ├─ --print 或 位置参数 prompt → runHeadless()  → 进程结束
   │      └─ 否则 → 交互 REPL:
   │            ├── new ApiClient(config)
   │            ├── getBuiltinTools()  (13 个工具)
   │            ├── new UsageTracker()
   │            ├── permissionContextFromSettings() + permAskHolder
   │            ├── new QueryEngine({...})  ← 构造时加载/创建会话、注册 plan handler
   │            └── launchRepl(engine, cwd, costTracker, config, permAskHolder)
   │
   ▼ (REPL 渲染，或 headless 结束)
.catch(e => stderr + exit(1))  ← parseAsync 的错误兜底
```

## 2. Commander 命令注册

`main.tsx` 顶部注册的唯一命令（无子命令）：

```typescript
program
  .name('harness-code')
  .description('A full-featured terminal coding agent')
  .version('0.1.0')
  .argument('[prompt]', 'optional prompt (runs in headless mode)')
  .option('-p, --print', 'run in headless mode (print result and exit)')
  .option('--output-format <format>', 'output format: text | stream-json', 'text')
  .option('--model <model>', 'model to use')
  .option('--api-key <key>', 'API key')
  .option('--base-url <url>', 'API base URL')
  .option('--max-turns <n>', 'max agent turns', parseInt)
  .option('--permission-mode <mode>', 'permission mode: default | auto | bypassPermissions')
  .option('--dangerously-skip-permissions', 'skip all permission prompts (bypass mode)')
  .option('-r, --resume [id]', 'resume a session (latest if no id given)')
  .option('--plan', 'start in plan mode (research read-only, then approve a plan)')
  .option('--init-config', 'write a template config file to ./.harness-code/config.json and exit')
```

> **无** `claude ssh`/`assistant`/`open`/deep-link/`--continue`/`--from-pr` 等特殊模式。argv 不做重写。

## 3. 配置加载与解析

### 3.1 配置文件发现 (`cli/configFile.ts`)

`discoverConfigFile(cwd)` 读两个位置并浅合并（project 覆盖 user）：

| 位置 | 路径 |
|------|------|
| user | `~/.harness-code/config.json` |
| project | `<cwd>/.harness-code/config.json` |

```typescript
interface HarnessConfigFile {
  apiKey?: string
  baseURL?: string
  model?: string
  smallModel?: string
  maxOutputTokens?: number
  models?: ModelEntry[]   // 模型目录，供 /model 切换
}
interface ModelEntry { id: string; name?: string; maxOutputTokens?: number }
```

合并规则：`{ ...user, ...project, models: project.models ?? user.models }`。返回 `{ config, path }`，`path` 是实际贡献设置的文件路径（project 优先）。

### 3.2 settings 发现 (`utils/permissions/settings.ts`)

`discoverSettings(cwd)` 读三个 Claude Code 兼容位置：

| 来源 | 路径 |
|------|------|
| user | `~/.claude/settings.json` |
| project | `<cwd>/.claude/settings.json` |
| local | `<cwd>/.claude/settings.local.json` (gitignored) |

> **注意：** harness-code 复用 `~/.claude/settings.json`（Claude Code 的路径），但配置文件用独立的 `~/.harness-code/config.json`。`flag`/`policy` 来源在 `SettingsSources` 类型里声明，但 `discoverSettings` **不**填充它们（无 `--settings` flag、无 MDM policy 读取）。

### 3.3 settings 合并 (`resolveSettings`)

合并顺序（低 → 高）：`user → project → local → flag → policy`（后两者实际为空）。

- `permissions.allow/deny/ask` 数组：跨源追加 + 去重（按精确字符串）
- `permissions.defaultMode`：后者覆盖
- `mcpServers`/`enabledPlugins`：对象合并
- 其他标量：后者覆盖

同时构建扁平 `permissionRules: PermissionRule[]`，每条带 source 标签，跨源按 `(behavior, toolName, ruleContent)` 去重（高优先源胜）。

```typescript
interface Settings {
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[]; defaultMode?: 'default'|'auto'|'bypassPermissions' }
  apiKey?: string; baseURL?: string; model?: string; smallModel?: string; maxOutputTokens?: number
  mcpServers?: Record<string, unknown>
  enabledPlugins?: Record<string, boolean>   // 声明但无加载逻辑
  autoMemoryDirectory?: string
  hooks?: Record<string, unknown>            // 事件名 → matcher 数组
}
```

### 3.4 最终配置解析 (`cli/config.ts` `resolveConfig`)

优先级（高 → 低）：

```
1. CLI flag (--api-key / --base-url / --model)
2. 环境变量 (HARNESS_API_KEY / HARNESS_AUTH_TOKEN / HARNESS_BASE_URL / HARNESS_MODEL / HARNESS_SMALL_MODEL / HARNESS_MAX_OUTPUT_TOKENS)
3. 配置文件 (~/.harness-code + .harness-code)
4. settings (~/.claude/settings.json 等)
5. 内置默认值
```

默认值：
```typescript
DEFAULT_BASE_URL = ''           // 空！必须显式提供，绝不硬编码端点
DEFAULT_MODEL = 'gpt-5.5'
DEFAULT_SMALL_MODEL = 'gpt-5.4-mini'
DEFAULT_MAX_OUTPUT_TOKENS = 8192
DEFAULT_TIMEOUT_MS = 600_000    // 10 分钟
```

> **关键安全决策：** `envVar()` **故意不**回退到 `ANTHROPIC_*`。文件头注释说明：harness-code 是独立工具，读 `ANTHROPIC_*` 会误用开发者的 Claude Code shell env（如 `ANTHROPIC_BASE_URL` 指向别的代理），静默路由到错误端点。

返回 `ApiConfig { apiKey, baseURL (去尾斜杠), model, smallModel, maxOutputTokens, timeoutMs (API_TIMEOUT_MS 或默认), models, configFilePath }`。

### 3.5 `--init-config`

`writeTemplateConfig(cwd)` 写 `<cwd>/.harness-code/config.json` 模板（含示例 apiKey/baseURL/model/smallModel/maxOutputTokens + 5 个模型目录条目），stdout 提示后 `return`（不进 REPL）。

## 4. API Key 校验

```typescript
if (!config.apiKey) {
  process.stderr.write('Error: no API key.\n')
  if (!configExists(cwd)) {
    process.stderr.write('Create a config file with `harness-code --init-config`, or set HARNESS_API_KEY, or pass --api-key.\n')
  }
  process.exit(1)
}
```

## 5. 权限模式解析

```typescript
const mode: PermissionMode = opts.dangerouslySkipPermissions
  ? 'bypassPermissions'
  : opts.permissionMode ?? settings.permissions?.defaultMode ?? 'default'
```

三种模式：`default`（写工具 ask、只读 allow）、`auto`（写工具由 AI 分类器判定）、`bypassPermissions`（全放行，但受保护路径仍 ask）。

## 6. Hooks Registry 构建

```typescript
const hooks: HooksRegistry = createHooksRegistry(
  loadHooksFromSettings(settings.hooks),
)
```

`loadHooksFromSettings` 容错解析 `settings.hooks`（事件名 → matcher 数组），只保留 `command`/`function` 类型（`http`/`prompt`/`agent` 加载但执行时跳过）。详见 [05-permission-and-hooks.md](./05-permission-and-hooks.md)。

## 7. 会话恢复 (`--resume [id]`)

```typescript
if (opts.resume !== undefined) {
  const { listSessions } = await import('./services/session/index.js')  // 懒加载
  const sessions = listSessions(cwd)   // 按 updatedAt 降序
  if (typeof opts.resume === 'string') {
    // 指定 id：校验存在，否则 stderr + exit(1)
    if (!sessions.some(s => s.id === opts.resume)) { stderr; exit(1) }
    resumeSessionId = opts.resume
  } else if (sessions.length > 0) {
    // 无 id：取最新
    resumeSessionId = sessions[0].id
    process.stderr.write(`Resuming latest session: ... (${sessions[0].messageCount} messages)\n`)
  } else {
    process.stderr.write('No previous sessions found for this directory; starting fresh.\n')
  }
}
```

> `listSessions` 是**懒加载**的（动态 import），避免启动时无谓加载会话模块。

## 8. Headless 分支

当 `opts.print` 或 `promptArg`（位置参数）存在时走 headless：

```typescript
if (opts.print || promptArg) {
  const prompt = promptArg ?? ''
  if (!prompt) { stderr('--print requires a prompt argument.'); exit(1) }
  await runHeadless({
    prompt, cwd,
    outputFormat: opts.outputFormat as 'text'|'stream-json',
    maxTurns: opts.maxTurns,
    permissionMode: mode,
    config, hooks,
    sessionId: resumeSessionId,
  })
  return   // 进程结束
}
```

`runHeadless`（`entrypoints/headless.ts`）：
- 用 `opts.config ?? resolveConfig()`（注意：main.tsx 已传 config，所以用传入的）
- `resolveSettings(discoverSettings(cwd))` + `opts.hooks ?? createHooksRegistry(...)`
- `permCtx = { ...permissionContextFromSettings(settings, opts.permissionMode ?? 'auto'), avoidPrompts: true }`
  - **headless 默认 auto 模式** + `avoidPrompts: true`（ask → deny）
- `new QueryEngine({...})`，`maxTurns: opts.maxTurns ?? 30`
- `engine.submitMessage(opts.prompt, callbacks)`
- callbacks 把事件写到 stdout（text 模式流式文本；`stream-json` 模式 NDJSON）
- 结束后 text 模式补尾换行；error 写 stderr

`stream-json` 输出的事件类型（每行一个 JSON）：
- `{ type: 'stream_event', subtype: 'text_delta', text }`
- `{ type: 'tool_use', name, input }`
- `{ type: 'tool_result', name, isError, result }`
- `{ type: 'assistant_message', message }`
- `{ type: 'result', reason, error }`（最后一行）

## 9. 交互 REPL 分支

```typescript
const client = new ApiClient(config)
const tools = getBuiltinTools()                          // 13 个工具
const costTracker = new UsageTracker()
const permCtx = permissionContextFromSettings(settings, mode)

// 权限 ask 回调 holder（REPL 挂载时注入；注入前 ask → deny）
const permAskHolder = { cb?: ... } = {}

const engine = new QueryEngine({
  client, tools,
  model: config.model, smallModel: config.smallModel, models: config.models,
  maxOutputTokens: config.maxOutputTokens,
  maxTurns: opts.maxTurns ?? 50,
  cwd,
  canUseTool: createCanUseTool(permCtx, {
    classify: { client, smallModel: config.smallModel },
    onAsk: async (tool, input, reason) => {
      if (permAskHolder.cb) return permAskHolder.cb(tool.name, input, reason)
      return false   // 无交互 handler → deny（安全默认）
    },
  }),
  permCtx,                                            // 可变，/bypass 运行时改 mode
  autoCompact: createAutoCompact({ client, model: config.smallModel, contextWindow: DEFAULT_CONTEXT_WINDOW, hooks, hooksCwd: cwd }),
  hooks,
  sessionId: resumeSessionId,
  startInPlanMode: opts.plan,
})

launchRepl(engine, cwd, costTracker, config, permAskHolder)
```

### 9.1 QueryEngine 构造期的副作用

`new QueryEngine(opts)` 构造时（`QueryEngine.ts`）：
1. `createFileStateCache()` — 文件读状态缓存
2. `fetchSystemPromptParts({...})` — 组装系统提示（默认 prompt + CLAUDE.md + git status + 日期 + memory），见 [06-context-and-memory.md](./06-context-and-memory.md)
3. `new ModelManager({...})` — 模型管理（运行时 /model 切换）
4. hooks registry（`opts.hooks ?? emptyRegistry()`）+ hooksLog（默认 `console.warn('[hooks] ...')`）
5. `permCtx` 引用保存（可变）
6. `planMode = !!opts.startInPlanMode`
7. **会话持久化**：
   - `disableSessionPersistence` → `sessionId = null`
   - `opts.sessionId` → `loadSession(cwd, sessionId)` 加载历史消息
   - 否则 → `createSession(cwd, model)` 新建（生成 id + 写空 meta + 空 transcript）
8. `fireHooks('SessionStart', { cwd })` — fire-and-forget，observe-only
9. `registerPlanApprovalHandler()` — 注册 ExitPlanMode 审批 handler（包装 UI 回调；approve 时退出 plan 模式）

### 9.2 `launchRepl`

`ink/App.tsx` 的 `launchRepl`：

```typescript
render(<App engine={engine} cwd={cwd} costTracker={costTracker} config={config} permAskHolder={permAskHolder} />, {
  exitOnCtrlC: false,   // 自己在 useInput 里处理 Ctrl+C
})
```

> `exitOnCtrlC: false` 是关键：Ink 默认首个 Ctrl+C 就杀进程，会绕过自写的双击退出逻辑。banner 作为 `<Static>` 的首个 item 渲染（持久在 scrollback， survives /resume remount）。

## 10. 关键环境变量

| 变量 | 作用 | 默认 |
|------|------|------|
| `HARNESS_API_KEY` / `HARNESS_AUTH_TOKEN` | API key | — |
| `HARNESS_BASE_URL` | API base URL | `''`（必须显式提供） |
| `HARNESS_MODEL` | 主模型 | `gpt-5.5` |
| `HARNESS_SMALL_MODEL` | 小模型（压缩/抽取/分类） | `gpt-5.4-mini` |
| `HARNESS_MAX_OUTPUT_TOKENS` | 单请求最大输出 tokens | `8192` |
| `API_TIMEOUT_MS` | API 请求超时 | `600000` (10 min) |
| `MCP_TIMEOUT` | MCP 连接超时 | `30000` |
| `HARNESS_MEMORY_PATH` / `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` | 记忆目录覆盖 | git root 派生 |
| `HARNESS_DISABLE_CLAUDE_MDS` | `=1` 禁用 CLAUDE.md 加载 | 启用 |
| `RUN_API_TESTS` | `=1` 运行 API 集成测试 | — |

> **无** `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`（单后端，靠 `baseURL` 配置）。**无** `CLAUDE_CODE_SIMPLE/COORDINATOR_MODE` 等。

## 11. 已知边界 / 未实现项

- **无** MDM/Keychain 并发预读取、**无** `setup()` 函数、**无**配置迁移系统、**无** UDS/Swarm 服务器、**无** FileChanged watcher、**无** worktree 创建、**无** 插件预热、**无** GrowthBook/feature flag、**无** 延迟预热 (`startDeferredPrefetches`)。
- **无** `--continue`/`--from-pr`/`ssh`/`assistant`/deep-link 模式。
- **无** argv 重写、**无** clientType 检测。
- `flag`/`policy` settings 来源在类型里声明但 `discoverSettings` 不填充。
- MCP 服务器**未在启动时连接**（`connectAllServers` 存在但 `main.tsx`/`QueryEngine` 不调用它——MCP 工具不进入工具池）。见 [07-mcp-integration.md](./07-mcp-integration.md)。
