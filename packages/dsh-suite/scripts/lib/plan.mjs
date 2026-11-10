/**
 * Pure planning logic for the suite installer.
 *
 * Nothing here touches the filesystem, the network, or a running DSH: the
 * installer shell script and the `installer.mjs` CLI feed raw argv and
 * environment values in and get a validated, fully-resolved plan back. That
 * keeps the interesting parts (argument parsing, `$DSH_HOME`/profile
 * resolution, the staged-copy path, URL rendering) unit-testable without a
 * real Harness installation.
 *
 * @module dsh-suite/scripts/lib/plan
 */

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import {
  basename, dirname, isAbsolute, join, resolve,
} from 'node:path'

/** The bundle package this installer manages. */
export const SUITE_NAME = '@local/dsh-suite'

/**
 * Packages that own the two rows the suite inserts. A profile that lists any
 * of them as its own dependency or bundle would insert the rows twice, so the
 * installer normalizes them away.
 */
export const SUITE_ROW_PACKAGES = Object.freeze(['@local/dsh-super-agent', 'dsh-remote'])

/** Default profile: the one the Desktop app owns and the iPhone app connects to. */
export const DEFAULT_PROFILE = 'desktop'

/** Default remote endpoint port (the DSH Remote app's default). */
export const DEFAULT_PORT = 3443

/** Default URL prefix served by dsh-remote (baked into the bundle patch). */
export const DEFAULT_PATH_PREFIX = '/remote-api'

/** Default listen address: reachable from the LAN and the tailnet. */
export const DEFAULT_LISTEN_HOST = '0.0.0.0'

/** Where staged suite copies live under `$DSH_HOME`. */
export const STAGE_ROOT = 'plugins/@local/dsh-suite'

/** The suite package's directory inside one stage snapshot. */
export const STAGE_SUITE_DIR = 'dsh-suite'

/**
 * The packages one stage snapshot contains, in the order they are staged.
 *
 * They are siblings in the repository (`<repo>/packages/*`) and they stay
 * siblings inside a stage, which is what lets the suite's own
 * `file:../dsh-super-agent` / `file:../dsh-remote` dependencies resolve both in
 * a clone and in an installed profile.
 */
export const PACKAGE_DIRS = Object.freeze({
  suite: 'dsh-suite',
  superAgent: 'dsh-super-agent',
  remote: 'dsh-remote',
})

/** Default verification budget, in seconds. */
export const DEFAULT_WAIT_SECONDS = 30

/** A rejected command line: the message is printed verbatim and nothing runs. */
export class UsageError extends Error {
  /** @param {string} message what the user must fix */
  constructor(message) {
    super(message)
    this.name = 'UsageError'
  }
}

/** Expand a leading `~` the way a shell would. */
export function expandHome(value, home = homedir()) {
  if (value === '~') return home
  if (typeof value === 'string' && value.startsWith('~/')) return join(home, value.slice(2))
  return value
}

/** Render a path for humans without leaking a trailing separator. */
function normalizeHome(value, home = homedir()) {
  return resolve(expandHome(value, home))
}

/** Parse a CLI argument of the `--name value` or `--name=value` form. */
function takeValue(argv, index, name) {
  const argument = argv[index]
  const equals = argument.indexOf('=')
  if (equals >= 0) {
    const value = argument.slice(equals + 1)
    if (value.length === 0) throw new UsageError(`${name} needs a value`)
    return { value, next: index }
  }
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('-')) throw new UsageError(`${name} needs a value`)
  return { value, next: index + 1 }
}

/** Parse a positive integer flag value. */
function parsePort(value, name) {
  if (!/^\d+$/.test(value)) throw new UsageError(`${name} must be a whole number`)
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError(`${name} must be between 1 and 65535`)
  return port
}

/** Parse a bounded number of seconds. */
function parseSeconds(value, name) {
  if (!/^\d+$/.test(value)) throw new UsageError(`${name} must be a whole number of seconds`)
  const seconds = Number(value)
  if (seconds < 0 || seconds > 600) throw new UsageError(`${name} must be between 0 and 600`)
  return seconds
}

