# 测试

> 基于 `vitest.config.ts` + `package.json` scripts + `tests/setup.ts` + `tests/` 下 22 个测试文件实际源码。
>
> 复现验证：一个 coding agent 复现本项目后，应能跑通这套测试来验证实现的正确性。当前基线：`npm test` → **19 文件通过 / 3 跳过 / 199 测试通过 / 5 跳过**（API 测试需凭证才跑）。

## 1. 测试栈

| 项 | 值 |
|----|-----|
| 框架 | vitest 4 |
| 环境 | `node`（`environment: 'node'`，非 jsdom——无 DOM，Ink UI 测试用 `ink-testing-library`） |
| globals | `true`（`describe`/`it`/`expect`/`vi` 全局可用，无需 import） |
| include | `tests/**/*.test.ts` + `tests/**/*.test.tsx` |
| 超时 | `testTimeout: 60000` / `hookTimeout: 60000`（1 分钟，容纳真实 API 调用） |
| setupFiles | `tests/setup.ts` |
| 转译 | esbuild `target: es2022` + `jsx: 'automatic'`（vitest 4 实际用 oxc，esbuild 配置被忽略——见运行警告） |

## 2. 测试命令（`package.json` scripts）

| 命令 | 作用 |
|------|------|
| `npm test` | `vitest run`——跑全部单元 + 集成测试（API 测试自动 skip，见 §4） |
| `npm run test:watch` | `vitest`——watch 模式 |
| `npm run test:api` | `RUN_API_TESTS=1 vitest run`——跑真实 API 集成测试（需凭证） |
| `npm run typecheck` | `tsc --noEmit`——类型检查（`tests/**/*` 在 `tsconfig.json` include 内） |
| `npm run build` | `tsup`——构建（不影响测试，但验证源码可编译）。**复现时必须先建 `src/shims/react-devtools-core.ts` no-op shim**（见 [README](./README.md) 构建说明 + [01](./01-architecture-overview.md) §4.1），否则 tsup 的 esbuild alias 解析失败、构建报错。 |

## 3. `tests/setup.ts` — 测试凭证与 API 门控

**核心设计：API 测试默认 skip，需显式 `RUN_API_TESTS=1` + 凭证才跑。** 凭证只从环境读，绝不硬编码。

```typescript
export const RUN_API_TESTS = process.env.RUN_API_TESTS === '1' || process.env.RUN_API_TESTS === 'true'

export const TEST_API_KEY = process.env.HARNESS_API_KEY ?? ''
export const TEST_BASE_URL = process.env.HARNESS_BASE_URL ?? ''
export const TEST_MODEL = process.env.HARNESS_MODEL ?? 'gpt-5.5'

// 无凭证时即使 RUN_API_TESTS=1 也强制 skip（绝不向真实端点发空 auth）
const hasCreds = Boolean(TEST_API_KEY && TEST_BASE_URL)
export const itApi = (RUN_API_TESTS && hasCreds) ? it : it.skip
export const describeApi = (RUN_API_TESTS && hasCreds) ? describe : describe.skip
```

**用法**：真实 API 测试用 `itApi`/`describeApi`（替代 `it`/`describe`）；纯单元测试用普通 `it`/`describe`。

**跑 API 测试**：
```bash
export HARNESS_API_KEY=... HARNESS_BASE_URL=... HARNESS_MODEL=gpt-5.5
npm run test:api
# 或: RUN_API_TESTS=1 HARNESS_API_KEY=... HARNESS_BASE_URL=... npx vitest run
```

> **为什么不靠 vitest config 的 `define` 注入？** `vitest.config.ts` 注释说明：`define` 会把 `process.env.HARNESS_*` 内联成编译时常量，破坏配置优先级链测试（那些测试需要观察 env 缺失时的行为）。所以凭证只从 `process.env` 运行时读。

## 4. 测试文件清单与分类

### 4.1 纯单元测试（无网络，`npm test` 即跑）

