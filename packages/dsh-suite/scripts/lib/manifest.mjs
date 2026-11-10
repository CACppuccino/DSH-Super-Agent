/**
 * Profile-manifest editing for the suite installer.
 *
 * A profile package.json carries two things the suite must own: the dependency
 * that makes the bundle resolvable, and the `dsh.profile.bundles` entry that
 * applies its patch layer. Editing both here (instead of relying only on
 * pnpm's argument handling) is what makes the installer idempotent and what
 * lets it repair a profile that previously listed the two plugins on their
 * own — that shape would insert both rows twice.
 *
 * @module dsh-suite/scripts/lib/manifest
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SUITE_NAME, SUITE_ROW_PACKAGES } from './plan.mjs'

/** Read and parse one JSON file. */
export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

/** Write one JSON file atomically with a trailing newline. */
export async function writeJsonAtomic(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

/** Clone a JSON-ish value enough to edit it without touching the input. */
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/**
 * Normalize a profile manifest for the suite.
 *
 * Install mode:
 *   - `dependencies[suiteName] = suiteSpec`
 *   - standalone `dsh-remote` / `@local/dsh-super-agent` dependencies are
 *     removed (the suite installs both packages and inserts their rows)
 *   - both names leave `dsh.profile.bundles`, and the suite is appended once
 *
 * Remove mode:
 *   - the suite and both plugin packages leave dependencies and bundles
 *
 * Unknown manifest fields, other dependencies, and the profile's own patch
 * file are untouched.
 *
 * @param {object} manifest parsed profile package.json
 * @param {object} options
 * @param {boolean} [options.remove] uninstall instead of install
 * @param {string} [options.suiteSpec] dependency spec for the suite (install mode)
 * @returns {{ manifest: object, changed: boolean, dependencies: string[], bundles: string[] }}
 *   the (possibly new) manifest, whether it differs from the input, and the
 *   resulting dependency and bundle name lists
 */
export function normalizeManifest(manifest, { remove = false, suiteSpec } = {}) {
  const next = clone(manifest)
  const dependencies = { ...(next.dependencies ?? {}) }
  const dsh = { ...(next.dsh ?? {}) }
  const profile = { ...(dsh.profile ?? {}) }
  const previousBundles = Array.isArray(profile.bundles) ? [...profile.bundles] : []

  const managed = new Set([SUITE_NAME, ...SUITE_ROW_PACKAGES])
  if (remove) {
    for (const name of managed) delete dependencies[name]
    profile.bundles = previousBundles.filter(name => !managed.has(name))
  } else {
    if (typeof suiteSpec !== 'string' || suiteSpec.length === 0) {
      throw new Error('normalizeManifest: suiteSpec is required in install mode')
    }
    dependencies[SUITE_NAME] = suiteSpec
    for (const name of SUITE_ROW_PACKAGES) delete dependencies[name]
    const bundles = previousBundles.filter(name => !SUITE_ROW_PACKAGES.includes(name))
    if (!bundles.includes(SUITE_NAME)) bundles.push(SUITE_NAME)
    profile.bundles = bundles
  }

  dsh.profile = profile
  next.dsh = dsh
  if (Object.keys(dependencies).length > 0) next.dependencies = dependencies
  else delete next.dependencies

  return {
    manifest: next,
    changed: JSON.stringify(next) !== JSON.stringify(manifest),
    dependencies: Object.keys(next.dependencies ?? {}),
    bundles: [...profile.bundles],
  }
}

/**
 * Apply {@link normalizeManifest} to a profile directory, writing only when the
 * manifest actually changes.
 * @param {string} profileDir absolute profile directory
 * @param {object} options install/remove options
 * @returns {Promise<{ changed: boolean, dependencies: string[], bundles: string[] }>}
 *   what changed and the resulting lists
 */
export async function normalizeProfileManifest(profileDir, options) {
  const path = join(profileDir, 'package.json')
  const before = await readJson(path)
  const result = normalizeManifest(before, options)
  if (result.changed) await writeJsonAtomic(path, result.manifest)
  return { changed: result.changed, dependencies: result.dependencies, bundles: result.bundles }
}

/** True when the profile manifest exists (a profile the Desktop app created). */
export async function profileExists(profileDir) {
  try {
    await readJson(join(profileDir, 'package.json'))
    return true
  } catch {
    return false
  }
}
