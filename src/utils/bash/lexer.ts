import type { Token } from './types.js'
export function lex(source: string): Token[] {
  const tokens: Token[] = []; let i = 0
  while (i < source.length) {
    const start = i; const char = source[i]!
    if (/\s/.test(char)) { i++; continue }
    if (';&|<>'.includes(char)) { let value = char; i++; if (source[i] === char || (char === '>' && source[i] === '|') || (char === '&' && source[i] === '>')) value += source[i++]!; tokens.push({ type: 'operator', value, start, end: i }); continue }
    let value = ''; let quote = ''
    while (i < source.length) {
      const c = source[i]!
      if (quote) { value += c; i++; if (c === quote && source[i - 2] !== '\\') quote = ''; continue }
      if (c === "'" || c === '"') { quote = c; value += c; i++; continue }
      if (/\s/.test(c) || ';&|<>'.includes(c)) break
      if (c === '\\' && i + 1 < source.length) { value += source[i++]! + source[i++]!; continue }
      value += c; i++
    }
    if (value) tokens.push({ type: 'word', value, start, end: i })
  }
  return tokens
}
