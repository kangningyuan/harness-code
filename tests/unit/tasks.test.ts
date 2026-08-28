import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTaskService } from '../../src/services/tasks/service.js'

describe('task service', () => {
  let home: string
  let service: ReturnType<typeof createTaskService>
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'harness-tasks-')); vi.stubEnv('HOME', home); service = createTaskService(join(home, 'project')) })
  afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) })

  it('enforces dependencies and owner transitions', () => {
    const first = service.create('first')
    expect(first.ok).toBe(true)
    const second = service.create('second', '', [first.task!.id])
    expect(second.ok).toBe(true)
    expect(service.claim(second.task!.id, 'agent')).toMatchObject({ ok: false })
    expect(service.claim(first.task!.id, 'agent').ok).toBe(true)
    expect(service.complete(first.task!.id, 'other').ok).toBe(false)
    expect(service.complete(first.task!.id, 'agent').ok).toBe(true)
    expect(service.claim(second.task!.id, 'agent').ok).toBe(true)
    expect(service.complete(second.task!.id, 'agent').ok).toBe(true)
  })

  it('rejects missing, duplicate, and self dependencies', () => {
    const missing = service.create('missing', '', ['task_unknown'])
    expect(missing).toMatchObject({ ok: false, error: 'Dependency task not found' })
    const first = service.create('first')
    expect(service.create('duplicate', '', [first.task!.id, first.task!.id]).ok).toBe(false)
    expect(service.create('self', '', ['__new__'])).toMatchObject({ ok: false, error: 'A task cannot depend on itself' })
  })

  it('recovers expired leases and reports unblocked tasks', () => {
    const first = service.create('first').task!
    const second = service.create('second', '', [first.id]).task!
    service.claim(first.id, 'agent')
    const expired = service.reconcile(Date.now() + 20 * 60_000)
    expect(expired.map(task => task.id)).toContain(first.id)
    expect(service.unblocked().map(task => task.id)).toContain(first.id)
    expect(service.get(second.id)?.status).toBe('pending')
  })
})
