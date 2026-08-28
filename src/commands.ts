import { parseSlashCommand, loadAllSkills } from './skills/loadSkillsDir.js'
import { formatTotalCost } from './services/api/usage.js'
import type { Message } from './services/api/types.js'
export interface CommandContext { cwd: string; clearConversation?: () => void; compact?: () => Promise<string>; getModel?: () => string; setModel?: (id: string) => string | null; listModels?: () => string; getConfigSummary?: () => string; getCostSummary?: () => string; listSkills?: () => string; getMemoryPrompt?: () => string | null; extractMemories?: () => Promise<string>; listHooks?: () => string; listSessions?: () => string; resumeSession?: (id: string) => { count: number } | null; listTasks?: () => string; listWorktrees?: () => string; listBackgroundTasks?: () => string; cancelBackgroundTask?: (id: string) => string; exportTranscript?: () => string; enterPlanMode?: () => void; isPlanMode?: () => boolean; setPermissionMode?: (mode: 'default'|'auto'|'bypassPermissions') => void; getPermissionMode?: () => string | null; newConversation?: () => void; openHistory?: () => void }
export type CommandResult = { kind: 'message'; message: Message } | { kind: 'prompt'; prompt: string } | { kind: 'action'; action: 'clear'|'compact'|'exit' } | { kind: 'none' }
export interface Command { name: string; description: string; type: 'local'|'prompt'|'local-jsx'; run?: (args: string, context: CommandContext) => Promise<CommandResult>; buildPrompt?: (args: string, context: CommandContext) => string }
const message = (text: string): CommandResult => ({ kind: 'message', message: { role: 'assistant', content: text } })
export function getBuiltinCommands(): Command[] { return [
  { name: 'help', description: 'List commands', type: 'local', run: async () => message(getBuiltinCommands().map(command => `/${command.name} — ${command.description}`).join('\n')) },
  { name: 'clear', description: 'Clear conversation', type: 'local', run: async (_a, context) => { context.clearConversation?.(); return { kind: 'action', action: 'clear' } } },
  { name: 'compact', description: 'Compact conversation', type: 'local', run: async (_a, context) => message(await context.compact?.() ?? 'Compaction unavailable') },
  { name: 'model', description: 'Switch model', type: 'local', run: async (args, context) => args ? message(context.setModel?.(args) ? `Model switched to ${args}` : `Unknown model: ${args}`) : message(context.listModels?.() ?? 'No models configured') },
  { name: 'models', description: 'List models', type: 'local', run: async (_a, context) => message(context.listModels?.() ?? 'No models configured') },
  { name: 'config', description: 'Show configuration', type: 'local', run: async (_a, context) => message(context.getConfigSummary?.() ?? 'Configuration unavailable') },
  { name: 'cost', description: 'Show cost', type: 'local', run: async (_a, context) => message(context.getCostSummary?.() ?? 'Cost unavailable') },
  { name: 'skills', description: 'List skills', type: 'local', run: async (_a, context) => message(context.listSkills?.() ?? (loadAllSkills(context.cwd).map(skill => `/${skill.name} — ${skill.description}`).join('\n') || 'No skills found')) },
  { name: 'memory', description: 'Show or save memory', type: 'local', run: async (args, context) => args.trim() === 'save' ? message(await context.extractMemories?.() ?? 'Memory extraction unavailable') : message(context.getMemoryPrompt?.() ?? 'No memory directory') },
  { name: 'hooks', description: 'List hooks', type: 'local', run: async (_a, context) => message(context.listHooks?.() ?? 'No hooks configured') },
  { name: 'init', description: 'Create CLAUDE.md with the agent', type: 'prompt', buildPrompt: () => 'Analyze this repository and create a useful CLAUDE.md file.' },
  { name: 'sessions', description: 'List sessions', type: 'local', run: async (_a, context) => message(context.listSessions?.() ?? 'No sessions found') },
  { name: 'resume', description: 'Resume a session', type: 'local', run: async (args, context) => { if (!args.trim()) return message(context.listSessions?.() ?? 'No sessions found'); const resumed = context.resumeSession?.(args.trim()); return message(resumed ? `Resumed session ${args.trim()} (${resumed.count} messages).` : `Session not found: ${args.trim()}`) } },
  { name: 'tasks', description: 'List durable and background tasks', type: 'local', run: async (_a, context) => message([context.listTasks?.(), context.listBackgroundTasks?.()].filter(Boolean).join('\\n') || 'No tasks.') },
  { name: 'worktrees', description: 'List managed worktrees', type: 'local', run: async (_a, context) => message(context.listWorktrees?.() ?? 'No worktrees.') },
  { name: 'cancel', description: 'Cancel a background task', type: 'local', run: async (args, context) => message(args.trim() ? context.cancelBackgroundTask?.(args.trim()) ?? 'Background task cancellation unavailable' : 'Usage: /cancel <task-id>') },
  { name: 'plan', description: 'Enter plan mode', type: 'local', run: async (_a, context) => { context.enterPlanMode?.(); return message('Entered plan mode. Only read-only tools are available.') } },
  { name: 'bypass', description: 'Change permission mode', type: 'local', run: async (args, context) => { const mode = args.trim() === 'off' || args.trim() === 'default' ? 'default' : args.trim() === 'auto' ? 'auto' : 'bypassPermissions'; context.setPermissionMode?.(mode); return message(`Permission mode: ${mode}`) } },
  { name: 'default', description: 'Return to default permission mode', type: 'local', run: async (_args, context) => { context.setPermissionMode?.('default'); return message('Permission mode: default') } },
  { name: 'export', description: 'Export transcript', type: 'local', run: async (_a, context) => message(context.exportTranscript?.() ?? 'Export unavailable') },
  { name: 'stop', description: 'Stop agent', type: 'local', run: async () => message('Nothing to stop.') },
  { name: 'new', description: 'Start a new conversation', type: 'local', run: async (_a, context) => { context.newConversation?.(); return { kind: 'action', action: 'clear' } } },
  { name: 'history', description: 'Open session history', type: 'local', run: async (_a, context) => { context.openHistory?.(); return { kind: 'none' } } },
  { name: 'exit', description: 'Exit', type: 'local', run: async () => ({ kind: 'action', action: 'exit' }) },
] }
export function findCommand(name: string): Command | undefined { return getBuiltinCommands().find(command => command.name === name) }
export { parseSlashCommand }
