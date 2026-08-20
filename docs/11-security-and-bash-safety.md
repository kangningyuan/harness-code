# 安全机制与 Bash 安全执行

> 基于 `src/utils/bash/` (lexer/parser/ast/types) + `src/utils/permissions/dangerousPatterns.ts` + 文件工具的安全逻辑（FileRead/Edit/Write/NotebookEdit）+ `src/utils/file/canonicalPath.ts` + `readFileState.ts` 实际源码。

## 1. 安全架构总览

harness-code 的安全是**纵深防御 + fail-closed**，多层共同工作：

```
┌─────────────────────────────────────────────────────┐
│ 1. Bash AST 安全分析 (utils/bash/ast.ts)             │
│    analyzeBashSafety → 可信 argv[] 或 too-complex    │
│    isReadOnlyCommand → 只读分类（影响权限）           │
├─────────────────────────────────────────────────────┤
│ 2. 文件系统安全 (文件工具 validateInput + call)       │
│    UNC 拒绝 / 设备路径拒绝 / 二进制扩展名拒绝         │
│    读前写 + mtime 新鲜度 / 大小上限 / canonicalPath   │
├─────────────────────────────────────────────────────┤
│ 3. 受保护路径 (dangerousPatterns.ts) — bypass-immune │
│    .git / .claude / .vscode / shell 配置文件          │
├─────────────────────────────────────────────────────┤
│ 4. 权限决策管线 (permissions.ts) — 见 doc 05         │
│    deny 规则 / ask / bypass-immune 层                 │
├─────────────────────────────────────────────────────┤
│ 5. auto 模式 AI 分类器 (classifier.ts) — fail-closed │
│    出错/超时 → shouldBlock=true                       │
└─────────────────────────────────────────────────────┘
```

> **无** 企业策略/MDM、**无** 沙箱执行（无 namespace/chroot/seatbelt）、**无** `dangerously-skip-permissions` 的 root/sudo 阻止、**无** 网络访问沙箱。安全完全靠 AST 分析 + 权限管线 + 受保护路径。

## 2. Bash 解析器 (`utils/bash/`)

手写的 Bash 解析器（lexer → parser → AST），tree-sitter-bash 兼容的节点类型。

### 2.1 词法分析 (`lexer.ts`, ~437 行)

`lex(source: string): Token[]`。tokenize 命令字符串为 token 流（word/string/raw_string/operator 等）。

### 2.2 解析器 (`bashParser.ts`, ~492 行)

```typescript
export function parse(source: string): ProgramNode {
  const tokens = lex(source)
  const parser = new Parser(tokens)
  return parser.parseProgram()
}

export class ParseError extends Error { ... }

export function stripSafeWrappers(command: string): string
```

`Parser` 递归下降，产出 `ProgramNode`。**Node 预算 + 超时**保护防 DoS：
- `throw new ParseError('Node budget exceeded (too-complex)')` — 节点数超限
- `throw new ParseError('Parse timeout (too-complex)')` — 解析超时
- 未处理构造 → `throw new ParseError(...)`（caller 当 `too-complex`）

### 2.3 `stripSafeWrappers` — 剥安全包装

分析前剥掉 `timeout`/`time`/`nice`/`nohup`/`command`/`env` 前缀 + 安全 env vars（`LANG`/`LC_ALL`/`LC_CTYPE`/`PATH`/`TERM`/`HOME`/`USER`），让权限规则匹配底层真实命令：
- `timeout 10 npm test` → `npm test`（timeout 带时长参数，剥前 2 个）
- `nice npm test` → `npm test`（剥前 1 个）
- `LANG=C LC_ALL=C grep foo` → `grep foo`（剥安全 env vars）
- 非安全 env vars 保留

## 3. AST 安全遍历器 (`ast.ts`, ~469 行)

核心问题：**能否为每个 simple_command 产出可信 argv[]？**

### 3.1 `analyzeBashSafety(command): SafetyVerdict`

```typescript
type SafetyVerdict =
  | { ok: true; argv: string[][]; commands: string[] }
  | { ok: false; reason: string; code: SafetyFailureCode }

type SafetyFailureCode =
  | 'too-complex' | 'control-chars' | 'ifs-assignment' | 'ps4-assignment'
  | 'declare-flags' | 'bare-var-ifs' | 'empty-var-bare' | 'arithmetic-injection'
  | 'unquoted-heredoc' | 'standalone-cmdsub' | 'read-in-conditional'
  | 'parse-error' | 'zsh-dynamic' | 'backslash-space'
```

