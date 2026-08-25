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
})
