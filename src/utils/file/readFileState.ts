import type { FileStateCache, ReadFileState } from '../../Tool.js'
export function createFileStateCache(): FileStateCache {
  const states = new Map<string, ReadFileState>()
  return {
    get: path => states.get(path),
    set: (path, state) => states.set(path, state),
    recordRead: (path, mtimeMs) => states.set(path, { mtimeMs, isFullRead: true }),
    clear: () => states.clear(),
  }
}
export function isFullRead(state: ReadFileState | undefined): boolean { return Boolean(state?.isFullRead || (state && state.offset === undefined && state.limit === undefined)) }
