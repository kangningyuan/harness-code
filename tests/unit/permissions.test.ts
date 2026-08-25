import { buildTool } from '../../src/Tool.js'
import { hasPermissionsToUseTool } from '../../src/utils/permissions/permissions.js'

function context(cwd = process.cwd()) {
  return { cwd, abortController: new AbortController(), readFileState: { get: () => undefined, set: () => undefined, recordRead: () => undefined, clear: () => undefined } }
}
const read = buildTool({ name: 'Read', inputJSONSchema: { type: 'object' }, maxResultSizeChars: 10, isReadOnly: () => true, call: async () => ({ data: 'ok' }), description: () => '', prompt: () => '', mapToolResultToToolResultBlockParam: () => [], renderToolUseMessage: () => '' })
const write = buildTool({ name: 'Write', inputJSONSchema: { type: 'object' }, maxResultSizeChars: 10, call: async () => ({ data: 'ok' }), description: () => '', prompt: () => '', mapToolResultToToolResultBlockParam: () => [], renderToolUseMessage: () => '' })

describe('permissions', () => {
  it('allows read-only and asks for writes', async () => { expect((await hasPermissionsToUseTool(read, {}, context(), { mode: 'default', rules: [] })).behavior).toBe('allow'); expect((await hasPermissionsToUseTool(write, {}, context(), { mode: 'default', rules: [] })).behavior).toBe('ask') })
  it('keeps deny immune in bypass mode', async () => { const result = await hasPermissionsToUseTool(write, {}, context(), { mode: 'bypassPermissions', rules: [{ source: 'test', ruleBehavior: 'deny', ruleValue: { toolName: 'Write' } }] }); expect(result.behavior).toBe('deny') })
  it('headless denies unapproved writes', async () => { const result = await hasPermissionsToUseTool(write, {}, context(), { mode: 'default', avoidPrompts: true, rules: [] }); expect(result.behavior).toBe('deny') })
  it('matches exact and recursive path rules before the permission mode', async () => {
    const exact = await hasPermissionsToUseTool(write, { file_path: '/tmp/project/.env' }, context(), { mode: 'bypassPermissions', rules: [{ source: 'test', ruleBehavior: 'deny', ruleValue: { toolName: 'Write', ruleContent: '/tmp/project/.env' } }] })
    const recursive = await hasPermissionsToUseTool(write, { file_path: '/tmp/project/src/index.ts' }, context(), { mode: 'default', rules: [{ source: 'test', ruleBehavior: 'allow', ruleValue: { toolName: 'Write', ruleContent: '/tmp/project/**' } }] })
    expect(exact.behavior).toBe('deny')
    expect(recursive.behavior).toBe('allow')
  })
  it('uses deny over ask over allow for matching path rules', async () => {
    const rules = [
      { source: 'test', ruleBehavior: 'allow' as const, ruleValue: { toolName: 'Write', ruleContent: '/tmp/project/**' } },
      { source: 'test', ruleBehavior: 'ask' as const, ruleValue: { toolName: 'Write', ruleContent: '/tmp/project/**' } },
      { source: 'test', ruleBehavior: 'deny' as const, ruleValue: { toolName: 'Write', ruleContent: '/tmp/project/**' } },
    ]
    expect((await hasPermissionsToUseTool(write, { file_path: '/tmp/project/a.txt' }, context(), { mode: 'bypassPermissions', rules })).behavior).toBe('deny')
  })
  it('honors a tool checkPermissions allow result', async () => {
    const allowed = buildTool({ name: 'SpecialWrite', inputJSONSchema: { type: 'object' }, maxResultSizeChars: 10, checkPermissions: async () => ({ behavior: 'allow' as const }), call: async () => ({ data: 'ok' }), description: () => '', prompt: () => '', renderToolUseMessage: () => '' })
    expect((await hasPermissionsToUseTool(allowed, {}, context(), { mode: 'default', rules: [] })).behavior).toBe('allow')
  })
})
