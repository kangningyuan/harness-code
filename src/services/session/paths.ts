import { homedir } from 'node:os'
import { join } from 'node:path'
import { sanitizeProjectPath } from '../../memdir/paths.js'

export function projectsRoot(): string { return join(homedir(), '.harness-code', 'projects') }
export function sessionsDir(cwd: string): string { return join(projectsRoot(), sanitizeProjectPath(cwd)) }
export function projectStateDir(cwd: string): string { return join(sessionsDir(cwd), 'state') }
export function isValidSessionId(id: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) }
function assertSessionId(id: string): void { if (!isValidSessionId(id)) throw new Error('Invalid session id') }
export function sessionFile(dir: string, id: string): string { assertSessionId(id); return join(dir, `${id}.jsonl`) }
export function sessionMetaFile(dir: string, id: string): string { assertSessionId(id); return join(dir, `${id}.meta.json`) }
