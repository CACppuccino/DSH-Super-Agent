/**
 * Tests for the installer CLI subcommands that touch only files:
 * staging, manifest editing, token creation, plan rendering, and purge.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const INSTALLER = resolve(import.meta.dirname, '..', 'scripts', 'installer.mjs')

/** Run one installer subcommand and return stdout. */
function run(args, options = {}) {
  return execFileSync(process.execPath, [INSTALLER, ...args], { encoding: 'utf8', ...options })
}

/**
 * Build a minimal on-disk monorepo: the three sibling packages the suite needs.
 * The `files` fields mirror the real manifests, so the staging rules are the
 * ones that run in production.
 */
async function fakeRepo() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-suite-fake-'))
  const packages = join(root, 'packages')
  const suite = join(packages, 'dsh-suite')
  const superAgent = join(packages, 'dsh-super-agent')
  const remote = join(packages, 'dsh-remote')
  for (const directory of [join(suite, 'scripts'), join(suite, 'node_modules'), join(suite, 'test'), join(superAgent, 'lib'), join(superAgent, 'test'), join(remote, 'lib'), join(remote, 'tests')]) {
    await mkdir(directory, { recursive: true })
  }
  await writeFile(join(suite, 'package.json'), JSON.stringify({
    name: '@local/dsh-suite',
    version: '0.0.9',
    dependencies: { '@local/dsh-super-agent': 'file:../dsh-super-agent', 'dsh-remote': 'file:../dsh-remote' },
    files: ['cordis.patch.yml', 'install.sh', 'uninstall.sh', 'scripts'],
  }))
  await writeFile(join(suite, 'cordis.patch.yml'), '- insert: []\n')
  await writeFile(join(suite, 'install.sh'), '#!/bin/sh\necho install\n')
  await chmod(join(suite, 'install.sh'), 0o644)
  await writeFile(join(suite, 'uninstall.sh'), '#!/bin/sh\necho uninstall\n')
  await writeFile(join(suite, 'scripts', 'helper.mjs'), 'export const ok = true\n')
  await writeFile(join(suite, 'node_modules', 'ignored.js'), 'ignored\n')
  await writeFile(join(suite, 'test', 'ignored.test.mjs'), 'ignored\n')
  await writeFile(join(suite, 'leftover.tgz'), 'ignored\n')
  await writeFile(join(superAgent, 'package.json'), JSON.stringify({
    name: '@local/dsh-super-agent', version: '0.0.9', files: ['index.js', 'lib'],
  }))
  await writeFile(join(superAgent, 'index.js'), 'export const name = "dsh-super-agent"\n')
  await writeFile(join(superAgent, 'lib', 'api.js'), 'export const ok = true\n')
  await writeFile(join(superAgent, 'test', 'ignored.test.js'), 'ignored\n')
  await writeFile(join(superAgent, 'screenshot.png'), 'ignored\n')
  await writeFile(join(remote, 'package.json'), JSON.stringify({
    name: 'dsh-remote', version: '0.0.9', files: ['lib'],
  }))
  await writeFile(join(remote, 'lib', 'index.js'), 'export const name = "dsh-remote"\n')
  await writeFile(join(remote, 'tests', 'ignored.test.mjs'), 'ignored\n')
  return { root, suite }
}

test('stage copies the shipped files of all three packages only', async () => {
  const { suite } = await fakeRepo()
  const stage = join(await mkdtemp(join(tmpdir(), 'dsh-suite-stage-')), 'staged')
  const printed = run(['stage', '--self', suite, '--stage', stage]).trim()
  assert.equal(printed, stage)
  assert.equal(await readFile(join(stage, 'dsh-suite', 'package.json'), 'utf8').then(text => JSON.parse(text).name), '@local/dsh-suite')
  assert.equal(await readFile(join(stage, 'dsh-suite', 'scripts', 'helper.mjs'), 'utf8'), 'export const ok = true\n')
  assert.equal((await stat(join(stage, 'dsh-suite', 'install.sh'))).mode & 0o777, 0o755)
  // The two `file:../<name>` dependencies are staged as real sibling packages.
  assert.equal(await readFile(join(stage, 'dsh-super-agent', 'index.js'), 'utf8'), 'export const name = "dsh-super-agent"\n')
  assert.equal(await readFile(join(stage, 'dsh-remote', 'lib', 'index.js'), 'utf8'), 'export const name = "dsh-remote"\n')
  for (const missing of [
    'dsh-suite/node_modules', 'dsh-suite/test', 'dsh-suite/leftover.tgz',
    'dsh-super-agent/test', 'dsh-super-agent/screenshot.png', 'dsh-remote/tests',
  ]) {
    await assert.rejects(() => stat(join(stage, missing)), /ENOENT/, `${missing} must not be staged`)
  }
})

test('stage fails with a hint when the sibling packages are missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-suite-lonely-'))
  const suite = join(root, 'packages', 'dsh-suite')
  await mkdir(suite, { recursive: true })
  await writeFile(join(suite, 'package.json'), JSON.stringify({ name: '@local/dsh-suite', version: '0.0.9' }))
  const stage = join(await mkdtemp(join(tmpdir(), 'dsh-suite-stage-')), 'staged')
  assert.throws(
    () => run(['stage', '--self', suite, '--stage', stage], { stdio: 'pipe' }),
    error => /dsh-super-agent/.test(String(error.stderr)),
  )
})

