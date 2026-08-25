import { lex } from './lexer.js'
import type { ProgramNode, SimpleCommandNode } from './types.js'
export class ParseError extends Error { constructor(message: string) { super(message); this.name = 'ParseError' } }
export function stripSafeWrappers(command: string): string {
  const parts = command.trim().split(/\s+/); const safeEnv = /^(LANG|LC_ALL|LC_CTYPE|PATH|TERM|HOME|USER)=/u
  while (parts.length && (['time','nice','nohup','command'].includes(parts[0]!) || safeEnv.test(parts[0]!))) parts.shift()
  if (parts[0] === 'timeout' || parts[0] === 'env') { parts.shift(); if (parts[0] && /^\d+(?:\.\d+)?[smhd]?$/.test(parts[0])) parts.shift() }
  return parts.join(' ')
}
export function parse(source: string): ProgramNode {
  if (source.length > 1_000_000) throw new ParseError('Node budget exceeded (too-complex)')
  const tokens = lex(source); const commands: SimpleCommandNode[] = []; let words: string[] = []; let redirects: string[] = []
  for (const token of tokens) {
    if (token.type === 'operator') {
      if (token.value === '>' || token.value === '>>' || token.value === '&>') redirects.push(token.value)
      if (words.length) { commands.push({ type: 'simple_command', words, redirects }); words = []; redirects = [] }
      if (![';', '&&', '||', '|'].includes(token.value)) throw new ParseError(`Unsupported operator: ${token.value}`)
    } else words.push(token.value.replace(/^(['"])(.*)\1$/s, '$2'))
  }
  if (words.length) commands.push({ type: 'simple_command', words, redirects })
  if (!commands.length) throw new ParseError('Empty command')
  return { type: 'program', source, commands, complex: /\b(if|for|while|case|function)\b|\$\(|<<|\{/.test(source) }
}
