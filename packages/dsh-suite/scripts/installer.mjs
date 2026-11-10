#!/usr/bin/env node
/**
 * The suite installer's Node helper.
 *
 * `install.sh` and `uninstall.sh` own the flow (preflight, CLI/pnpm fallback,
 * restart) and call these subcommands for everything that is easier and safer
 * to express in JavaScript: argument planning, staging the package, editing the
 * profile manifest, creating the token, verifying the endpoint, and purging
 * plugin-owned data.
 *
 * No subcommand needs a running DSH except `verify`, which only needs the
 * endpoint URL and token.
 *
 * @module dsh-suite/scripts/installer
 */

import { randomBytes } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyAddresses, formatPairingBlock, renderPairingUrls } from './lib/net.mjs'
import { normalizeProfileManifest, profileExists } from './lib/manifest.mjs'
import { readPackage } from './lib/packages.mjs'
import {
  PACKAGE_DIRS, STAGE_ROOT, SUITE_NAME, UsageError, asUninstall, packagesRootFor, parseArgs, stageDirFor,
  stageRootForSpec, toShell, treeHash, usage,
} from './lib/plan.mjs'
import { verifyRemote } from './lib/verify.mjs'

const SUITE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Fail loudly with the usage text. */
function fail(message, code = 1) {
  process.stderr.write(`error: ${message}\n`)
  process.exit(code)
}

/** Print one informational line. */
function info(message) {
  process.stdout.write(`${message}\n`)
}

/**
 * Resolve the three packages one stage snapshot contains.
 *
 * The suite is `<repo>/packages/dsh-suite`; its `file:../dsh-super-agent` and
 * `file:../dsh-remote` dependencies are tracked copies of their sibling
 * directories, so a stage is the whole installable release, not one package.
 * @param {string} selfDir the suite directory (`packages/dsh-suite`)
 * @returns {Promise<Array<{ dir: string, directory: string, manifest: object, files: string[] }>>}
 *   one entry per package, in stage order
 */
async function stagePackages(selfDir) {
  const packagesRoot = packagesRootFor(selfDir)
  const packages = []
  for (const dir of Object.values(PACKAGE_DIRS)) {
    packages.push({ dir, ...await readPackage(join(packagesRoot, dir)) })
  }
  const suite = packages.find(entry => entry.dir === PACKAGE_DIRS.suite)
  if (suite.manifest.name !== SUITE_NAME) {
    throw new UsageError(`${suite.directory} is not the ${SUITE_NAME} package (found ${JSON.stringify(suite.manifest.name)})`)
  }
  return packages
}

/**
 * List every file the staged copy contains as `<package>/<path>`.
 * The same list feeds the content hash, so the stage directory name always
 * identifies exactly the bytes that were copied.
 * @param {Array<{ dir: string, directory: string, files: string[] }>} packages from {@link stagePackages}
 * @returns {Array<{ path: string, source: string }>} sorted entries with absolute sources
 */
function stageEntries(packages) {
  const entries = []
  for (const pkg of packages) {
    for (const file of pkg.files) {
      entries.push({ path: `${pkg.dir}/${file}`, source: join(pkg.directory, file) })
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path))
}

/** Hash the staged content by reading each shipped file. */
async function suiteTreeHash(entries) {
  const contents = []
  for (const entry of entries) {
    contents.push({ path: entry.path, content: await readFile(entry.source) })
  }
  return treeHash(contents)
}

/** Simple `--flag value` / `--flag=value` / `--switch` parser for subcommands. */
function parseFlags(argv) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) throw new UsageError(`unexpected argument ${JSON.stringify(argument)}`)
    const equals = argument.indexOf('=')
    if (equals >= 0) {
      flags[argument.slice(2, equals)] = argument.slice(equals + 1)
      continue
    }
    const name = argument.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next
      index += 1
    } else {
      flags[name] = true
    }
  }
  return flags
}

/** Require one string flag. */
function required(flags, name) {
  const value = flags[name]
  if (typeof value !== 'string' || value.length === 0) throw new UsageError(`--${name} is required`)
  return value
}

/** Resolve the packages and files one stage snapshot contains, plus its hash. */
async function stageSnapshot(selfDir) {
  const packages = await stagePackages(selfDir)
  const entries = stageEntries(packages)
  return { packages, entries, hash: await suiteTreeHash(entries) }
}

/** Resolve the suite directory, its staged packages, and the content hash. */
async function resolveStage(dshHome, selfDir) {
  const snapshot = await stageSnapshot(selfDir)
  const suite = snapshot.packages.find(entry => entry.dir === PACKAGE_DIRS.suite)
  return {
    version: suite.manifest.version,
    ...snapshot,
    dir: stageDirFor(dshHome, suite.manifest.version, snapshot.hash),
  }
}

