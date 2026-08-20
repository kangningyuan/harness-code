# 会话持久化与恢复

> 基于 `src/services/session/` (store.ts ~189 行 / paths.ts ~30 行 / index.ts) + `src/QueryEngine.ts` (会话恢复部分) + `src/ink/App.tsx` (`/resume`/`/history` UI) 实际源码。
>
> **重要更名说明：** 旧版本文档标题为"会话桥接与远程控制"，描述 Claude Code 的 `claude remote-control` / Bridge 协议 / claude.ai Web 桥接 / 遥测系统。**harness-code 完全没有这些功能**——无 `bridge/` 目录、无 `bridgeMain.ts`、无远程控制、无遥测、无 OAuth、无多后端 API。本篇实际讲的是 harness-code **真实存在**的会话持久化系统（JSONL transcript + meta sidecar + `/resume` `/history` 恢复）。文档目录里保留"12-session-bridge.md"文件名仅为不破坏既有引用，内容已是会话持久化。

## 1. 会话存储架构

```
~/.harness-code/projects/<sanitized-cwd>/
   ├── <sessionId>.jsonl          ← 追加式 transcript（每行一个 Message）
   ├── <sessionId>.meta.json      ← 元数据 sidecar
   ├── <otherSession>.jsonl
   └── <otherSession>.meta.json
```

- **JSONL transcript**：每行一个 `JSON.stringify(Message)`。追加式（`appendFileSync`），崩溃安全——增量写存活。
- **meta sidecar**：`SessionMeta` JSON，记录 id/cwd/model/时间戳/消息数/摘要。
- **路径**：`projectsRoot()` = `~/.harness-code/projects/`，`sessionsDir(cwd)` = `<root>/<sanitizeProjectPath(cwd)>`。

> **注意路径差异：** 会话在 `~/.harness-code/projects/`，记忆在 `~/.claude/projects/`（见 [06](./06-context-and-memory.md)）。两者都用 `sanitizeProjectPath`（来自 `memdir/paths.ts`）派生键，但根目录不同。会话用 `cwd` 派生键（非 git root），记忆用 git root 派生键。

## 2. 路径解析 (`session/paths.ts`)

```typescript
export function projectsRoot(): string { return join(homedir(), '.harness-code', 'projects') }
export function sessionsDir(cwd: string): string { return join(projectsRoot(), sanitizeProjectPath(cwd)) }
export function sessionFile(dir, sessionId): string { return join(dir, `${sessionId}.jsonl`) }
export function sessionMetaFile(dir, sessionId): string { return join(dir, `${sessionId}.meta.json`) }
```

`sanitizeProjectPath`（`memdir/paths.ts`）：`/` → `-`，去非 `[a-zA-Z0-9._-]`，去前导 `-`，截 200 字符，空则 `default`。

## 3. SessionMeta (`session/store.ts`)

```typescript
interface SessionMeta {
  id: string               // `${now.toString(36)}-${randomUUID().slice(0,8)}`
  cwd: string
  model: string
  createdAt: number        // epoch ms
  updatedAt: number
  messageCount: number
  summary?: string         // 小模型生成的一行摘要（best-effort）
}
```

id 格式：时间戳 base36 + 短 UUID（如 `lq8f3x2b-1a2b3c4d`）。

## 4. 存储 API (`session/store.ts`)

### 4.1 `createSession(cwd, model, opts?)`

```typescript
const dir = sessionsDir(cwd)
if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
const now = Date.now()
const meta: SessionMeta = { id: `${now.toString(36)}-${randomUUID().slice(0,8)}`, cwd, model, createdAt: now, updatedAt: now, messageCount: 0 }
writeFileSync(sessionMetaFile(dir, meta.id), JSON.stringify(meta, null, 2) + '\n')
writeFileSync(sessionFile(dir, meta.id), '', 'utf8')   // 空 transcript
return meta
```

### 4.2 `appendMessages(cwd, sessionId, messages, opts?)`

```typescript
if (messages.length === 0) return
const file = sessionFile(dir, sessionId)
const lines = messages.map(m => JSON.stringify(m)).join('\n') + '\n'
appendFileSync(file, lines, 'utf8')   // 追加
// 更新 meta
const meta = readMeta(dir, sessionId)
if (meta) {
  meta.updatedAt = Date.now()
  meta.messageCount += messages.length
  writeFileSync(sessionMetaFile(dir, sessionId), JSON.stringify(meta, null, 2) + '\n')
}
```