**Fail-closed**：任何未显式处理的节点类型 → `too-complex`（caller 要求用户确认，而非放行）。

### 3.2 预检查（解析前）

```typescript
const CONTROL_CHARS = /[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/              // 控制字符 → control-chars
const UNICODE_WHITESPACE_CHARS = [' ', ' ', ' ', ...]                   // Unicode 空白 → too-complex
const BACKSLASH_SPACE = /\\[ \t]/                                        // 行续行 → backslash-space
const ZSH_DYNAMIC = /~\[|(^|\s)=\w/                                      // zsh 动态目录/equals 扩展 → zsh-dynamic
const SAFE_PS4_CHARS = /^[\w\s.:/_+$(){}'"-]*$/                          // PS4 安全字符白名单
```

预检查命中即返回对应失败码，不进解析。

### 3.3 遍历 (`walk`)

递归遍历 AST，维护 `scope: Map<string, string>`（变量→值/`VAR_PLACEHOLDER`）。各类节点：

| 节点 | 处理 |
|------|------|
| `program`/`compound_statement` | 遍历 children，同 scope |
| `subshell` | **隔离 scope**（`new Map(scope)`） |
| `list` (`&&`/`\|\|`/`;`/`&`/`\|`) | `&&`/`;` 线性传播 scope；`\|\|`/`\|`/`&` 重置 scope（条件/子壳） |
| `pipeline` | 每阶段子壳隔离 scope |
| `simple_command` | `walkSimpleCommand`（核心，见 §3.4） |
| `if_statement` | condition 独立 scope；consequence/alternative 各新 scope |
| `for_statement` | 循环变量标记 `VAR_PLACEHOLDER`；iterable 在 bodyScope 遍历 |
| `while_statement` | condition 独立 scope；body 新 scope |
| `case_statement` | value 评估；每个 item body 新 scope |
| `function_definition` | （源码处理） |
| `command_substitution` | `CMDSUB_PLACEHOLDER` |
| `expansion`/`concatenation` | 解析变量引用 |
| `file_redirect`/`heredoc_redirect`/`herestring_redirect` | 重定向分析 |
| **未知类型** | → `too-complex` |

### 3.4 安全检查（`walkSimpleCommand` 内）

源码 §11.2.2.3 列举的检查：
- **IFS 赋值** → `ifs-assignment`（改变 word splitting）
- **PS4 赋值**（非白名单字符）→ `ps4-assignment`（RCE via `set -x` tracing）
- **`declare -n/-i/-a/-A`** → `declare-flags`（改变赋值语义）
- **裸 `$VAR` 含 IFS/glob 字符** → `bare-var-ifs`
- **空 `$VAR` 作裸参数** → `empty-var-bare`（word splitting 下消失）
- **`$((expr))` 含变量** → `arithmetic-injection`
- **未引号 heredoc 定界符** → `unquoted-heredoc`（body 被扩展）
- **独立 `CMDSUB_PLACEHOLDER` 作 argv** → `standalone-cmdsub`
- **`read VAR` 在 `\|\|`/pipe 中** → `read-in-conditional`（可能覆盖被跟踪字面量）

### 3.5 `isReadOnlyCommand(command): boolean`

```typescript
const READ_ONLY_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'wc',
  'stat', 'file', 'echo', 'printf', 'pwd', 'whoami', 'date', 'env', 'printenv',
  'which', 'type', 'uname', 'df', 'du', 'ps', 'top', 'node', 'rustc', 'gcc',
])

export function isReadOnlyCommand(command: string): boolean {
  const verdict = analyzeBashSafety(command)
  if (!verdict.ok) return false   // 分析失败 → 非只读（fail-closed，要求确认）
  for (const argv of verdict.argv) {
    const name = argv[0] ?? ''
    if (name === 'git') {
      const sub = argv[1] ?? ''
      if (!['status','log','diff','branch','show','remote','rev-parse','ls-files','blame'].includes(sub)) return false
    } else if (!READ_ONLY_COMMANDS.has(name)) return false
  }
  if (/>|>>|&>/.test(command)) return false   // 写重定向 → 非只读
  return true
}
```

