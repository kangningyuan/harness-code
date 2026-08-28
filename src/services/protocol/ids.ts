import { randomUUID } from 'node:crypto'

export function newRequestId(prefix = 'req'): string { return `${prefix}_${randomUUID()}` }
export function newMessageId(): string { return newRequestId('msg') }
export function newAgentId(): string { return newRequestId('agent') }
export function newTaskId(): string { return newRequestId('task') }
export function newWorktreeId(): string { return newRequestId('wt') }
