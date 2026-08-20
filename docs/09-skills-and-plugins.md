# 技能（Skills）与 Slash 命令系统

> 基于 `src/skills/loadSkillsDir.ts` (~143 行) + `src/commands.ts` (~371 行) + `src/tools/SkillTool/SkillTool.ts` (53 行) 实际源码。
>
> **关键事实：** harness-code **无插件系统**。`enabledPlugins` 在 `Settings` 类型里声明，但无 `plugins/` 目录、无加载逻辑、无插件 hooks。只有 **Skills**（SKILL.md 加载）和 **内置 Slash 命令**（`commands.ts`）。

## 1. 技能系统概览

技能是含 `SKILL.md` 的目录，通过 `/name` 触发，把 Markdown body 作为提示注入模型上下文。

```
~/.claude/skills/<name>/SKILL.md    (user 全局)
<cwd>/.claude/skills/<name>/SKILL.md (project)
```

加载由 `loadAllSkills(cwd)` 完成：`[...loadSkillsDir(userDir, 'user'), ...loadSkillsDir(projectDir, 'project')]`。

## 2. SKILL.md 格式 (`loadSkillsDir.ts`)

```markdown
---
name: <skill-name>
description: <one-line>
argument-hint: <hint>
arguments:
  - <arg1>
  - <arg2>
allowed-tools:
  - <ToolName>
model: <model-id>
user-invocable: true|false
disable-model-invocation: true|false
---

<body — 可含 $ARGUMENT_NAME / ${CLAUDE_SKILL_DIR} / $ARGUMENTS 占位符>
```

`parseSkillFile(path, source)`：手写 frontmatter 正则 `^---\n([\s\S]*?)\n---\n([\s\S]*)$`；无 frontmatter → 整文件当 body，`name: ''`（后续 `loadSkillsDir` 用目录名补 name）。`user-invocable` 缺省 true，`disable-model-invocation` 缺省 false。

`parseFrontmatter` 手写 YAML：支持 `key: value` 和 `- list item`（缩进列表）。`arguments`/`allowed-tools` 解析成数组。

`Skill` 结构：
```typescript
interface Skill {
  name: string
  description: string
  argumentHint?: string
  arguments?: Array<{ name: string; description?: string }>
  allowedTools?: string[]
  model?: string
  userInvocable?: boolean
  disableModelInvocation?: boolean
  skillDir?: string
  body: string
  source: 'user' | 'project' | 'bundled'
}
```

> `source: 'bundled'` 在类型里声明但 `loadAllSkills` 只产生 `'user'|'project'`（无内置 skill 目录）。

## 3. 参数替换 (`substituteArguments`)

```typescript
export function substituteArguments(body, args: Record<string,string>, skillDir?): string
```

- `$KEY` / `${KEY}` → `args[KEY]`（`replaceAll`）
- `${CLAUDE_SKILL_DIR}` → `skillDir`
- `$ARGUMENTS` → `Object.values(args).join(' ')`（所有位置参数拼接）

## 4. Slash 命令解析 (`parseSlashCommand`)

```typescript
export function parseSlashCommand(input: string): { name: string; args: string } | null {
  // 必须以 '/' 开头；首个空格前是 name，之后是 args
  // "/model gpt-5" → { name: 'model', args: 'gpt-5' }
  // "/clear" → { name: 'clear', args: '' }
}
```

## 5. 内置 Slash 命令 (`commands.ts`)

```typescript
interface Command {
  name: string
  description: string
  type: 'local' | 'prompt' | 'local-jsx'   // local-jsx 声明但无命令使用
  run?: (args: string, context: CommandContext) => Promise<CommandResult>      // local
  buildPrompt?: (args: string, context: CommandContext) => string             // prompt
  isEnabled?: () => boolean
}

type CommandResult =
  | { kind: 'message'; message: Message }       // 合成 assistant 消息
  | { kind: 'prompt'; prompt: string }
  | { kind: 'action'; action: 'clear'|'compact'|'exit' }
  | { kind: 'none' }                            // 不追加消息（如 /history 打开选择器）
```

### 5.1 命令列表（20 个）

| 命令 | type | 说明 |
|------|------|------|
| `/help` | local | 列出所有命令 |
| `/clear` | local | 清空对话（`clearConversation` + transcriptKey 重置） |
| `/compact` | local | 手动压缩（`compact()`） |
| `/model [name]` | local | 无参→交互选择器（arrow+Enter）/ 列目录；有参→切换 |
| `/models` | local | 列模型目录 |
| `/config` | local | 显示有效配置（apiKey 脱敏 `前8…后4`） |
| `/cost` | local | 会话成本汇总 |
| `/skills` | local | 列可用 skill |
| `/memory [save]` | local | 显示记忆 prompt；`save`→抽取记忆 |
| `/hooks` | local | 列配置的 hooks（事件→matcher 计数） |
| `/init` | prompt | 注入"分析代码库写 CLAUDE.md"提示 |
| `/sessions` | local | 列可恢复会话 |
| `/resume <id>` | local | 恢复会话（无参→列会话） |
| `/plan` | local | 进入 plan 模式 |
| `/bypass [on\|off\|auto]` | local | 切权限模式 |
| `/export` | local | 导出 transcript 到 markdown 文件 |
| `/stop` | local | 强制停止 agent（运行中由 handleSubmit 拦截，idle 时提示） |
| `/new` | local | 新对话（清历史+transcript） |
| `/history` | local | 打开会话历史选择器（arrow+Enter 恢复） |
| `/exit` | local | 退出（返回 `{ kind:'action', action:'exit' }`） |

