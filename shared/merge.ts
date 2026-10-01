// Line-based three-way merge (diff3) for text files. Pure functions, no I/O.

const MAX_TEXT = 4 * 1024 * 1024 // larger files count as binary: never auto-merged
const MAX_EDITS = 2000 // Myers search depth; past it we report a conflict instead of burning memory

/** UTF-8 without NUL bytes. Anything else is binary and is never text-merged. */
export function isText(bytes: Uint8Array): boolean {
  if (bytes.length > MAX_TEXT || bytes.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/** Keeps a BOM, so decode → merge → encode round-trips byte for byte. */
export const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)

const lines = (s: string) => (s === '' ? [] : s.split(/(?<=\n)/)) // each line keeps its ending
const same = (x: string[], y: string[]) => x.length === y.length && x.every((l, i) => l === y[i])
const block = (l: string[]) => (l.length && !l[l.length - 1].endsWith('\n') ? [...l, '\n'] : l)

export interface Merged {
  text: string
  conflicts: number
}

/**
 * diff3: base lines that both sides kept are sync points. Between two sync points, take the
 * side that changed. Both sides changing the same stretch differently (adjacent lines
 * included) is a conflict, written out with git-style markers.
 */
export function merge3(base: string, ours: string, theirs: string, labels = ['ours', 'theirs']): Merged {
  const o = lines(base), a = lines(ours), b = lines(theirs)
  const ma = lcs(o, a), mb = lcs(o, b)
  const out: string[] = []
  let conflicts = 0, i = 0, ia = 0, ib = 0
  const region = (ei: number, ea: number, eb: number) => {
    const O = o.slice(i, ei), A = a.slice(ia, ea), B = b.slice(ib, eb)
    if (same(A, O)) out.push(...B)
    else if (same(B, O) || same(A, B)) out.push(...A)
    else {
      conflicts++
      out.push(`<<<<<<< ${labels[0]}\n`, ...block(A), '||||||| base\n', ...block(O), '=======\n', ...block(B), `>>>>>>> ${labels[1]}\n`)
    }
  }
  for (let k = 0; k < o.length; k++) {
    if (ma[k] < 0 || mb[k] < 0) continue
    region(k, ma[k], mb[k])
    out.push(o[k])
    i = k + 1
    ia = ma[k] + 1
    ib = mb[k] + 1
  }
  region(o.length, a.length, b.length)
  return { text: out.join(''), conflicts }
}

/**
 * For each line of x, the index of its partner in y along a shortest edit script, or -1.
 * Myers O((N+M)·D), with moves kept inside the edit grid so the search can't end off it.
 */
export function lcs(x: string[], y: string[]): Int32Array {
  const n = x.length, m = y.length, off = n + m + 1
  const v = new Int32Array(2 * off + 1).fill(-1) // v[off+k] = furthest x on diagonal k, -1 = unreachable
  const trace: Int32Array[] = [] // v as it stood before each round, diagonals -d-1..d+1
  // where an edit onto diagonal k lands in round d: [diagonal it came from, x], x = -1 if none
  const step = (at: (k: number) => number, k: number, d: number): [number, number] => {
    const down = k < d ? at(k + 1) : -1 // insert a line of y
    const right = k > -d && at(k - 1) >= 0 ? at(k - 1) + 1 : -1 // delete a line of x
    const okDown = down >= 0 && down - k <= m, okRight = right >= 0 && right <= n
    if (okDown && (!okRight || down >= right)) return [k + 1, down]
    return okRight ? [k - 1, right] : [0, -1]
  }
  let d = 0
  search: for (; ; d++) {
    if (d > MAX_EDITS) throw new Error('diff too large to merge safely')
    trace.push(v.slice(off - d - 1, off + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let px = d === 0 ? 0 : step(j => v[off + j], k, d)[1]
      if (px < 0) {
        v[off + k] = -1
        continue
      }
      let py = px - k
      while (px < n && py < m && x[px] === y[py]) px++, py++
      v[off + k] = px
      if (px === n && py === m) break search
    }
  }
  const res = new Int32Array(n).fill(-1)
  let px = n, py = m
  for (; d > 0; d--) {
    const t = trace[d], at = (k: number) => t[k + d + 1]
    const [pk, sx] = step(at, px - py, d)
    while (px > sx) res[--px] = --py // walk the snake back to where the edit landed
    px = at(pk)
    py = px - pk
  }
  while (px > 0) res[--px] = --py
  return res
}
