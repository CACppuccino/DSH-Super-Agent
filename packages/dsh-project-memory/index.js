/**
 * dsh-project-memory host half.
 *
 * Registers one standard `project-memory` skill and decorates live agent
 * scopes with role-scoped memory tools:
 *
 *   Super Agent  projects, summary read/write, notes read, search
 *   Worker       notes read, note append (own project only)
 *
 * Role detection reads the Super Agent catalog (`state.json`) and falls back
 * to the least-privileged worker role in the session cwd, so this plugin works
 * with or without `dsh-super-agent`.
 *
 * Storage lives under `$DSH_HOME/state/dsh-project-memory/`; override with
 * `DSH_PROJECT_MEMORY_DIR` in tests or isolated deployments.
 */
import { createCatalogReader, defaultSuperAgentStateFile } from './lib/catalog.js'
import { createBackend } from './lib/backends/create.js'
import { resolveBackendConfig } from './lib/config.js'
import { defaultMemoryRoot } from './lib/projects.js'
import { ProjectMemoryService } from './lib/service.js'
import { loadSkillDefinition, registerSkill } from './lib/skill.js'
import { ProjectMemoryStore } from './lib/store.js'

export const name = 'dsh-project-memory'
export const inject = ['agents', 'skills', 'tools']

/**
 * Mount the plugin.
 *
 * Config (all optional): `backend` (`auto` | `local` | `cloudflare`) and a
 * `cloudflare` block (`url`, `machineId`, `keychainService`, `keychainAccount`,
 * `timeoutMs`, …). Environment variables and `<root>/cloud.json` fill the same
 * fields; the bearer token itself only comes from the macOS Keychain (or
 * `DSH_PROJECT_MEMORY_TOKEN` for headless use).
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export async function apply(ctx, rawConfig = {}) {
  const config = await resolveBackendConfig(rawConfig ?? {}, { logger: ctx.logger })
  const rootDir = config.rootDir
  const store = await createBackend({ config, logger: ctx.logger })
  await store.init()
  const catalog = createCatalogReader({ file: defaultSuperAgentStateFile() })
  const skill = loadSkillDefinition()
  const service = new ProjectMemoryService({
    store,
    catalog,
    skills: ctx.skills,
    skill,
    logger: ctx.logger,
    clock: Date.now,
  })

  ctx.effect(() => registerSkill(ctx, skill), 'dsh-project-memory: project-memory skill')
  ctx.effect(() => ctx.on('agent/created', ({ agent }) => service.registerAgent(agent)), 'dsh-project-memory: decorate agents')
  ctx.effect(() => ctx.on('agent/disposed', ({ agent }) => service.disposeAgent(agent)), 'dsh-project-memory: release agents')
  ctx.effect(() => {
    for (const agent of ctx.agents.list()) service.registerAgent(agent)
    return () => {
      service.dispose()
      void Promise.resolve(store.close?.()).catch(() => {})
    }
  }, 'dsh-project-memory: existing agents')

  const catalogState = catalog.readSync()
  ctx.logger?.info?.(
    'dsh-project-memory ready (root: %s; backend: %s; super-agent catalog: %s)',
    rootDir,
    config.backend,
    catalogState.exists ? catalog.file : 'not found — notes-only mode',
  )
  if (config.configError) {
    ctx.logger?.warn?.(`dsh-project-memory: running with local cache only — ${config.configError}`)
  }
}

export { createBackend, resolveBackendConfig }
export { CloudflareBackend } from './lib/backends/cloudflare.js'
export { LocalFileBackend } from './lib/backends/local.js'
export { defaultMemoryRoot, defaultSuperAgentStateFile, ProjectMemoryService, ProjectMemoryStore }
export { TAG_VOCABULARY, normalizeTags } from './lib/tags.js'
export { SKILL_NAME, GUIDE_TOOL } from './lib/skill.js'
