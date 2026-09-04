/**
 * Unit tests for the pure WSL helpers in src/wsl-util.ts (compiled to
 * lib/wsl-util.js). Plain Node `assert`-based — no framework — so it runs
 * anywhere: `node test/wsl-util.test.mjs`.
 */
import assert from 'node:assert/strict'
import {
  shellQuote,
  isWslUnc,
  toWslPath,
  distroOf,
  wslArgv,
  buildScript,
  resolveWorkdir,
  readWindowCmd,
  grepCmd,
  DEFAULT_DISTRO,
} from '../lib/wsl-util.js'

let passed = 0
const ok = (name, fn) => { fn(); passed++; console.log('  ok  ' + name) }

console.log('== shellQuote ==')
ok('quotes a plain value', () => assert.equal(shellQuote('abc'), "'abc'"))
ok('escapes embedded single quotes', () => assert.equal(shellQuote("a'b"), "'a'\\''b'"))

console.log('== isWslUnc ==')
ok('matches \\\\wsl.localhost\\<distro>\\...', () => assert.equal(isWslUnc('\\\\wsl.localhost\\Ubuntu-22.04\\home\\x'), true))
ok('matches \\\\wsl$\\<distro>\\...', () => assert.equal(isWslUnc('\\\\wsl$\\Ubuntu\\home\\x'), true))
ok('rejects a normal Windows path', () => assert.equal(isWslUnc('C:\\Users\\crack'), false))
ok('accepts forward-slash variant', () => assert.equal(isWslUnc('//wsl.localhost/Ubuntu-22.04/home/x'), true))

console.log('== toWslPath ==')
ok('translates UNC to /<distro>/<inside>', () => assert.equal(toWslPath('\\\\wsl.localhost\\Ubuntu-22.04\\home\\crack\\work'), '/home/crack/work'))
ok('keeps a bare linux path unchanged', () => assert.equal(toWslPath('/home/crack/work'), '/home/crack/work'))
ok('empty → "/"', () => assert.equal(toWslPath(''), '/'))

console.log('== distroOf ==')
ok('distro from UNC share', () => assert.equal(distroOf('\\\\wsl.localhost\\Ubuntu-22.04\\home', ''), 'Ubuntu-22.04'))
ok('distro from wsl$ share', () => assert.equal(distroOf('\\\\wsl$\\Ubuntu\\home', ''), 'Ubuntu'))
ok('falls back to configured distro', () => assert.equal(distroOf('C:\\x', 'my-distro'), 'my-distro'))
ok('falls back to DEFAULT_DISTRO', () => assert.equal(distroOf(undefined, ''), DEFAULT_DISTRO))

console.log('== wslArgv ==')
ok('builds wsl.exe argv', () => assert.deepEqual(
  wslArgv('Ubuntu-22.04', '/home', 'export A=1', 'pwd'),
  ['wsl.exe', '-d', 'Ubuntu-22.04', '--cd', '/home', '--exec', 'bash', '-lc', 'export A=1\npwd'],
))

console.log('== buildScript ==')
ok('exports valid keys with quoting', () => assert.equal(
  buildScript({ FOO: 'a b', _X: "it's", 'BAD-KEY': 'x', '': 'y' }),
  "export FOO='a b'\nexport _X='it'\\''s'",
))

console.log('== resolveWorkdir ==')
ok('win32 absolute passthrough', () => assert.equal(resolveWorkdir('C:\\abc', 'D:\\ws'), 'C:\\abc'))
ok('relative joins on session cwd', () => assert.equal(resolveWorkdir('sub', 'C:\\ws\\root'), 'C:\\ws\\root\\sub'))
ok('absent returns session cwd', () => assert.equal(resolveWorkdir(undefined, 'C:\\ws'), 'C:\\ws'))

console.log('== readWindowCmd ==')
ok('defaults to whole file (window 1-)', () => assert.match(
  readWindowCmd('/tmp/a b.txt'),
  /awk 'NR>=1&&NR<=9007199254740991/,
))
ok('carries offset/limit into awk window', () => assert.match(
  readWindowCmd('/tmp/x', 5, 20),
  /awk 'NR>=5&&NR<=24/,
))
ok('shell-quotes the path', () => assert.match(readWindowCmd("/tmp/it's"), /\[ ! -f '\/tmp\/it'\\''s' \]/))
ok('emits line-count footer', () => assert.match(
  readWindowCmd('/tmp/x', 1, 10),
  /WC=\$\(wc -l < '\/tmp\/x'\)/,
))

console.log('== grepCmd ==')
ok('prefers rg with grep fallback', () => assert.match(
  grepCmd('TODO'),
  /command -v rg.*&& rg -n --no-heading 'TODO' '\.' \|\| grep -RnE 'TODO' '\.'/,
))
ok('maps include to rg --glob and grep --include', () => assert.match(
  grepCmd('x', '/src', '*.ts'),
  /--glob '\*\.ts'/,
))
ok('shell-quotes path argument', () => assert.match(
  grepCmd('x', '/a b'),
  / '\/a b' \|\| grep -RnE 'x' '\/a b'/,
))

console.log(`\n${passed} assertions passed`)