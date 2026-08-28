import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { newMessageId } from './ids.js'
import { projectStateDir } from '../session/paths.js'
import { withFileLock } from '../tasks/lock.js'
import type { ProtocolMessage } from './types.js'

function safeAgent(agent: string): string { return agent.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'agent' }
function clone(message: ProtocolMessage): ProtocolMessage { return { ...message, metadata: message.metadata ? { ...message.metadata } : undefined } }

export class MessageBus {
  readonly dir: string
  constructor(cwd: string) { this.dir = join(projectStateDir(cwd), 'mailboxes'); mkdirSync(this.dir, { recursive: true }) }
  send(input: Omit<ProtocolMessage, 'messageId' | 'createdAt'> & { messageId?: string; createdAt?: number }): ProtocolMessage {
    const message: ProtocolMessage = { ...input, messageId: input.messageId ?? newMessageId(), createdAt: input.createdAt ?? Date.now() }
    const path = this.mailboxPath(message.to)
    withFileLock(`${path}.lock`, () => appendFileSync(path, JSON.stringify(message) + '\n', 'utf8'))
    return clone(message)
  }
  consume(agent: string, sessionId: string): ProtocolMessage[] {
    const path = this.mailboxPath(agent); if (!existsSync(path)) return []
    const ackPath = `${path}.ack`; return withFileLock(`${path}.lock`, () => {
      const acknowledged = new Set(this.readIds(ackPath))
      const messages: ProtocolMessage[] = []
      for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const value: unknown = JSON.parse(line)
          if (!value || typeof value !== 'object') continue
          const message = value as ProtocolMessage
          if (message.sessionId === sessionId && typeof message.messageId === 'string' && !acknowledged.has(message.messageId)) { messages.push(clone(message)); acknowledged.add(message.messageId) }
        } catch { /* retain malformed lines for diagnostics without delivering them */ }
      }
      if (messages.length) appendFileSync(ackPath, messages.map(message => `${message.messageId}\n`).join(''), 'utf8')
      return messages
    })
  }
  private mailboxPath(agent: string): string { return join(this.dir, `${safeAgent(agent)}.jsonl`) }
  private readIds(path: string): string[] { try { return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean) } catch { return [] } }
}
