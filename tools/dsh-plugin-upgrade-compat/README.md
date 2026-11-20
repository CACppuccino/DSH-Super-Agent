# dsh-plugin-upgrade-compat

A DSH skill that keeps installed plugins working across DeepSeek Harness core
upgrades. It scans the **running** installation, reports per-plugin
`OK / DEGRADED / BROKEN` with evidence, and applies only versioned,
source-referenced rename rules.

- Skill entry point: [`SKILL.md`](SKILL.md)
- Live copy: `~/.dsh/skills/dsh-plugin-upgrade-compat/` (this repository copy is
  the source of truth; sync it after changes)
- No build step, no dependencies: plain Node 24 (`node:test` for the tests).

## Quick start

```sh
node scripts/compat-scan.mjs                  # read-only scan → reports/report.{json,md}
node scripts/compat-scan.mjs --strict         # exit 1 on DEGRADED too
node scripts/compat-scan.mjs --no-tests       # fast static pass
node scripts/compat-scan.mjs --only dsh-remote
node scripts/compat-adapt.mjs                 # dry run: planned edits, no writes
node scripts/compat-adapt.mjs --apply         # edit + test + rollback on failure
node --test tests/unit.test.mjs tests/adapt.test.mjs
```

Exit codes: `0` clean, `1` an installed plugin is newly `BROKEN` (or `DEGRADED`
with `--strict`), `2` the scan could not run. When a baseline exists, a plugin
whose status matches the baseline is marked `(pre-existing)` and does not fail
the gate, so known issues do not mask regressions; `--fail-on-preexisting`
gates on the absolute state instead.

## How the skill is discovered

DSH's `@deepseek-ai/dsh-skill-filesystem` provider scans, in rank order:
`<project>/.dsh/skills`, `<project>/.agents/skills`, configured custom roots,
`~/.dsh/skills`, `~/.agents/skills`, and the bundled root. A directory skill is
a folder containing `SKILL.md` with YAML frontmatter (`name` must be kebab-case
and match the folder; `description` is required; `whenToUse` is optional).

This skill is installed at `~/.dsh/skills/dsh-plugin-upgrade-compat/SKILL.md`
(user-dsh root). The provider watches that root and invalidates its catalog on
change, so no host restart is needed: the skill appears on the next catalog
lookup (typically the next turn). Discovery only needs the folder and
`SKILL.md`; `scripts/`, `tests/`, and `baseline/` are loaded on demand by path.

## Discovery of plugins

| Source | Role | How |
| --- | --- | --- |
| `~/.dsh/profiles/*/package.json` dependencies | `live` | resolved through `<profile>/node_modules` (follows `link:` and workspace symlinks) |
| `~/.Projects/...` source roots in `scripts/config.json` | `repo` / `workspace` | package directories with a `dsh` field or a `dsh-*` name |
| `~/.dsh/plugins` | `installed` / `staged` | tarball/staged installs |
| profile `node_modules` | `live` | any remaining local plugin |

Core packages (`@deepseek-ai/dsh-*` present in the installation) are filtered
out. `config.json` holds the roots, exclusions, and check timeouts; edit it for
another machine instead of changing code.

## What is checked

`scripts/lib/core-surface.mjs` builds a read-only surface from the installation:

- installed `@deepseek-ai/*` packages: version, `exports`, resolved entry, and
  the entry module's exported names (ESM/CJS, re-exports followed one level);
- host services and events from `declare module '@deepseek-ai/cordis'`
  `interface Context` / `interface Events` augmentations in each package's
  shipped `src/`, including the event's `@mode`;
- client services from the same augmentation under `src/**/client/`;
- client slots from `slots.register` / `slots.inject` / `children` keys;
- core tool names from `defineTool({ name })` / `tools.register({ name })`;
- the Web frontend's static module map (the modules a client plugin may
  `require` without an installed package);
- WebServer route kinds and the core route paths that use literal constants.

`scripts/lib/analyze.mjs` then checks each plugin:

| Check id | Meaning |
| --- | --- |
| `manifest.compat` | core's own `evaluatePluginCompatibility` rejects `engines.dsh` / dsh peers |
| `manifest.export-file`, `manifest.bundle`, `manifest.client`, `manifest.entry` | declared files/fields are missing or malformed |
| `import.package`, `import.subpath`, `import.symbol` | import does not resolve against the installed core |
| `service.inject`, `service.optional`, `service.usage` | service not declared by the core |
| `event.unknown` | event not declared by the core (review: another plugin may emit it) |
| `client.inject.module`, `client.inject.service`, `client.slot` | client dependency not available in this composition |
| `route.kind`, `route.path`, `route.collision` | WebServer route contract |
| `tool.collision` | registered tool name collides with a core tool |
| `copy.drift` | repository and live copies of one package differ |
| `runtime.load`, `runtime.tests` | host load probe or plugin test suite failed |

Severity: a hard requirement (required service, missing import, invalid
manifest, failing load/test) is `BROKEN`; review items and optional fallbacks
are `DEGRADED`.

### Runtime smoke

