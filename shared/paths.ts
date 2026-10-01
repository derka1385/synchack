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

/** Canonical relative POSIX path in NFC, or throws. The result cannot climb out of a root. */
export function cleanPath(p: unknown): string {
  if (typeof p !== 'string') throw new Error('path must be a string')
  const n = p.normalize('NFC')
  const parts = n.split('/')
  if (n.length > 1024 || n.includes('\0') || parts.some(s => s === '' || s === '.' || s === '..' || HARD.has(s)))
    throw new Error(`invalid path ${JSON.stringify(p)}`)
  return n
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
    if (parts.some(s => HARD.has(s))) return true
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
