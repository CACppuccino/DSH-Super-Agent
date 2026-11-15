import test from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ProjectMemoryService } from '../lib/service.js'
import { FakeAgent, catalogFor, makeService, makeStore } from './helpers.js'

async function loadHarnessSchemaValidator() {
  const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
  const file = join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')
  try {
    const module = await import(pathToFileURL(file).href)
    return typeof module.assertSupportedJsonSchema === 'function' ? module.assertSupportedJsonSchema : undefined
  } catch {
    return undefined
  }
}

test('every generated tool schema stays inside the Harness JSON-schema subset', async (t) => {
  const assertSupportedJsonSchema = await loadHarnessSchemaValidator()
  if (!assertSupportedJsonSchema) {
    t.skip('@deepseek-ai/dsh-tools is not installed in this environment')
    return
  }
  const { store } = await makeStore()
  const catalog = catalogFor({ superPath: '/tmp/super', workerPath: '/tmp/a', otherPath: '/tmp/b' })
  const service = makeService({ store, catalog })
  const agents = [
    new FakeAgent('super-1', { cwd: '/tmp/super' }),
    new FakeAgent('worker-1', { cwd: '/tmp/a' }),
  ]
  for (const agent of agents) {
    service.registerAgent(agent)
    assert.ok(agent.tools.size > 0)
    for (const [name, definition] of agent.tools) {
      assert.doesNotThrow(
        () => assertSupportedJsonSchema(definition.parameters),
        `${name} parameters must be accepted by dsh-tools`,
      )
      assert.doesNotThrow(
        () => assertSupportedJsonSchema(definition.output.schema),
        `${name} output schema must be accepted by dsh-tools`,
      )
    }
  }
})
