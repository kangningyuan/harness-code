import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fetchSystemPromptParts } from '../../src/context.js'
import { buildMemoryIndex, ensureMemoryDir, getAutoMemPath, getMemoryIndexPath, loadMemoryPrompt, parseMemoryFile, scanMemoryFiles } from '../../src/memdir/memdir.js'
import { sanitizeProjectPath } from '../../src/memdir/paths.js'
function git(cwd: string, ...args: string[]): void { execFileSync('git', args, { cwd, stdio: 'ignore' }) }

describe('context and memory contract', () => {
  let home: string
  let repo: string
  let nested: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'harness-context-contract-')); repo = join(home, 'repo'); nested = join(repo, 'src', 'nested'); mkdirSync(nested, { recursive: true }); vi.stubEnv('HOME', home)
    git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 'test@example.com'); git(repo, 'config', 'user.name', 'Harness Test')
    writeFileSync(join(repo, 'README.md'), 'initial\n'); git(repo, 'add', 'README.md'); git(repo, 'commit', '-qm', 'initial')
  })
  afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) })

  it('assembles default prompt, nearest project files, date, git state, append prompt, and memory', () => {
    writeFileSync(join(repo, 'CLAUDE.md'), 'root instructions\n')
    writeFileSync(join(repo, 'src', 'HARNESS.md'), 'src instructions\n')
    const memory = join(home, 'memory'); mkdirSync(memory); writeFileSync(join(memory, 'MEMORY.md'), '# Memory Index\n\n- durable\n'); vi.stubEnv('HARNESS_MEMORY_PATH', memory)
    writeFileSync(join(repo, 'untracked.txt'), 'change\n')
    const parts = fetchSystemPromptParts({ cwd: nested, tools: [], appendSystemPrompt: 'append me' })
    const text = parts.map(part => part.text).join('\n')
    expect(text).toContain('You are harness code')
    expect(text).toContain('root instructions')
    expect(text).toContain('src instructions')
    expect(text).toContain('Today\'s date is')
    expect(text).toContain('# Git status')
    expect(text).toContain('untracked.txt')
    expect(text).toContain('append me')
    expect(text).toContain('# Auto memory')
  })

  it('deduplicates symlinked CLAUDE files and honors the disable switch', () => {
    const shared = join(home, 'shared.md'); writeFileSync(shared, 'shared instructions')
    symlinkSync(shared, join(repo, 'CLAUDE.md'))
    symlinkSync(shared, join(repo, 'HARNESS.md'))
    const text = fetchSystemPromptParts({ cwd: repo, tools: [] }).map(part => part.text).join('\n')
    expect(text.match(/shared instructions/g)).toHaveLength(1)
    vi.stubEnv('HARNESS_DISABLE_CLAUDE_MDS', '1')
    expect(fetchSystemPromptParts({ cwd: repo, tools: [] }).map(part => part.text).join('\n')).not.toContain('shared instructions')
  })

  it('uses explicit memory path before settings and git-derived defaults', () => {
    const configured = join(home, 'configured'); mkdirSync(configured)
    const overridden = join(home, 'overridden'); mkdirSync(overridden)
    expect(getAutoMemPath(repo, { autoMemoryDirectory: configured })).toBe(configured)
    vi.stubEnv('HARNESS_MEMORY_PATH', overridden)
    expect(getAutoMemPath(repo, { autoMemoryDirectory: configured })).toBe(overridden)
    expect(sanitizeProjectPath('/a/project path')).toBe('a-projectpath')
  })

  it('parses memory frontmatter, ignores MEMORY.md, initializes an index, and caps index size', () => {
    const dir = join(home, 'memory'); ensureMemoryDir(dir)
    expect(readFileSync(getMemoryIndexPath(dir), 'utf8')).toContain('# Memory Index')
    const good = join(dir, 'good.md'); writeFileSync(good, '---\nname: Good\ndescription: Durable fact\ntype: feedback\n---\nbody\n')
    writeFileSync(join(dir, 'MEMORY.md'), 'index')
    writeFileSync(join(dir, 'bad.md'), 'not frontmatter')
    expect(parseMemoryFile(good)).toMatchObject({ name: 'Good', type: 'feedback', body: 'body\n' })
    expect(scanMemoryFiles(dir)).toHaveLength(1)
    const files = Array.from({ length: 250 }, (_, index) => ({ path: `x${index}`, name: `name-${index}`, description: 'd'.repeat(150), type: 'project' as const, body: '', mtimeMs: 0 }))
    const index = buildMemoryIndex(files)
    expect(index).toContain('index truncated')
    expect(index.length).toBeLessThan(25_100)
  })
})
