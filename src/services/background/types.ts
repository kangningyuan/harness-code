import type { ToolResult, ToolResultReference, ToolUseContext } from '../../Tool.js'
import type { CorrelationContext } from '../protocol/types.js'

export type BackgroundTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'orphaned'

export interface BackgroundTask {
  id: string
  sessionId: string
  turnId: string
  toolUseId: string
  toolName: string
  command?: string
  cwd: string
  status: BackgroundTaskStatus
  createdAt: number
  startedAt?: number
  finishedAt?: number
  exitCode?: number | null
  resultRef?: ToolResultReference
  summary?: string
  error?: string
  owner?: string
}

export interface BackgroundRunResult {
  result: ToolResult
  context?: ToolUseContext
}

export interface BackgroundStartOptions {
  correlation: CorrelationContext
  toolName: string
  command?: string
  cwd: string
  run: (signal: AbortSignal) => Promise<BackgroundRunResult>
  onResult?: (result: ToolResult, task: BackgroundTask) => void
}

export interface BackgroundEvent {
  type: 'started' | 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'orphaned'
  task: BackgroundTask
  notification: string
}