- **Load probe** (`scripts/lib/host-load-probe.mjs`): imports the host entry in a
  child process and validates the Cordis load contract (`apply` function,
  optional `name`, `inject` array/object). Import failures are hard breaks.
- **Tests**: runs the plugin's `package.json` `scripts.test` (falling back to
  `node --test`) and records the first failing line. Exit 127 / missing runner
  is reported as `SKIPPED`, not as a plugin failure.

## Reports

`reports/report.json` and `reports/report.md`:

```json
{
  "schemaVersion": 1,
  "skill": { "name": "dsh-plugin-upgrade-compat", "rulesVersion": "2026-11-20.1" },
  "core": { "version": "0.2.2-rc.3", "installDir": "...", "catalogs": { "hostServices": 115 } },
  "plugins": [{
    "name": "dsh-remote",
    "installed": true,
    "kind": "bundle+host",
    "status": "DEGRADED",
    "roots": [{ "path": "...", "role": "live" }],
    "findings": [{ "check": "service.optional", "status": "DEGRADED", "service": "accountController", "message": "…", "evidence": "lib/compat.js:278", "ruleId": null }],
    "runtime": { "load": { "status": "PASS" }, "tests": { "status": "PASS" } }
  }],
  "summary": { "OK": 5, "DEGRADED": 5, "BROKEN": 1, "total": 11 },
  "fixList": [{ "rank": 3, "plugin": "dsh-remote", "check": "service.optional", "action": "…", "ruleId": null, "needsManual": true }],
  "diff": null
}
```

- Output is sorted and timestamp-free, so two scans of the same state are
  byte-identical.
- `file:line` evidence is relative to the plugin's primary root.
- The fix list ranks automated `BROKEN` fixes first, then manual `BROKEN`,
  automated `DEGRADED`, manual `DEGRADED`.
- `reports/` is gitignored; `baseline/` is committed.

## Baselines across upgrades

```sh
node scripts/compat-scan.mjs --write-baseline   # record the current core surface
# ... upgrade the core ...
node scripts/compat-scan.mjs                    # diffs against baseline/latest.json
```

`baseline/latest.json` (plus `baseline/core-<version>.json`) records package
versions and the service/event/slot/tool catalogs. The next scan reports what
the core removed, and upgrades a `DEGRADED` event/slot finding to `BROKEN` when
that name existed in the baseline.

## Rules and adaptation

`scripts/rules.json`:

```json
{
  "rulesVersion": "2026-11-20.1",
  "rules": [{
    "id": "dsh-0.2.1a1-web-runtime-service",
    "kind": "rename-service",
    "since": "0.2.1-alpha.1",
    "match": { "check": "service.inject", "service": "webRuntime" },
    "replace": { "old": "webRuntime", "new": "webStartup", "scope": "service-name" },
    "source": "docs/upgrade-guide/v0.2.1-alpha.1/web-listener-trust-config/guide.md"
  }]
}
```

`match` keys are compared with the same-named finding fields. Supported
`replace.scope` values: `package`, `service-name`, `ctx.get-argument`,
`property`, `value` / `provider-key`, `import-clause`. `kind: "manual"` marks a
rule that documents the change but must not be auto-applied. `unlessPresent`
skips the edit when the file already contains the new name.

`compat-adapt.mjs`:

1. plans edits only for findings whose `ruleId` matches (one edit per file+rule);
2. refuses a dirty/non-git tree unless `--allow-dirty`;
3. refuses a rule whose `source` guide is missing from the running core;
4. backs up in memory, writes each file, runs the affected plugins' tests;
5. on any failure restores every file and exits 1; on success prints
   `git diff --stat` per repository.

Findings without a rule are listed under `needsManual`.

## Files

```
SKILL.md                     skill frontmatter + agent instructions
README.md                    this document
scripts/compat-scan.mjs      scan CLI
scripts/compat-adapt.mjs     adaptation CLI
scripts/config.json          discovery roots, exclusions, timeouts
scripts/rules.json           versioned rename/removal rules with sources
scripts/lib/runtime.mjs      ASAR runtime, exports resolution, process helpers
scripts/lib/core-surface.mjs core package + catalog extraction
scripts/lib/plugins.mjs      plugin discovery and copy drift
scripts/lib/analyze.mjs      per-plugin checks
scripts/lib/rules.mjs        rule matching and scoped replacement
scripts/lib/probe.mjs        host load probe runner
scripts/lib/host-load-probe.mjs  child-process import probe
scripts/lib/report.mjs       deterministic Markdown/console output
tests/unit.test.mjs          parsing, rules, analyzer
tests/adapt.test.mjs         dry run, apply, rollback, dirty tree, determinism
baseline/                    committed core surface snapshots
reports/                     generated output (gitignored)
```

## Known limits

- Service/event/slot catalogs come from shipped TypeScript sources; a package
  that ships only built JavaScript contributes no declarations. The report says
  how many packages and sources were read.
- Client slot checks only see registrations written as literal names; computed
  slot ids are not resolved.
- The scan reads the current plugin source; it does not type-check it.
- Tests run in the developer environment, so a missing runner is `SKIPPED`;
  a real failing test is `BROKEN`.