/** `plan`: validate argv and print shell assignments for the installer script. */
async function commandPlan(argv) {
  const index = argv.indexOf('--self')
  if (index < 0 || argv[index + 1] === undefined) throw new UsageError('plan requires --self <suite dir>')
  const selfDir = resolve(argv[index + 1])
  const rest = [...argv.slice(0, index), ...argv.slice(index + 2)]
  if (rest.includes('--help') || rest.includes('-h')) {
    info(usage().trimEnd())
    return
  }
  const uninstall = rest.includes('--uninstall')
  const parsed = parseArgs(rest.filter(argument => argument !== '--uninstall'))
  if (parsed.help) {
    info(usage().trimEnd())
    return
  }
  const plan = uninstall ? asUninstall(parsed) : parsed
  if (plan.purge && plan.mode !== 'uninstall') throw new UsageError('--purge is only valid for uninstall.sh')
  const staged = await resolveStage(plan.dshHome, selfDir)
  plan.version = staged.version
  plan.stageDir = staged.dir
  plan.suiteDir = selfDir
  info(toShell(plan).trimEnd())
}

/** `stage`: copy the shipped files of all three packages into the stage. */
async function commandStage(argv) {
  const flags = parseFlags(argv)
  const selfDir = resolve(required(flags, 'self'))
  const stage = resolve(required(flags, 'stage'))
  if (stage === selfDir) {
    info(stage)
    return
  }
  const snapshot = await stageSnapshot(selfDir)
  await rm(stage, { recursive: true, force: true })
  await mkdir(stage, { recursive: true, mode: 0o700 })
  for (const entry of snapshot.entries) {
    const target = join(stage, entry.path)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await copyFile(entry.source, target)
  }
  for (const script of ['install.sh', 'uninstall.sh']) {
    try {
      await chmod(join(stage, PACKAGE_DIRS.suite, script), 0o755)
    } catch {
      // A stripped package may omit one of the scripts; the other still works.
    }
  }
  info(stage)
}

/** `prune-stage`: remove staged suite builds no profile references any more. */
async function commandPruneStage(argv) {
  const flags = parseFlags(argv)
  const dshHome = resolve(required(flags, 'home'))
  const keep = resolve(required(flags, 'keep'))
  const root = join(dshHome, STAGE_ROOT)
  const referenced = new Set([keep])
  let profiles
  try {
    profiles = await readdir(join(dshHome, 'profiles'), { withFileTypes: true })
  } catch {
    profiles = []
  }
  for (const entry of profiles) {
    if (!entry.isDirectory()) continue
    try {
      const manifest = JSON.parse(await readFile(join(dshHome, 'profiles', entry.name, 'package.json'), 'utf8'))
      for (const spec of Object.values(manifest.dependencies ?? {})) {
        if (typeof spec !== 'string' || !spec.startsWith('file:')) continue
        referenced.add(stageRootForSpec(spec.slice('file:'.length)))
      }
    } catch {
      // A profile without a readable manifest cannot reference a staged build.
    }
  }
  let removed = 0
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    entries = []
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = join(root, entry.name)
    if (referenced.has(candidate)) continue
    await rm(candidate, { recursive: true, force: true })
    removed += 1
  }
  info(`pruned ${removed} staged build(s)`)
}

/** `edit-manifest`: install/remove the suite dependency and bundle rows. */
async function commandEditManifest(argv) {
  const flags = parseFlags(argv)
  const profileDir = resolve(required(flags, 'profile-dir'))
  if (!await profileExists(profileDir)) {
    fail(`profile manifest not found: ${join(profileDir, 'package.json')}`, 3)
  }
  const remove = flags.remove === true
  const result = await normalizeProfileManifest(profileDir, remove
    ? { remove: true }
    : { remove: false, suiteSpec: required(flags, 'suite-spec') })
  info(JSON.stringify(result))
}

/** `ensure-token`: return the existing bearer token, or create a 0600 one. */
async function commandEnsureToken(argv) {
  const flags = parseFlags(argv)
  const file = resolve(required(flags, 'file'))
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  let token = ''
  try {
    const text = await readFile(file, 'utf8')
    token = text.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0) ?? ''
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (token.length === 0) {
    token = randomBytes(32).toString('hex')
    await writeFile(file, `${token}\n`, { flag: 'wx', mode: 0o600 })
  }
  await chmod(file, 0o600)
  if (token.length < 16) fail(`token file ${file} contains a token shorter than 16 characters`)
  info(token)
}

