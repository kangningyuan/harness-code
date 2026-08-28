import type { BuiltTool } from './Tool.js'
import { FileReadTool } from './tools/FileReadTool/FileReadTool.js'
import { FileEditTool } from './tools/FileEditTool/FileEditTool.js'
import { FileWriteTool } from './tools/FileWriteTool/FileWriteTool.js'
import { NotebookEditTool } from './tools/NotebookEditTool/NotebookEditTool.js'
import { BashTool } from './tools/BashTool/BashTool.js'
import { GlobTool } from './tools/GlobTool/GlobTool.js'
import { GrepTool } from './tools/GrepTool/GrepTool.js'
import { TodoWriteTool } from './tools/TodoWriteTool/TodoWriteTool.js'
import { AskUserQuestionTool } from './tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { WebFetchTool } from './tools/WebFetchTool/WebFetchTool.js'
import { AgentTool } from './tools/AgentTool/AgentTool.js'
import { SkillTool } from './tools/SkillTool/SkillTool.js'
import { ExitPlanModeTool } from './tools/ExitPlanModeTool/ExitPlanModeTool.js'
export interface BuiltinToolOptions { agentTool?: BuiltTool; excludeAgent?: boolean }
export function getBuiltinTools(additional: BuiltTool[] = [], options: BuiltinToolOptions = {}): BuiltTool[] { const agent = options.agentTool ?? AgentTool; return [FileReadTool, FileEditTool, FileWriteTool, NotebookEditTool, BashTool, GlobTool, GrepTool, TodoWriteTool, AskUserQuestionTool, WebFetchTool, ...(options.excludeAgent ? [] : [agent]), SkillTool, ExitPlanModeTool, ...additional] }
export function assembleToolPool(builtin: BuiltTool[], mcp: BuiltTool[] = []): BuiltTool[] { const seen = new Set<string>(); return [...builtin, ...mcp].sort((a, b) => a.name.localeCompare(b.name)).filter(tool => !seen.has(tool.name) && (seen.add(tool.name), true)) }
export function toolsToApiDefs(tools: BuiltTool[]) { return tools.map(tool => ({ name: tool.name, description: tool.prompt(), input_schema: tool.jsonSchema })) }
