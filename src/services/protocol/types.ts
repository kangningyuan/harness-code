export type ProtocolMessageType = 'message' | 'task_notification' | 'plan_approval_request' | 'plan_approval_response' | 'shutdown_request' | 'shutdown_response' | 'result'

export interface CorrelationContext {
  sessionId: string
  turnId: string
  requestId?: string
  agentId?: string
  taskId?: string
  worktreeId?: string
  toolUseId?: string
  attempt?: number
}

export interface ProtocolMessage {
  messageId: string
  sessionId: string
  requestId?: string
  from: string
  to: string
  type: ProtocolMessageType
  payload: string
  createdAt: number
  ackedAt?: number
  metadata?: Record<string, unknown>
}

export interface ProtocolRequest {
  requestId: string
  sessionId: string
  type: 'plan_approval' | 'shutdown'
  sender: string
  target: string
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  payload: string
  createdAt: number
  resolvedAt?: number
}
