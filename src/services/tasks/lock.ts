import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const LOCK_STALE_MS = 30_000
const WAIT_MS = 10
const MAX_WAIT_MS = 10_000
function sleep(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

export function withFileLock<T>(lockPath: string, fn: () => T): T {
  mkdirSync(dirname(lockPath), { recursive: true })
  const started = Date.now()
  while (true) {
    try {
      mkdirSync(lockPath)
      writeFileSync(join(lockPath, 'owner'), `${process.pid}:${randomUUID()}\n`, 'utf8')
      break
    } catch {
      try {
        if (Date.now() - statSync(join(lockPath, 'owner')).mtimeMs > LOCK_STALE_MS) rmSync(lockPath, { recursive: true, force: true })
      } catch { /* lock may be between creation and owner write */ }
      if (Date.now() - started >= MAX_WAIT_MS) throw new Error(`Timed out waiting for lock: ${lockPath}`)
      sleep(WAIT_MS)
    }
  }
  try { return fn() } finally { rmSync(lockPath, { recursive: true, force: true }) }
}

export function readLockOwner(lockPath: string): string | null { try { return existsSync(lockPath) ? readFileSync(join(lockPath, 'owner'), 'utf8').trim() : null } catch { return null } }
