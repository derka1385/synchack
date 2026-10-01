// Path canonicalisation (server validation, client writes) and ignore rules (client watching).

/** Never synced at any depth, whatever .synchackignore says. */
const HARD = new Set(['.git', '.synchack'])

/** Built-in rules. A project's .synchackignore adds to them and can `!re-include` them. */
export const DEFAULT_IGNORE = [
  'node_modules/',
  'dist/',
  'build/',
  '.next/',
  'coverage/',
  '*.log',
  '.DS_Store',
  // secrets stay on the machine that has them
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  // OS and editor litter
  '._*',
  '*.swp',
  '*~',
]

/**
 * A name as macOS compares it: APFS and HFS+ ignore case, and HFS+ also ignores invisible
 * characters such as U+200C, so ".GIT" and ".g\u200cit" are the folder ".git" on a Mac.
 */
const fold = (name: string) => name.normalize('NFC').replace(/\p{Default_Ignorable_Code_Point}/gu, '').toLowerCase()
const hard = (name: string) => HARD.has(fold(name))

/** Canonical relative POSIX path in NFC, or throws. The result cannot climb out of a root. */
export function cleanPath(p: unknown): string {
  if (typeof p !== 'string') throw new Error('path must be a string')
  const n = p.normalize('NFC')
  const parts = n.split('/')
  // control characters: no real file needs them, and they could forge lines in logs and the TUI
  if (n.length > 1024 || /[\x00-\x1f\x7f]/.test(n) || parts.some(s => s === '' || s === '.' || s === '..' || hard(s)))
    throw new Error(`invalid path ${JSON.stringify(p)}`)
  return n
}

/** Whether the absolute path `real` (already symlink-resolved) is `root` or inside it. */
export const within = (root: string, real: string) => real === root || real.startsWith(root.endsWith('/') ? root : root + '/')

/**
 * A safe folder name for a project name chosen on another Mac: one plain path segment that is
 * not hidden, so it can't be "..", "~/.ssh" or a path. Falls back to "project".
 */
export function folderName(name: string) {
  const n = name.normalize('NFC').replace(/[\x00-\x1f\x7f/:\\]/g, '-').replace(/^[\s.]+/, '').trim().slice(0, 100).trim()
  return n || 'project'
}

export type Ignore = (path: string, isDir?: boolean) => boolean

/**
 * A gitignore subset: `*` `**` `?` globs, trailing `/` = directories only, any other `/`
 * anchors to the project root, `!` re-includes, the last matching rule wins, and nothing
 * inside an ignored directory can be re-included (same as git).
 */
export function ignoreRules(text = ''): Ignore {
  const rules = [...DEFAULT_IGNORE, ...text.split('\n')]
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(compile)
  const hit = (s: string) => rules.reduce((ignored, r) => (r.re.test(s) ? !r.neg : ignored), false)
  return (path, isDir = false) => {
    const parts = path.split('/')
    if (parts.some(hard)) return true
    for (let i = 1; i <= parts.length; i++)
      if (hit(parts.slice(0, i).join('/') + (i < parts.length || isDir ? '/' : ''))) return true
    return false
  }
}

const GLOB: Record<string, string> = { '**/': '(.*/)?', '/**': '/.*', '**': '.*', '*': '[^/]*', '?': '[^/]' }

function compile(line: string) {
  const neg = line.startsWith('!')
  if (neg) line = line.slice(1)
  const dirOnly = line.endsWith('/')
  if (dirOnly) line = line.slice(0, -1)
  const anchored = line.includes('/')
  if (line.startsWith('/')) line = line.slice(1)
  const body = line.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/|\/\*\*$|\*\*|\*|\?/g, t => GLOB[t])
  // tested against one path prefix at a time; directories carry a trailing '/'
  return { neg, re: new RegExp(`${anchored ? '^' : '(^|/)'}${body}${dirOnly ? '/$' : '/?$'}`) }
}
