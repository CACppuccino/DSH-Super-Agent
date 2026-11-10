/**
 * Tests for profile-manifest normalization: one suite dependency, one suite
 * bundle entry, and no standalone plugin rows that would insert twice.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { normalizeManifest, normalizeProfileManifest, profileExists } from '../scripts/lib/manifest.mjs'

const BASE = {
  name: 'dsh-profile-desktop',
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
}

test('install adds the suite dependency and bundle once', () => {
  const { manifest, changed, bundles, dependencies } = normalizeManifest(BASE, {
    suiteSpec: 'file:/Users/tester/.dsh/plugins/@local/dsh-suite/0.1.0-abc',
  })
  assert.equal(changed, true)
  assert.deepEqual(dependencies, ['@local/dsh-suite'])
  assert.deepEqual(bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@local/dsh-suite'])
  assert.equal(manifest.dsh.profile.bundles.at(-1), '@local/dsh-suite')
  assert.equal(manifest.private, true)
})

test('install removes standalone plugin dependencies and rows', () => {
  const previous = {
    ...BASE,
    dependencies: { 'dsh-remote': 'link:/repo/ios/dsh-remote', '@local/dsh-super-agent': 'link:/repo/dsh-super-agent' },
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@local/dsh-super-agent', 'dsh-remote'],
        other: 'kept',
      },
    },
  }
  const { manifest } = normalizeManifest(previous, { suiteSpec: 'file:/stage' })
  assert.deepEqual(Object.keys(manifest.dependencies), ['@local/dsh-suite'])
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@local/dsh-suite'])
  assert.equal(manifest.dsh.profile.other, 'kept')
})

test('normalizing twice reports no change the second time', () => {
  const first = normalizeManifest(BASE, { suiteSpec: 'file:/stage' })
  const second = normalizeManifest(first.manifest, { suiteSpec: 'file:/stage' })
  assert.equal(second.changed, false)
  assert.deepEqual(second.manifest, first.manifest)
})

test('a rewrite of the same dependency spec is a no-op', () => {
  const first = normalizeManifest(BASE, { suiteSpec: 'file:/stage' })
  const second = normalizeManifest(first.manifest, { suiteSpec: 'file:/stage' })
  assert.equal(second.changed, false)
})

test('remove takes the suite and both plugin packages out', () => {
  const installed = normalizeManifest(BASE, { suiteSpec: 'file:/stage' }).manifest
  const { manifest, changed, bundles, dependencies } = normalizeManifest(installed, { remove: true })
  assert.equal(changed, true)
  assert.deepEqual(bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  assert.deepEqual(dependencies, [])
  assert.equal(manifest.dependencies, undefined)
})

test('install mode requires a spec', () => {
  assert.throws(() => normalizeManifest(BASE, { suiteSpec: '' }), /suiteSpec/)
})

test('a profile manifest without dsh metadata gains it', () => {
  const { manifest } = normalizeManifest({ name: 'bare', private: true }, { suiteSpec: 'file:/stage' })
  assert.deepEqual(manifest.dsh.profile.bundles, ['@local/dsh-suite'])
})

test('normalizeProfileManifest writes atomically only when changed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-suite-manifest-'))
  await mkdir(join(directory, 'nested'), { recursive: true })
  const manifestPath = join(directory, 'package.json')
  await writeFile(manifestPath, `${JSON.stringify(BASE, null, 2)}\n`)
  assert.equal(await profileExists(directory), true)
  assert.equal(await profileExists(join(directory, 'nested')), false)

  const first = await normalizeProfileManifest(directory, { suiteSpec: 'file:/stage' })
  assert.equal(first.changed, true)
  const installed = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.equal(installed.dependencies['@local/dsh-suite'], 'file:/stage')
  assert.equal(installed.dsh.profile.bundles.at(-1), '@local/dsh-suite')

  const second = await normalizeProfileManifest(directory, { suiteSpec: 'file:/stage' })
  assert.equal(second.changed, false)

  const removed = await normalizeProfileManifest(directory, { remove: true })
  assert.equal(removed.changed, true)
  const cleaned = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.equal(cleaned.dependencies, undefined)
  assert.deepEqual(cleaned.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
})
