# 权限系统与 Hooks

> 基于 `src/utils/permissions/` (permissions/settings/permissionRuleParser/shellRuleMatching/dangerousPatterns) + `src/permissions/` (canUseTool/classifier) + `src/services/hooks/` (types/loader/runner/index) 实际源码。

## 1. 权限系统架构

### 1.1 规则字符串解析 (`permissionRuleParser.ts`)

规则字符串格式：`"ToolName"` 或 `"ToolName(content)"`。

```typescript
interface PermissionRule {
  source: RuleSource          // userSettings | projectSettings | localSettings | flagSettings | policySettings | cliArg | command | session
  ruleBehavior: 'allow' | 'deny' | 'ask'
  ruleValue: { toolName: string; ruleContent?: string }
}
```

`parsePermissionRuleString(str, source, behavior)`：
- 无括号 → 工具级规则（`ruleContent` 为空）。若含 `()\` stray → 返回 null（malformed）
- `"Bash(*)"` 和 `"Bash()"` → 降级为工具级规则（无 `ruleContent`）
- 否则取括号内 `rawContent`，转义处理：`\(` → `(`、`\)` → `)`、`\\` → `\`
- 闭合括号后还有内容 → null
- `toolName` 含 `\` → null

`parsePermissionRules(strings, source, behavior)`：批解析 + 同源内按精确字符串去重。

### 1.2 Bash 命令规则匹配 (`shellRuleMatching.ts`)

`ruleContent` 解析成三种匹配类型：

| 类型 | 示例 | 匹配 |
|------|------|------|
| exact | `"npm install"` | 字符串相等 |
| prefix（legacy） | `"npm:*"` | `=== prefix` 或 `startsWith(prefix + ' ')` |
| wildcard | `"npm * --save"` | `*` → `.*`，`\*` → 字面 `*` |

`parseShellRule(ruleContent)`：
- 以 `:*` 结尾 → prefix
- 含未转义 `*` 或以 `*` 开头 → wildcard（`wildcardToRegex`）
- 否则 exact

**特殊**：以 ` *`（空格+星）结尾的模式同时匹配 `"prefix arg"` 和裸 `"prefix"`（trailing space+arg 可选）→ 正则加 `( .*)?`。

`findMatchingShellRule(rules, command)`：过滤 `Bash`/`BashTool` 工具且有 `ruleContent` 的规则，按优先级 `deny(3) > ask(2) > allow(1)` 返回最高优先级匹配。

`isCompoundCommand(command)`：含 `&&`/`||`/`;`/`|` → 复合命令（prefix 规则不匹配复合命令的守卫辅助）。

### 1.3 受保护路径 (`dangerousPatterns.ts`)

```typescript
export const SAFETY_CHECK_PATHS = [
  '.git/', '.claude/', '.vscode/',
  '.bashrc', '.zshrc', '.profile', '.bash_profile', '.zprofile',
  '.config/fish/config.fish',
]
```

`isSafetyCheckPath(path, cwd)`：`canonicalPath` 后检查是否落在受保护目录/文件。`bashCommandTouchesSafetyPath(command)`：启发式检查 Bash 命令是否写受保护路径（`>`/`>>`/`tee`/`cp`/`mv`/`rm`/`mkdir`/`touch` + 含受保护路径字串）。

## 2. 权限决策管线 (`permissions.ts`)

```typescript
export type PermissionMode = 'default' | 'auto' | 'bypassPermissions'

interface PermissionContext {
  mode: PermissionMode
  rules: PermissionRule[]
  avoidPrompts?: boolean   // headless：ask → deny
}

type PermissionDecision =
  | { behavior: 'allow'; reason: string }
  | { behavior: 'deny'; reason: string }
  | { behavior: 'ask'; reason: string }
```

### 2.1 `hasPermissionsToUseTool(tool, input, context, permCtx)` 决策序列

```
Step 1a: 工具级 deny 规则（bypass-immune）
   └─ rules 里 behavior='deny' && toolName 匹配 && 无 ruleContent → deny "Denied by tool-level rule"

Step 1b: 工具级 ask 规则（记录，bypass-immune）
   └─ behavior='ask' && toolName 匹配 && 无 ruleContent → toolLevelAsk

Step 1c: tool.checkPermissions(input, context)
   └─ 默认 passthrough（buildTool 注入）

Step 1d: toolPerm.behavior === 'deny' → 传播 deny

Step 1g: 受保护路径安全检查（bypass-immune）
   └─ checkSafetyPaths(tool, input, context) → ask（写 .git/.claude/.vscode/shell 配置）

Step 1e/1f: toolLevelAsk 存在 → ask "Asking per tool-level ask rule"（bypass-immune）

   toolPerm.behavior === 'allow' → allow "Tool allowed"

   Bash: 内容级 shell 规则匹配（findMatchingShellRule）
      └─ deny/allow/ask

   文件工具: 路径规则匹配（checkPathRules）
      └─ 按优先级 deny>ask>allow

