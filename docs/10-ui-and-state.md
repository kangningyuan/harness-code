# UI 渲染与状态管理

> 基于 `src/ink/App.tsx` (~743 行，UI 核心) + `src/ink/barGlyph.ts` (~30 行) 实际源码。这是用户最关心的文档——CLI 的 UI 交互细节（光标逻辑、logo 显示、信息显示、spinner、进度条、交互选择器等）全部在此。
>
> **关键事实：** harness-code UI 用**原生 Ink**（`useInput`/`useApp`/`render`/`Text`/`Box`/`Static`/`Newline`），**不**是定制 reconciler。**无** ScrollBox、**无** 鼠标处理、**无** Vim 模式、**无** 18 上下文快捷键系统、**无** AppState。状态全在 `App` 组件的 `useState`/`useRef`，唯一在用的外部 pub/sub 是 `TodoWriteTool` 的模块级 store。
>
> **关于 `src/state/store.ts`：** 该文件存在（极简 `createStore<T>` pub/sub，文件头自称 "docs §10.1.1"），但**未被任何代码 import（死代码）**。实际 UI 状态管理不依赖它。复现时可建该文件保留，或直接不建（不影响构建/运行）。

## 1. 状态管理

### 1.1 React `useState` + `useRef`（无外部 store）

`App` 组件持有所有 UI 状态。关键 state/ref：

```typescript
const { exit } = useApp()
const [input, setInput] = useState('')                    // 输入框文本
const [cursorPos, setCursorPos] = useState(0)             // 光标在 input 中的索引
const [transcriptKey, setTranscriptKey] = useState(0)     // /new /clear /resume 时 +1，作 <Static key> 强制重挂载
const cursorRef = React.useRef(0)                         // cursorPos 的 ref 镜像（防批量按键读陈旧闭包）
const setCursor = (p) => { cursorRef.current = p; setCursorPos(p) }   // 同步更新两者
const [transcript, setTranscript] = useState<TranscriptEntry[]>([])
const [loading, setLoading] = useState(false)             // agent 是否运行
const [streamingText, setStreamingText] = useState('')    // 当前流式 assistant 文本
const [history, setHistory] = useState<string[]>([])      // 上箭头历史
const [historyIdx, setHistoryIdx] = useState(-1)
const [pendingPlan, setPendingPlan] = useState<string | null>(null)   // plan 审批对话框
const planResolver = React.useRef<((approved: boolean) => void) | null>(null)
const [modelSelectIdx, setModelSelectIdx] = useState<number | null>(null)  // /model 选择器（null=未开）
const [pendingPerm, setPendingPerm] = useState<{ tool; reason } | null>(null)  // 权限审批对话框
const permResolver = React.useRef<((approved: boolean) => void) | null>(null)
const [todos, setTodos] = useState<TodoList>(getCurrentTodos())  // 固定 todo 面板（订阅 TodoWriteTool）
const [historySelect, setHistorySelect] = useState<{ sessions; idx } | null>(null)  // /history 选择器
const [spinnerFrame, setSpinnerFrame] = useState(0)       // braille spinner 帧
const [ringFrame, setRingFrame] = useState(0)             // 进度条 shine 动画帧
const [activity, setActivity] = useState('thinking')      // spinner 标签
const ctrlCCount = React.useRef(0)                        // 双击 Ctrl+C 退出计时
const ctrlCTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
const [footer, setFooter] = useState<{ ctxK; winK; pct; total; model; mode }>(...)
```

### 1.2 `cursorRef` 的必要性

源码注释：批量按键在单次 render 里合并，`cursorPos` 的闭包值可能陈旧。`cursorRef` 是 `cursorPos` 的 ref 镜像，插入/删除字符时读 `cursorRef.current` 而非 `cursorPos`，避免光标位置错乱。`setCursor` 同步更新两者。

### 1.3 `transcriptKey` 的作用

Ink 的 `<Static>` 内部索引只增不减，`/resume` 重新注入历史后会跳过已渲染项。`transcriptKey` 作为 `<Static key={transcriptKey}>`，`/new`/`/clear`/`/resume` 时 +1 强制重挂载，重新渲染所有项。

### 1.4 TodoWriteTool 的模块级 pub/sub

`TodoWriteTool`（见 [04](./04-tool-system.md)）维护模块级 `currentTodos` + `subscribers`。`App` 用 `useEffect` 订阅以渲染固定 todo 面板：

