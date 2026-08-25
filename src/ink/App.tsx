import React, { useEffect, useRef, useState } from 'react'
import { Box, Newline, Static, Text, useApp, useInput } from 'ink'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { QueryEngine } from '../QueryEngine.js'
import type { Message, ApiConfig, ContentBlock } from '../services/api/types.js'
import type { UsageTracker } from '../services/api/usage.js'
import { formatCost, formatTotalCost } from '../services/api/usage.js'
import { DEFAULT_CONTEXT_WINDOW } from '../services/compact/compact.js'
import { getBuiltinCommands } from '../commands.js'
import { loadMemoryPrompt } from '../memdir/memdir.js'
import { getCurrentTodos, subscribeTodos, type TodoList } from '../tools/TodoWriteTool/TodoWriteTool.js'
import { listSessions, type SessionMeta } from '../services/session/store.js'
import { redactApiKey } from '../cli/config.js'
import { renderBar } from './barGlyph.js'

const BANNER = [
  '▗▖ ▗▖ ▗▄▖ ▗▄▄▖ ▗▖  ▗▖▗▄▄▄▖ ▗▄▄▖ ▗▄▄▖      ▗▄▄▖ ▗▄▖ ▗▄▄▄  ▗▄▄▄▖',
  '▐▌ ▐▌▐▌ ▐▌▐▌ ▐▌▐▛▚▖▐▌▐▌   ▐▌   ▐▌        ▐▌   ▐▌ ▐▌▐▌  █ ▐▌   ',
  '▐▛▀▜▌▐▛▀▜▌▐▛▀▚▖▐▌ ▝▜▌▐▛▀▀▘ ▝▀▚▖ ▝▀▚▖     ▐▌   ▐▌ ▐▌▐▌  █ ▐▛▀▀▘',
  '▐▌ ▐▌▐▌ ▐▌▐▌ ▐▌▐▌  ▐▌▐▙▄▄▖▗▄▄▞▘▗▄▄▞▘     ▝▚▄▄▖▝▚▄▞▘▐▙▄▄▀ ▐▙▄▄▖',
] as const
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
let entrySequence = 0
export interface AppProps {
  engine: QueryEngine
  cwd: string
  costTracker: UsageTracker
  config: ApiConfig
  permAskHolder?: { cb?: (tool: string, input: unknown, reason: string) => Promise<boolean> }
}
type Entry = { id: number; role: 'user'|'assistant'|'tool'|'banner'; text: string; toolName?: string }
type Footer = { ctxK: string; winK: string; pct: number; total: string; model: string; mode: string }
function entry(role: Entry['role'], text: string, toolName?: string): Entry { return { id: entrySequence++, role, text, toolName } }
function contentText(content: Message['content']): string { if (typeof content === 'string') return content; return content.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text').map(block => block.text).join('') }
function toolLabel(name: string, input: unknown): string {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const label = value.file_path ?? value.notebook_path ?? value.command ?? value.pattern ?? value.url ?? value.description ?? value.question ?? name
  return String(label).slice(0, 60)
}
function entriesFromMessages(messages: Message[]): Entry[] {
  const result: Entry[] = [entry('banner', '')]
  for (const message of messages) {
    if (typeof message.content === 'string') { result.push(entry(message.role, message.content)); continue }
    for (const block of message.content) {
      if (block.type === 'text') result.push(entry(message.role, block.text))
      else if (block.type === 'tool_use') result.push(entry('tool', `▶ ${block.name}: ${toolLabel(block.name, block.input)}`, block.name))
      else if (block.type === 'tool_result') result.push(entry('tool', `${block.is_error ? '✗' : '✓'} tool_result: ${block.tool_use_id}`))
    }
  }
  return result
}
function formatContextTokens(tokens: number): string { return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${Math.round(tokens)}` }

export function App({ engine, cwd, costTracker, config, permAskHolder }: AppProps) {
  const { exit } = useApp()
  const [input, setInput] = useState('')
  const [cursorPos, setCursorPos] = useState(0)
  const cursorRef = useRef(0)
  const [transcriptKey, setTranscriptKey] = useState(0)
  const [transcript, setTranscript] = useState<Entry[]>([entry('banner', '')])
  const [loading, setLoading] = useState(false)
  const [deferredCommand, setDeferredCommand] = useState<string | null>(null)
  const [streamingText, setStreamingText] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyIdx, setHistoryIdx] = useState(-1)
  const [spinnerFrame, setSpinnerFrame] = useState(0)
  const [ringFrame, setRingFrame] = useState(0)
  const [activity, setActivity] = useState('thinking')
  const [todos, setTodos] = useState<TodoList>(getCurrentTodos())
  const [pendingPerm, setPendingPerm] = useState<{ tool: string; input: unknown; reason: string } | null>(null)
  const permResolver = useRef<((approved: boolean) => void) | null>(null)
  const [pendingPlan, setPendingPlan] = useState<string | null>(null)
  const planResolver = useRef<((approved: boolean) => void) | null>(null)
  const [modelSelectIdx, setModelSelectIdx] = useState<number | null>(null)
  const [historySelect, setHistorySelect] = useState<{ sessions: SessionMeta[]; idx: number } | null>(null)
  const [refresh, forceRefresh] = useState(0)
  void refresh
  const setCursor = (value: number) => { cursorRef.current = value; setCursorPos(value) }
  const append = (item: Omit<Entry, 'id'>) => setTranscript(items => [...items, entry(item.role, item.text, item.toolName)])
  const rebuildTranscript = () => { setTranscript(entriesFromMessages(engine.getMessages())); setTranscriptKey(key => key + 1); forceRefresh(value => value + 1) }

  useEffect(() => { const unsubscribe = subscribeTodos(setTodos); return unsubscribe }, [])
  useEffect(() => { if (!loading) { setSpinnerFrame(0); return undefined }; const id = setInterval(() => setSpinnerFrame(frame => (frame + 1) % SPINNER_FRAMES.length), 80); return () => clearInterval(id) }, [loading])
  useEffect(() => { const id = setInterval(() => setRingFrame(frame => (frame + 1) % 18), 120); return () => clearInterval(id) }, [])
  useEffect(() => {
    if (!permAskHolder) return undefined
    permAskHolder.cb = async (tool, input, reason) => { setPendingPerm({ tool, input, reason }); return new Promise<boolean>(resolve => { permResolver.current = resolve }) }
    return () => { if (permAskHolder) permAskHolder.cb = undefined }
  }, [permAskHolder])

  const footer: Footer = (() => { const ctx = engine.getContextTokens(); const pct = Math.min(100, Math.round(ctx / DEFAULT_CONTEXT_WINDOW * 100)); return { ctxK: formatContextTokens(ctx), winK: `${DEFAULT_CONTEXT_WINDOW / 1000}k`, pct, total: formatCost(costTracker.getTotalCost()), model: engine.getModelManager().getModel(), mode: engine.getPermissionMode() ?? 'default' } })()
  const modelEntries = engine.getModelManager().listModels()
  const resolvePermission = (approved: boolean) => { const resolver = permResolver.current; permResolver.current = null; setPendingPerm(null); resolver?.(approved) }
  const resolvePlan = (approved: boolean) => { const resolver = planResolver.current; planResolver.current = null; setPendingPlan(null); resolver?.(approved) }
  const showHistory = () => setHistorySelect({ sessions: listSessions(cwd).slice(0, 20), idx: 0 })
  const exportTranscript = () => { const id = engine.getSessionId() ?? 'current'; const path = join(cwd, `harness-export-${id}.md`); const lines = [`# harness-code transcript (${id})`, '', ...transcript.filter(item => item.role !== 'banner').map(item => `${item.role === 'user' ? '## User' : item.role === 'tool' ? '## Tool' : '## Assistant'}\n\n${item.text}\n`)]; writeFileSync(path, lines.join('\n'), 'utf8'); return `Exported transcript to ${path}` }
  const listModels = () => modelEntries.length ? modelEntries.map((model, index) => `${model.id === footer.model ? '▸ ' : '  '}${index + 1}. ${model.id}${model.name ? ` — ${model.name}` : ''}`).join('\n') : `Current model: ${footer.model}`
  const commandContext = () => ({
    cwd, clearConversation: () => { engine.clearConversation(); setTranscript([entry('banner', '')]); setTranscriptKey(key => key + 1) }, compact: () => engine.compactNow(), getModel: () => footer.model, setModel: (id: string) => engine.setModel(id), listModels, getConfigSummary: () => `baseURL: ${config.baseURL}\napiKey: ${redactApiKey(config.apiKey)}\nmodel: ${footer.model}\nsmallModel: ${config.smallModel}\nmaxOutputTokens: ${config.maxOutputTokens}`, getCostSummary: () => formatTotalCost(costTracker), listSkills: undefined, getMemoryPrompt: () => loadMemoryPrompt(cwd), extractMemories: () => engine.extractMemories(), listHooks: () => 'Hooks are loaded from project settings.', listSessions: () => listSessions(cwd).slice(0, 20).map(session => `${session.id}  ${session.messageCount} msgs  ${new Date(session.updatedAt).toLocaleString()}`).join('\n') || 'No sessions found', resumeSession: (id: string) => { const result = engine.resumeSession(id); if (result) rebuildTranscript(); return result }, exportTranscript, enterPlanMode: () => engine.enterPlanMode(), isPlanMode: () => engine.isPlanMode(), setPermissionMode: (mode: 'default'|'auto'|'bypassPermissions') => engine.setPermissionMode(mode), getPermissionMode: () => engine.getPermissionMode(), newConversation: () => { engine.newConversation(); setTranscript([entry('banner', '')]); setTranscriptKey(key => key + 1) }, openHistory: showHistory,
  })

  const runQuery = async (prompt: string) => {
    setLoading(true); setStreamingText(''); setActivity('thinking'); append({ role: 'user', text: prompt })
    try {
      const result = await engine.submitMessage(prompt, { onTextDelta: text => { setStreamingText(value => value + text); setActivity('writing'); forceRefresh(value => value + 1) }, onToolStart: (name, value) => { setStreamingText(''); setActivity(`running ${toolLabel(name, value)}`); append({ role: 'tool', text: `▶ ${name}: ${toolLabel(name, value)}`, toolName: name }) }, onToolEnd: (name, value, _result, isError) => { setActivity('thinking'); append({ role: 'tool', text: `${isError ? '✗' : '✓'} ${name}: ${toolLabel(name, value)}`, toolName: name }) }, onUsage: () => forceRefresh(value => value + 1), onPlanPresented: plan => { setPendingPlan(plan); return new Promise<boolean>(resolve => { planResolver.current = resolve }) } })
      const finalText = contentText(result.messages[result.messages.length - 1]?.content ?? '') || engine.getFinalText()
      if (finalText) append({ role: 'assistant', text: finalText })
      if (result.reason === 'error') append({ role: 'assistant', text: `Error: ${result.error ?? 'unknown error'}` })
    } catch (error) { append({ role: 'assistant', text: `Error: ${error instanceof Error ? error.message : String(error)}` }) }
    finally { setLoading(false); setStreamingText(''); setActivity('thinking'); forceRefresh(value => value + 1) }
  }
  const submit = async (submittedPrompt?: string) => {
    const prompt = (submittedPrompt ?? input).trim(); if (!prompt) return
    setHistory(values => [...values, prompt]); setHistoryIdx(-1); setInput(''); setCursor(0)
    if (loading) { if (prompt === '/stop') engine.interrupt(); else if (prompt.startsWith('/')) { setDeferredCommand(prompt); append({ role: 'tool', text: `(busy — ${prompt} deferred until idle)` }) } else { engine.enqueueUserMessage(prompt); append({ role: 'tool', text: '(queued — will be sent on the next turn)' }) }; return }
    if (/^(exit|quit)$/i.test(prompt) || prompt === '/exit') { await engine.shutdown(); exit(); return }
    if (prompt.startsWith('/')) { const [name, ...parts] = prompt.slice(1).split(/\s+/); if (name === 'history') { showHistory(); return }; if (name === 'model' && parts.length === 0 && modelEntries.length) { setModelSelectIdx(Math.max(0, modelEntries.findIndex(model => model.id === footer.model))); return }; const command = getBuiltinCommands().find(item => item.name === name); if (command?.run) { const result = await command.run(parts.join(' '), commandContext()); if (result.kind === 'message') append({ role: 'assistant', text: contentText(result.message.content) }); if (result.kind === 'action' && result.action === 'exit') { await engine.shutdown(); exit() }; return } if (command?.buildPrompt) { await runQuery(command.buildPrompt(parts.join(' '), commandContext())); return } }
    await runQuery(prompt)
  }
  useEffect(() => { if (!loading && deferredCommand) { const next = deferredCommand; setDeferredCommand(null); void submit(next) } }, [loading, deferredCommand])
  useInput((value, key) => {
    if (pendingPerm) { if (value.toLowerCase() === 'y') resolvePermission(true); else if (value.toLowerCase() === 'n' || key.escape) resolvePermission(false); return }
    if (pendingPlan) { if (value.toLowerCase() === 'y') resolvePlan(true); else if (value.toLowerCase() === 'n' || key.escape) resolvePlan(false); return }
    if (modelSelectIdx !== null) { if (key.upArrow) setModelSelectIdx(index => index === null ? null : (index - 1 + modelEntries.length) % modelEntries.length); else if (key.downArrow) setModelSelectIdx(index => index === null ? null : (index + 1) % modelEntries.length); else if (key.return) { const model = modelEntries[modelSelectIdx]; if (model) { engine.setModel(model.id); append({ role: 'assistant', text: `Model switched to ${model.id}` }); forceRefresh(value => value + 1) }; setModelSelectIdx(null) } else if (key.escape || (key.ctrl && value === 'c')) setModelSelectIdx(null); return }
    if (historySelect) { const length = historySelect.sessions.length; if (!length) { if (key.escape || key.return) setHistorySelect(null); return }; if (key.upArrow) setHistorySelect(state => state ? { ...state, idx: (state.idx - 1 + length) % length } : state); else if (key.downArrow) setHistorySelect(state => state ? { ...state, idx: (state.idx + 1) % length } : state); else if (key.return) { const session = historySelect.sessions[historySelect.idx]; if (session) { engine.resumeSession(session.id); rebuildTranscript(); append({ role: 'assistant', text: `Resumed session ${session.id} (${session.messageCount} messages).` }) }; setHistorySelect(null) } else if (key.escape || (key.ctrl && value === 'c')) setHistorySelect(null); return }
    if (key.escape && loading) { engine.interrupt(); append({ role: 'tool', text: '(stopped)' }); return }
    if (key.ctrl && value === 'c') { if (loading) { engine.interrupt(); append({ role: 'tool', text: '(stopped)' }); return }; const now = Date.now(); const last = (globalThis as { __harnessLastCtrlC?: number }).__harnessLastCtrlC ?? 0; if (now - last < 1500) { void engine.shutdown().finally(exit); return }; (globalThis as { __harnessLastCtrlC?: number }).__harnessLastCtrlC = now; append({ role: 'tool', text: 'Press Ctrl+C again to exit.' }); return }
    if (key.return) { void submit(); return }
    if (key.leftArrow) { setCursor(Math.max(0, cursorRef.current - 1)); return }
    if (key.rightArrow) { setCursor(Math.min([...input].length, cursorRef.current + 1)); return }
    if (key.upArrow && history.length) { const index = historyIdx === -1 ? history.length - 1 : Math.max(0, historyIdx - 1); setHistoryIdx(index); setInput(history[index] ?? ''); setCursor([...(history[index] ?? '')].length); return }
    if (key.downArrow && historyIdx !== -1) { const index = historyIdx + 1; setHistoryIdx(index >= history.length ? -1 : index); setInput(index >= history.length ? '' : history[index] ?? ''); setCursor(index >= history.length ? 0 : [...(history[index] ?? '')].length); return }
    if (key.backspace || key.delete) { const position = cursorRef.current; if (position > 0) { const chars = [...input]; chars.splice(position - 1, 1); setInput(chars.join('')); setCursor(position - 1) }; return }
    if (value && !key.ctrl && !key.meta && value !== '\r') { const chars = [...input]; chars.splice(cursorRef.current, 0, ...[...value]); setInput(chars.join('')); setCursor(cursorRef.current + [...value].length) }
  })

  const done = todos.todos.filter(todo => todo.status === 'completed').length
  const barColor = footer.pct >= 80 ? 'red' : footer.pct >= 50 ? 'yellow' : 'cyan'
  return <Box flexDirection="column">
    <Static key={transcriptKey} items={transcript}>{(item) => <Box key={item.id} flexDirection="column">{item.role === 'banner' && BANNER.map((line, index) => <Text key={index} color="cyan">{line}</Text>)}{item.role === 'user' && <Text color="green">❯ {item.text}</Text>}{item.role === 'assistant' && <Text color="cyan">{item.text}</Text>}{item.role === 'tool' && <Text dimColor>{item.text}</Text>}</Box>}</Static>
    <Text dimColor>cwd: {cwd}  ·  /help for commands  ·  Esc/Ctrl+C stop  ·  Ctrl+C×2 exit</Text>
    {pendingPerm && <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}><Text bold color="magenta">Permission requested: {pendingPerm.tool}</Text><Text dimColor>{pendingPerm.reason}</Text><Text bold color="green">Allow? [y] yes / [n] no</Text></Box>}
    {pendingPlan && <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}><Text bold color="yellow">Proposed plan</Text><Text>{pendingPlan}</Text><Text bold color="green">Approve? [y] yes / [n] no</Text></Box>}
    {modelSelectIdx !== null && <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}><Text bold color="cyan">Select model · ↑/↓ move · Enter confirm · Esc cancel</Text>{modelEntries.map((model, index) => <Text key={model.id} color={index === modelSelectIdx ? 'cyan' : undefined} bold={index === modelSelectIdx}>{index === modelSelectIdx ? '❯' : ' '} {model.id}{model.name ? ` — ${model.name}` : ''}</Text>)}</Box>}
    {historySelect && <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}><Text bold color="magenta">Session history · ↑/↓ move · Enter resume · Esc cancel</Text>{historySelect.sessions.map((session, index) => <Text key={session.id} color={index === historySelect.idx ? 'magenta' : undefined} bold={index === historySelect.idx}>{index === historySelect.idx ? '❯' : ' '} {session.id} · {session.messageCount} msgs · {new Date(session.updatedAt).toLocaleString()}</Text>)}</Box>}
    {todos.todos.length > 0 && todos.todos.some(todo => todo.status !== 'completed') && <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1}><Text bold color="blue">Todos ({done}/{todos.todos.length})</Text>{todos.todos.map((todo, index) => <Text key={`${todo.content}-${index}`} color={todo.status === 'completed' ? 'gray' : todo.status === 'in_progress' ? 'cyan' : undefined}>{todo.status === 'completed' ? '  ✓ ' : todo.status === 'in_progress' ? '  ▶ ' : '  · '}{todo.activeForm || todo.content}</Text>)}</Box>}
    <Newline />
    <Box flexDirection="column">{streamingText && <Text color="cyan">{streamingText}</Text>}{loading && !streamingText && <Text dimColor>{SPINNER_FRAMES[spinnerFrame]} {activity}…</Text>}</Box>
    <Text><Text color="blue">❯ </Text>{[...input].slice(0, cursorPos).join('')}<Text color="blue">▋</Text>{[...input].slice(cursorPos).join('')}</Text>
    <Box flexDirection="row"><Text color={barColor}>{renderBar(footer.pct, ringFrame)}</Text><Text dimColor>  ctx: {footer.ctxK}/{footer.winK} ({footer.pct}%) · {footer.model} · {footer.mode}{engine.isPlanMode() ? ' · plan' : ''} · {footer.total}</Text></Box>
  </Box>
}
export function launchRepl(engine: QueryEngine, cwd: string, costTracker: UsageTracker, config: ApiConfig, permAskHolder?: AppProps['permAskHolder']): void { void import('ink').then(({ render }) => render(<App engine={engine} cwd={cwd} costTracker={costTracker} config={config} permAskHolder={permAskHolder} />, { exitOnCtrlC: false })) }
