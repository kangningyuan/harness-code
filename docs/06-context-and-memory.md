# 上下文管理与记忆系统

> 基于 `src/context.ts` (~219 行) + `src/memdir/` (memdir.ts ~138 行 / paths.ts ~56 行) + `src/services/extractMemories/extract.ts` (~213 行) + `src/services/compact/compact.ts` (~220 行) 实际源码。

## 1. 系统提示组装 (`context.ts`)

`fetchSystemPromptParts(opts)` 在 QueryEngine 构造时调用**一次**，返回 `SystemBlock[]`（首块带 `cache_control`）。**不在每轮重组**——同一 systemPrompt 引用贯穿整个会话。

```typescript
function fetchSystemPromptParts(opts): SystemBlock[] {
  const blocks: SystemBlock[] = []

  // [1] 默认或自定义系统提示（可缓存稳定前缀）
  const base = opts.customSystemPrompt ?? getDefaultSystemPrompt(opts.tools, opts.verbose)
  blocks.push({ type: 'text', text: base, cache_control: { type: 'ephemeral' } })

  // [2] CLAUDE.md + 日期
  const user = getUserContext(opts.cwd, opts.extraDirs)
  if (user.claudeMd) blocks.push({ type: 'text', text: `# Project context (CLAUDE.md)\n\n${user.claudeMd}` })
  blocks.push({ type: 'text', text: user.currentDate })

  // [3] git status
  const sys = getSystemContext(opts.cwd)
  if (sys.gitStatus) blocks.push({ type: 'text', text: `# Git status\n\n${sys.gitStatus}` })

  // [4] 追加提示
  if (opts.appendSystemPrompt) blocks.push({ type: 'text', text: opts.appendSystemPrompt })

  // [5] 记忆提示（自动记忆目录）
  const memoryPrompt = loadMemoryPrompt(opts.cwd)
  if (memoryPrompt) blocks.push({ type: 'text', text: memoryPrompt })

  return blocks
}
```

### 1.1 默认系统提示 (`getDefaultSystemPrompt`)

```typescript
`You are harness code, an interactive CLI agent that helps users with software engineering tasks. You operate in a terminal and have access to tools.

# Core principles
- Read files before editing them (FileReadTool before FileEditTool/FileWriteTool).
- Make precise, minimal edits. Prefer FileEditTool over rewriting whole files.
- Verify changes: run tests, typecheck, or read the result back.
- Reference files as file_path:line when relevant.
- When a task is ambiguous, ask a clarifying question.
- Fail closed: if you are unsure whether an action is safe, ask the user.

# Tool use
- Use tools to gather information and make changes. Do not guess file contents.
- Tool calls run in parallel when concurrency-safe; otherwise serially.
- Every tool_use must receive a tool_result before you continue.

# Output style
- Be concise. Use markdown in the terminal.
- For code references, use \`path:line\` format.
- Show progress with brief status; avoid verbose narration.

# Available tools
${toolSection}`   // 每个工具: "## <name>\n<prompt()>"
```

> 工具描述按 `getBuiltinTools()` 的定义顺序拼接（**非字母序**，见 [04](./04-tool-system.md) 的已知边界）。

### 1.2 CLAUDE.md 发现 (`findClaudeMdFiles`)

从 `cwd` 和 `extraDirs` 向上遍历到根（最多 64 层防死循环），查找 `CLAUDE.md` 或 `HARNESS.md`。再加 `~/.claude/CLAUDE.md`（全局用户记忆）。用 `realpathSync` 去重（防符号链接重复）。

```typescript
if (process.env.HARNESS_DISABLE_CLAUDE_MDS === '1') return []   // 禁用
const names = ['CLAUDE.md', 'HARNESS.md']
```

`getUserContext(cwd, extraDirs)`：拼接所有文件内容为 `# <path>\n\n<content>`，并生成 `Today's date is YYYY-MM-DD.`（`new Date()` 取当天）。

### 1.3 git status (`getSystemContext`)

非 git 仓库 → 返回 null。否则 `execSync`（5s 超时，`--no-optional-locks`）：
- `git status --short`（改动）
- `git rev-parse --abbrev-ref HEAD`（分支）
- `git log --oneline -n 5`（最近提交）
- 拼成 `Branch: ...\nStatus:\n...\nRecent commits:\n...`，超 2000 字符截断