QueryEngine `submitMessage` 末尾调此（`slice(prevLen)` 只持久化本轮新增）：

```typescript
if (this.sessionId) {
  const newMessages = this.messages.slice(prevLen)
  try { appendMessages(this.opts.cwd, this.sessionId, newMessages) }
  catch { /* 持久化失败非致命 */ }
}
```

### 4.3 `loadSession(cwd, sessionId, opts?)`

```typescript
const messages: Message[] = []
if (existsSync(file)) {
  const raw = readFileSync(file, 'utf8')
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try { messages.push(JSON.parse(trimmed)) }   // 逐行解析
    catch { /* 跳过 malformed 行 */ }
  }
}
return { messages, meta: readMeta(dir, sessionId) }
```

逐行解析（malformed 行跳过），返回 messages + meta。

### 4.4 `listSessions(cwd, opts?)`

```typescript
const metas: SessionMeta[] = []
for (const entry of readdirSync(dir)) {
  if (!entry.endsWith('.meta.json')) continue
  try { metas.push(JSON.parse(readFileSync(join(dir, entry), 'utf8'))) }
  catch { /* 跳过 invalid meta */ }
}
return metas.sort((a, b) => b.updatedAt - a.updatedAt)   // newest-first
```

按 `updatedAt` 降序（最新在前）。

### 4.5 `summarizeSession(client, smallModel, messages)`

best-effort 调小模型生成一行摘要（≤200 字符）：

```typescript
const transcript = renderForSummary(messages).slice(0, 50_000)   // [User/Assistant] text 截 1000
const result = await client.callOnce({
  model: smallModel, max_tokens: 256,
  system: 'Summarize this agent conversation in a single concise sentence (max ~80 chars). Output only the sentence.',
  messages: [{ role: 'user', content: transcript }],
})
// 取 text 块 trim，slice(0, 200)
```

> **注意：** `summarizeSession` 在源码里**导出但未被调用**——`createSession`/`appendMessages` 不自动生成 summary，`listSessions` 读的 meta 里 `summary` 字段实际永远是 undefined（除非外部写入）。`/history`/`/sessions` 显示 `s.summary ? \` — ${s.summary}\` : ''` 总是空。复现时保留这个未接线状态。

### 4.6 `sessionMtime(dir, sessionId)`

`statSync(sessionFile).mtimeMs`——meta 缺失时的排序 fallback（导出但 listSessions 用 meta 的 updatedAt，未用此）。

## 5. QueryEngine 的会话生命周期

### 5.1 构造时（`QueryEngine` 构造函数）

```typescript
if (opts.disableSessionPersistence) {
  this.sessionId = null                                     // 测试用：禁用持久化
} else if (opts.sessionId) {
  const { messages } = loadSession(opts.cwd, opts.sessionId)
  this.messages = messages                                  // 恢复历史
  this.sessionId = opts.sessionId
} else {
  const meta = createSession(opts.cwd, opts.model)          // 新建
  this.sessionId = meta.id
}
```

`--resume [id]` → `opts.sessionId`（main.tsx 解析）；否则新建。

### 5.2 `resumeSession(sessionId)`

```typescript
resumeSession(sessionId): { count: number } | null {
  const { messages } = loadSession(this.opts.cwd, sessionId)
  this.messages = messages
  this.sessionId = sessionId
  this.readFileState.clear()     // 清读状态缓存（新会话的读状态从零开始）
  return { count: messages.length }
}
```

**不重新持久化**——后续轮次追加到恢复的 sessionId。

### 5.3 `newConversation()`

```typescript
newConversation(): void {
  this.messages = []
  this.pendingQueue = []          // 丢弃排队输入
  this.readFileState.clear()
  if (!this.opts.disableSessionPersistence) {
    const meta = createSession(this.opts.cwd, this.modelManager.getModel())   // 新会话
    this.sessionId = meta.id
  }
}
```

旧会话保留在磁盘（可经 `/history` 恢复）。

### 5.4 `getSessionId()` / `getMessages()`

供 UI（`/resume` 重注入 transcript、`/export`、footer）使用。

### 5.5 `shutdown()`

```typescript
async shutdown(): Promise<void> {
  await this.fireHooks('SessionEnd', { messages: this.messages })
}
```

触发 SessionEnd hooks（observe-only）。**不**显式关闭会话文件（JSONL 已追加持久化）。