`BashTool.isReadOnly = (input) => classifyReadOnly(input.command) = isReadOnlyCommand(input.command)`。只读命令在 default/auto 模式自动 allow（见 [05](./05-permission-and-hooks.md)）。

> **只读 git 子命令白名单**：`status log diff branch show remote rev-parse ls-files blame`。其他 git 子命令（`add`/`commit`/`push`/`reset` 等）→ 非只读 → ask。

## 4. 文件系统安全

### 4.1 UNC 路径拒绝（所有文件工具）

```typescript
function isUncPath(p: string): boolean {
  return /^[\\/]{2}[^\\/]+[\\/]/.test(p)   // \\server\share 或 //server/share
}
```

UNC 路径在 Windows 下可能触发 NTLM 凭证泄漏。FileRead/Edit/Write 的 `validateInput` 拒绝。

### 4.2 设备路径拒绝（FileReadTool）

```typescript
const BLOCKED_DEVICE_PATHS = new Set([
  '/dev/zero', '/dev/random', '/dev/urandom', '/dev/stdin', '/dev/tty',
  '/proc/self/fd/0', '/proc/self/fd/1', '/proc/self/fd/2',
])
```

读这些会挂起或泄漏凭证。`validateInput` 拒绝（规范化后比较 + 前缀）。

### 4.3 二进制扩展名拒绝（FileReadTool）

```typescript
const BINARY_EXTENSIONS = new Set([
  '.exe', '.bin', '.dll', '.so', '.dylib', '.o', '.a', '.class', '.jar',
  '.war', '.pyc', '.pyo', '.wasm', '.obj', '.lib', '.pdb',
])
```

`validateInput` 拒绝（避免把二进制当文本读进上下文）。

### 4.4 `canonicalPath` — 路径规范化 (`utils/file/canonicalPath.ts`)

```typescript
export function canonicalPath(p: string, cwd: string): string {
  const abs = isAbsolute(p) ? p : resolve(cwd, p)
  try { return realpathSync(abs) }   // 解符号链接
  catch { return abs }
}
```

**关键**：macOS 上 `/var` → `/private/var`、`/tmp` → `/private/tmp`。若模型读用一种路径形式、编辑用另一种，`readFileState` 缓存键会失配，破坏读前写。`realpathSync` 把两种形式映射到同一键。所有文件工具用它规范化路径。

### 4.5 读前写 + mtime 新鲜度（FileEdit/Write/NotebookEdit）

```
存在文件编辑/覆盖前:
  1. readFileState.get(path) 必须存在且 isFullRead（无 offset/limit）→ 否则 error "Must read ... before editing"
  2. stat.mtimeMs === prev.mtimeMs → 否则 error "File was modified since last read (mtime changed)"
```

`isFullRead(entry)`：`entry.offset === undefined && entry.limit === undefined`（完整读，非切片）。

- **新文件创建**（FileEdit `old_string===""` / FileWrite 不存在）→ 跳过读要求
- 编辑/写后更新 `readFileState.recordRead(path, newMtimeMs)`，同轮再编辑可用

### 4.6 文件大小上限

| 工具 | 上限 | 行为 |
|------|------|------|
| FileReadTool | 2 MiB 文本 / 2 MiB 图像 | 超限拒绝（提示用 offset/limit 或 GrepTool） |
| FileEditTool | 1 GiB | 超限拒绝 |
| FileWriteTool | 无显式上限 | （依赖读前写间接限制） |
| BashTool | 64 MiB stdout/stderr | 超限截断捕获 |

### 4.7 行尾规范化（FileWriteTool）

```typescript
const content = input.content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')   // 总是 LF
```

### 4.8 引号归一化（FileEditTool）

```typescript
function normalizeQuotes(s) {
  return s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/–/g, '-').replace(/—/g, '--')
}
```

`countOccurrences`/`applyEdit` 用归一化比较，容忍模型用弯引号/破折号。

### 4.9 去重 stub（FileReadTool）

完整读且 mtime 未变 → 返回 `FILE_UNCHANGED_STUB`（`<system-reminder>File content unchanged since last read</system-reminder>`），省 token。

