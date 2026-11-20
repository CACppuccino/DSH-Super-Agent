/**
 * Probe one host plugin entry module through the Cordis load contract.
 * Runs the entry import in a child process (`host-load-probe.mjs`).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJson, resolveExportsTarget, run } from './runtime.mjs'

const PROBE = fileURLToPath(new URL('./host-load-probe.mjs', import.meta.url))

/**
 * @param {object} plugin discovery record
 * @param {object} core core surface
 * @param {{ timeoutMs?: number }} [options]
 */
export function probePlugin(plugin, core, options = {}) {
  const root = plugin.primaryRoot
  const manifest = plugin.manifest
  const entry = resolveEntry(root, manifest)
  if (entry === undefined) {
    return { status: 'FAIL', entry: join(root, 'package.json'), firstError: 'no host entry module could be resolved' }
  }
  const runtime = probeRuntime(core)
  const result = run(runtime.command, [...runtime.prefix, PROBE, entry], {
    cwd: root,
    timeoutMs: options.timeoutMs ?? 30_000,
    env: { DSH_COMPAT_PROBE: '1', ...runtime.env },
  })
  const payload = lastJsonLine(result.stdout) ?? lastJsonLine(result.stderr)
  if (payload === undefined) {
    const detail = (result.error ?? result.stderr.split('\n').filter((line) => line.trim().length > 0).slice(-3).join(' | ')).slice(0, 500)
    return { status: 'FAIL', entry, firstError: detail.length > 0 ? detail : `probe exited ${result.status} without output` }
  }
  if (payload.ok !== true) {
    return { status: 'FAIL', entry, firstError: String(payload.error ?? 'import failed').split('\n')[0].slice(0, 400) }
  }
  const problems = []
  const notes = []
  if (payload.apply !== 'function') problems.push(`module exports \`apply\` as ${payload.apply}`)
  if (payload.name === null) notes.push('module has no `name` export; the Cordis loader falls back to the package identity')
  if (payload.inject !== null && payload.inject !== 'array' && payload.inject !== 'object') problems.push(`module inject is ${payload.inject}`)
  return {
    status: problems.length === 0 ? 'PASS' : 'FAIL',
    entry,
    name: payload.name,
    apply: payload.apply,
    inject: payload.inject,
    exports: payload.exports,
    ...(notes.length === 0 ? {} : { notes }),
    ...(problems.length === 0 ? {} : { firstError: problems.join('; ') }),
  }
}

function resolveEntry(root, manifest) {
  const exportsField = manifest.exports ?? {}
  const target = resolveExportsTarget(exportsField, '.', root)
  if (target !== undefined && existsSync(target)) return target
  if (typeof manifest.main === 'string' && existsSync(join(root, manifest.main))) return join(root, manifest.main)
  return undefined
}

/** The probe must read core packages even when they live inside app.asar. */
function probeRuntime(core) {
  const electron = process.env.DSH_NODE_EXECUTABLE
  if (core.installDir.includes('.asar') && typeof electron === 'string' && electron.length > 0) {
    return { command: electron, prefix: [], env: { ELECTRON_RUN_AS_NODE: '1' } }
  }
  return { command: process.execPath, prefix: [] }
}

function lastJsonLine(text) {
  const lines = text.split('\n').reverse()
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      return JSON.parse(trimmed)
    } catch {
      // Not the probe payload.
    }
  }
  return undefined
}

/** Read an installed plugin's manifest through its exports, for tests. */
export function readPluginManifest(root) {
  return readJson(join(root, 'package.json'))
}
