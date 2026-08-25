import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadSkillsDir, parseSlashCommand, substituteArguments } from '../../src/skills/loadSkillsDir.js'

describe('skills', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-skills-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  it('parses scalar and list frontmatter fields', () => {
    const skillDir = join(dir, 'review'); mkdirSync(skillDir); writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: review\ndescription: Review code\narguments:\n  - path: target path\n  - mode\nallowed-tools:\n  - FileReadTool\n  - GrepTool\nuser-invocable: false\n---\nReview $1 in ${CLAUDE_SKILL_DIR}.')
    const skill = loadSkillsDir(dir, 'project')[0]
    expect(skill).toMatchObject({ name: 'review', description: 'Review code', userInvocable: false, allowedTools: ['FileReadTool', 'GrepTool'], arguments: [{ name: 'path', description: 'target path' }, { name: 'mode' }] })
  })
  it('substitutes positional and skill directory arguments literally', () => {
    expect(substituteArguments('Use $1 at ${CLAUDE_SKILL_DIR}; all=$ARGUMENTS', { '1': '$value', ARGUMENTS: 'a b' }, '/tmp/skill')).toBe('Use $value at /tmp/skill; all=a b')
  })
  it('parses slash commands', () => {
    expect(parseSlashCommand('/model gpt-5')).toEqual({ name: 'model', args: 'gpt-5' })
    expect(parseSlashCommand('model gpt-5')).toBeNull()
  })
})
