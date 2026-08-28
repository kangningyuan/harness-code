import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ApiClient } from '../../src/services/api/client.js'
import type { ModelResult, StreamEvent } from '../../src/services/api/types.js'

export function scriptedClient(results: Array<ModelResult | Error>): ApiClient {
  let index = 0
  return {
    callModel: vi.fn(async () => {
      const next = results[Math.min(index++, results.length - 1)]
      if (next instanceof Error) throw next
      return next
    }),
    callOnce: vi.fn(async () => ({ content: [], stopReason: 'end_turn', usage: undefined })),
  } as unknown as ApiClient
}

export function modelText(text: string, stopReason = 'end_turn'): ModelResult {
  return { content: [{ type: 'text', text }], stopReason }
}

export function modelTool(id: string, name: string, input: Record<string, unknown> = {}): ModelResult {
  return { content: [{ type: 'tool_use', id, name, input }], stopReason: 'tool_use' }
}

export function encodeSse(events: Array<StreamEvent & { eventId?: string }>, trailingNewline = true): string {
  const body = events.map(event => `${event.eventId === undefined ? '' : `id: ${event.eventId}\n`}data: ${JSON.stringify(event)}\n`).join('\n')
  return trailingNewline ? body : body.replace(/\n$/, '')
}

export async function withHttpServer(
  handler: (request: IncomingMessage, response: ServerResponse<IncomingMessage>) => void | Promise<void>,
): Promise<{ url: string; server: Server; close: () => Promise<void> }> {
  const server = createServer((request, response) => { void handler(request, response) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}`,
    server,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
