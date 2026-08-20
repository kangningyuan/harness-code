# MCP（Model Context Protocol）集成

> 基于 `src/services/mcp/client.ts` (~158 行) 实际源码。
>
> **关键事实：** MCP 客户端代码**已完整实现**（stdio 连接、工具发现、包装），但 `main.tsx`/`QueryEngine`/`tools.ts` **从不调用** `connectAllServers`/`collectMcpTools`/`assembleToolPool`。因此实际运行时**没有 MCP 工具进入工具池**——MCP 是"已实现但未接线"的状态。复现时必须保留这个死代码状态。

## 1. MCP 架构概览

harness-code 实现了 MCP **stdio** 客户端（用 `@modelcontextprotocol/sdk`），工具以 `mcp__<server>__<tool>` 命名包装成 `BuiltTool`。

```
settings.mcpServers (settings.json)
   │ { "name": { command, args, env, type?, disabled? } }
   ▼
connectAllServers(servers)
   ├── 过滤 disabled
   ├── 批量并发 (batchSize=3)
   │     └─ connectToServer(name, config)
   │           ├── StdioClientTransport({ command, args, env })
   │           ├── new Client({ name:'harness-code', version:'0.1.0' }, { capabilities: { roots:{listChanged:false}, elicitation:{} } })
   │           ├── Promise.race(connect, timeout MCP_TIMEOUT)
   │           └── discoverTools(name, client)
   └── 连接失败 → stderr "[mcp] server connection failed: ..."，跳过（不崩溃）

collectMcpTools(connections)  → BuiltTool[]
assembleToolPool(builtin, mcpTools)  → 内置字母序 ++ MCP 字母序，去重（内置胜）
```

> 上述 `connectAllServers` → `collectMcpTools` → `assembleToolPool` 链路在源码里**从不被调用**。实际工具池 = `getBuiltinTools()` 原序 13 个。

## 2. 服务器配置

```typescript
interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  type?: 'stdio'          // 仅 stdio
  disabled?: boolean      // true → connectAllServers 跳过
}
```

配置来源：`settings.mcpServers`（`~/.claude/settings.json` + project + local 合并，对象合并）。`Settings.mcpServers` 类型是 `Record<string, unknown>`（声明但未强类型化为 `McpServerConfig`）。

> **仅 stdio 传输。** 无 SSE/HTTP/WS，无 OAuth 认证。docs 旧版提到的"8 种传输类型"不适用于 harness-code。

## 3. 连接流程 (`connectToServer`)

```typescript
const transport = new StdioClientTransport({
  command: config.command,
  args: config.args ?? [],
  env: { ...process.env, ...config.env },   // 继承当前 env + 服务器配置 env
})

const client = new Client(
  { name: 'harness-code', version: '0.1.0' },
  { capabilities: { roots: { listChanged: false }, elicitation: {} } },
)

// 竞速连接 vs 超时
await Promise.race([
  client.connect(transport),
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`MCP server ${name} connect timeout`)), MCP_TIMEOUT_MS)),
])

const tools = await discoverTools(name, client)
return { name, client, transport, tools }
```

`MCP_TIMEOUT_MS = Number(process.env.MCP_TIMEOUT ?? 30_000)`。

## 4. 工具发现与包装 (`discoverTools`)

```typescript
const result = await client.listTools()   // 失败 → 返回 []
toolList = result.tools as Array<{
  name: string; description?: string; inputSchema?: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean }
}>
```

每个 server 工具包装成 `BuiltTool`：

