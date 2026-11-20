---
name: dsh-plugin-upgrade-compat
description: "Use when the DSH core was upgraded, or before/after installing a new DeepSeek Harness release, to check every installed plugin (Super Agent, dsh-remote, local and third-party plugins) for breakage: import/export surface, host services, events, client injects and slots, routes, tools, manifest engines, plus plugin tests and a host load probe. Scans read-only, writes a deterministic report, and applies only versioned, sourced rename/removal rules with tests and rollback."
whenToUse: "After upgrading DeepSeek Harness (dsh --version changed), after switching a profile to a new core, when a plugin silently stops working after an update, or as a release gate before publishing a plugin against a newer core."
---

# DSH plugin upgrade compatibility

A DSH core upgrade can break an installed plugin without any error at install
time: a renamed service, a removed export, a changed event, or a missing client
slot. This skill scans every plugin against the **running** installation,
reports `OK / DEGRADED / BROKEN` with `file:line` evidence, ranks fixes, and can
apply a small, versioned set of proven renames — never a guess.

Read-only by default. The scan writes only its own report files; `--apply` is
opt-in and restores every edited file when the plugin's tests fail.

## Run this after every core upgrade

```sh
# 1. scan (read-only). Exit 0 = no installed plugin is newly BROKEN.
node ~/.dsh/skills/dsh-plugin-upgrade-compat/scripts/compat-scan.mjs

# 2. read the report (ranked fix list is at the end)
open ~/.dsh/skills/dsh-plugin-upgrade-compat/reports/report.md

# 3. dry-run the adaptation rules (no writes)
node ~/.dsh/skills/dsh-plugin-upgrade-compat/scripts/compat-adapt.mjs

# 4. apply only rule-matched edits, with plugin tests + rollback
node ~/.dsh/skills/dsh-plugin-upgrade-compat/scripts/compat-adapt.mjs --apply
```

Add `--strict` to the scan to fail on `DEGRADED` too, `--no-tests` for a fast
static-only pass, and `--only dsh-remote` to narrow the run.

In DSH Desktop the core lives inside `app.asar`, which plain Node cannot read.
Inside a DSH session `DSH_NODE_EXECUTABLE` is set, so the script re-executes
itself under the app's Electron binary automatically. Outside a DSH session,
point it at a readable checkout or the running Electron binary:

```sh
DSH_NODE_EXECUTABLE='/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' \
  node ~/.dsh/skills/dsh-plugin-upgrade-compat/scripts/compat-scan.mjs
# or: node .../compat-scan.mjs --core /path/to/apps/cli
```

## What the scan checks

For every plugin discovered from the live profiles, the plugin repositories, and
`$DSH_HOME/plugins`:

| Area | Check |
| --- | --- |
| Manifest | `engines.dsh` / dsh peer requirements through the core's own `evaluatePluginCompatibility`, `engines.node`, `dsh.manifestVersion`, bundle patch file, client declaration shape, exported files |
| Imports | every `import` / `require` / `import()` of `@deepseek-ai/dsh-*` and `dsh/...`, resolved against the installed packages' real `exports`; named symbols compared with the built module's exports |
| Host extension points | `inject` (required and optional) and `ctx.<service>` reads against the core's `interface Context` declarations |
| Events | `ctx.on` / `ctx.once` / `ctx.emit` names against the core's `interface Events` catalog, with the declared dispatch mode |
| Client | `dsh.client.inject` module ids (installed package or Web static module), client service injects, slot registrations and `slots.inject` names |
| Routes | `webServer.register` kinds (`exact` / `prefix`), path shape, collisions |
| Tools | tool names the plugin registers, collisions with core tools |
| Copies | repository vs live-install drift for the same package |
| Runtime | a child-process load probe of the host entry (`name` / `apply` / `inject` contract) and the plugin's own test suite, recording the first error |

Statuses: `BROKEN` = hard requirement missing or a failing load/test;
`DEGRADED` = review needed (optional service, plugin-emitted event, drift);
`OK` = every check passed. Source-only copies that no profile loads are marked
`(source-only)` and do not fail the upgrade gate. With a baseline in place, an
issue the baseline already recorded is marked `(pre-existing)` and does not
fail the gate — only regressions do. Pass `--fail-on-preexisting` to gate on
the absolute state instead.

The report is deterministic (sorted, no timestamps):
`reports/report.json` for tooling and `reports/report.md` for humans. Every
finding carries `file:line` evidence and a ranked fix.

## Adapt rules

`scripts/rules.json` is the only source of automated edits. Each rule has an
`id`, `kind`, `since` (core version), a `source` path into the installed
`docs/upgrade-guide/` tree, and an old→new replacement. A finding without a
matching rule is reported as `NEEDS_MANUAL`; the adapter never invents an API.

`--apply` preconditions:

1. every touched plugin root is a clean git work tree, or `--allow-dirty` is passed;
2. the rule exists and its `source` guide is present in the running core;
3. after editing, the plugin's own test suite passes — otherwise every file is
   restored from the in-memory backup and the run exits 1.

## Guardrails

- Never edit DSH core or the profile's installed packages as part of a scan.
  Adapt edits plugin source files only, and only through `rules.json`.
- Do not restart or reinstall the host to "make it work"; report what needs a
  restart and let the user decide.
- Treat `DEGRADED` event/slot findings as review items, not proof of breakage:
  the event may be emitted by another plugin in the same profile.
- If a source guide is missing from the installed core, the rule is stale: fix
  `rules.json`, do not apply it.
- Keep `baseline/latest.json` under version control. `--write-baseline` records
  the current core surface; the next upgrade then reports exactly what the core
  removed.

## Maintenance

After a DSH upgrade lands, add rules from the new
`docs/upgrade-guide/<version>/*/guide.md` files (old value, new value, guide
path), bump `rulesVersion`, refresh the baseline with
`compat-scan.mjs --write-baseline`, and commit both. Rule semantics and the
report schema are documented in `README.md`.
