import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../../utils/file/atomicWrite.js'
import { projectStateDir } from '../session/paths.js'
import { newRequestId } from './ids.js'
import type { ProtocolRequest } from './types.js'
import { withFileLock } from '../tasks/lock.js'

function copy(request: ProtocolRequest): ProtocolRequest { return { ...request } }
function valid(value: unknown): value is ProtocolRequest { if (!value || typeof value !== 'object') return false; const item = value as Record<string, unknown>; return typeof item.requestId === 'string' && typeof item.sessionId === 'string' && typeof item.type === 'string' && typeof item.sender === 'string' && typeof item.target === 'string' && typeof item.status === 'string' && typeof item.payload === 'string' && typeof item.createdAt === 'number' }

export class ProtocolRequestStore {
  readonly dir: string
  readonly lockPath: string
  constructor(cwd: string) { this.dir = join(projectStateDir(cwd), 'requests'); this.lockPath = join(projectStateDir(cwd), 'requests.lock'); mkdirSync(this.dir, { recursive: true }) }
  create(sessionId: string, type: ProtocolRequest['type'], sender: string, target: string, payload: string): ProtocolRequest { return withFileLock(this.lockPath, () => { const request: ProtocolRequest = { requestId: newRequestId(), sessionId, type, sender, target, status: 'pending', payload, createdAt: Date.now() }; this.save(request); return copy(request) }) }
  get(id: string): ProtocolRequest | null { try { const value: unknown = JSON.parse(readFileSync(join(this.dir, `${id}.json`), 'utf8')); return valid(value) ? copy(value) : null } catch { return null } }
  list(sessionId?: string): ProtocolRequest[] { return readdirSync(this.dir).filter(name => name.endsWith('.json')).map(name => this.get(name.slice(0, -5))).filter((request): request is ProtocolRequest => Boolean(request && (!sessionId || request.sessionId === sessionId))) }
  resolve(id: string, input: { sessionId: string; sender: string; target: string; type: ProtocolRequest['type']; approve: boolean }): ProtocolRequest | null { return withFileLock(this.lockPath, () => { const request = this.get(id); if (!request || request.status !== 'pending' || request.sessionId !== input.sessionId || request.sender !== input.sender || request.target !== input.target || request.type !== input.type) return null; request.status = input.approve ? 'approved' : 'rejected'; request.resolvedAt = Date.now(); this.save(request); return copy(request) }) }
  private save(request: ProtocolRequest): void { mkdirSync(this.dir, { recursive: true }); atomicWriteFile(join(this.dir, `${request.requestId}.json`), JSON.stringify(request, null, 2) + '\n') }
}