| 文件 | it 数 | 测什么 |
|------|:-----:|--------|
| `tests/unit/barGlyph.test.ts` | 5 | `renderBar` 进度条字符渲染（填充/shine/dot/边界） |
| `tests/unit/bash-safety.test.ts` | 31 | `analyzeBashSafety`/`isReadOnlyCommand` AST 安全分析（各失败码 + 只读分类） |
| `tests/unit/classifier.test.ts` | 9 | auto 模式 AI 分类器（mock client，fail-closed、缓存） |
| `tests/unit/compact.test.ts` | 10 | 压缩（mock client，阈值/断路器/摘要） |
| `tests/unit/config.test.ts` | 25 | `resolveConfig` 配置优先级链（CLI>env>configFile>settings>defaults） |
| `tests/unit/extractMemories.test.ts` | 6 | `/memory save` 抽取（mock client，去重/写入/索引） |
| `tests/unit/hooks.test.ts` | 13 | hooks 加载/执行（function/command、block/approve、glob 匹配） |
| `tests/unit/permissions.test.ts` | 25 | 权限决策管线（deny/ask/bypass-immune、shell 规则、路径规则） |
| `tests/unit/plan-mode.test.ts` | 8 | plan 模式（工具过滤、审批 approve/reject） |
| `tests/unit/session.test.ts` | 7 | 会话存储（create/append/load/list、JSONL） |
| `tests/unit/skills-memdir.test.ts` | 7 | SKILL.md 解析、记忆目录扫描/索引 |
| `tests/unit/stream-accumulator.test.ts` | 1 | `StreamAccumulator` SSE 事件累加 |
| `tests/unit/usage.test.ts` | 4 | `UsageTracker`/`formatCost` 成本计算 |

### 4.2 文件系统测试（真实 fs，临时目录，`npm test` 即跑）

| 文件 | it 数 | 测什么 |
|------|:-----:|--------|
| `tests/fs/bash.test.ts` | 10 | BashTool 执行（超时、退出码、stderr） |
| `tests/fs/fileedit.test.ts` | 13 | FileEditTool（读前写、mtime、引号归一化、创建新文件） |
| `tests/fs/fileread.test.ts` | 8 | FileReadTool（行号、去重 stub、二进制/设备路径拒绝） |
| `tests/fs/glob-grep.test.ts` | 6 | GlobTool/GrepTool（ripgrep + Node fallback） |

### 4.3 集成测试

| 文件 | it 数 | 状态 |
|------|:-----:|------|
| `tests/integration/loop/agent-loop.test.ts` | 0 it（`describeApi`/`itApi` gated） | 端到端 agent 循环（真实 API：读+编辑文件跨完整 loop）——**需 `RUN_API_TESTS=1` + 凭证** |
| `tests/mcp/mcp.test.ts` | 1 | MCP stdio 连接（`describeApi` gated）——需凭证/真实 MCP server |
| `tests/api/stream.test.ts` | 0 it（gated） | API 客户端流式（真实 SSE：累加/usage/abort）——需凭证 |
| `tests/api/tooluse.test.ts` | 0 it（gated） | API tool_use 流式（真实）——需凭证 |

> `it 数 = 0` 的文件是**全部用 `itApi`/`describeApi`** 的 gated 测试——`npm test` 时整文件 skip，`npm run test:api` + 凭证才跑。这就是 `npm test` 输出 "3 skipped" 的来源。

## 5. 测试范式

### 5.1 范式 A：纯单元测试（无依赖）

直接 import 源码函数，断言返回值。例 `barGlyph.test.ts`、`config.test.ts`。

```typescript
import { estimateTokens } from '../../src/services/compact/compact.js'
it('estimates tokens as chars/4', () => {
  expect(estimateTokens([{ role: 'user', content: 'a'.repeat(400) }])).toBe(100)
})
```

### 5.2 范式 B：mock client（不触网）

构造一个只实现被测路径的假 `ApiClient`，用 `vi.fn().mockResolvedValue(...)`。例 `compact.test.ts`：

```typescript
const mockClient = {
  callOnce: vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: 'summary of earlier turns' }],
  }),
}
// 传入 compactConversation({ client: mockClient as any, ... })
expect(mockClient.callOnce).toHaveBeenCalled()
```

> **类型用 `as any` 绕过**——假 client 只实现被测方法（`callOnce`），不实现完整 `ApiClient`。`classifier.test.ts`/`extractMemories.test.ts` 同范式。

### 5.3 范式 C：真实文件系统（临时目录）

`mkdtemp`/`mkdtempSync` 建临时目录，测文件工具。例 `fileedit.test.ts`：