### 5.2 `CommandContext`

REPL 在 `App.tsx` `handleSubmit` 里构造 `CommandContext`，把引擎能力以回调形式注入：

```typescript
interface CommandContext {
  cwd: string
  clearConversation?()                                // 清 transcript + transcriptKey++
  compact?(): Promise<string>                         // engine.compactNow()
  getModel?(): string; setModel?(id): string|null    // ModelManager
  listModels?(): string                               // 目录（当前项标 ▸）
  getConfigSummary?(): string                         // baseURL/apiKey脱敏/model/smallModel/maxOutputTokens/configFile
  getCostSummary?(): string                           // formatTotalCost
  listSkills?(): string                               // /name — description
  getMemoryPrompt?(): string | null
  extractMemories?(): Promise<string>                 // engine.extractMemories()
  listHooks?(): string                                // 事件→matcher→hook 明细
  listSessions?(): string                             // 新会话标 ▸
  resumeSession?(id): { count } | null
  exportTranscript?(): string                         // 写 harness-export-<sid>.md
  enterPlanMode?(); isPlanMode?(): boolean
  setPermissionMode?(mode); getPermissionMode?(): string | null
  newConversation?()                                  // engine.newConversation() + 清 transcript
  openHistory?()                                      // 打开历史选择器
}
```

### 5.3 命令分发流程（`App.tsx` `handleSubmit`）

```
prompt = input.trim()
loading（agent 运行中）:
   /stop → engine.interrupt()，立即返回
   /xxx → "(busy — /xxx deferred; run again when idle)"，返回
   普通文本 → engine.enqueueUserMessage() + "(queued...)"，返回

/^(exit|quit)$/i → engine.shutdown() + exit()

parsed = parseSlashCommand(prompt)
cmd = findCommand(parsed.name, getBuiltinCommands())
   ├─ /model 无参 → 交互选择器（setModelSelectIdx），返回
   ├─ cmd.type === 'local' && cmd.run:
   │     ctx = {...}  // 构造 CommandContext
   │     result = await cmd.run(parsed.args, ctx)
   │     refreshFooter()   // /bypass /model 改了引擎状态
   │     result.kind === 'message' → transcript 追加 assistant
   │     result.kind === 'action' && action === 'exit' → shutdown + exit
   └─ cmd.type === 'prompt' && cmd.buildPrompt:
         builtPrompt = cmd.buildPrompt('', { cwd })
         transcript 追加 user prompt
         await runQuery(builtPrompt)

未匹配 slash / 普通文本 → transcript 追加 user，runQuery(prompt)
```

> `/stop` 在 agent 运行时由 `handleSubmit` **直接拦截**（不经命令分发），调 `engine.interrupt()`。idle 时才走 `cmd.run`（提示 "Nothing to stop"）。

## 6. SkillTool — 模型按名调用 skill (`SkillTool.ts`)

```typescript
inputSchema = { skill: string min1, args?: string }
isReadOnly: true; isConcurrencySafe: true; maxResultSizeChars: 30_000

async call(input, context) {
  const skills = loadAllSkills(context.cwd)
  const skill = skills.find(s => s.name === input.skill)
  if (!skill) return { result: `Skill not found: ${input.skill}. Available: ...`, isError: true }
  const argMap = {}
  if (input.args) {
    argMap.ARGUMENTS = input.args
    input.args.split(/\s+/).forEach((a, i) => argMap[String(i + 1)] = a)   // $1, $2, ...
  }
  const content = substituteArguments(skill.body, argMap, skill.skillDir)
  return { data: { content }, result: content }
}
```

> **SkillTool 与 `/skill` slash 命令是两条路径**：SkillTool 是模型主动调用的工具；`/skill` 是用户触发的 slash 命令（但 `commands.ts` **没有**动态注册 skill 为 slash 命令——只有内置 20 个命令）。用户输入 `/未知名` 会落到 `findCommand` 未匹配 → 当普通文本发给模型。skill 只能通过 SkillTool（模型调用）或 `/skills`（列出）触达。

## 7. 插件系统 — 不存在

- `Settings.enabledPlugins?: Record<string, boolean>` 在类型里声明。
- `settings.ts` 的 `mergeSettingsInto` 对 `enabledPlugins` 做对象合并。
- **但无 `plugins/` 目录、无插件加载逻辑、无 `loadPluginHooks`、无插件热重载、无插件 marketplaces。**
- `enabledPlugins` 合并后**从不被读取使用**。

> 复现时：保留 `Settings.enabledPlugins` 字段声明和合并逻辑，但**不要**实现插件加载——这是当前真实状态。

## 8. 已知边界 / 未实现项

- **无插件系统**（`enabledPlugins` 声明但不使用）。
- **skill 不动态注册为 slash 命令**——`commands.ts` 只有 20 个硬编码命令。用户 `/skill-name` 不会触发 skill（除非正好匹配内置命令名）；skill 只能经 SkillTool 由模型调用。
- **无内置 skill**（`source: 'bundled'` 声明但 `loadAllSkills` 不产生）。
- **无 `/mcp` 命令、无 skill 热重载监控**（`skillChangeDetector` 不存在）。
- **`local-jsx` 命令类型声明但无命令使用**。
- **`/init` 是 prompt 类型**（注入提示让模型写 CLAUDE.md），非本地直接生成。
- **`/config` 的 configFile 显示**：`config.configFilePath ?? '(none)'`。
- skill 的 `allowed-tools`/`model`/`arguments` 解析但**不强制约束**（不限制模型用哪些工具、不切换模型）。
