import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { atomicWriteFile } from '../../utils/file/atomicWrite.js'
import type { ToolResultReference, ToolResultStore } from '../../Tool.js'

const DEFAULT_THRESHOLD = 30_000
const PREVIEW_HEAD = 1_500
const PREVIEW_TAIL = 500

function safeId(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 32) }
function preview(content: string): string {
  if (content.length <= PREVIEW_HEAD + PREVIEW_TAIL) return content
  return `${content.slice(0, PREVIEW_HEAD)}\n... (preview truncated) ...\n${content.slice(-PREVIEW_TAIL)}`
}

export function createToolResultStore(cwd: string, sessionId?: string, threshold = DEFAULT_THRESHOLD): ToolResultStore {
  const root = join(cwd, '.harness-code', 'tool-results', safeId(sessionId ?? 'ephemeral'))
  return {
    persist(content, metadata): ToolResultReference | null {
      if (content.length <= threshold) return null
      mkdirSync(root, { recursive: true, mode: 0o700 })
      const digest = createHash('sha256').update(content).digest('hex')
      const id = safeId(`${metadata.toolUseId}:${metadata.toolName}:${digest}`)
      const file = join(root, `${id}.txt`)
      if (!existsSync(file)) {
        atomicWriteFile(file, content)
        try { chmodSync(file, 0o600) } catch { /* best effort on platforms without chmod */ }
      } else {
        try {
          const existing = readFileSync(file, 'utf8')
          if (existing !== content) return null
        } catch { return null }
      }
      return { id, relativePath: relative(cwd, file), byteLength: Buffer.byteLength(content), sha256: digest, preview: preview(content) }
    },
  }
}

export function formatToolResultReference(reference: ToolResultReference): string {
  return `<persisted-tool-result>\nartifact: ${reference.id}\npath: ${reference.relativePath}\nbytes: ${reference.byteLength}\nsha256: ${reference.sha256}\npreview:\n${reference.preview}\n</persisted-tool-result>`
}
