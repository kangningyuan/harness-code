import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { renameSync, unlinkSync, writeFileSync } from 'node:fs'

export function atomicWriteFile(path: string, content: string): void {
  const temporary = join(dirname(path), `.${randomUUID()}.harness-tmp`)
  try {
    writeFileSync(temporary, content, 'utf8')
    renameSync(temporary, path)
  } finally {
    try { unlinkSync(temporary) } catch { /* already renamed or never created */ }
  }
}