```typescript
useEffect(() => {
  const unsub = subscribeTodos(setTodos)
  return () => { unsub() }
}, [])
```

## 2. 渲染栈

```
React 组件树 (App.tsx)
    │
    ▼
Ink（原生，ink 7 + react 19 + yoga-layout）
    │
    ▼
ANSI 转义序列
    │
    ▼
stdout
```

> **无** 自定义 React reconciler、**无** DOMElement 树抽象、**无** 鼠标事件。Ink 的 `exitOnCtrlC: false`——Ctrl+C 由 `useInput` 自处理。

## 3. 启动 banner（logo 显示）

`BANNER` 常量——半块（half-block）字符 ASCII art "harness code"：

```typescript
const BANNER = [
  '▗▖ ▗▖ ▗▄▖ ▗▄▄▖ ▗▖  ▗▖▗▄▄▄▖ ▗▄▄▖ ▗▄▄▖      ▗▄▄▖ ▗▄▖ ▗▄▄▄  ▗▄▄▄▖',
  '▐▌ ▐▌▐▌ ▐▌▐▌ ▐▌▐▛▚▖▐▌▐▌   ▐▌   ▐▌        ▐▌   ▐▌ ▐▌▐▌  █ ▐▌   ',
  '▐▛▀▜▌▐▛▀▜▌▐▛▀▚▖▐▌ ▝▜▌▐▛▀▀▘ ▝▀▚▖ ▝▀▚▖     ▐▌   ▐▌ ▐▌▐▌  █ ▐▛▀▀▘',
  '▐▌ ▐▌▐▌ ▐▌▐▌ ▐▌▐▌  ▐▌▐▙▄▄▖▗▄▄▞▘▗▄▄▞▘     ▝▚▄▄▖▝▚▄▞▘▐▙▄▄▀ ▐▙▄▄▖',
] as const
```

渲染：作为 `<Static>` 的**首个 item**（`{ role: 'banner', text: '' }`），每行 `<Text color="cyan">`。这样 banner 持久留在 scrollback，survives `/resume` 重挂载（源码注释：pre-render `stdout.write` 会在重挂载时被清掉）。

> **无** banner 动画、**无** 版本号附加。纯静态 4 行青色 ASCII art。

## 4. 顶部提示行

```tsx
<Text dimColor>cwd: {cwd}  ·  /help for commands  ·  Esc/Ctrl+C stop  ·  Ctrl+C×2 exit</Text>
```

固定一行暗色（dimColor）提示：当前 cwd、`/help`、停止/退出快捷键。

## 5. Transcript 渲染（`<Static>`）

```tsx
<Static key={transcriptKey} items={[{ role: 'banner', text: '' }, ...transcript]}>
  {(entry, i) => (
    <Box key={i} flexDirection="column">
      {entry.role === 'banner' && BANNER.map((line, idx) => <Text key={idx} color="cyan">{line}</Text>)}
      {entry.role === 'user' && <Text color="green">❯ {entry.text}</Text>}
      {entry.role === 'assistant' && <Text color="cyan">{entry.text}</Text>}
      {entry.role === 'tool' && <Text dimColor>{entry.text}</Text>}
    </Box>
  )}
</Static>
```

`TranscriptEntry { role: 'user'|'assistant'|'tool'|'banner'; text: string; toolName?: string }`。

- **user**：绿色 `❯ <text>`
- **assistant**：青色 `<text>`
- **tool**：暗色 `<text>`（形如 `▶ BashTool: npm test` / `✓ FileEditTool: src/x.ts`）
- **banner**：见 §3

`<Static>` 使已渲染项持久留在终端 scrollback（不随后续渲染重绘）。

### 5.1 工具标签生成 (`toolLabel`)

`toolLabel(name, input)` 生成人类可读的工具调用标签（非裸工具名）：

| 工具 | 标签 |
|------|------|
| FileRead/Edit/Write/NotebookEdit | `file_path` 或 `notebook_path` |
| BashTool/Bash | `command` 截 60 字符 |
| GlobTool | `pattern` |
| GrepTool | `pattern` |
| TodoWriteTool | `N todos (done/N done)` 或 `clear todos` |
| WebFetchTool | `url` 截 60 字符 |
| AgentTool | `description` 或 `prompt` 截 60 字符 |
| ExitPlanMode | `present plan` |
| AskUserQuestionTool | 第一个 `question` 截 60 字符 |
| 其他 | 裸工具名 |