```typescript
buildTool({
  name: `mcp__${serverName}__${t.name}`,         // 命名约定
  inputJSONSchema: t.inputSchema ?? { type:'object', properties:{} },  // 原始 JSON schema（非 Zod）
  isMcp: true,
  maxResultSizeChars: 30_000,
  isReadOnly: () => !!t.annotations?.readOnlyHint,
  isDestructive: () => !!t.annotations?.destructiveHint,
  isConcurrencySafe: () => !!t.annotations?.readOnlyHint,   // 只读 → 并发安全

  async call(args, _context) {
    const result = await client.callTool({ name: t.name, arguments: args })
    const content = result.content   // Array<{type, text?}>
    const text = Array.isArray(content) ? content.map(c => c.text ?? '').join('\n') : String(content ?? '')
    return { data: result, result: text || '[no output]', isError: result.isError === true }
  },

  description() { return `${t.description ?? t.name}`.slice(0, 2048) },
  prompt() { return `${t.description ?? t.name} (MCP tool from server "${serverName}")`.slice(0, 2048) },
  mapToolResultToToolResultBlockParam: textToolResult,
  renderToolUseMessage() { return `${serverName}: ${t.name}` },
})
```

**关键点：**
- MCP 工具用 `inputJSONSchema`（原始 JSON schema），`buildTool` 跳过 Zod 转换，`validateWithSchema` 接受原始 input。
- 只读性来自 MCP `annotations.readOnlyHint`，同时决定 `isReadOnly` 和 `isConcurrencySafe`。
- `call` 失败 → error result（不抛）。
- description/prompt 截 2048 字符。

## 5. 批量并发连接 (`connectAllServers`)

```typescript
const enabled = Object.entries(servers).filter(([, c]) => !c.disabled)
const batchSize = 3
for (let i = 0; i < enabled.length; i += batchSize) {
  const batch = enabled.slice(i, i + batchSize)
  const connected = await Promise.allSettled(batch.map(([name, config]) => connectToServer(name, config)))
  for (const r of connected) {
    if (r.status === 'fulfilled') results.push(r.value)
    else process.stderr.write(`[mcp] server connection failed: ${reason}\n`)   // 跳过，不崩溃
  }
}
return results
```

并发度 3，失败服务器跳过（不影响其他）。

## 6. 关闭与工具收集

```typescript
export async function disconnectAll(connections: McpConnection[]): Promise<void> {
  await Promise.allSettled(connections.map(c => c.transport.close()))
}

export function collectMcpTools(connections: McpConnection[]): BuiltTool[] {
  return connections.flatMap(c => c.tools)
}
```

## 7. McpConnection 结构

```typescript
interface McpConnection {
  name: string
  client: Client
  transport: StdioClientTransport
  tools: BuiltTool[]
}
```

## 8. 已知边界 / 未实现项（重要）

- **MCP 客户端已实现但完全未接线**：
  - `connectAllServers` 从不被调用 → 启动时不连任何 MCP 服务器。
  - `collectMcpTools` 从不被调用 → MCP 工具不进工具池。
  - `assembleToolPool`（`tools.ts`）从不被调用 → 工具池始终是 `getBuiltinTools()` 原序。
  - `disconnectAll` 从不被调用 → 无优雅关闭（进程退出时子进程随父退出）。
  - QueryEngine 构造时不接 MCP；`main.tsx` 不构建 MCP 连接。
- **仅 stdio 传输**（无 SSE/HTTP/WS、无 OAuth）。
- **无 resources/prompts 发现**（docs 旧版提到，实际 `discoverTools` 只 `listTools`）。
- **无 MCP 工具的权限规则特殊处理**（`mcp__server__tool` 名字可被规则匹配，但因未接线无意义）。
- **`/mcp` 命令不存在**（`commands.ts` 无 MCP 管理命令）。
- 复现时：保留 `services/mcp/client.ts` 全部代码原样，**不要**在 `main.tsx`/`QueryEngine` 里接上 `connectAllServers`——这是当前项目的真实状态。若要"激活" MCP，需在 `main.tsx` REPL 分支加 `const mcpConnections = await connectAllServers(settings.mcpServers ?? {})` 并把 `collectMcpTools(mcpConnections)` 经 `assembleToolPool` 合入 `tools`，但**这超出了"复现当前代码"的范围**。