`isGitRepo(cwd)`：`git rev-parse --is-inside-work-tree`（3s 超时）。

## 2. 自动记忆目录 (`memdir/`)

### 2.1 路径解析 (`paths.ts`)

`getAutoMemPath(cwd, settings?)` 优先级：
1. `HARNESS_MEMORY_PATH` / `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` env
2. `settings.autoMemoryDirectory`
3. `~/.claude/projects/<sanitized-git-root>/memory/`

`findCanonicalGitRoot(cwd)`：`git rev-parse --show-toplevel`（3s 超时），处理 worktree/submodule——所有 worktree 共享同一记忆目录。

`sanitizeProjectPath(path)`：`/` → `-`，去非 `[a-zA-Z0-9._-]`，去前导 `-`，截 200 字符，空则 `default`。

> **注意：** 记忆目录在 `~/.claude/projects/`（Claude Code 路径），而**会话**在 `~/.harness-code/projects/`（见 [12](./12-session-bridge.md)）。两者用相同的 `sanitizeProjectPath` 派生键。

`getMemoryIndexPath(memDir)` = `<memDir>/MEMORY.md`。

### 2.2 记忆文件格式 (`memdir.ts`)

每条记忆一个 `.md` 文件，frontmatter + body：

```markdown
---
name: <kebab-case-slug>
description: <one-line summary>
metadata:
  type: user | feedback | project | reference
---

<body>
```

`MemoryFile { path, name, description, type, body, mtimeMs }`。

`parseMemoryFile` 用手写 frontmatter 正则 `^---\n([\s\S]*?)\n---\n([\s\S]*)$` + 手写 YAML 解析（支持 `metadata:` 嵌套）。`type` 缺省 `project`。

四种类型：`user`（用户角色/偏好）、`feedback`（工作方式反馈）、`project`（项目目标/约束）、`reference`（外部资源指针）。

`scanMemoryFiles(memDir)`：遍历 `.md`（跳过 `MEMORY.md`），解析每个。

### 2.3 MEMORY.md 索引

`buildMemoryIndex(files)`：每行 `- [<name>](<path>) — <description>`。上限 200 行 / 25_000 字节（超则截断 + `<!-- index truncated -->`）。

`loadMemoryPrompt(cwd, settings?)`：记忆目录不存在 → null；否则返回注入系统提示的文本（含 MEMORY.md 索引全文 + 使用说明："Save non-obvious facts... Do not save what the code/git already records."）。

`ensureMemoryDir(memDir)`：mkdir + 初始化空 `# Memory Index\n\n`。

> **agent 可直接用 FileEdit/FileWrite 写记忆**——memdir 模块只提供读/扫描/索引辅助。LLM 抽取是 `/memory save` 的便利路径（见 §3）。

## 3. 记忆抽取 (`services/extractMemories/`)

`extractMemories({ client, smallModel, messages, cwd, settings })` —— **仅 `/memory save` 显式触发**，**无后台自动抽取**（源码注释："would surprise users with unexpected file writes"）。

### 3.1 流程

```
messages 为空 → error "No conversation to extract from."
memDir = getAutoMemPath(cwd, settings); ensureMemoryDir(memDir)
existing = scanMemoryFiles(memDir); existingNames = Set(小写名)
indexContent = 读 MEMORY.md（不存在则 "# Memory Index\n\n"）
transcript = renderTranscript(messages)   ← 每条 [User/Assistant] text 截 1500 字符，tool_use 只记名，总截 60_000

proposed = callExtractor(client, smallModel, transcript, indexContent)
   └─ client.callOnce({ model, max_tokens: 2048,
       system: "抽取持久记忆...一条一个非显然事实...不要存代码/git/CLAUDE.md 已记录的...只返回 JSON {memories:[{name,description,type,body}]}...最多 5 条...无则 {memories:[]}",
       messages: [{ role:'user', content: "## Existing MEMORY.md index\n...## Recent conversation\n..." }] })
   └─ parseMemoriesJson(text)   ← 剥 fence、找首个平衡 {...}、JSON.parse、filter isProposedMemory

for mem of proposed.slice(0, 5):   ← MAX_MEMORIES_PER_RUN = 5
   name 非法 → skipped++
   type 非法 → 默认 'project'
   已存在（小写名） → skipped++
   slugify(name) → 写 <slug>.md（renderMemoryFile frontmatter 格式）
   写失败 → skipped++

if written.length > 0:
   refreshed = scanMemoryFiles(memDir)   ← 重扫（含新写）
   newIndex = buildMemoryIndex(refreshed)
   写 MEMORY.md

return { written, skipped, names: written }
```