### 5.2 工具调用在 transcript 的呈现

`runQuery` 的回调：
- `onToolStart(name, input)` → 追加 `{ role:'tool', text: '▶ ${name}: ${label}' }`，清空 streamingText，设 activity=`running ${label}`
- `onToolEnd(name, input, _, isError)` → 追加 `{ role:'tool', text: '${isError ? "✗" : "✓"} ${name}: ${label}' }`，activity=`thinking`

`▶` 表示开始，`✓`/`✗` 表示结束（成功/失败）。

## 6. 流式文本与 spinner

```tsx
<Newline />
<Box flexDirection="column">
  {streamingText && <Text color="cyan">{streamingText}</Text>}
  {loading && !streamingText && <Text dimColor>{SPINNER_FRAMES[spinnerFrame]} {activity}…</Text>}
</Box>
```

- **流式文本**：`onTextDelta` 累加到 `streamingText`，青色显示。工具开始时清空。
- **spinner**：仅在 `loading && !streamingText` 时显示（有流式文本时不显示 spinner）。

### 6.1 Braille spinner

```typescript
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
```

10 帧 braille，80ms 切换：

```typescript
useEffect(() => {
  if (!loading) { setSpinnerFrame(0); return }
  const id = setInterval(() => setSpinnerFrame(f => (f + 1) % SPINNER_FRAMES.length), 80)
  return () => clearInterval(id)
}, [loading])
```

### 6.2 activity 标签

`activity` 状态随生命周期变化：
- `submitMessage` 开始 → `'thinking'`
- `onTextDelta` → `'writing'`
- `onToolStart` → `'running ${label}'`（如 `running src/x.ts`、`running npm test`）
- `onToolEnd` → `'thinking'`

显示：`{spinner帧} {activity}…`（如 `⠋ thinking…`、`⠹ writing…`、`⠼ running npm test…`）。

## 7. 交互式对话框与选择器

### 7.1 权限审批对话框 (`pendingPerm`)

写工具需要审批时（`permAskHolder.cb` 被调）：

```tsx
{pendingPerm && (
  <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
    <Text bold color="magenta">Permission requested: {pendingPerm.tool}</Text>
    {pendingPerm.reason && <Text dimColor>{pendingPerm.reason}</Text>}
    <Text bold color="green">Allow? [y] yes  /  [n] no</Text>
  </Box>
)}
```

`useInput` 拦截：`y` → `permResolver(true)`；`n` → `permResolver(false)`；其他键忽略。

### 7.2 Plan 审批对话框 (`pendingPlan`)

```tsx
{pendingPlan && (
  <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
    <Text bold color="yellow">Proposed plan</Text>
    <Text>{pendingPlan}</Text>
    <Text bold color="green">Approve? [y] yes  /  [n] no</Text>
  </Box>
)}
```

`useInput` 拦截：`y`/`n` 同上（`planResolver`）。

### 7.3 模型选择器 (`modelSelectIdx`)

`/model` 无参时打开（`setModelSelectIdx` 设当前模型索引）：

```tsx
{modelSelectIdx !== null && (
  <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
    <Text bold color="cyan">Select model  </Text>
    <Text dimColor>↑/↓ move  ·  Enter confirm  ·  Esc cancel</Text>
    {engine.getModelManager().listModels().map((m, i) => (
      <Text key={m.id} color={i === modelSelectIdx ? 'cyan' : undefined} bold={i === modelSelectIdx}>
        {i === modelSelectIdx ? '❯' : ' '} {m.id}{m.name ? ` — ${m.name}` : ''}
      </Text>
    ))}
  </Box>
)}
```

`useInput` 拦截：
- `↑` → `idx = (idx - 1 + len) % len`
- `↓` → `idx = (idx + 1) % len`
- `Enter` → `setModel(chosen.id)`，transcript 提示 `Model switched to ${resolved}`，refreshFooter
- `Esc` 或 `Ctrl+C` → 取消（`setModelSelectIdx(null)`）

### 7.4 历史会话选择器 (`historySelect`)

`/history` 打开：

