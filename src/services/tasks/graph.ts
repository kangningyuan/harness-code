import type { TaskRecord } from './types.js'

export function validateTaskDependencies(tasks: Iterable<TaskRecord>, subject: string, blockedBy: string[]): string | null {
  const records = [...tasks]
  const ids = new Set(records.map(task => task.id))
  if (new Set(blockedBy).size !== blockedBy.length) return 'Duplicate task dependency'
  if (blockedBy.some(id => id === subject)) return 'A task cannot depend on itself'
  if (blockedBy.some(id => !ids.has(id))) return 'Dependency task not found'
  const byId = new Map(records.map(task => [task.id, task]))
  const visiting = new Set<string>(); const visited = new Set<string>()
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    for (const dependency of byId.get(id)?.blockedBy ?? []) if (visit(dependency)) return true
    visiting.delete(id); visited.add(id); return false
  }
  for (const id of [...ids, subject]) if (id !== subject && visit(id)) return 'Task dependency cycle detected'
  if (blockedBy.some(id => byId.get(id)?.blockedBy.includes(subject))) return 'Task dependency cycle detected'
  return null
}

export function dependenciesComplete(task: TaskRecord, byId: Map<string, TaskRecord>): boolean { return task.blockedBy.every(id => byId.get(id)?.status === 'completed') }
export function findUnblocked(tasks: TaskRecord[]): TaskRecord[] {
  const byId = new Map(tasks.map(task => [task.id, task]))
  return tasks.filter(task => task.status === 'pending' && dependenciesComplete(task, byId)).map(task => ({ ...task, blockedBy: [...task.blockedBy] }))
}
