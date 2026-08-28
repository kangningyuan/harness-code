import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTaskService } from '../../src/services/tasks/service.js'
import { TaskStore } from '../../src/services/tasks/store.js'
import { dependenciesComplete, findUnblocked, validateTaskDependencies } from '../../src/services/tasks/graph.js'
import type { TaskRecord } from '../../src/services/tasks/types.js'
import { projectStateDir } from '../../src/services/session/paths.js'

function record(id: string, blockedBy: string[] = [], status: TaskRecord['status'] = 'pending'): TaskRecord {
  return { id, subject: id, description: '', status, blockedBy, sessionId: 's', createdAt: 1, updatedAt: 1, version: 1, attempts: 0 }
}

describe('task DAG and persistence contract', () => {
  let home: string
  let cwd: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'harness-task-contract-')); cwd = join(home, 'project'); vi.stubEnv('HOME', home) })
  afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) })

  it('detects direct and indirect dependency cycles', () => {
    const a = record('a', ['b']); const b = record('b', ['a'])
    expect(validateTaskDependencies([a, b], 'new', ['a'])).toBe('Task dependency cycle detected')
    expect(validateTaskDependencies([record('a')], 'new', ['a', 'a'])).toBe('Duplicate task dependency')
    expect(validateTaskDependencies([record('a')], 'new', ['missing'])).toBe('Dependency task not found')
    expect(validateTaskDependencies([record('a')], 'a', ['a'])).toBe('A task cannot depend on itself')
  })

  it('returns immutable task copies and computes blocked state from status', () => {
    const waiting = record('waiting', ['done'])
    const done = record('done', [], 'completed')
    const byId = new Map([waiting, done].map(item => [item.id, item]))
    expect(dependenciesComplete(waiting, byId)).toBe(true)
    const unblocked = findUnblocked([waiting, done])
    expect(unblocked).toHaveLength(1)
    unblocked[0]!.blockedBy.push('mutated')
    expect(waiting.blockedBy).toEqual(['done'])
  })

  it('enforces owner, lease, version and terminal-state semantics', () => {
    const service = createTaskService(cwd, 10)
    const task = service.create('work', '', [], 's').task!
    expect(service.claim(task.id, 'agent', 'other')).toMatchObject({ ok: false, error: 'Task belongs to another session' })
    const claimed = service.claim(task.id, 'agent', 's').task!
    expect(claimed).toMatchObject({ status: 'in_progress', owner: 'agent', attempts: 1, version: 2 })
    expect(service.complete(task.id, 'wrong')).toMatchObject({ ok: false, error: 'Only the task owner can change this task' })
    expect(service.fail(task.id, 'agent', 'boom').task).toMatchObject({ status: 'failed', error: 'boom', version: 3 })
    expect(service.complete(task.id, 'agent')).toMatchObject({ ok: false, error: 'Task is failed' })
  })

  it('reconciles leases only after their expiry and makes them claimable again', () => {
    const service = createTaskService(cwd, 100)
    const task = service.create('work').task!
    const claimed = service.claim(task.id, 'agent').task!
    expect(service.reconcile(claimed.leaseUntil)).toEqual([])
    const recovered = service.reconcile((claimed.leaseUntil ?? 0) + 1)
    expect(recovered).toHaveLength(1)
    expect(service.get(task.id)).toMatchObject({ status: 'pending', error: 'Previous owner lease expired' })
    expect(service.claim(task.id, 'new-owner').ok).toBe(true)
  })

  it('isolates session listing while allowing unscoped legacy tasks', () => {
    const service = createTaskService(cwd)
    const one = service.create('one', '', [], 'one').task!
    const two = service.create('two', '', [], 'two').task!
    const legacy = service.create('legacy').task!
    expect(new Set(service.list('one').map(task => task.id))).toEqual(new Set([one.id, legacy.id]))
    expect(new Set(service.list('two').map(task => task.id))).toEqual(new Set([two.id, legacy.id]))
  })

  it('ignores malformed task records without destroying them', () => {
    const store = new TaskStore(cwd)
    writeFileSync(join(projectStateDir(cwd), 'tasks', 'bad.json'), '{bad')
    writeFileSync(join(projectStateDir(cwd), 'tasks', 'wrong.json'), JSON.stringify({ id: 'wrong', subject: 'x' }))
    expect(store.list()).toEqual([])
  })
})
