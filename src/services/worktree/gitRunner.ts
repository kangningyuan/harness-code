import { execFileSync } from 'node:child_process'
import type { GitResult, GitRunner } from './types.js'

export class ExecGitRunner implements GitRunner {
  run(args: readonly string[], options: { cwd: string; timeoutMs?: number } = { cwd: process.cwd() }): GitResult {
    try {
      const stdout = execFileSync('git', [...args], { cwd: options.cwd, encoding: 'utf8', timeout: options.timeoutMs ?? 30_000, stdio: ['ignore', 'pipe', 'pipe'] })
      return { ok: true, stdout: String(stdout), stderr: '', exitCode: 0 }
    } catch (error) {
      const value = error as { stdout?: unknown; stderr?: unknown; status?: unknown; message?: unknown }
      return { ok: false, stdout: String(value.stdout ?? ''), stderr: String(value.stderr ?? value.message ?? ''), exitCode: typeof value.status === 'number' ? value.status : 1 }
    }
  }
}
