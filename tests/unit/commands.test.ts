import { getBuiltinCommands } from '../../src/commands.js'

describe('slash commands', () => {
  it('includes /default and switches permission mode', async () => {
    let mode = 'bypassPermissions'
    const command = getBuiltinCommands().find(item => item.name === 'default')
    expect(command).toBeDefined()
    const result = await command!.run!('', { cwd: process.cwd(), setPermissionMode: value => { mode = value } })
    expect(mode).toBe('default')
    expect(result).toMatchObject({ kind: 'message' })
  })
  it('keeps /init as a prompt command with a repository-analysis prompt', () => {
    const command = getBuiltinCommands().find(item => item.name === 'init')
    expect(command?.type).toBe('prompt')
    expect(command?.buildPrompt?.('', { cwd: process.cwd() })).toContain('CLAUDE.md')
  })
  it('lists the current built-in command set in help', async () => {
    const help = getBuiltinCommands().find(item => item.name === 'help')!
    const result = await help.run!('', { cwd: process.cwd() })
    const text = result.kind === 'message' && typeof result.message.content === 'string' ? result.message.content : ''
    expect(text).toContain('/default')
    expect(text).toContain('/init')
  })
  it('exposes durable task, worktree, and background command behavior', async () => {
    const context = { cwd: process.cwd(), listTasks: () => 'task-1 · pending · build', listBackgroundTasks: () => 'bg-1 · running · npm test', listWorktrees: () => 'wt-1 · active · feature · /tmp/wt', cancelBackgroundTask: (id: string) => `Cancelled ${id}` }
    const tasks = await getBuiltinCommands().find(item => item.name === 'tasks')!.run!('', context)
    const worktrees = await getBuiltinCommands().find(item => item.name === 'worktrees')!.run!('', context)
    const cancel = await getBuiltinCommands().find(item => item.name === 'cancel')!.run!(' bg-1 ', context)
    const usage = await getBuiltinCommands().find(item => item.name === 'cancel')!.run!('', context)
    expect(tasks).toMatchObject({ kind: 'message', message: { content: expect.stringContaining('task-1') } })
    expect(worktrees).toMatchObject({ kind: 'message', message: { content: expect.stringContaining('wt-1') } })
    expect(cancel).toMatchObject({ kind: 'message', message: { content: 'Cancelled bg-1' } })
    expect(usage).toMatchObject({ kind: 'message', message: { content: 'Usage: /cancel <task-id>' } })
  })
})
