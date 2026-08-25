import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
export function canonicalPath(path: string, cwd: string): string { const absolute = isAbsolute(path) ? path : resolve(cwd, path); try { return realpathSync(absolute) } catch { return absolute } }