## 5. 受保护路径 (`dangerousPatterns.ts`) — bypass-immune

```typescript
export const SAFETY_CHECK_PATHS = [
  '.git/', '.claude/', '.vscode/',
  '.bashrc', '.zshrc', '.profile', '.bash_profile', '.zprofile',
  '.config/fish/config.fish',
]
```

`isSafetyCheckPath(path, cwd)`：`canonicalPath` 后检查路径是否落在受保护目录/文件。

`bashCommandTouchesSafetyPath(command)`：启发式——命令含受保护路径字串 **且** 是写操作（`>`/`>>`/`tee`/`cp`/`mv`/`rm`/`mkdir`/`touch`）→ true。

权限管线 `checkSafetyPaths`（[05](./05-permission-and-hooks.md) §2.2）：
- 非只读工具才检查
- BashTool 查 `bashCommandTouchesSafetyPath`
- 文件工具查 `file_path`/`notebook_path`/`path` 是否 `isSafetyCheckPath`
- 命中 → `ask`（**即使 bypassPermissions 模式也 ask**——bypass-immune）

> **这是唯一阻挡 `--dangerously-skip-permissions` 的层**。bypass 模式下写 `.git/`、`.claude/`、shell 配置仍要用户确认。

## 6. BashTool 执行安全

见 [04](./04-tool-system.md) §3.5。关键安全点：
- `spawn({ shell: true })` 执行
- 超时 `120_000`ms（默认），SIGTERM → 2s 后 SIGKILL
- abort signal 监听 → SIGTERM
- stdout/stderr 各 64 MiB cap
- `isReadOnly` 由 AST 判定（影响权限，非执行隔离）
- **无沙箱**（无 namespace/chroot/seatbelt），命令在 `context.cwd` 直接跑

## 7. auto 模式 AI 分类器安全

见 [05](./05-permission-and-hooks.md) §4。fail-closed：出错/超时/非 JSON → `shouldBlock=true`。BLOCK 规则：破坏性/不可逆/受保护路径/危险命令（`rm -rf`/force push/`sudo`/`curl|sh`）/外发数据。

## 8. 安全层级与 bypass 行为汇总

| 层 | bypass 是否跳过 | 失败行为 |
|----|:--------------:|---------|
| Bash AST 分析（只读分类） | 间接（bypass allow，但只读分类影响 isReadOnly） | 分析失败 → 非只读 → bypass 下 allow / default 下 ask |
| 文件 UNC/设备/二进制拒绝 | **否**（validateInput 总跑） | error tool_result |
| 读前写 + mtime | **否**（工具 call 内强制） | error tool_result |
| 受保护路径 | **否**（bypass-immune） | ask |
| 工具级 deny 规则 | **否**（bypass-immune） | deny |
| 工具级 ask 规则 | **否**（bypass-immune） | ask |
| 其他写工具 | **是**（bypass → allow） | allow |
| auto 分类器 | N/A（auto 模式专用） | fail-closed block |

## 9. 已知边界 / 未实现项

- **无沙箱执行**（无 namespace/chroot/seatbelt/sandbox-exec）。Bash 命令在 cwd 直接跑。
- **无 root/sudo 阻止**（bypass 模式不检查是否 root）。
- **无网络访问沙箱**（无出站网络限制；WebFetchTool 预批准主机声明但权限未用）。
- **无企业策略/MDM**（`policy` settings 来源声明但不填充）。
- **`isCompoundCommand` 守卫声明但 `findMatchingShellRule` 未用它**（复合命令仍可能被 prefix 规则匹配）。
- **BashTool `run_in_background` 未实现**（恒前台，无后台进程管理）。
- **`bashCommandTouchesSafetyPath` 是启发式**（字串匹配 + 写操作正则，非 AST 精确分析）。
- **FileReadTool PDF 未真正解析**（当文本读，`pages` 参数仅校验扩展名）。
- **危险模式检测依赖 AST**——未处理构造 → `too-complex`（要求确认），这是 fail-closed 的核心，但意味着复杂合法命令也可能被要求确认。
- `stripSafeWrappers` 只剥**前缀**安全包装（`timeout 10 cmd`），不处理嵌套。