/** Validate the profile name against the directory names DSH accepts. */
function parseProfile(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new UsageError(`profile ${JSON.stringify(value)} is not a valid profile name`)
  }
  return value
}

/** Validate the listen address (wildcard, IP literal, or hostname). */
function parseHost(value) {
  if (value.length === 0 || /[\s/]/.test(value)) throw new UsageError(`--host ${JSON.stringify(value)} is not an address`)
  return value
}

/** True when the listen host only accepts loopback traffic. */
export function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost' || /^127\./.test(host)
}

/** True when the listen host binds every interface. */
export function isWildcardHost(host) {
  return host === '0.0.0.0' || host === '::' || host === ''
}

/** Wrap an IPv6 literal in brackets for use in a URL authority. */
export function hostForUrl(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

/**
 * Build the base origin the verifier should call.
 * A wildcard listen address is reached through loopback, not literally.
 * @param {string} host listen address from the plan
 * @param {number} port listen port
 * @returns {string} `http://host:port` without a trailing slash
 */
export function defaultVerifyUrl(host, port) {
  const target = isWildcardHost(host) ? '127.0.0.1' : host
  return `http://${hostForUrl(target)}:${port}`
}

/**
 * Resolve the default token path (`$DSH_HOME/remote/token`, 0600).
 * @param {string} dshHome absolute Harness home
 * @returns {string} absolute token path
 */
export function defaultTokenFile(dshHome) {
  return join(dshHome, 'remote', 'token')
}

/**
 * Parse installer argv into a validated plan.
 *
 * Recognized flags (both `--flag value` and `--flag=value`):
 * `--profile`, `--dsh-home`, `--host`, `--port`, `--token-file`,
 * `--verify-url`, `--wait`, `--dsh`, `--restart`, `--verify-only`,
 * `--no-verify`, `--purge`, `--help`.
 *
 * @param {readonly string[]} argv arguments after the script name
 * @param {Record<string, string | undefined>} [env] environment snapshot
 * @returns {object} the resolved plan
 */
export function parseArgs(argv, env = process.env) {
  const home = env.HOME ?? homedir()
  const plan = {
    mode: 'install',
    profile: env.DSH_PROFILE?.trim() || DEFAULT_PROFILE,
    dshHome: normalizeHome(env.DSH_HOME?.trim() || join(home, '.dsh'), home),
    host: DEFAULT_LISTEN_HOST,
    port: DEFAULT_PORT,
    pathPrefix: DEFAULT_PATH_PREFIX,
    tokenFile: undefined,
    verifyUrl: undefined,
    waitSeconds: DEFAULT_WAIT_SECONDS,
    dshCli: env.DSH_CLI?.trim() || undefined,
    nodeBin: env.DSH_NODE?.trim() || undefined,
    pnpmBin: env.DSH_PNPM?.trim() || undefined,
    restart: false,
    verifyOnly: false,
    noVerify: false,
    purge: false,
    help: false,
  }
  const seen = new Set()

  /** Record a repeatable flag once. */
  const once = (name) => {
    if (seen.has(name)) throw new UsageError(`${name} may only be given once`)
    seen.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const name = argument.includes('=') ? argument.slice(0, argument.indexOf('=')) : argument
    switch (name) {
      case '-h':
      case '--help':
        plan.help = true
        break
      case '--profile': {
        once(name)
        const taken = takeValue(argv, index, name)
        plan.profile = parseProfile(taken.value)
        index = taken.next
        break
      }
      case '--dsh-home': {
        once(name)
        const taken = takeValue(argv, index, name)
        plan.dshHome = normalizeHome(taken.value, home)
        index = taken.next
        break
      }
      case '--host': {
        once(name)
        const taken = takeValue(argv, index, name)
        plan.host = parseHost(taken.value)
        index = taken.next
        break
      }
      case '--port': {
        once(name)
        const taken = takeValue(argv, index, name)
        plan.port = parsePort(taken.value, name)
        index = taken.next
        break
      }
      case '--token-file': {
        once(name)
        const taken = takeValue(argv, index, name)
        plan.tokenFile = resolve(expandHome(taken.value, home))
        index = taken.next
        break
      }
      case '--verify-url': {
        once(name)
        const taken = takeValue(argv, index, name)
        plan.verifyUrl = taken.value.replace(/\/+$/, '')
        index = taken.next
        break
      }
      case '--wait': {
        once(name)
        const taken = takeValue(argv, index, name)
        plan.waitSeconds = parseSeconds(taken.value, name)
        index = taken.next
        break
      }
      case '--dsh': {
        once(name)
        const taken = takeValue(argv, index, name)
        plan.dshCli = resolve(expandHome(taken.value, home))
        index = taken.next
        break
      }
      case '--node': {
        once(name)
        const taken = takeValue(argv, index, name)
        plan.nodeBin = resolve(expandHome(taken.value, home))
        index = taken.next
        break
      }
      case '--pnpm': {
        once(name)
        const taken = takeValue(argv, index, name)
        plan.pnpmBin = resolve(expandHome(taken.value, home))
        index = taken.next
        break
      }
      case '--restart':
        plan.restart = true
        break
      case '--verify-only':
        plan.verifyOnly = true
        break
      case '--no-verify':
        plan.noVerify = true
        break
      case '--purge':
        plan.purge = true
        break
      default:
        throw new UsageError(`unknown option ${JSON.stringify(argument)}`)
    }
  }

  if (plan.verifyOnly && plan.noVerify) throw new UsageError('--verify-only and --no-verify are mutually exclusive')
  if (plan.verifyOnly && plan.purge) throw new UsageError('--verify-only and --purge are mutually exclusive')
  if (plan.dshHome === '/' || plan.dshHome.length === 0) throw new UsageError('--dsh-home must not be the filesystem root')
  if (!isAbsolute(plan.dshHome)) throw new UsageError('--dsh-home must be an absolute path')

  plan.profileDir = join(plan.dshHome, 'profiles', plan.profile)
  plan.tokenFile = plan.tokenFile ?? defaultTokenFile(plan.dshHome)
  plan.verifyUrl = plan.verifyUrl ?? defaultVerifyUrl(plan.host, plan.port)
  plan.urlPrefix = DEFAULT_PATH_PREFIX
  return plan
}

/** Mark the plan as an uninstall run (same parser, different lifecycle). */
export function asUninstall(plan) {
  return { ...plan, mode: 'uninstall' }
}

/**
 * Hash a staged directory tree's contents.
 *
 * The stage directory name carries this hash, so a reinstall of a different
 * build with the same version still installs fresh files: pnpm would otherwise
 * consider `file:<same path>` already up to date and keep the old inodes.
 *
 * @param {Array<{ path: string, content: Buffer }>} entries relative paths and contents
 * @returns {string} 12 hex characters
 */
export function treeHash(entries) {
  const sorted = [...entries].sort((left, right) => left.path.localeCompare(right.path))
  const hash = createHash('sha256')
  for (const entry of sorted) {
    hash.update(`${entry.path}\0`)
    hash.update(String(entry.content.length))
    hash.update('\0')
    hash.update(entry.content)
  }
  return hash.digest('hex').slice(0, 12)
}

/**
 * Resolve the immutable stage directory for one suite build.
 * @param {string} dshHome absolute Harness home
 * @param {string} version suite package version
 * @param {string} contentHash {@link treeHash} of the suite tree
 * @returns {string} absolute stage directory
 */
export function stageDirFor(dshHome, version, contentHash) {
  return join(dshHome, STAGE_ROOT, `${version}-${contentHash}`)
}

/**
 * The repository's `packages` directory, derived from the suite's own path.
 * @param {string} suiteDir absolute path of `packages/dsh-suite`
 * @returns {string} absolute path of `<repo>/packages`
 */
export function packagesRootFor(suiteDir) {
  return resolve(suiteDir, '..')
}

/**
 * The dependency spec a profile records for one stage snapshot.
 *
 * The stage root holds the three package directories, so the spec points at
 * the suite inside it and its `file:../<name>` dependencies stay siblings.
 * @param {string} stageDir absolute stage directory
 * @returns {string} `file:` spec for the profile manifest
 */
export function suiteSpecFor(stageDir) {
  return `file:${join(stageDir, STAGE_SUITE_DIR)}`
}

/**
 * Recover the stage directory a profile dependency spec points into.
 *
 * Accepts both the current layout (`<stage>/dsh-suite`) and a spec written by
 * an older release (`<stage>` = the package itself), so a profile installed
 * before this repository layout still prunes correctly.
 * @param {string} spec `file:<path>` dependency spec
 * @returns {string} absolute stage directory
 */
export function stageRootForSpec(spec) {
  const target = resolve(spec)
  return basename(target) === STAGE_SUITE_DIR ? dirname(target) : target
}

/**
 * Render a plan as POSIX-shell assignments safe for `eval`.
 *
 * The installer shell script sources this instead of re-implementing argument
 * parsing, so the tested parser is the only parser.
 * @param {object} plan resolved plan
 * @returns {string} newline-terminated `KEY='value'` lines
 */
export function toShell(plan) {
  const values = {
    MODE: plan.mode,
    PROFILE: plan.profile,
    PROFILE_DIR: plan.profileDir,
    DSH_HOME: plan.dshHome,
    LISTEN_HOST: plan.host,
    PORT: String(plan.port),
    PATH_PREFIX: plan.pathPrefix,
    TOKEN_FILE: plan.tokenFile,
    VERIFY_URL: plan.verifyUrl,
    WAIT_SECONDS: String(plan.waitSeconds),
    DSH_CLI: plan.dshCli ?? '',
    NODE_BIN: plan.nodeBin ?? '',
    PNPM_BIN: plan.pnpmBin ?? '',
    SUITE_NAME,
    SUITE_VERSION: plan.version ?? '',
    STAGE_DIR: plan.stageDir ?? '',
    STAGE_SUITE_DIR,
    SUITE_SPEC: plan.stageDir ? suiteSpecFor(plan.stageDir) : '',
    RESTART: plan.restart ? '1' : '0',
    VERIFY_ONLY: plan.verifyOnly ? '1' : '0',
    NO_VERIFY: plan.noVerify ? '1' : '0',
    PURGE: plan.purge ? '1' : '0',
  }
  return Object.entries(values)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join('\n') + '\n'
}

/** Quote one value for a POSIX shell. */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

/** The usage text shared by `install.sh` and `uninstall.sh`. */
export function usage(program = 'install.sh') {
  return `Usage: ${program} [options]

Install the Super Agent + dsh-remote suite into a DeepSeek Harness profile.

Options:
  --profile <name>      target profile (default: desktop)
  --dsh-home <dir>      Harness home (default: $DSH_HOME or ~/.dsh)
  --host <address>      remote endpoint listen address in the printed pairing
                        block (default: 0.0.0.0); set this if you changed the
                        dsh-remote row config in the profile patch
  --port <number>       remote endpoint port (default: 3443)
  --token-file <path>   bearer token file (default: <dsh-home>/remote/token)
  --verify-url <url>    base URL the verification calls (default:
                        http://127.0.0.1:<port>)
  --wait <seconds>      how long verification retries a not-yet-loaded endpoint
                        (default: ${DEFAULT_WAIT_SECONDS})
  --dsh <path>          dsh CLI to use for plugin management (default: the
                        Desktop app's bundled CLI, then dsh on PATH)
  --node <path>         Node.js binary used by the installer itself (default:
                        node on PATH, then the Desktop app's Electron binary)
  --pnpm <path>         pnpm used to sync the profile's dependencies (default:
                        pnpm on PATH, then the Desktop app's bundled pnpm)
  --restart             quit and reopen the Desktop app (macOS) before verifying
  --verify-only         skip installation; only verify the running endpoint
  --no-verify           skip the healthz/session.list verification
  --purge               (uninstall.sh) also remove the token and plugin state
  -h, --help            show this help

Environment:
  DSH_HOME, DSH_PROFILE, DSH_CLI, DSH_NODE, DSH_PNPM, DSH_DESKTOP_APP
`
}
