import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readLockOwner, withFileLock } from '../../src/services/tasks/lock.js'

describe('file lock contract', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-lock-contract-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('creates parent directories, exposes owner metadata, and releases after success', () => {
    const lock = join(dir, 'nested', 'resource.lock')
    const value = withFileLock(lock, () => {
      expect(readLockOwner(lock)).toMatch(/^\d+:/)
      expect(statSync(join(lock, 'owner')).isFile()).toBe(true)
      return 42
    })
    expect(value).toBe(42)
    expect(readLockOwner(lock)).toBeNull()
  })

  it('releases the lock when the protected callback throws', () => {
    const lock = join(dir, 'resource.lock')
    expect(() => withFileLock(lock, () => { throw new Error('callback failed') })).toThrow('callback failed')
    expect(readLockOwner(lock)).toBeNull()
  })

  it('recovers an abandoned stale lock before entering the critical section', () => {
    const lock = join(dir, 'resource.lock')
    mkdirSync(lock, { recursive: true }); writeFileSync(join(lock, 'owner'), 'old-owner\n')
    const old = new Date(Date.now() - 60_000); utimesSync(join(lock, 'owner'), old, old)
    expect(withFileLock(lock, () => readFileSync(join(lock, 'owner'), 'utf8'))).not.toBe('old-owner\n')
    expect(readLockOwner(lock)).toBeNull()
  })
})
