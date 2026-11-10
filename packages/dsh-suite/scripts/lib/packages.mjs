/**
 * Package file lists for the stage snapshot.
 *
 * A stage is an immutable copy of the three monorepo packages the suite needs:
 * `dsh-suite` itself plus its two `file:../<name>` dependencies. Only the files
 * each package's own `files` field ships are copied, so a test directory, a
 * `node_modules` tree, or a stray tarball in the working copy never ends up in
 * a profile.
 *
 * The file list is also what the stage content hash is computed from, so the
 * stage directory name identifies exactly the bytes installed.
 *
 * @module dsh-suite/scripts/lib/packages
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { UsageError } from './plan.mjs'

/** Escape one `files` glob segment for a regular expression. */
function segmentPattern(segment) {
  return new RegExp(`^${segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*')}$`)
}

/** Directories that are build state, never source. */
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', '.DS_Store'])

/** Recursively list regular files under one directory, skipping installs. */
async function walkFiles(root, relativeDir) {
  const files = []
  const directory = join(root, relativeDir)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue
    const child = relativeDir.length === 0 ? entry.name : `${relativeDir}/${entry.name}`
    if (entry.isDirectory()) files.push(...await walkFiles(root, child))
    else if (entry.isFile()) files.push(child)
  }
  return files
}

/**
 * Expand one `files` entry from a package manifest.
 * Supports directory entries, plain files, and `*` in any segment.
 * @param {string} root package directory
 * @param {string} pattern one `files` entry, `/`-separated
 * @returns {Promise<string[]>} relative paths
 */
async function expandPattern(root, pattern) {
  let candidates = ['']
  for (const segment of pattern.split('/')) {
    const next = []
    for (const base of candidates) {
      if (!segment.includes('*')) {
        next.push(base.length === 0 ? segment : `${base}/${segment}`)
        continue
      }
      const matcher = segmentPattern(segment)
      let entries
      try {
        entries = await readdir(join(root, base), { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (matcher.test(entry.name)) next.push(base.length === 0 ? entry.name : `${base}/${entry.name}`)
      }
    }
    candidates = next
  }
  const files = []
  for (const candidate of candidates) {
    let info
    try {
      info = await stat(join(root, candidate))
    } catch {
      continue
    }
    if (info.isDirectory()) files.push(...await walkFiles(root, candidate))
    else if (info.isFile()) files.push(candidate)
  }
  return files
}

/**
 * Read one package manifest and the files it ships.
 *
 * `package.json` is always included: pnpm and the bundle loader both need it.
 *
 * @param {string} directory absolute package directory
 * @returns {Promise<{ directory: string, manifest: object, files: string[] }>}
 *   the manifest and its sorted `/`-separated relative file list
 * @throws {UsageError} when the package is not a readable monorepo package
 */
export async function readPackage(directory) {
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  } catch (error) {
    throw new UsageError(
      `${directory} 不是可安装的包（读不到 package.json：${error instanceof Error ? error.message : String(error)}）。`
      + '请从完整仓库运行安装脚本：不要单独复制 packages/dsh-suite。',
    )
  }
  const patterns = Array.isArray(manifest.files) ? manifest.files : []
  const files = new Set(['package.json'])
  for (const pattern of patterns) {
    for (const file of await expandPattern(directory, pattern)) files.add(file)
  }
  return { directory, manifest, files: [...files].sort() }
}
