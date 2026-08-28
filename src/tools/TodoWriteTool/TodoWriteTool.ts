import { buildTool, textToolResult, type ToolUseContext } from '../../Tool.js'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'
export interface TodoItem { content: string; status: TodoStatus; activeForm: string }
export interface TodoList { todos: TodoItem[] }
type Subscriber = { callback: (todos: TodoList) => void; sessionId?: string }
const todosBySession = new Map<string, TodoList>()
const subscribers = new Set<Subscriber>()
const DEFAULT_SESSION = 'global'
function sessionKey(sessionId?: string): string { return sessionId || DEFAULT_SESSION }
function copy(list: TodoList): TodoList { return { todos: list.todos.map(todo => ({ ...todo })) } }
export function subscribeTodos(callback: (todos: TodoList) => void, sessionId?: string): () => void { const subscriber = { callback, sessionId }; subscribers.add(subscriber); return () => subscribers.delete(subscriber) }
export function getCurrentTodos(sessionId?: string): TodoList { return copy(todosBySession.get(sessionKey(sessionId)) ?? { todos: [] }) }

export const TodoWriteTool = buildTool<Record<string, unknown>, unknown>({ name: 'TodoWriteTool', inputJSONSchema: { type: 'object', properties: { todos: { type: 'array' } }, required: ['todos'] }, maxResultSizeChars: 5_000,
  async call(input, context: ToolUseContext) {
    const sessionId = sessionKey(context.correlation?.sessionId); const todos = Array.isArray(input.todos) ? input.todos as TodoItem[] : []; const current = { todos: todos.map(todo => ({ ...todo })) }; todosBySession.set(sessionId, current)
    for (const subscriber of subscribers) if (!subscriber.sessionId || subscriber.sessionId === sessionId) { try { subscriber.callback(copy(current)) } catch { /* UI subscribers cannot block the tool */ } }
    return { data: copy(current), result: current.todos.length ? current.todos.map(todo => `${todo.status === 'completed' ? '[x]' : todo.status === 'in_progress' ? '[*]' : '[ ]'} ${todo.content}`).join('\n') : 'clear todos' }
  },
  description: input => `${Array.isArray(input.todos) ? input.todos.length : 0} todos`, prompt: () => 'Maintain a concise task checklist for this session.', mapToolResultToToolResultBlockParam: textToolResult, renderToolUseMessage: () => 'todos'
})
