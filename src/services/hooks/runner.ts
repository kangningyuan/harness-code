import { spawn } from 'node:child_process'
import type { HookCommand, HookEvent, HookInput, HookMatcher, HookOutcome, HooksRegistry } from './types.js'

export interface HookRunOptions { failClosed?: boolean }
function matches(matcher: string | undefined, toolName: string | undefined): boolean { if (!matcher || matcher === '*') return true; return new RegExp(`^${matcher.replace(/[.+?^${}()|[\\]\\]/g, '\\$&').replaceAll('*', '.*')}$`).test(toolName ?? '') }
function failed(message: string, options: HookRunOptions): HookOutcome { return options.failClosed ? { decision: 'block', reason: message } : {} }
async function commandHook(command: HookCommand, event: HookEvent, input: HookInput, timeout = 60_000, options: HookRunOptions = {}): Promise<HookOutcome> {
  return new Promise(resolve => {
    if (!command.command) return resolve(failed('Hook command is missing', options))
    const child = spawn(command.command, { shell: true, cwd: input.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let settled = false
    const finish = (outcome: HookOutcome) => { if (settled) return; settled = true; clearTimeout(timer); resolve(outcome) }
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(failed('Hook timed out', options)) }, command.timeout ?? timeout)
    child.stdout.on('data', chunk => stdout += String(chunk))
    child.on('error', () => finish(failed('Hook process failed', options)))
    child.on('close', () => { try { const parsed: unknown = JSON.parse(stdout); finish(parsed && typeof parsed === 'object' ? parsed as HookOutcome : failed('Hook returned a non-object result', options)) } catch { finish(failed('Hook returned invalid JSON', options)) } })
    try { child.stdin.write(JSON.stringify({ event, ...input })); child.stdin.end() } catch { finish(failed('Hook input could not be written', options)) }
  })
}
async function one(command: HookCommand, event: HookEvent, input: HookInput, options: HookRunOptions): Promise<HookOutcome> {
  if (command.type === 'function' && command.function) {
    try { const value = await command.function({ input, event }); return value && typeof value === 'object' ? value as HookOutcome : failed('Hook returned no decision', options) } catch { return failed('Function hook failed', options) }
  }
  if (command.type === 'command') return commandHook(command, event, input, 60_000, options)
  return failed(`Unsupported hook type: ${command.type}`, options)
}
export async function runHooks(registry: HooksRegistry, event: HookEvent, input: HookInput, options: HookRunOptions = {}): Promise<HookOutcome> {
  const matchers: HookMatcher[] = registry.matchers[event] ?? []
  const commands = matchers.filter(matcher => matches(matcher.matcher, input.toolName)).flatMap(matcher => matcher.hooks)
  const outcomes = await Promise.all(commands.map(command => one(command, event, input, options)))
  return outcomes.find(outcome => outcome.decision === 'block') ?? outcomes.find(outcome => outcome.decision === 'approve') ?? {}
}