Step 2a: permCtx.mode === 'bypassPermissions' → allow "Bypass permissions mode"

Step 2b: tool.isReadOnly(input) → allow "Allowed (read-only)"   ← auto 和 default 模式都放行只读

Step 3: passthrough →
   ├─ avoidPrompts → deny "No matching allow rule (headless)"
   └─ 否则 → ask "No matching rule; asking user"
```

**Bypass-immune 层**（即使 `--dangerously-skip-permissions` 也不跳过）：
- 工具级 deny 规则（Step 1a）
- 工具级 ask 规则（Step 1e/1f）
- 受保护路径安全检查（Step 1g）

### 2.2 `checkSafetyPaths`

只对非只读工具检查。BashTool 查 `bashCommandTouchesSafetyPath`；文件工具查 `input.file_path`/`notebook_path`/`path` 是否 `isSafetyCheckPath`。命中返回 reason 字符串。

### 2.3 `checkPathRules`

对文件工具的 `file_path`/`notebook_path`/`path`，按 `(toolName, 有 ruleContent)` 过滤规则，`pathMatchesPattern` 匹配（`/*` 后缀、`/**` 后缀、前缀或相等），按 `deny>ask>allow` 选最佳。

### 2.4 `permissionContextFromSettings(settings, modeOverride?)`

```typescript
{ mode: modeOverride ?? settings.permissions?.defaultMode ?? 'default', rules: settings.permissionRules }
```

## 3. `canUseTool` — 接进 runTools (`canUseTool.ts`)

```typescript
export function createCanUseTool(permCtx: PermissionContext, options: CanUseToolOptions = {}): CanUseTool
```

返回 `(tool, input) => Promise<{ behavior: 'allow'|'deny'; message? }>`：

```
decision = hasPermissionsToUseTool(tool, input, context, permCtx)
   ├─ allow → { behavior: 'allow' }
   ├─ deny  → { behavior: 'deny', message: decision.reason }
   └─ ask:
        ├─ mode === 'auto' && options.classify → classifyYoloAction(...)
        │     ├─ shouldBlock → { behavior: 'deny', message: verdict.reason }
        │     └─ 否则 → { behavior: 'allow' }
        ├─ options.onAsk → await onAsk(tool, input, reason)
        │     ├─ approved → { behavior: 'allow' }
        │     └─ 拒绝 → { behavior: 'deny', message: reason }
        └─ 无 handler（headless）→ { behavior: 'deny', message: reason }
```

> `context` 是最小伪造的 `ToolUseContext`（`cwd: process.cwd()`，空 readFileState）——管线只读 cwd + isReadOnly。

**`onAsk`**（main.tsx 注入）：REPL 挂载时 `permAskHolder.cb` 被设为弹出 y/n 对话框的回调；注入前 ask → deny（安全默认）。headless 不注入 `onAsk`，且 `avoidPrompts: true` 使管线直接 deny。

## 4. auto 模式 AI 分类器 (`classifier.ts`)

`classifyYoloAction({ client, smallModel, toolName, input })`：调小模型判定工具动作是否安全自动批准。

```
key = `${toolName}:${sha256(JSON.stringify(input)).slice(0,16)}`   ← 缓存键
cache.get(key) 命中 → 直接返回
否则 callClassifier:
   client.callOnce({
     model: smallModel, max_tokens: 256,
     system: "安全分类器...BLOCK 破坏性/不可逆/受保护路径/危险命令/外发数据；ALLOW 普通安全操作；不确定 BLOCK；只返回 JSON {shouldBlock, reason}",
     messages: [{ role:'user', content: `Tool: ${toolName}\nInput: ${JSON.stringify(input).slice(0,4000)}` }]
   })
   → parseClassifierJson(text)
   出错/超时/非 JSON → { shouldBlock: true, failed: true }   ← fail-closed
cache.set(key, result)（LRU 上限 200）
```

`parseClassifierJson`：剥 markdown fence，找首个平衡 `{...}`，`JSON.parse`，`shouldBlock !== false` 视为 block（即缺省 block）。

> 结果按 `(toolName, inputHash)` 缓存（Map，上限 200，淘汰最旧）。`clearClassifierCache()` 供测试。

## 5. Hooks 系统 (`services/hooks/`)

### 5.1 类型 (`types.ts`)

```typescript
type HookEvent = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'SessionStart' | 'SessionEnd' | 'Stop' | 'PreCompact' | 'PostCompact'

type HookType = 'command' | 'function' | 'http' | 'prompt' | 'agent'   // v1 只实现 command/function

interface HookCommand {
  type: HookType
  command?: string                    // type='command' 的 shell 命令
  function?: (ctx: { input: HookInput; event: HookEvent }) => unknown | Promise<unknown>  // type='function'
  timeout?: number                    // 默认 60_000（command），N/A（function）
}

interface HookMatcher { matcher?: string; hooks: HookCommand[] }   // matcher 是工具名 glob（PreToolUse/PostToolUse）

interface HookInput {
  cwd: string
  toolName?: string; input?: Record<string, unknown>; toolResult?: unknown; isError?: boolean
  messages?: unknown[]; reason?: string
}

interface HookOutcome { decision?: 'block' | 'approve'; reason?: string }
```

**PreToolUse 决策语义**：
- `{ decision: 'block' }` → 拒绝工具（带 reason）
- `{ decision: 'approve' }` → 跳过权限 ask（deny 规则仍生效）
- 无 decision → observe-only，落入权限管线

**其他事件**：全部 observe-only（`decision` 被忽略）。

**Fail-closed-but-not-blocking**：hook 出错/超时 → 记日志 + 当作无决策；只有显式 `block` 才拦截。

### 5.2 加载 (`loader.ts`)

`loadHooksFromSettings(raw)`：容错解析 `settings.hooks`（事件名 → matcher 数组）。只保留 `command`/`function` 类型（`http`/`prompt`/`agent` 加载以便配置 round-trip，执行时跳过）。

`functionHooksToMatchers(registered)`：把进程内注册的 function hooks 转成 matcher map（供编程式注册）。

`mergeHooks(a, b)`：settings matchers 在前，function matchers 在后（config hooks 先跑）。

### 5.3 执行 (`runner.ts`)

```typescript
interface HooksRegistry { matchers: Record<HookEvent, HookMatcher[]> }

export async function runHooks(registry, event, input, ctx: RunHooksContext): Promise<HookOutcome>
```

流程：
1. 取 `registry.matchers[event]`；PreToolUse/PostToolUse 按 `hookMatches(matcher, toolName)` 过滤（`*` 或 omit = 全匹配；简单 glob `*` → `.*`）
2. 收集所有匹配的 hook commands
3. `Promise.all` **并发**执行所有 hook（每个 `.catch` 吞错为 `{}`）
4. 聚合：**首个 `block` 胜**（带其 reason）；否则**首个 `approve` 胜**；否则 `{}`

**`runOne`**：
- `function` → 调 `cmd.function({ input, event })`，`coerceOutcome`（只认 `decision: 'block'|'approve'`）
- `command` → `runCommandHook`：`spawn(command, { shell: true, cwd, env, stdio: ['pipe','pipe','pipe'] })`，stdin 喂 `JSON.stringify({ event, ...input })`，stdout 解析为 `HookOutcome`（非 JSON → 无决策），超时 SIGKILL + 记日志 + 返回 `{}`
- `http`/`prompt`/`agent` → 记日志 "not implemented in v1 — skipping"，返回 `{}`

`DEFAULT_COMMAND_TIMEOUT = 60_000`。

### 5.4 registry 构建

`createHooksRegistry(matchers)` / `emptyRegistry()`。main.tsx：
```typescript
createHooksRegistry(loadHooksFromSettings(settings.hooks))
```

## 6. 三种权限模式行为对比

| 场景 | default | auto | bypassPermissions |
|------|---------|------|-------------------|
| 只读工具 | allow | allow | allow |
| 写工具（无规则） | ask（REPL y/n / headless deny） | AI 分类器判定 | allow |
| 写工具（allow 规则） | allow | allow | allow |
| 工具级 deny 规则 | deny | deny | deny（bypass-immune） |
| 工具级 ask 规则 | ask | ask | ask（bypass-immune） |
| 受保护路径（.git 等） | ask | ask | ask（bypass-immune） |
| headless（avoidPrompts） | ask → deny | 分类器判定 | allow |

## 7. Slash 命令对权限的影响

`/bypass [on|off|auto]`（`commands.ts`）调 `ctx.setPermissionMode`：
- `off`/`default` → `default`
- `auto` → `auto`
- 无参/`on` → `bypassPermissions`（带 ⚠ 警告）

`QueryEngine.setPermissionMode(mode)` 直接改 `permCtx.mode`（可变引用，下一轮工具检查生效）。footer 显示当前 mode。

## 8. 已知边界 / 未实现项

- **`flag`/`policy` settings 来源声明但不填充**（无 `--settings` flag、无 MDM policy 读取）。
- **Hooks 仅 command + function**（http/prompt/agent 声明但执行时跳过）。
- **`functionHooksToMatchers`/`mergeHooks` 存在但 main.tsx 只用 `loadHooksFromSettings`**（无进程内 function hook 注册路径）。
- **`isCompoundCommand` 守卫声明但 `findMatchingShellRule` 未用它**（复合命令仍可能被 prefix 规则匹配）。
- **WebFetchTool 的 `PREAPPROVED_HOSTS`/`isPreapprovedHost` 导出但权限管线未用**（WebFetch 只读自动 allow，不查预批准主机）。
- **无企业策略/MDM、无沙箱执行、无 OAuth。**
- auto 分类器缓存是**模块级全局**（跨会话共享，`clearClassifierCache` 仅供测试）。
