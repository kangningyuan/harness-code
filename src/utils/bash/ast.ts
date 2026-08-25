import { parse, ParseError, stripSafeWrappers } from './bashParser.js'
import type { SafetyVerdict } from './types.js'
const READ_ONLY_COMMANDS = new Set(['ls','cat','head','tail','grep','egrep','fgrep','rg','find','wc','stat','file','echo','printf','pwd','whoami','date','env','printenv','which','type','uname','df','du','ps','top','node','rustc','gcc'])
const READ_ONLY_GIT = new Set(['status','log','diff','branch','show','remote','rev-parse','ls-files','blame'])
function hasUnmatchedQuote(command: string): boolean { let quote = ''; for (let index = 0; index < command.length; index++) { const char = command[index]; if (char === '\\') { index++; continue }; if (quote) { if (char === quote) quote = ''; continue }; if (char === "'" || char === '"') quote = char }; return Boolean(quote) }
export function analyzeBashSafety(command: string): SafetyVerdict {
  if (/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/.test(command)) return { ok: false, reason: 'Control characters are not allowed', code: 'control-chars' }
  if (hasUnmatchedQuote(command)) return { ok: false, reason: 'Unmatched quote', code: 'parse-error' }
  if (/\\[ \t]/.test(command)) return { ok: false, reason: 'Backslash-space is ambiguous', code: 'backslash-space' }
  if (/~\[|(^|\s)=\w/.test(command)) return { ok: false, reason: 'Dynamic zsh expansion', code: 'zsh-dynamic' }
  if (/\bIFS\s*=/.test(command)) return { ok: false, reason: 'IFS assignment', code: 'ifs-assignment' }
  if (/\bPS4\s*=/.test(command) && !/^[-\w\s.:/_+$(){}'"-]*$/.test(command)) return { ok: false, reason: 'Unsafe PS4 assignment', code: 'ps4-assignment' }
  if (/\bdeclare\s+-[niaA]/.test(command)) return { ok: false, reason: 'Unsafe declare flags', code: 'declare-flags' }
  if (/(^|[\s=(|;&])\$(?:@|\*|\{[^}]+\[(?:@|\*)\]\})(?=$|[\s|;&])/.test(command)) return { ok: false, reason: 'Unquoted variable may undergo word splitting or globbing', code: 'bare-var-ifs' }
  if (/\$\{[A-Za-z_]\w*:-\}(?:\s|$)/.test(command)) return { ok: false, reason: 'Empty variable used as a bare argument', code: 'empty-var-bare' }
  if (/\$\(\([^)]*[A-Za-z_][^)]*\)\)/.test(command)) return { ok: false, reason: 'Arithmetic injection', code: 'arithmetic-injection' }
  if (/<<\s*[^'"\s]/.test(command)) return { ok: false, reason: 'Unquoted heredoc', code: 'unquoted-heredoc' }
  if (/\bread\s+[^;&|]+(?:\|\||&&|\|)/.test(command)) return { ok: false, reason: 'read in conditional or pipeline', code: 'read-in-conditional' }
  try {
    const program = parse(stripSafeWrappers(command))
    if (program.complex) return { ok: false, reason: 'Unsupported complex shell construct', code: 'too-complex' }
    const argv = program.commands.map(item => item.words)
    if (argv.some(words => words.some(word => /^\$\([^)]*\)$/.test(word)))) return { ok: false, reason: 'Standalone command substitution', code: 'standalone-cmdsub' }
    return { ok: true, argv, commands: argv.map(words => words[0] ?? '') }
  } catch (error) { return { ok: false, reason: error instanceof ParseError ? error.message : String(error), code: 'parse-error' }
  }
}
export function isReadOnlyCommand(command: string): boolean {
  const verdict = analyzeBashSafety(command); if (!verdict.ok || />|>>|&>/.test(command)) return false
  return verdict.argv.every(argv => { const name = argv[0] ?? ''; return name === 'git' ? READ_ONLY_GIT.has(argv[1] ?? '') : READ_ONLY_COMMANDS.has(name) })
}
