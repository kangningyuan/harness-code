import type { ModelResult, StreamEvent } from './types.js'

export interface ResumeCursor { requestId: string; lastEventId?: string; sequence: number; token?: string }
export interface ResumeAdapter {
  readonly supported: boolean
  resume(cursor: ResumeCursor, onEvent: (event: StreamEvent) => void, signal?: AbortSignal): Promise<ModelResult>
}

export class UnsupportedResumeAdapter implements ResumeAdapter {
  readonly supported = false
  async resume(): Promise<ModelResult> { throw new Error('Server does not advertise resumable streams') }
}

export function assertResumeCursor(cursor: ResumeCursor, expectedRequestId: string): void {
  if (!cursor.requestId || cursor.requestId !== expectedRequestId) throw new Error('Resume cursor request mismatch')
  if (!Number.isInteger(cursor.sequence) || cursor.sequence < 0) throw new Error('Invalid resume cursor sequence')
}