```tsx
{historySelect && (
  <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
    <Text bold color="magenta">Session history  </Text>
    <Text dimColor>↑/↓ move  ·  Enter resume  ·  Esc cancel</Text>
    {historySelect.sessions.slice(0, 20).map((s, i) => (
      <Text key={s.id} color={i === historySelect.idx ? 'magenta' : undefined} bold={i === historySelect.idx}>
        {i === historySelect.idx ? '❯' : ' '} {s.id}  ·  {s.messageCount} msgs  ·  {new Date(s.updatedAt).toLocaleString()}{s.summary ? `  — ${s.summary}` : ''}
      </Text>
    ))}
  </Box>
)}
```

`useInput` 拦截：`↑`/`↓` 移动（循环）、`Enter` → `engine.resumeSession(chosen.id)` + 重挂载 transcript + footer + 提示 `Resumed session ${id} (${count} messages).`、`Esc`/`Ctrl+C` 取消。最多显示 20 条。

### 7.5 固定 Todo 面板

```tsx
{todos.todos.length > 0 && todos.todos.some(t => t.status !== 'completed') && (
  <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} marginTop={1}>
    <Text bold color="blue">Todos ({done}/{total})</Text>
    {todos.todos.map((t, idx) => (
      <Text key={idx} color={t.status === 'completed' ? 'gray' : t.status === 'in_progress' ? 'cyan' : undefined}>
        {t.status === 'completed' ? '  ✓ ' : t.status === 'in_progress' ? '  ▶ ' : '  · '}{t.activeForm || t.content}
      </Text>
    ))}
  </Box>
)}
```

仅当有 todo 且非全部完成时显示。`completed`→灰色 `✓`、`in_progress`→青色 `▶`、`pending`→`·`。订阅 `TodoWriteTool` 实时更新，固定在输入框上方（不随 transcript 滚动）。

## 8. 输入框与光标逻辑

```tsx
<Newline />
<Box>
  <Text color="blue">❯ </Text>
  <Text>{input.slice(0, cursorPos)}<Text color="blue">▋</Text>{input.slice(cursorPos)}</Text>
</Box>
```

**光标显示**：青色（blue）`▋`（块字符）插入在 `input.slice(0, cursorPos)` 和 `input.slice(cursorPos)` 之间。光标位置 = `cursorPos` 索引。

### 8.1 光标移动

```
leftArrow  → setCursor(max(0, cursorRef.current - 1))
rightArrow → setCursor(min(input.length, cursorRef.current + 1))
```

### 8.2 字符插入（IME 感知）

```typescript
if (inputChar && !key.ctrl && !key.meta && inputChar !== '\r') {
  const p = cursorRef.current
  setInput(s => s.slice(0, p) + inputChar + s.slice(p))
  // 按 code point 数量移动（IME 可能一次发整词如 "你好"，+1 会留在 token 中间）
  setCursor(p + [...inputChar].length)
}
```

> **关键 IME 细节**：`[...inputChar].length` 用扩展运算符按 code point 计数，而非 `+1`。IME 一次可能发多字符（如中文整词），`+1` 会把光标留在多字符 token 中间。

### 8.3 退格

```typescript
if (key.backspace || key.delete) {
  const p = cursorRef.current
  if (p > 0) {
    setInput(s => s.slice(0, p - 1) + s.slice(p))
    setCursor(p - 1)
  }
}
```

删光标前一个字符，光标左移。

### 8.4 历史导航（上/下箭头）

```
upArrow: history.length > 0 →
  newIdx = historyIdx === -1 ? history.length - 1 : max(0, historyIdx - 1)
  setHistoryIdx(newIdx); setInput(history[newIdx]); setCursor(history[newIdx].length)  // 光标移到末尾

downArrow: historyIdx !== -1 →
  newIdx = historyIdx + 1
  newIdx >= history.length → setHistoryIdx(-1); setInput(''); setCursor(0)   // 越界回到空输入
  否则 → setHistoryIdx(newIdx); setInput(history[newIdx]); setCursor(history[newIdx].length)
```

`history` 在 `handleSubmit` 成功提交时追加（`setHistory(h => [...h, prompt])`）。注意：这是**会话内**历史（React state），**不**持久化到磁盘（无 `~/.claude/history.jsonl`）。上箭头填入历史项时光标自动到末尾。

### 8.5 提交

`key.return`（Enter）→ `handleSubmit()`。

## 9. 键盘输入处理总表 (`useInput`)