```typescript
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'harness-edit-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
```

### 5.4 范式 D：真实 API 集成（gated）

用 `itApi`/`describeApi` + 真实 `ApiClient`。例 `agent-loop.test.ts`：

```typescript
import { TEST_API_KEY, TEST_BASE_URL, TEST_MODEL, itApi, describeApi } from '../../setup.js'

describeApi('agent loop end-to-end', () => {
  itApi('reads and edits a file across a full agent loop', async () => {
    const config = resolveConfig({}, { apiKey: TEST_API_KEY, baseURL: TEST_BASE_URL, model: TEST_MODEL })
    const client = new ApiClient(config)
    const engine = new QueryEngine({
      client, tools: getBuiltinTools(), /* ... */
      disableSessionPersistence: true,   // 测试用：禁用会话持久化
      canUseTool: createCanUseTool(permissionContextFromSettings(settings, 'bypassPermissions')),
    })
    const result = await engine.submitMessage('Read X, edit count 0→1, confirm.', { onToolStart, onTextDelta })
    expect(result.reason).toBe('completed')
    expect(await readFile(target, 'utf8')).toContain('count = 1')
  })
})
```

**测试专用选项**：`QueryEngine` 构造时传 `disableSessionPersistence: true` 避免写 `~/.harness-code/projects/`（测试不污染真实会话存储）。权限常用 `bypassPermissions` 模式避免交互 ask。

## 6. Ink UI 测试

`package.json` devDependencies 含 `ink-testing-library`（`^4.0.0`），但目前 `tests/` 下**没有** `.test.tsx` 文件——**UI 层（`App.tsx`）目前无测试覆盖**。复现时若要补 UI 测试，用：

```typescript
import { render } from 'ink-testing-library'
// render(<App .../>) 返回 { rerender, stdout, stdin, unmount }
// 通过 stdin.write 模拟按键，断言 stdout.lastFrame()
```

> 这是当前已知覆盖缺口，不是必须复现的——但 `vitest.config.ts` 的 `include` 已含 `*.test.tsx`，框架就绪。

## 7. 关键被测行为（复现验证清单）

复现后跑 `npm test` 应验证这些核心行为：

- **配置优先级**（`config.test.ts`）：CLI flag > `HARNESS_*` env > configFile > settings > defaults；**不**回退 `ANTHROPIC_*`。
- **权限管线**（`permissions.test.ts`）：bypass-immune 层（deny 规则/ask 规则/受保护路径）即使 bypass 也拦截。
- **Bash 安全**（`bash-safety.test.ts`）：各 `SafetyFailureCode`（too-complex/ifs/declare/...）；只读命令白名单 + git 子命令白名单。
- **读前写**（`fileedit.test.ts`）：无 full read → error；mtime 变 → error；引号归一化匹配。
- **压缩断路器**（`compact.test.ts`）：3 次连续失败后停止。
- **分类器 fail-closed**（`classifier.test.ts`）：出错/超时/非 JSON → `shouldBlock=true`。
- **进度条**（`barGlyph.test.ts`）：`renderBar` 的 shine/dot 字符位置。
- **plan 模式**（`plan-mode.test.ts`）：approve 后退出 plan 模式恢复全工具集。
- **会话 JSONL**（`session.test.ts`）：create/append/load/list，newest-first 排序。

## 8. 已知边界 / 未实现项

- **`summarizeSession` 无测试**（函数导出但未被调用，见 [12](./12-session-bridge.md) §4.5）。
- **AgentTool 无测试**（未接线，见 [08](./08-multi-agent-system.md)）。
- **`assembleToolPool`/`connectAllServers`/`collectMcpTools` 无测试**（死代码，未接线）。
- **Ink UI（`App.tsx`）无测试**——`ink-testing-library` 已装但无 `*.test.tsx`。
- **`AskUserQuestionTool` 交互 handler 无测试**（未接线）。
- 真实 API 测试依赖可用的 Anthropic 兼容代理端点（`gpt-5.5`/`mimo-v2.5` 等）；无端点时这些测试永久 skip，不影响 `npm test` 通过。
- `vitest.config.ts` 的 esbuild 配置被 vitest 4 的 oxc 忽略（运行时有警告）——不影响测试结果，但 `target`/`jsx` 实际由 oxc 处理。
