import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appendMessages, createSession, listSessions, loadSession, replaceMessages } from '../../src/services/session/store.js'
import { isValidSessionId, sessionFile, sessionsDir } from '../../src/services/session/paths.js'

describe('session store', () => {
  let home: string
  let cwd: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'harness-session-home-')); cwd = join(home, 'project'); vi.stubEnv('HOME', home) })
  afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) })
  it('creates, appends, loads, and lists sessions', () => { const session = createSession(cwd, 'test'); appendMessages(cwd, session.id, [{ role: 'user', content: 'hello' }]); expect(loadSession(cwd, session.id).messages).toHaveLength(1); expect(listSessions(cwd)[0]?.id).toBe(session.id) })
  it('replaces a session snapshot and updates metadata count', () => {
    const session = createSession(cwd, 'test')
    appendMessages(cwd, session.id, [{ role: 'user', content: 'old' }])
    replaceMessages(cwd, session.id, [{ role: 'user', content: 'summary' }, { role: 'assistant', content: 'recent' }])
    expect(loadSession(cwd, session.id).messages).toEqual([{ role: 'user', content: 'summary' }, { role: 'assistant', content: 'recent' }])
    expect(listSessions(cwd)[0]?.messageCount).toBe(2)
  })
  it('skips malformed JSONL lines while loading', () => {
    const session = createSession(cwd, 'test')
    appendMessages(cwd, session.id, [{ role: 'user', content: 'valid' }])
    appendFileSync(sessionFile(sessionsDir(cwd), session.id), '{not-json}\n')
    expect(loadSession(cwd, session.id).messages).toHaveLength(1)
  })
  it('rejects unsafe session ids before constructing paths', () => {
    expect(isValidSessionId('abc-123')).toBe(true)
    expect(isValidSessionId('../outside')).toBe(false)
    expect(() => sessionFile(sessionsDir(cwd), '../outside')).toThrow('Invalid session id')
  })
  it('sorts sessions newest first using metadata timestamps', () => {
    const older = createSession(cwd, 'test')
    const newer = createSession(cwd, 'test')
    const dir = sessionsDir(cwd)
    const olderMetaPath = join(dir, `${older.id}.meta.json`)
    const newerMetaPath = join(dir, `${newer.id}.meta.json`)
    writeFileSync(olderMetaPath, JSON.stringify({ ...older, updatedAt: 1 }))
    writeFileSync(newerMetaPath, JSON.stringify({ ...newer, updatedAt: 2 }))
    expect(listSessions(cwd).map(session => session.id)).toEqual([newer.id, older.id])
  })
})
