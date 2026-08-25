export interface Token { type: string; value: string; start: number; end: number }
export interface SimpleCommandNode { type: 'simple_command'; words: string[]; redirects?: string[] }
export interface ProgramNode { type: 'program'; source: string; commands: SimpleCommandNode[]; complex?: boolean }
export type SafetyFailureCode = 'too-complex'|'control-chars'|'ifs-assignment'|'ps4-assignment'|'declare-flags'|'bare-var-ifs'|'empty-var-bare'|'arithmetic-injection'|'unquoted-heredoc'|'standalone-cmdsub'|'read-in-conditional'|'parse-error'|'zsh-dynamic'|'backslash-space'
export type SafetyVerdict = { ok: true; argv: string[][]; commands: string[] } | { ok: false; reason: string; code: SafetyFailureCode }
