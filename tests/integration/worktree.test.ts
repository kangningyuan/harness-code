import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWorktreeService } from '../../src/services/worktree/service.js'

function git(cwd: string, ...args: string[]): string { return String(execFileSync('git', args, { cwd, encoding: 'utf8' })) }

describe('worktree service', () => {
  let home: string
  let repo: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'harness-worktree-home-'))
    repo = join(home, 'repo'); mkdirSync(repo, { recursive: true }); vi.stubEnv('HOME', home)
    git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.email', 'test@example.com'); git(repo, 'config', 'user.name', 'Test')
    writeFileSync(join(repo, 'README.md'), 'initial\n'); git(repo, 'add', 'README.md'); git(repo, 'commit', '-m', 'initial')
  })
  afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) })

  it('creates, keeps, and removes an isolated worktree', () => {
    const service = createWorktreeService(repo)
    const created = service.create('feature', { owner: 'lead', sessionId: 'session' })
    expect(created.ok).toBe(true)
    expect(created.worktree?.status).toBe('active')
    expect(created.worktree?.path).toContain('.harness-code/worktrees/feature')
    expect(service.keep('feature', 'lead').worktree?.status).toBe('kept')
    expect(service.remove('feature', { owner: 'lead' }).ok).toBe(true)
    expect(service.get('feature')?.status).toBe('removed')
  })

  it('refuses dirty removal without explicit discard', () => {
    const service = createWorktreeService(repo)
    const created = service.create('dirty')
    expect(created.ok).toBe(true)
    writeFileSync(join(created.worktree!.path, 'uncommitted.txt'), 'changes\n')
    expect(service.remove('dirty')).toMatchObject({ ok: false })
    expect(service.remove('dirty', { discardChanges: true })).toMatchObject({ ok: true, worktree: { status: 'removed' } })
  })

  it('rejects unsafe names before invoking git', () => {
    const service = createWorktreeService(repo)
    expect(service.create('../escape')).toMatchObject({ ok: false })
    expect(service.create('bad/name')).toMatchObject({ ok: false })
  })
})
