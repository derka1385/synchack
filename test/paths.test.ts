import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanPath, ignoreRules } from '../shared/paths.ts'

test('cleanPath rejects anything that could leave the project', () => {
  for (const bad of ['', '/etc/passwd', '../x', 'a/../../b', 'a//b', 'a/', './a', '.git/config', 'sub/.git/HEAD', '.synchack/tmp/x', 'a\0b', 5, null])
    assert.throws(() => cleanPath(bad), String(bad))
  assert.equal(cleanPath('src/App.tsx'), 'src/App.tsx')
  assert.equal(cleanPath('my file.txt'), 'my file.txt')
  assert.equal(cleanPath('docs/ré sumé 日本語.md'.normalize('NFD')), 'docs/ré sumé 日本語.md'.normalize('NFC'))
})

test('default ignore rules', () => {
  const ig = ignoreRules()
  for (const p of ['node_modules/a/b.js', 'web/node_modules/x.js', '.env', '.env.local', 'api/.env', 'a.log', 'logs/x.log', 'dist/x.js', 'build/x', '.next/cache/x', 'coverage/lcov.info', '.DS_Store', 'sub/.DS_Store', 'certs/server.pem', 'id.key', '.git/HEAD', '.synchack/tmp/x', 'x.swp', 'notes.txt~'])
    assert.ok(ig(p), `${p} should be ignored`)
  for (const p of ['src/App.tsx', 'package.json', '.envrc', 'src/env.ts', 'docs/build.md', 'distance.ts', 'a.logic', 'keys.ts', 'build'])
    assert.ok(!ig(p), `${p} should sync`)
  assert.ok(ig('build', true))
})

test('.synchackignore rules', () => {
  const ig = ignoreRules('# team rules\nsecret/\n!.env.example\n/root-only.txt\n**/gen/**\n*.tmp\n!node_modules/keep.js\n')
  assert.ok(ig('secret/a.txt'))
  assert.ok(!ig('.env.example'))
  assert.ok(ig('.env'))
  assert.ok(ig('root-only.txt'))
  assert.ok(!ig('sub/root-only.txt'))
  assert.ok(ig('a/gen/b.ts'))
  assert.ok(ig('gen/x'))
  assert.ok(ig('x.tmp'))
  assert.ok(ig('node_modules/keep.js'), 'nothing inside an ignored folder can be re-included')
})
