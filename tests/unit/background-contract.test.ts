import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BackgroundTaskManager } from '../../src/services/background/manager.js'
import { BackgroundTaskStore } from '../../src/services/background/store.js'
import type { ToolResultReference } from '../../src/Tool.js'
import { projectStateDir } from '../../src/services/session/paths.js'
import { waitFor } from '../support/fixtures.js'

function reference(): ToolResultReference {
  return { id: 'artifact-1', relativePath: 'tool-results/artifact-1.txt', byteLength: 4, sha256: 'hash', preview: 'done' }
}

describe('background manager durability and failure contract', () => {
  let home: string
  let cwd: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'harness-bg-contract-')); cwd = join(home, 'project'); vi.stubEnv('HOME', home) })
  afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) })

  it('persists terminal state only after result processing and bounds notifications', async () => {
    const store = new BackgroundTaskStore(cwd)
    const manager = new BackgroundTaskManager(store, false)
    const order: string[] = []
    const task = manager.start({
      correlation: { sessionId: 's', turnId: 't', toolUseId: 'tool' }, toolName: 'BashTool', cwd,
      run: async () => ({ result: { data: ' output\n'.repeat(100), result: ' output\n'.repeat(100) }, context: { abortController: new AbortController(), readFileState: { get: () => undefined, set: () => undefined, recordRead: () => undefined, clear: () => undefined }, cwd, resultStore: { persist: () => { order.push('artifact'); return reference() } } } }),
      onResult: () => order.push('observer'),
    })
    expect(task.status).toBe('running')
    await waitFor(() => manager.get(task.id)?.status === 'completed')
    expect(order).toEqual(['artifact', 'observer'])
    const saved = store.get(task.id)
    expect(saved).toMatchObject({ status: 'completed', resultRef: reference() })
    const notification = manager.drainNotifications('s')[0] ?? ''
    expect(notification).toContain(task.id)
    expect(notification.length).toBeLessThan(900)
    expect(manager.drainNotifications('s')).toEqual([])
  })

  it('records failed, timed-out, and cancelled terminal outcomes exactly once', async () => {
    const manager = new BackgroundTaskManager(undefined, false)
    const events: string[] = []
    manager.subscribe(event => events.push(event.type))
    const failed = manager.start({ correlation: { sessionId: 's', turnId: 't' }, toolName: 'BashTool', cwd, run: async () => ({ result: { data: 'bad', result: 'bad', isError: true } }) })
    const timed = manager.start({ correlation: { sessionId: 's', turnId: 't' }, toolName: 'BashTool', cwd, run: async () => { throw new Error('process timeout') } })
    const cancelled = manager.start({ correlation: { sessionId: 's', turnId: 't' }, toolName: 'BashTool', cwd, run: async signal => { await new Promise(resolve => setTimeout(resolve, 30)); return { result: { data: signal.aborted ? 'cancelled' : 'done', result: 'done' } } } })
    expect(manager.cancel(cancelled.id)).toBe(true)
    expect(manager.cancel(cancelled.id)).toBe(false)
    await waitFor(() => [failed, timed, cancelled].every(item => ['failed', 'timed_out', 'cancelled'].includes(manager.get(item.id)?.status ?? '')))
    expect(manager.get(failed.id)?.error).toBe('bad')
    expect(manager.get(timed.id)?.status).toBe('timed_out')
    expect(events.filter(type => type === 'failed')).toHaveLength(1)
    expect(events.filter(type => type === 'timed_out')).toHaveLength(1)
    expect(events.filter(type => type === 'cancelled')).toHaveLength(1)
    expect(manager.drainNotifications('s')).toHaveLength(3)
  })

  it('isolates notification draining by session and listener failures', async () => {
    const manager = new BackgroundTaskManager(undefined, false)
    manager.subscribe(() => { throw new Error('observer failure') })
    manager.start({ correlation: { sessionId: 'a', turnId: 't' }, toolName: 'BashTool', cwd, run: async () => ({ result: { data: 'a', result: 'a' } }) })
    manager.start({ correlation: { sessionId: 'b', turnId: 't' }, toolName: 'BashTool', cwd, run: async () => ({ result: { data: 'b', result: 'b' } }) })
    await waitFor(() => manager.list().filter(task => task.status === 'completed').length === 2)
    expect(manager.drainNotifications('a')).toHaveLength(1)
    expect(manager.drainNotifications('a')).toEqual([])
    expect(manager.drainNotifications('b')).toHaveLength(1)
  })

  it('marks persisted queued/running tasks orphaned on restart and emits recovery notifications', () => {
    const store = new BackgroundTaskStore(cwd)
    const running = { id: 'running', sessionId: 's', turnId: 't', toolUseId: 'u', toolName: 'BashTool', cwd, status: 'running' as const, createdAt: Date.now() }
    const queued = { id: 'queued', sessionId: 'other', turnId: 't', toolUseId: 'u', toolName: 'BashTool', cwd, status: 'queued' as const, createdAt: Date.now() }
    store.save(running); store.save(queued)
    const manager = new BackgroundTaskManager(store, true)
    expect(manager.get('running')).toMatchObject({ status: 'orphaned', error: 'Process was not recoverable after restart' })
    expect(manager.get('queued')).toMatchObject({ status: 'orphaned' })
    expect(manager.drainNotifications('s')).toEqual([expect.stringContaining('running')])
    expect(manager.drainNotifications('other')).toEqual([expect.stringContaining('queued')])
  })

  it('rejects starts after shutdown and limits cancellation to the manager scope', async () => {
    const manager = new BackgroundTaskManager(undefined, false, 's')
    const a = manager.start({ correlation: { sessionId: 's', turnId: 't' }, toolName: 'BashTool', cwd, run: async () => { await new Promise(resolve => setTimeout(resolve, 100)); return { result: { data: 'a', result: 'a' } } } })
    const b = manager.start({ correlation: { sessionId: 'other', turnId: 't' }, toolName: 'BashTool', cwd, run: async () => { await new Promise(resolve => setTimeout(resolve, 100)); return { result: { data: 'b', result: 'b' } } } })
    expect(manager.cancelAll()).toBe(1)
    expect(manager.get(a.id)?.status).toBe('cancelled')
    expect(manager.get(b.id)?.status).toBe('running')
    await manager.shutdown(1)
    expect(() => manager.start({ correlation: { sessionId: 's', turnId: 't' }, toolName: 'BashTool', cwd, run: async () => ({ result: { data: '', result: '' } }) })).toThrow('shutting down')
  })

  it('does not treat corrupt persisted records as runnable tasks', () => {
    const dir = join(projectStateDir(cwd), 'background')
    // Constructing the store creates the directory before injecting corruption.
    const store = new BackgroundTaskStore(cwd)
    writeFileSync(join(dir, 'bad.json'), '{not-json')
    writeFileSync(join(dir, 'wrong.json'), JSON.stringify({ id: 'wrong', status: 'running' }))
    expect(store.list()).toEqual([])
    expect(existsSync(join(dir, 'bad.json'))).toBe(true)
    expect(readFileSync(join(dir, 'bad.json'), 'utf8')).toContain('not-json')
  })
})
