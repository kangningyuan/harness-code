import { analyzeBashSafety, isReadOnlyCommand } from '../../src/utils/bash/ast.js'
import { buildTool } from '../../src/Tool.js'
import { hasPermissionsToUseTool } from '../../src/utils/permissions/permissions.js'
import { createCanUseTool } from '../../src/permissions/canUseTool.js'

function context(cwd = '/tmp/project') {
  return { cwd, abortController: new AbortController(), readFileState: { get: () => undefined, set: () => undefined, recordRead: () => undefined, clear: () => undefined } }
}
function tool(name: string, flags: { readOnly?: boolean; destructive?: boolean } = {}) {
  return buildTool({ name, inputJSONSchema: { type: 'object' }, maxResultSizeChars: 100, isReadOnly: () => flags.readOnly === true, isDestructive: () => flags.destructive === true, call: async () => ({ data: 'ok', result: 'ok' }), description: () => name, prompt: () => name, renderToolUseMessage: () => name })
}

describe('security boundary contract', () => {
  it.each([
    ['control chars', `echo hi${String.fromCharCode(0)}`, 'control-chars'],
    ['unmatched quote', "echo 'x", 'parse-error'],
    ['backslash-space', 'echo\\ hi', 'backslash-space'],
    ['zsh dynamic expansion', 'echo ~[', 'zsh-dynamic'],
    ['IFS assignment', 'IFS=x echo hi', 'ifs-assignment'],
    ['unsafe PS4', 'PS4=foo; echo hi', 'ps4-assignment'],
    ['unsafe declare', 'declare -n ref=value', 'declare-flags'],
    ['bare positional variable', 'echo $@', 'bare-var-ifs'],
    ['empty default variable', 'echo ${X:-} value', 'empty-var-bare'],
    ['arithmetic injection', 'echo $((user+1))', 'arithmetic-injection'],
    ['unquoted heredoc', 'cat <<EOF', 'unquoted-heredoc'],
    ['read in pipeline', 'read value | cat', 'read-in-conditional'],
  ])('rejects %s with code %s', (_label, command, code) => {
    expect(analyzeBashSafety(command)).toMatchObject({ ok: false, code })
  })

  it.each([
    ['ls -la', true], ['git status --short', true], ['git diff', true], ['pwd | wc -l', true],
    ['echo hi > output.txt', false], ['git commit -am save', false], ['rm -rf /tmp/x', false], ['cat $(whoami)', false],
  ])('classifies read-only command %s as %s', (command, expected) => { expect(isReadOnlyCommand(command)).toBe(expected) })

  it('keeps destructive and protected paths hard even in bypass mode', async () => {
    const destructive = await hasPermissionsToUseTool(tool('Delete', { destructive: true }), {}, context(), { mode: 'bypassPermissions', rules: [] })
    const protectedPath = await hasPermissionsToUseTool(tool('Write'), { file_path: '/tmp/project/.claude/settings.json' }, context(), { mode: 'bypassPermissions', rules: [] })
    expect(destructive).toMatchObject({ behavior: 'ask', hard: true })
    expect(protectedPath).toMatchObject({ behavior: 'ask', hard: true })
  })

  it('enforces path specificity and preserves hard deny over hook approval', async () => {
    const write = tool('Write')
    const rules = [
      { source: 'test', ruleBehavior: 'allow' as const, ruleValue: { toolName: 'Write', ruleContent: '/tmp/project/**' } },
      { source: 'test', ruleBehavior: 'deny' as const, ruleValue: { toolName: 'Write', ruleContent: '/tmp/project/private/*' } },
    ]
    expect(await hasPermissionsToUseTool(write, { file_path: '/tmp/project/public/a.txt' }, context(), { mode: 'default', rules })).toMatchObject({ behavior: 'allow' })
    expect(await hasPermissionsToUseTool(write, { file_path: '/tmp/project/private/a.txt' }, context(), { mode: 'bypassPermissions', rules })).toMatchObject({ behavior: 'deny', hard: true })
    const canUse = createCanUseTool({ mode: 'default', rules: [{ source: 'test', ruleBehavior: 'deny', ruleValue: { toolName: 'Write' } }] })
    expect(await canUse(write, {}, { hookApproved: true })).toMatchObject({ behavior: 'deny' })
  })

  it('aborts an interactive permission request instead of waiting forever', async () => {
    const controller = new AbortController()
    const canUse = createCanUseTool({ mode: 'default', rules: [] }, { onAsk: async () => new Promise<boolean>(() => undefined) })
    const pending = canUse(tool('Write'), {}, { signal: controller.signal })
    controller.abort()
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' })
  })
})