`useInput` 的处理顺序（**先到先匹配，return 后不再处理**）：

| 优先级 | 条件 | 行为 |
|:------:|------|------|
| 1 | `pendingPerm` + `permResolver` | `y`→approve, `n`→deny，return |
| 2 | `pendingPlan` + `planResolver` | `y`→approve, `n`→reject，return |
| 3 | `modelSelectIdx !== null` | `↑/↓` 移动, `Enter` 确认, `Esc`/`Ctrl+C` 取消，return |
| 4 | `historySelect` | `↑/↓` 移动, `Enter` 恢复, `Esc`/`Ctrl+C` 取消，return |
| 5 | `key.escape && loading` | `engine.interrupt()` + "(stopped)"，return |
| 6 | `key.return` | `handleSubmit()`，return |
| 7 | `Ctrl+C` | loading→interrupt；idle→双击退出（见 §10） |
| 8 | `upArrow` | 历史导航（§8.4） |
| 9 | `downArrow` | 历史导航（§8.4） |
| 10 | `leftArrow` | 光标左移 |
| 11 | `rightArrow` | 光标右移 |
| 12 | `backspace`/`delete` | 退格 |
| 13 | 普通 `inputChar`（非 ctrl/meta，非 `\r`） | IME 感知插入（§8.2） |

> 对话框/选择器开启时，普通字符输入被**抑制**（前面分支 return 了）。这保证 `pendingPerm` 时按 `y` 不会同时往输入框插 `y`。

## 10. Ctrl+C / Esc / 退出逻辑

```
Esc + loading → engine.interrupt() + "(stopped)"   ← 停止当前输出，不退出
Ctrl+C:
  loading → engine.interrupt() + "(stopped)"        ← 同 Esc，停止输出不退出
  idle → 双击退出:
    now - ctrlCCount.current < 1500ms → engine.shutdown() + exit()   ← 1.5s 内第二次 → 退出
    否则 → ctrlCCount.current = now; transcript "Press Ctrl+C again to exit."
           setTimeout(1500ms) 重置 ctrlCCount
```

> **关键设计**：`exitOnCtrlC: false`（`launchRepl` 里）。Ink 默认首个 Ctrl+C 杀进程，会绕过自处理逻辑。运行中 Ctrl+C = 停止输出（非退出）；idle 时需**双击**（1.5s 内）才退出。裸 `exit`/`quit` 输入也可退出（`handleSubmit` 里 `/^(exit|quit)$/i`）。

## 11. 进度条与 footer（信息显示）

```tsx
<Box flexDirection="row" gap={1}>
  <Text color={footer.pct >= 80 ? 'red' : footer.pct >= 50 ? 'yellow' : 'cyan'}>
    {renderBar(footer.pct, ringFrame)}
  </Text>
  <Text dimColor>ctx: {footer.ctxK}/{footer.winK} ({footer.pct}%)  ·  {footer.model}  ·  {footer.mode}  ·  {footer.total}</Text>
</Box>
```

### 11.1 footer 数据

```typescript
interface Footer { ctxK: string; winK: string; pct: number; total: string; model: string; mode: string }
```

`refreshFooter()`：
```typescript
const ctx = engine.getContextTokens()                          // estimateTokens(messages) ≈ chars/4
const pct = min(100, round(ctx / DEFAULT_CONTEXT_WINDOW * 100))
const ctxK = ctx >= 1000 ? `${(ctx/1000).toFixed(1)}k` : `${ctx}`
const winK = `${(DEFAULT_CONTEXT_WINDOW / 1000).toFixed(0)}k`   // "400k"
const total = formatCost(costTracker.getTotalCost())           // >$0.5→2位小数, 否则4位
const model = engine.getModelManager().getModel()
const mode = engine.getPermissionMode() ?? 'default'
```

- `DEFAULT_CONTEXT_WINDOW = 400_000`（来自 compact.ts）
- 颜色：pct≥80 红、≥50 黄、否则青
- `refreshFooter` 在 `loading` 变化时 + 每次 `onUsage` + 命令改变引擎状态后调用

### 11.2 进度条 (`renderBar`, `barGlyph.ts`)