`slugify`：小写、非字母数字 → `-`、去前后 `-`、截 60 字符、空则 `memory`。

`QueryEngine.extractMemories()` 包装此函数，返回人类可读摘要（`Wrote N memor(y|ies): ...` / `No new memories to save.` / `Memory extraction failed: ...`）。

## 4. 上下文压缩 (`services/compact/compact.ts`)

### 4.1 阈值与常量

```typescript
DEFAULT_CONTEXT_WINDOW = 400_000        // 代理模型 ~400K 上下文
SUMMARY_OUTPUT_BUDGET = 20_000
COMPACT_BUFFER = 13_000
MAX_RECENT_FILES_TOKENS = 50_000         // 声明，v1 未用于重注入
MAX_CONSECUTIVE_FAILURES = 3             // 断路器
```

`shouldAutoCompact(messages, contextWindow)`：`estimateTokens(messages) >= contextWindow - 20_000 - 13_000`。

`estimateTokens(messages)`：粗估 `chars / 4`（累加 text/thinking/tool_use input/tool_result content）。

### 4.2 `compactConversation`

```
consecutiveFailures >= 3 → return null（断路器跳闸）

keepCount = min(2, messages.length)        ← 保留最近 1-2 条（user+assistant 连续性）
toSummarize = messages.slice(0, len - keepCount)
keep = messages.slice(len - keepCount)
toSummarize 为空 → return null

PreCompact hook (observe-only)

summary = summarizeMessages(toSummarize, opts).catch(() => null)
   └─ client.callOnce({ model, max_tokens: min(20_000, 8192),
       system: "对话摘要器...保留：用户问了什么、读了/改了哪些文件、关键决策、当前任务状态、未决问题...具体文件路径和改动...只输出摘要",
       messages: [{ role:'user', content: renderTranscript(toSummarize) }] })
   └─ renderTranscript: [User/Assistant] text 截 2000、tool_use 名+input 截 500、tool_result 截 1000，总截 100_000
summary 为 null → consecutiveFailures++; return null

consecutiveFailures = 0

compacted = [
  { role: 'user', content: `<context_compaction>\nThis conversation was compacted. Summary of earlier turns:\n\n${summary}\n</context_compaction>` },
  ...keep,
]

PostCompact hook (observe-only)

return compacted
```

### 4.3 `createAutoCompact(opts)`

返回 `(messages) => Promise<Message[] | null>`：`shouldAutoCompact` 不满足 → null；否则 `compactConversation`。QueryEngine 把它作为 `autoCompact` 传给 `query()`，`query()` 每轮 callModel 前检查。

`/compact` 命令调 `engine.compactNow()` → 直接 `compactConversation`（bypass 阈值），返回人类可读摘要（`Compacted N messages → M.` / `Not enough conversation to compact.` / `Compaction failed.`）。

### 4.4 辅助

- `stripThinking(messages)`：剥所有 assistant 消息的 thinking 块（`assistantBlocksForNextTurn`）——声明但 v1 未在压缩流程用。
- `resetCompactionState()`：重置断路器（测试/新会话）。

## 5. 已知边界 / 未实现项

- **系统提示只组装一次**（QueryEngine 构造时），不在每轮重组（CLAUDE.md/git status 变化不会动态反映）。
- **记忆抽取仅 `/memory save` 显式触发**，无后台自动抽取、无 SessionMemory 临时笔记模块。
- **压缩不重注入最近文件/计划/skill**（`MAX_RECENT_FILES_TOKENS` 声明但未用；源码注释 "v1: re-inject recent file reads via readFileState" 是未实现计划）。
- **`stripThinking` 声明但压缩流程未用**。
- **token 估算是粗估**（chars/4），非精确 tokenizer。
- **断路器是模块级全局** `consecutiveFailures`（跨会话共享，`resetCompactionState` 供测试）。
- **无 micro/partial compaction**（只一种整摘要压缩）。
