export type WorktreeStatus = 'creating' | 'active' | 'kept' | 'removing' | 'removed' | 'orphaned' | 'error'

export interface WorktreeRecord {
  id: string
  name: string
  path: string
  branch: string
  baseRef: string
  repoRoot: string
  taskId?: string
  owner?: string
  sessionId?: string
  status: WorktreeStatus
  createdAt: number
  updatedAt: number
  leaseUntil?: number
  error?: string
}

export interface WorktreeResult {
  ok: boolean
  worktree?: WorktreeRecord
  error?: string
}

export interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number
}

export interface GitRunner {
  run(args: readonly string[], options: { cwd: string; timeoutMs?: number }): GitResult
}