```typescript
export function renderBar(pct: number, phase: number, width = 18): string {
  const clamped = max(0, min(100, pct))
  const filled = round(clamped / 100 * width)
  let out = '['
  for (i in 0..width):
    if (i < filled):
      shinePos = filled - 1 - (phase % 4)          // ▓ shine 在填充边缘内右移
      out += i === shinePos ? '▓' : '█'
    else:
      dotPos = filled + (phase % max(1, width - filled))   // ▒ 暗点在空区游走
      out += i === dotPos ? '▒' : '░'
  out += ']'
}
```

效果：`[███████▓▒░░░░░░░]`
- 填充区：实心 `█`，边缘内有 `▓` shine 每 4 帧右移
- 空区：暗 `░`，一个 `▒` 点游走

**动画**：`ringFrame` 每 120ms +1（mod 18）：

```typescript
useEffect(() => {
  const id = setInterval(() => setRingFrame(f => (f + 1) % 18), 120)
  return () => clearInterval(id)
}, [])
```

> shine/dot 持续流动，任何填充水平都"有生气"。`renderBar` 只返回括号内条（不含百分比），百分比由 footer 文本拼接。

## 12. `handleSubmit` 逻辑

见 [09-skills-and-plugins.md](./09-skills-and-plugins.md) §5.3 的完整流程。关键 UI 相关点：
- 提交后 `setInput('')` + `setCursor(0)`
- `loading` 时：`/stop` 立即中断；其他 `/` 延迟；普通文本排队 + "(queued — will be sent on the next turn)"
- slash 命令分发后 `refreshFooter()`（因 `/bypass`/`/model` 改了 footer 显示的引擎状态）

## 13. `runQuery` — agent 调用与 UI 回调

```typescript
async function runQuery(prompt: string) {
  setLoading(true); setStreamingText(''); setActivity('thinking')
  try {
    const result = await engine.submitMessage(prompt, {
      onTextDelta: (t) => { setStreamingText(s => s + t); setActivity('writing') },
      onToolStart: (name, input) => {
        const label = toolLabel(name, input)
        setActivity(`running ${label}`)
        setTranscript(t => [...t, { role:'tool', text:`▶ ${name}: ${label}`, toolName:name }])
        setStreamingText('')
      },
      onToolEnd: (name, input, _, isError) => {
        const label = toolLabel(name, input)
        setTranscript(t => [...t, { role:'tool', text:`${isError?'✗':'✓'} ${name}: ${label}`, toolName:name }])
        setActivity('thinking')
      },
      onUsage: () => refreshFooter(),
      onPlanPresented: (plan) => {
        setPendingPlan(plan)
        return new Promise<boolean>(resolve => { planResolver.current = resolve })
      },
    })
    const finalText = getFinalText(result.messages)
    if (finalText) setTranscript(t => [...t, { role:'assistant', text: finalText }])
    if (result.reason === 'error') setTranscript(t => [...t, { role:'assistant', text:`Error: ${result.error}` }])
  } catch (e) {
    setTranscript(t => [...t, { role:'assistant', text:`Error: ${(e as Error).message}` }])
  } finally {
    setLoading(false); setStreamingText('')
  }
}
```

### 13.1 会话恢复 transcript 重注入

`App` 挂载时 + `/resume`/`/history` 恢复时，从 `engine.getMessages()` 重建 transcript entries（text 块→user/assistant，tool_use 块→tool），`setTranscriptKey(k+1)` 强制 `<Static>` 重挂载。这段逻辑在源码里**重复了 3 次**（挂载 useEffect、`resumeSession` ctx 回调、history 选择器 Enter）——复现时保留重复。

### 13.2 `permAskHolder` 注入

```typescript
useEffect(() => {
  if (!permAskHolder) return
  permAskHolder.cb = async (tool, _input, reason) => {
    setPendingPerm({ tool, reason })
    return new Promise<boolean>(resolve => { permResolver.current = resolve })
  }
}, [])
```

`main.tsx` 创建空 `permAskHolder` 对象传入；`App` 挂载时注入 `cb`。注入前（极早期）ask → deny（main.tsx 的 `onAsk` fallback）。

## 14. 成本追踪 (`services/api/usage.ts`)

### 14.1 `UsageTracker`

```typescript
class UsageTracker {
  private byModel = new Map<string, ModelUsage>()
  private totalCost = 0
  add(model, usage): void      // computeCost + 累加 byModel + totalCost
  getTotalCost(): number
  getByModel(): Map<string, ModelUsage>
  reset(): void
}
```

