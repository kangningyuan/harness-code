import { runBash } from '../../src/tools/BashTool/BashTool.js'

describe('BashTool execution', () => {
  it('captures stdout, stderr, and exit code', async () => {
    const result = await runBash('printf out; printf err >&2; exit 3', process.cwd(), 5000)
    expect(result.stdout).toBe('out')
    expect(result.stderr).toBe('err')
    expect(result.exitCode).toBe(3)
    expect(result.timedOut).toBe(false)
    expect(result.backgrounded).toBe(false)
  })
  it('terminates commands that exceed timeout', async () => {
    const result = await runBash('sleep 1', process.cwd(), 10)
    expect(result.timedOut).toBe(true)
  })
  it('terminates a running command on abort', async () => {
    const controller = new AbortController()
    const promise = runBash('sleep 1', process.cwd(), 5000, controller.signal)
    setTimeout(() => controller.abort(), 10)
    const result = await promise
    expect(result.exitCode).not.toBe(0)
  })
})
