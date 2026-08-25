export type TodoStatus = 'pending' | 'in_progress' | 'completed'
export interface TodoItem { content: string; status: TodoStatus; activeForm: string }
export interface TodoList { todos: TodoItem[] }
let currentTodos: TodoList = { todos: [] }; const subscribers = new Set<(todos: TodoList) => void>()
export function subscribeTodos(callback: (todos: TodoList) => void): () => void { subscribers.add(callback); return () => subscribers.delete(callback) }
export function getCurrentTodos(): TodoList { return { todos: currentTodos.todos.map(todo => ({ ...todo })) } }
import { buildTool, textToolResult } from '../../Tool.js'
export const TodoWriteTool = buildTool<Record<string, unknown>, unknown>({ name: 'TodoWriteTool', inputJSONSchema: { type: 'object', properties: { todos: { type: 'array' } }, required: ['todos'] }, maxResultSizeChars: 5_000,
  async call(input) { currentTodos = { todos: Array.isArray(input.todos) ? input.todos as TodoItem[] : [] }; for (const callback of subscribers) callback(getCurrentTodos()); const done = currentTodos.todos.filter(todo => todo.status === 'completed').length; return { data: currentTodos, result: currentTodos.todos.length ? currentTodos.todos.map(todo => `${todo.status === 'completed' ? '[x]' : todo.status === 'in_progress' ? '[*]' : '[ ]'} ${todo.content}`).join('\n') : 'clear todos' } },
  description: input => `${Array.isArray(input.todos) ? input.todos.length : 0} todos`, prompt: () => 'Maintain a concise task checklist.', mapToolResultToToolResultBlockParam: textToolResult, renderToolUseMessage: () => 'todos'
})
