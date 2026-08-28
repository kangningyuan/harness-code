import { mkdtempSync, rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GitResult, GitRunner } from '../../src/services/worktree/types.js'

export function tempDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function withTempHome(prefix = 'harness-test-'): { home: string; cwd: string; cleanup: () => void } {
  const home = tempDirectory(prefix)
  const cwd = join(home, 'project')
  return {
    home,
    cwd,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  }
}

export async function removeDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

export async function waitFor(predicate: () => boolean, timeoutMs = 1_000, intervalMs = 5): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`)
    await new Promise<void>(resolve => setTimeout(resolve, intervalMs))
  }
}

export async function flushPromises(): Promise<void> {
  await new Promise<void>(resolve => queueMicrotask(resolve))
}

export function fakeGit(defaultResult: Partial<GitResult> = {}): GitRunner & { calls: string[][]; results: GitResult[] } {
  const calls: string[][] = []
  const results: GitResult[] = []
  const result = (): GitResult => ({ ok: true, stdout: '', stderr: '', exitCode: 0, ...defaultResult })
  return {
    calls,
    results,
    run(args) {
      calls.push([...args])
      const next = results.shift()
      return next ?? result()
    },
  }
}

export function restoreHome(home: string): () => void {
  const previous = process.env.HOME
  process.env.HOME = home
  return () => {
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
  }
}

export function normalizeDynamic(value: string): string {
  return value
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<uuid>')
    .replace(/\b[a-z0-9]{8,}-[a-z0-9_-]+\b/gi, '<id>')
    .replace(/\b\d{10,}\b/g, '<timestamp>')
}
