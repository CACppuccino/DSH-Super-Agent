import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createCatalogReader, defaultSuperAgentStateFile } from '../lib/catalog.js'
import { defaultMemoryRoot } from '../lib/projects.js'
import { tempDir, writeCatalog } from './helpers.js'

test('the catalog reader sees a file written after it was created', async () => {
  const dir = await tempDir('pm-catalog-')
  const file = join(dir, 'state.json')
  const reader = createCatalogReader({ file })
  assert.equal(reader.readSync().exists, false)
  await writeCatalog(file, {
    conversations: { 'super-1': { id: 'super-1', kind: 'super', workspacePath: '/tmp/super' } },
    workspaces: { 'ws-a': { id: 'ws-a', path: '/tmp/a', title: 'A' } },
  })
  const first = reader.readSync()
  assert.equal(first.exists, true)
  assert.equal(first.conversations['super-1'].kind, 'super')
  assert.equal(first.workspaces['ws-a'].path, '/tmp/a')
})

test('the catalog path follows DSH_HOME, profile, and the explicit override', () => {
  assert.equal(
    defaultSuperAgentStateFile({ DSH_HOME: '/tmp/home', DSH_PROFILE: 'desktop' }, ['node'], '/home/me'),
    '/tmp/home/state/dsh-super-agent/state.json',
  )
  assert.equal(
    defaultSuperAgentStateFile({ DSH_HOME: '/tmp/home', DSH_PROFILE: 'web' }, ['node'], '/home/me'),
    '/tmp/home/state/dsh-super-agent/profiles/web/state.json',
  )
  assert.equal(
    defaultSuperAgentStateFile({ DSH_SUPERAGENT_STATE_DIR: '/tmp/custom' }, ['node'], '/home/me'),
    '/tmp/custom/state.json',
  )
})

test('the memory root honors DSH_PROJECT_MEMORY_DIR and DSH_HOME', () => {
  assert.equal(
    defaultMemoryRoot({ DSH_HOME: '/tmp/home' }, '/home/me'),
    '/tmp/home/state/dsh-project-memory',
  )
  assert.equal(
    defaultMemoryRoot({ DSH_PROJECT_MEMORY_DIR: '/tmp/custom-memory', DSH_HOME: '/tmp/home' }, '/home/me'),
    '/tmp/custom-memory',
  )
})
