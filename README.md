# harness-code

一个基于 TypeScript、React Ink 和 Anthropic-compatible Messages API 的终端 Coding Agent。它支持多轮 Agent 循环、工具调用、权限控制、会话持久化、计划模式、Skills、上下文压缩以及 headless 输出。

> 本项目是独立实现，不是 Anthropic 官方 Claude Code。

## 环境要求

- Node.js >= 18
- npm
- 一个兼容 Anthropic Messages API 的服务端点

## 安装与运行

```bash
npm install
npm run build
node dist/main.js --help
```

也可以使用环境变量配置 API：

```bash
export HARNESS_API_KEY="your-api-key"
export HARNESS_BASE_URL="https://your-api.example.com"
export HARNESS_MODEL="gpt-5.5"

node dist/main.js
```

项目不会把 API key 写入源码。请将 `.env` 保持在本地，并确保不会提交到 Git。

## 全局命令

构建后可以通过 npm link 注册全局命令：

```bash
npm run build
npm link
harness-code
```

普通启动会创建新会话；显式恢复会话：

```bash
harness-code --resume
harness-code --resume <session-id>
```

## 常用命令

在交互界面中可使用：

```text
/help       查看命令
/default    切回默认权限模式
/bypass     切换权限模式
/plan       进入计划模式
/compact    手动压缩上下文
/sessions   查看会话
/history    打开会话历史
/new        开始新对话
/exit       退出
```

## Headless 模式

```bash
harness-code --print "查看当前项目状态"
harness-code --print --output-format stream-json "运行测试并报告结果"
```

## 开发与测试

```bash
npm test
npm run typecheck
npm run build
```

真实 API 测试默认关闭，只有显式设置 `RUN_API_TESTS=1` 且提供 `HARNESS_API_KEY`、`HARNESS_BASE_URL` 时才会运行：

```bash
RUN_API_TESTS=1 npm run test:api
```

## 主要目录

```text
docs/       开发文档与设计说明
src/        TypeScript 源码
tests/      单元、文件系统、集成和 API 测试
dist/       构建产物
```

更完整的模块说明请参阅 [docs/README.md](docs/README.md)。