## 6. 恢复 UI（`App.tsx`）

### 6.1 `--resume` 启动时

main.tsx 解析 `--resume`：指定 id 校验存在；无 id 取 `listSessions(cwd)[0]`（最新）。stderr 提示 `Resuming latest session: ...`。QueryEngine 构造时 `loadSession` 加载历史。

`App` 挂载的 `useEffect` 从 `engine.getMessages()` 重建 transcript entries（text→user/assistant，tool_use→tool），`setTranscript(entries)`。见 [10](./10-ui-and-state.md) §13.1。

### 6.2 `/resume <id>` 命令

`commands.ts` 的 `/resume`：有参→`ctx.resumeSession(id)`（返回 count 或 null）；无参→`ctx.listSessions()`。`CommandContext.resumeSession` 回调（`App.tsx`）调 `engine.resumeSession` + 重注入 transcript + `setTranscriptKey(k+1)`。

### 6.3 `/history` 交互选择器

`/history` → `ctx.openHistory()` → `setHistorySelect({ sessions: listSessions(cwd), idx: 0 })`。UI 渲染选择器（见 [10](./10-ui-and-state.md) §7.4）：`↑/↓` 移动、`Enter` 恢复、`Esc` 取消。Enter 时调 `engine.resumeSession` + 重注入 + footer 刷新 + 提示 `Resumed session ${id} (${count} messages).`

### 6.4 `/sessions` 命令

`ctx.listSessions()` 格式化（最新在前，最多 20）：
```
Sessions (newest first):
  <id> ▸  <N> msgs  <date>  — <summary>
```
`▸` 标记当前会话（`s.id === engine.getSessionId()`）。`summary` 实际总空（见 §4.5）。

### 6.5 `/export` 命令

`ctx.exportTranscript()` 把 `engine.getMessages()` 渲染成 markdown 写到 `<cwd>/harness-export-<sid>.md`：

```typescript
const lines = [`# harness-code transcript (${sid})`, '']
for (const m of msgs) {
  const role = m.role === 'user' ? '## User' : '## Assistant'
  // string content → role + content
  // array content → 逐块: text → text; tool_use → _[tool_use: name(input)]_; tool_result → _[tool_result]_
}
writeFileSync(join(cwd, `harness-export-${sid}.md`), lines.join('\n'))
```

## 7. 会话与记忆的路径对比

| 数据 | 根目录 | 键派生自 | 路径 |
|------|--------|---------|------|
| 会话 transcript + meta | `~/.harness-code/projects/` | `cwd`（sanitizeProjectPath） | `~/.harness-code/projects/<sanitized-cwd>/<id>.jsonl` |
| 记忆目录 | `~/.claude/projects/` | git root（findCanonicalGitRoot） | `~/.claude/projects/<sanitized-git-root>/memory/` |

> 会话用 cwd、记忆用 git root——不同 worktree（同 git root）共享记忆但不共享会话（cwd 不同）。

## 8. 已知边界 / 未实现项（重要）

- **无 Bridge/远程控制**：无 `claude remote-control`、无 claude.ai Web 桥接、无 `bridgeMain.ts`、无 DirectConnectSession、无 SSH 会话、无 assistant 模式。
- **无遥测系统**：无 analytics/、无 Datadog/OTel、无 1P 遥测。
- **无 OAuth**：无 oauth/、无 Keychain、无 token 刷新。API key 靠配置/env/flag。
- **无多后端 API**：无 Bedrock/Vertex/Foundry 切换；单一可配 `baseURL`。
- **`summarizeSession` 导出但未被调用**——meta 的 `summary` 字段实际永远 undefined（`/sessions`/`/history` 的 summary 显示总空）。复现时保留。
- **`sessionMtime` 导出但 `listSessions` 未用**（用 meta.updatedAt 排序）。
- **无会话成本持久化**（`UsageTracker` 内存单例，退出即失；无按 sessionId 存读成本）。
- **无 `--continue` 恢复最近会话的 flag**（`--resume` 无参才取最新）。
- **会话 id 用 cwd 派生键**，非 git root——切到不同 cwd 看不到彼此时会话（即使同仓库）。
- **持久化失败非致命**（`appendMessages` 的 catch 吞错）——磁盘满/权限错误时静默丢失消息。
- 恢复时 `readFileState.clear()`——读前写缓存不跨会话（恢复后需重新读文件才能编辑）。