/** `verify`: healthz, then authenticated session.list. */
async function commandVerify(argv) {
  const flags = parseFlags(argv)
  const baseUrl = required(flags, 'base-url')
  const pathPrefix = required(flags, 'prefix')
  const tokenFile = required(flags, 'token-file')
  const waitMs = Number.parseInt(flags.wait ?? '0', 10)
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new UsageError('--wait must be a non-negative number of seconds')
  const token = (await readFile(tokenFile, 'utf8')).split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0)
  if (token === undefined) fail(`token file ${tokenFile} is empty`)
  const result = await verifyRemote({
    baseUrl,
    pathPrefix,
    token,
    waitMs: waitMs * 1000,
    log: info,
  })
  if (result.ok) {
    info(`  ✓ GET ${baseUrl}/healthz → dsh-remote ${result.health?.version ?? ''}`.trimEnd())
    info(`  ✓ POST ${baseUrl}${pathPrefix}/session.list → ${result.items.length} 个会话（第 ${result.attempts} 次尝试）`)
    return
  }
  process.stderr.write(`  ✗ ${result.stage} 验证失败：${result.message}\n`)
  process.stderr.write(`    原因：${result.kind}\n`)
  process.stderr.write(`    处理：${result.hint}\n`)
  process.exit(2)
}

/** `pairing`: print the URLs and token the phone needs. */
async function commandPairing(argv) {
  const flags = parseFlags(argv)
  const host = required(flags, 'host')
  const port = Number(required(flags, 'port'))
  const profile = required(flags, 'profile')
  const pathPrefix = required(flags, 'prefix')
  const tokenFile = required(flags, 'token-file')
  const token = (await readFile(tokenFile, 'utf8')).split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0)
  if (token === undefined) fail(`token file ${tokenFile} is empty`)

  const classified = classifyAddresses(networkInterfaces())
  const tailscale = [...classified.tailscale]
  const extra = typeof flags['extra-tailscale'] === 'string' ? flags['extra-tailscale'].split(',') : []
  for (const address of extra) {
    const trimmed = address.trim()
    if (trimmed.length > 0 && !tailscale.some(entry => entry.address === trimmed)) {
      tailscale.push({ address: trimmed, iface: 'tailscale' })
    }
  }
  const urls = renderPairingUrls({
    listenHost: host,
    port,
    pathPrefix,
    lan: classified.lan,
    tailscale,
  })
  process.stdout.write(formatPairingBlock({
    profile,
    listenHost: host,
    port,
    pathPrefix,
    token,
    tokenFile,
    urls,
  }))
}

/** `purge`: remove plugin-owned state after uninstall (never DSH session data). */
async function commandPurge(argv) {
  const flags = parseFlags(argv)
  const dshHome = resolve(required(flags, 'dsh-home'))
  const profile = required(flags, 'profile')
  const tokenFile = resolve(required(flags, 'token-file'))
  if (dshHome === '/' || dshHome.length < 2) fail('refusing to purge the filesystem root')

  const removed = []
  const skipped = []
  const remove = async (path) => {
    const target = resolve(path)
    if (target !== dshHome && !target.startsWith(`${dshHome}${sep}`)) {
      skipped.push(target)
      return
    }
    try {
      await stat(target)
    } catch {
      return
    }
    await rm(target, { recursive: true, force: true })
    removed.push(target)
  }

  if (resolve(tokenFile).startsWith(`${dshHome}${sep}`)) {
    await remove(tokenFile)
    try {
      await rmdir(dirname(tokenFile))
    } catch {
      // The remote directory still holds certificates or other files.
    }
  } else {
    skipped.push(resolve(tokenFile))
  }

  // Desktop keeps the historical state root; other profiles own a subdirectory.
  const stateRoot = join(dshHome, 'state', 'dsh-super-agent')
  await remove(profile === 'desktop' ? stateRoot : join(stateRoot, 'profiles', profile))
  await remove(join(dshHome, STAGE_ROOT))

  for (const path of removed) info(`  ✓ 已删除 ${path}`)
  for (const path of skipped) info(`  ! 跳过 ${path}（在 DSH_HOME 之外，请手动确认）`)
  info('  ! DSH 自己的会话历史（$DSH_HOME/sessions）保持不动')
}

/** Dispatch one subcommand. */
async function main() {
  const [command, ...argv] = process.argv.slice(2)
  switch (command) {
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      info(usage().trimEnd())
      return
    case 'plan':
      return commandPlan(argv)
    case 'stage':
      return commandStage(argv)
    case 'prune-stage':
      return commandPruneStage(argv)
    case 'edit-manifest':
      return commandEditManifest(argv)
    case 'ensure-token':
      return commandEnsureToken(argv)
    case 'verify':
      return commandVerify(argv)
    case 'pairing':
      return commandPairing(argv)
    case 'purge':
      return commandPurge(argv)
    default:
      throw new UsageError(`unknown command ${JSON.stringify(command)}`)
  }
}

try {
  await main()
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`error: ${error.message}\n\n${usage()}`)
    process.exit(1)
  }
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
