/**
 * Host load probe.
 *
 * The Cordis loader's first contract with a host plugin is static: the module
 * must export a `name`, an `apply` function, and an optional `inject`
 * declaration. This child process imports one entry module and reports that
 * contract as JSON. It runs in its own process so a top-level throw or a
 * hanging import cannot take the scan down.
 */
import { pathToFileURL } from 'node:url'

const entry = process.argv[2]

try {
  const module = await import(pathToFileURL(entry).href)
  const inject = module.inject
  const report = {
    ok: true,
    entry,
    name: typeof module.name === 'string' ? module.name : null,
    apply: typeof module.apply,
    inject: inject === undefined ? null : Array.isArray(inject) ? 'array' : typeof inject,
    defaultExport: module.default === undefined ? null : typeof module.default,
    exports: Object.keys(module).sort(),
    error: null,
  }
  process.stdout.write(`\n${JSON.stringify(report)}\n`)
} catch (error) {
  const report = {
    ok: false,
    entry,
    name: null,
    apply: null,
    inject: null,
    defaultExport: null,
    exports: null,
    error: String(error && error.stack ? error.stack : error).slice(0, 4000),
  }
  process.stdout.write(`\n${JSON.stringify(report)}\n`)
  process.exitCode = 1
}