test('plan renders eval-safe assignments from a real suite tree', async () => {
  const output = run(['plan', '--self', resolve(import.meta.dirname, '..'), '--profile', 'web', '--port', '3999'], {
    env: { ...process.env, HOME: '/Users/tester', DSH_HOME: '' },
  })
  assert.match(output, /^PROFILE='web'$/m)
  assert.match(output, /^PORT='3999'$/m)
  assert.match(output, /^VERIFY_URL='http:\/\/127\.0\.0\.1:3999'$/m)
  assert.match(output, /^STAGE_DIR='\/Users\/tester\/\.dsh\/plugins\/@local\/dsh-suite\/0\.1\.0-[0-9a-f]{12}'$/m)
  assert.match(output, /^SUITE_SPEC='file:\/Users\/tester\/\.dsh\/plugins\/@local\/dsh-suite\/0\.1\.0-[0-9a-f]{12}\/dsh-suite'$/m)
})

test('edit-manifest installs once and repairs idempotently', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'dsh-suite-profile-'))
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: { 'dsh-remote': 'link:/old/dsh-remote' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-remote'] } },
  }))
  const first = JSON.parse(run(['edit-manifest', '--profile-dir', profile, '--suite-spec', 'file:/stage/dsh-suite']))
  assert.equal(first.changed, true)
  assert.deepEqual(first.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@local/dsh-suite'])
  assert.deepEqual(first.dependencies, ['@local/dsh-suite'])
  const second = JSON.parse(run(['edit-manifest', '--profile-dir', profile, '--suite-spec', 'file:/stage/dsh-suite']))
  assert.equal(second.changed, false)
  const removed = JSON.parse(run(['edit-manifest', '--profile-dir', profile, '--remove']))
  assert.equal(removed.changed, true)
  assert.deepEqual(removed.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  assert.deepEqual(removed.dependencies, [])
})

test('edit-manifest fails clearly on a missing profile', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'dsh-suite-missing-'))
  assert.throws(
    () => run(['edit-manifest', '--profile-dir', profile, '--suite-spec', 'file:/stage/dsh-suite'], { stdio: 'pipe' }),
    error => error.status === 3,
  )
})

test('ensure-token creates a 0600 token and then reuses it', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'dsh-suite-token-')), 'remote', 'token')
  const first = run(['ensure-token', '--file', file]).trim()
  assert.match(first, /^[0-9a-f]{64}$/)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  const second = run(['ensure-token', '--file', file]).trim()
  assert.equal(second, first)
})

test('purge removes plugin-owned data and leaves DSH sessions alone', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-suite-purge-'))
  const tokenFile = join(home, 'remote', 'token')
  await mkdir(join(home, 'remote'), { recursive: true })
  await writeFile(tokenFile, 'a'.repeat(64))
  await mkdir(join(home, 'state', 'dsh-super-agent'), { recursive: true })
  await writeFile(join(home, 'state', 'dsh-super-agent', 'state.json'), '{}')
  await mkdir(join(home, 'plugins', '@local', 'dsh-suite', '0.1.0-abc'), { recursive: true })
  await mkdir(join(home, 'sessions'), { recursive: true })
  await writeFile(join(home, 'sessions', 'keep.jsonl'), '{}\n')

  run(['purge', '--dsh-home', home, '--profile', 'desktop', '--token-file', tokenFile])
  await assert.rejects(() => stat(tokenFile), /ENOENT/)
  await assert.rejects(() => stat(join(home, 'state', 'dsh-super-agent')), /ENOENT/)
  await assert.rejects(() => stat(join(home, 'plugins', '@local', 'dsh-suite')), /ENOENT/)
  assert.equal(await readFile(join(home, 'sessions', 'keep.jsonl'), 'utf8'), '{}\n')
})

test('purge skips a token file outside the Harness home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-suite-purge-home-'))
  const outside = join(await mkdtemp(join(tmpdir(), 'dsh-suite-purge-outside-')), 'token')
  await writeFile(outside, 'b'.repeat(64))
  run(['purge', '--dsh-home', home, '--profile', 'desktop', '--token-file', outside])
  assert.equal((await stat(outside)).size, 64)
})

test('prune-stage keeps builds a profile still references', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-suite-prune-'))
  const suiteDir = join(home, 'plugins', '@local', 'dsh-suite')
  const referenced = join(suiteDir, '0.1.0-aaaaaaaaaaaa')
  const kept = join(suiteDir, '0.1.0-bbbbbbbbbbbb')
  const unreferenced = join(suiteDir, '0.0.9-cccccccccccc')
  for (const directory of [referenced, kept, unreferenced]) {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), '{}')
  }
  for (const [profile, spec] of [['desktop', referenced], ['web', kept]]) {
    await mkdir(join(home, 'profiles', profile), { recursive: true })
    await writeFile(join(home, 'profiles', profile, 'package.json'), JSON.stringify({
      name: `dsh-profile-${profile}`,
      dependencies: { '@local/dsh-suite': `file:${join(spec, 'dsh-suite')}` },
    }))
  }
  const output = run(['prune-stage', '--home', home, '--keep', kept]).trim()
  assert.equal(output, 'pruned 1 staged build(s)')
  assert.equal((await stat(kept)).isDirectory(), true)
  assert.equal((await stat(referenced)).isDirectory(), true)
  await assert.rejects(() => stat(unreferenced), /ENOENT/)
})
