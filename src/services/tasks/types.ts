export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'

export interface TaskRecord {
  id: string
  subject: string
  description: string
  status: TaskStatus
  owner?: string
  blockedBy: string[]
  worktreeId?: string
  sessionId?: string
  createdAt: number
  updatedAt: number
  version: number
  attempts: number
  leaseUntil?: number
  error?: string
}

export interface TaskMutationResult {
  ok: boolean
  task?: TaskRecord
  error?: string
  unblocked?: TaskRecord[]
}
