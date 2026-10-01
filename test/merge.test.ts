import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decode, isText, lcs, merge3 } from '../shared/merge.ts'

const L = (...xs: string[]) => xs.map(x => x + '\n').join('')
const rng = (seed: number) => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000

function lcsLength(x: string[], y: string[]) {
  const t = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0))
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1])
  return t[0][0]
}

test('lcs matches a longest common subsequence (5000 random cases vs DP)', () => {
  const r = rng(7)
  const gen = () => Array.from({ length: Math.floor(r() * 14) }, () => 'abc'[Math.floor(r() * 3)])
  for (let round = 0; round < 5000; round++) {
    const x = gen(), y = gen()
    let last = -1, count = 0
    lcs(x, y).forEach((j, i) => {
      if (j < 0) return
      assert.ok(j > last, 'matches must be increasing')
      assert.equal(x[i], y[j])
      last = j
      count++
    })
    assert.equal(count, lcsLength(x, y), `${x.join('')} vs ${y.join('')}`)
  }
})

test('merge3 identities on random texts', () => {
  const r = rng(11)
  const gen = () => Array.from({ length: Math.floor(r() * 10) }, () => 'xyz'[Math.floor(r() * 3)] + '\n').join('')
  for (let round = 0; round < 2000; round++) {
    const o = gen(), a = gen()
    assert.deepEqual(merge3(o, a, o), { text: a, conflicts: 0 })
    assert.deepEqual(merge3(o, o, a), { text: a, conflicts: 0 })
    assert.deepEqual(merge3(o, a, a), { text: a, conflicts: 0 })
  }
})

test('independent edits merge; overlapping or adjacent ones conflict', () => {
  const base = L('1', '2', '3', '4', '5', '6', '7')
  assert.deepEqual(merge3(base, L('1', '2 ours', '3', '4', '5', '6', '7'), L('1', '2', '3', '4', '5', '6 theirs', '7')), {
    text: L('1', '2 ours', '3', '4', '5', '6 theirs', '7'),
    conflicts: 0,
  })
  const clash = merge3(base, L('1', 'X', '3', '4', '5', '6', '7'), L('1', 'Y', '3', '4', '5', '6', '7'))
  assert.equal(clash.conflicts, 1)
  assert.equal(clash.text, L('1', '<<<<<<< ours', 'X', '||||||| base', '2', '=======', 'Y', '>>>>>>> theirs', '3', '4', '5', '6', '7'))
  assert.equal(merge3(base, L('1', '2a', '3', '4', '5', '6', '7'), L('1', '2', '3b', '4', '5', '6', '7')).conflicts, 1, 'adjacent')
  assert.equal(merge3(base, L('1', '3', '4', '5', '6', '7'), L('1', '3', '4', '5', '6', '7')).conflicts, 0, 'same delete')
  assert.deepEqual(merge3(base, L('0', '1', '2', '3', '4', '5', '6', '7'), L('1', '2', '3', '4', '5', '6', '7', '8')), {
    text: L('0', '1', '2', '3', '4', '5', '6', '7', '8'),
    conflicts: 0,
  })
  assert.equal(merge3(L('a', 'b'), L('a', 'x', 'b'), L('a', 'y', 'b')).conflicts, 1, 'insert at the same spot')
  assert.equal(merge3(L('a'), L('a', 'x'), L('a', 'y')).conflicts, 1, 'both appended')
  assert.equal(merge3('', 'x\n', 'y\n').conflicts, 1, 'both created')
  assert.deepEqual(merge3('', 'x\n', 'x\n'), { text: 'x\n', conflicts: 0 })
})

test('CRLF, BOM and a missing final newline round-trip', () => {
  const base = '﻿a\r\nb\r\nc\r\nd'
  assert.deepEqual(merge3(base, '﻿a\r\nB\r\nc\r\nd', '﻿a\r\nb\r\nc\r\nd!'), { text: '﻿a\r\nB\r\nc\r\nd!', conflicts: 0 })
  assert.equal(decode(Buffer.from('﻿hi')), '﻿hi')
})

test('large files with spread-out edits still merge quickly', () => {
  const base = Array.from({ length: 20000 }, (_, i) => `line ${i}`)
  const ours = base.slice(), theirs = base.slice()
  ours[100] = 'ours 100'
  ours[19000] = 'ours 19000'
  theirs[10000] = 'theirs 10000'
  const t0 = performance.now()
  const r = merge3(L(...base), L(...ours), L(...theirs))
  assert.equal(r.conflicts, 0)
  assert.equal(r.text, L(...base.map((l, i) => (i === 100 ? 'ours 100' : i === 19000 ? 'ours 19000' : i === 10000 ? 'theirs 10000' : l))))
  assert.ok(performance.now() - t0 < 2000)
})

test('binary detection', () => {
  assert.ok(isText(Buffer.from('plain text ✓\n')))
  assert.ok(!isText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])))
  assert.ok(!isText(Buffer.from([0x61, 0xff, 0x62])))
})
