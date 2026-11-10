/**
 * Tests for the installer's pure planning logic: argument parsing, home and
 * token resolution, URL derivation, content hashing, and shell rendering.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PACKAGE_DIRS, STAGE_SUITE_DIR, SUITE_NAME, UsageError, asUninstall, defaultTokenFile, defaultVerifyUrl,
  expandHome, hostForUrl, isLoopbackHost, isWildcardHost, packagesRootFor, parseArgs, shellQuote,
  stageDirFor, stageRootForSpec, suiteSpecFor, toShell, treeHash, usage,
} from '../scripts/lib/plan.mjs'

const ENV = { HOME: '/Users/tester' }

test('defaults target the desktop profile and port 3443', () => {
  const plan = parseArgs([], ENV)
  assert.equal(plan.profile, 'desktop')
  assert.equal(plan.dshHome, '/Users/tester/.dsh')
  assert.equal(plan.profileDir, '/Users/tester/.dsh/profiles/desktop')
  assert.equal(plan.host, '0.0.0.0')
  assert.equal(plan.port, 3443)
  assert.equal(plan.pathPrefix, '/remote-api')
  assert.equal(plan.tokenFile, '/Users/tester/.dsh/remote/token')
  assert.equal(plan.verifyUrl, 'http://127.0.0.1:3443')
  assert.equal(plan.waitSeconds, 30)
  assert.equal(plan.mode, 'install')
  assert.equal(plan.help, false)
})

test('environment values seed the plan and flags override them', () => {
  const plan = parseArgs(
    ['--profile', 'web', '--port', '8443', '--host', '192.168.1.5', '--wait', '90'],
    { ...ENV, DSH_HOME: '/tmp/home', DSH_PROFILE: 'tui' },
  )
  assert.equal(plan.dshHome, '/tmp/home')
  assert.equal(plan.profile, 'web')
  assert.equal(plan.port, 8443)
  assert.equal(plan.host, '192.168.1.5')
  assert.equal(plan.waitSeconds, 90)
  assert.equal(plan.verifyUrl, 'http://192.168.1.5:8443')
  assert.equal(plan.tokenFile, '/tmp/home/remote/token')
})

test('--flag=value form is accepted everywhere', () => {
  const plan = parseArgs(['--profile=rescue', '--dsh-home=/tmp/dsh', '--port=1234'], ENV)
  assert.equal(plan.profile, 'rescue')
  assert.equal(plan.dshHome, '/tmp/dsh')
  assert.equal(plan.port, 1234)
})

test('~ is expanded in the Harness home and token path', () => {
  assert.equal(expandHome('~/x', '/Users/tester'), '/Users/tester/x')
  assert.equal(expandHome('~', '/Users/tester'), '/Users/tester')
  assert.equal(expandHome('/abs', '/Users/tester'), '/abs')
  const plan = parseArgs(['--dsh-home', '~/harness', '--token-file', '~/tok'], ENV)
  assert.equal(plan.dshHome, '/Users/tester/harness')
  assert.equal(plan.tokenFile, '/Users/tester/tok')
})

test('an IPv6 listen host produces a bracketed verify URL', () => {
  const plan = parseArgs(['--host', '::1'], ENV)
  assert.equal(plan.verifyUrl, 'http://[::1]:3443')
  const wildcard = parseArgs(['--host', '::'], ENV)
  assert.equal(wildcard.verifyUrl, 'http://127.0.0.1:3443')
  assert.equal(defaultVerifyUrl('127.0.0.1', 3443), 'http://127.0.0.1:3443')
  assert.equal(hostForUrl('::1'), '[::1]')
  assert.equal(hostForUrl('[::1]'), '[::1]')
})

test('verification-only and uninstall switches are parsed', () => {
  assert.equal(parseArgs(['--verify-only'], ENV).verifyOnly, true)
  assert.equal(parseArgs(['--no-verify'], ENV).noVerify, true)
  assert.equal(parseArgs(['--restart'], ENV).restart, true)
  assert.equal(parseArgs(['--purge'], ENV).purge, true)
  assert.equal(asUninstall(parseArgs([], ENV)).mode, 'uninstall')
})

test('invalid input is rejected with a usage error', () => {
  for (const argv of [
    ['--port', '0'],
    ['--port', '70000'],
    ['--port', 'abc'],
    ['--profile', '../escape'],
    ['--profile'],
    ['--unknown'],
    ['--dsh-home', '/'],
    ['--wait', '601'],
    ['--verify-only', '--no-verify'],
    ['--verify-only', '--purge'],
  ]) {
    assert.throws(() => parseArgs(argv, ENV), UsageError, `expected ${argv.join(' ')} to be rejected`)
  }
})

test('host classification matches loopback and wildcard semantics', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true)
  assert.equal(isLoopbackHost('::1'), true)
  assert.equal(isLoopbackHost('localhost'), true)
  assert.equal(isLoopbackHost('192.168.1.5'), false)
  assert.equal(isWildcardHost('0.0.0.0'), true)
  assert.equal(isWildcardHost('::'), true)
  assert.equal(isWildcardHost('127.0.0.1'), false)
})

test('default token file lives under the Harness home', () => {
  assert.equal(defaultTokenFile('/Users/tester/.dsh'), '/Users/tester/.dsh/remote/token')
})

test('trailing slashes are stripped from a custom verify URL', () => {
  assert.equal(parseArgs(['--verify-url', 'http://[::1]:3443/'], ENV).verifyUrl, 'http://[::1]:3443')
})

test('content hashes are order independent and content sensitive', () => {
  const left = [{ path: 'b.txt', content: Buffer.from('two') }, { path: 'a.txt', content: Buffer.from('one') }]
  const right = [{ path: 'a.txt', content: Buffer.from('one') }, { path: 'b.txt', content: Buffer.from('two') }]
  assert.equal(treeHash(left), treeHash(right))
  const changed = [{ path: 'a.txt', content: Buffer.from('one') }, { path: 'b.txt', content: Buffer.from('three') }]
  assert.notEqual(treeHash(left), treeHash(changed))
  assert.match(treeHash(left), /^[0-9a-f]{12}$/)
})

test('the stage directory encodes the version and content hash', () => {
  assert.equal(
    stageDirFor('/Users/tester/.dsh', '0.1.0', 'abcdef012345'),
    '/Users/tester/.dsh/plugins/@local/dsh-suite/0.1.0-abcdef012345',
  )
})

test('a stage holds the three sibling packages and a profile points at the suite inside it', () => {
  assert.deepEqual(Object.values(PACKAGE_DIRS), ['dsh-suite', 'dsh-super-agent', 'dsh-remote'])
  assert.equal(packagesRootFor('/repo/packages/dsh-suite'), '/repo/packages')
  const stage = '/Users/tester/.dsh/plugins/@local/dsh-suite/0.1.0-abcdef012345'
  assert.equal(suiteSpecFor(stage), `file:${stage}/dsh-suite`)
  assert.equal(STAGE_SUITE_DIR, 'dsh-suite')
  assert.equal(stageRootForSpec(`${stage}/dsh-suite`), stage)
  // A spec written by an older release pointed at the package itself.
  assert.equal(stageRootForSpec(stage), stage)
})

test('tool overrides are validated and rendered for the shell', () => {
  const plan = parseArgs(['--node', '/opt/node/bin/node', '--pnpm=/opt/pnpm'], ENV)
  assert.equal(plan.nodeBin, '/opt/node/bin/node')
  assert.equal(plan.pnpmBin, '/opt/pnpm')
  const rendered = toShell({ ...plan, version: '0.1.0', stageDir: '/tmp/stage' })
  assert.match(rendered, /^NODE_BIN='\/opt\/node\/bin\/node'$/m)
  assert.match(rendered, /^PNPM_BIN='\/opt\/pnpm'$/m)
  assert.match(rendered, /^SUITE_SPEC='file:\/tmp\/stage\/dsh-suite'$/m)
  const fromEnv = parseArgs([], { ...ENV, DSH_NODE: '/env/node', DSH_PNPM: '/env/pnpm' })
  assert.equal(fromEnv.nodeBin, '/env/node')
  assert.equal(fromEnv.pnpmBin, '/env/pnpm')
})

test('shell rendering round-trips through a POSIX shell', async () => {
  const { execFileSync } = await import('node:child_process')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { rmSync, writeFileSync } = await import('node:fs')
  const plan = parseArgs(['--profile', 'web'], ENV)
  const rendered = toShell({ ...plan, version: '0.1.0', stageDir: '/tmp/stage', tokenFile: "/tmp/a'b/token" })
  assert.match(rendered, /^MODE='install'$/m)
  assert.match(rendered, /^SUITE_VERSION='0\.1\.0'$/m)
  assert.match(rendered, /^STAGE_DIR='\/tmp\/stage'$/m)
  assert.equal(shellQuote("a'b"), `'a'\\''b'`)
  const file = join(tmpdir(), `dsh-suite-plan-${process.pid}.sh`)
  writeFileSync(file, rendered)
  try {
    const probe = execFileSync('sh', ['-c', `. ${JSON.stringify(file)}; printf '%s|%s|%s' "$PROFILE" "$PORT" "$TOKEN_FILE"`], { encoding: 'utf8' })
    assert.equal(probe, "web|3443|/tmp/a'b/token")
  } finally {
    rmSync(file, { force: true })
  }
})

test('usage names the flags users need', () => {
  const text = usage()
  for (const flag of ['--profile', '--dsh-home', '--port', '--node', '--pnpm', '--restart', '--verify-only', '--purge']) {
    assert.ok(text.includes(flag), `usage is missing ${flag}`)
  }
  assert.ok(text.includes('dsh-remote'))
})