`computeCost(model, usage)`：按 `DEFAULT_PRICING[model]` 算（input/output/cacheRead/cacheWrite 各自 per1M）。未知模型回退 `gpt-5.5` 定价。定价是占位（代理不计费）。

```typescript
const DEFAULT_PRICING = {
  'gpt-5.5':      { inputPer1M: 1.25, outputPer1M: 10, cacheReadPer1M: 0.1, cacheWritePer1M: 1.5 },
  'gpt-5.4':      { inputPer1M: 1.25, outputPer1M: 10, cacheReadPer1M: 0.1, cacheWritePer1M: 1.5 },
  'gpt-5.4-mini': { inputPer1M: 0.15, outputPer1M: 0.6, cacheReadPer1M: 0.015, cacheWritePer1M: 0.18 },
  'mimo-v2.5':    { inputPer1M: 0.5,  outputPer1M: 2,  cacheReadPer1M: 0.05, cacheWritePer1M: 0.6 },
  'mimo-v2.5-pro':{ inputPer1M: 1,    outputPer1M: 4,  cacheReadPer1M: 0.1,  cacheWritePer1M: 1.2 },
}
```

### 14.2 格式化

```typescript
formatCost(usd): string        // > $0.5 → `$X.XX` (2位); ≤ $0.5 → `$X.XXXX` (4位)
formatTotalCost(tracker): string   // 按模型分行: "  model: N in / N out / N cache-read / N cache-write — $X.XX" + "  Total: $X.XX"
```

### 14.3 UI 集成

- footer 的 `{footer.total}` = `formatCost(costTracker.getTotalCost())`
- `/cost` 命令 = `formatTotalCost(costTracker)`
- `onUsage` 回调（query 每轮 callModel 后）→ `usageTracker.add(model, usage)` + `refreshFooter()`

> **注意：** `QueryEngine` 内部有**自己的** `UsageTracker`（`this.usageTracker`），而 `main.tsx` 创建了**另一个** `UsageTracker` 传给 `App`/`launchRepl`。`onUsage` 回调同时喂两者（QueryEngine 的在 query deps 里，main 的在 callbacks.onUsage 里）。`/cost` 和 footer 用 main 的；`engine.getUsageTracker()` 用内部的。

## 15. 关键源码路径

| 功能 | 源码路径 |
|------|---------|
| Ink REPL 根组件 | `src/ink/App.tsx` |
| 进度条渲染 | `src/ink/barGlyph.ts` |
| 成本追踪 | `src/services/api/usage.ts` |
| Todo pub/sub | `src/tools/TodoWriteTool/TodoWriteTool.ts` |
| REPL 启动 | `src/ink/App.tsx` `launchRepl()` |
| Slash 命令分发 | `src/ink/App.tsx` `handleSubmit()` + `src/commands.ts` |

## 16. 已知边界 / 未实现项

- **无** AppState（~450 字段）/ `useSyncExternalStore` 选择器。状态全在 `App` 的 `useState`/`useRef`。`src/state/store.ts` 的 `createStore` 存在但未被任何代码 import（死代码）。
- **无** 定制 Ink reconciler / ScrollBox / DOMElement 树 / 鼠标事件 / 悬停 / 超链接。
- **无** Vim 模式（motions/operators/textObjects/点重复）。
- **无** 18 上下文快捷键系统 / 和弦 / 热重载 / keybindings.json。
- **无** 终端能力探测（Kitty/xterm/XTVERSION）。
- **无** 提示历史持久化（`history` 是会话内 React state，不写 `~/.claude/history.jsonl`；无粘贴引用系统）。
- **无** 成本会话持久化（`UsageTracker` 是内存单例，退出即失；无 `saveCurrentSessionCosts`/`restoreCostStateForSession`）。
- **无** 退出时成本汇总 hook（无 `process.on('exit')` 打印 `/cost`）。
- **无** 差异视图 / 主题选择器 / 消息选择器 / 附件 / 标签页。
- `AskUserQuestionTool` 的交互 UI **未接线**（REPL 不拦截它，模型调时走 headless 默认）。
- transcript 重注入逻辑在源码里重复 3 次（挂载/resume ctx/history Enter）——保留重复。
- `renderBar` 的 `shinePos`/`dotPos` 计算在填充=0 或=width 时有边界行为（`max(1, width-filled)` 守卫空区）。
- banner 无版本号、无动画。
