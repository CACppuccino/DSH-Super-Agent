# Cloudflare Worker shared-memory backend

Worker + D1 backend for the DSH `dsh-project-memory` plugin. It stores the
project registry, per-project summaries (with version history) and append-only
detail notes so two machines can share project memory. Conversations, sessions,
worker transcripts and workspaces stay local and are never sent here.

The HTTP contract lives under `/v1`; every route requires
`Authorization: Bearer <MEMORY_TOKEN>` and JSON errors look like
`{"error":{"code":"...","message":"..."}}`.

## Current deployment (non-secret)

This repository's deployment already exists (2026-11-15):

- Worker URL: `https://dsh-project-memory.ziyang-liu03.workers.dev`
- D1 database: `dsh-project-memory`, id `cc6a9f97-e273-4025-b99d-d156b6eb3b74` (WNAM)
- The bearer token lives only in the Worker secret `MEMORY_TOKEN` and each Mac's
  Keychain; it is **not** in this repository.

`wrangler.toml` already contains that database id. For your own instance, replace it
with the id printed by `wrangler d1 create`.

## One-time deploy

Run from this directory (`packages/dsh-project-memory/cloudflare`) on one machine:

```sh
npm install                      # installs wrangler + workers types locally
npx wrangler login               # interactive browser login

npx wrangler d1 create dsh-project-memory
# Copy the printed database_id into wrangler.toml:
#   database_id = "REPLACE_WITH_D1_DATABASE_ID"

npx wrangler d1 migrations apply dsh-project-memory --remote

# Generate the shared bearer token once and store it in the Worker secret.
openssl rand -base64 48          # keep this value; each Mac needs it too
npx wrangler secret put MEMORY_TOKEN   # paste the token when prompted

npx wrangler deploy
```

`wrangler deploy` prints the Worker URL (`https://<name>.<subdomain>.workers.dev`
or your custom route). Use that as the plugin's cloud URL on every machine.

## Verify

```sh
TOKEN="<the shared token>"
curl -sS -H "Authorization: Bearer $TOKEN" https://<worker-url>/v1/health
# {"ok":true,"service":"dsh-project-memory","version":1,"time":...,"machineId":null}

curl -sS -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'X-Machine-Id: macbook-a' \
  -X POST https://<worker-url>/v1/projects \
  -d '{"identity":"git:github.com/me/repo","title":"Repo","pathHint":"/Users/me/repo"}'
```

A missing/invalid token returns `401 unauthorized`; a Worker whose
`MEMORY_TOKEN` secret is unset returns `500 config_error`; a broken D1
(unapplied migrations) returns `500 db_error` from `/v1/health`.

## Machine setup (per Mac)

From the package root (`packages/dsh-project-memory/`):

```sh
security add-generic-password -U -s dsh-project-memory -a cloudflare-token -w
node scripts/cloud-setup.mjs --url https://<worker-url> --machine-id macbook-a
node scripts/cloud-setup.mjs --check
```

`cloud.json` contains only the URL, machine id, Keychain names and (optionally) a
local proxy; the token lives in the macOS Keychain (service `dsh-project-memory`,
account `cloudflare-token`). See [`../cloud.json.example`](../cloud.json.example).

If this Mac's network blocks `*.workers.dev` (wrong DNS answer, TLS reset, or
timeouts) while ordinary HTTPS works, add a local HTTP CONNECT proxy:

```sh
node ../scripts/cloud-setup.mjs --url https://<worker-url> --machine-id macbook-a \
  --proxy http://127.0.0.1:15236
node ../scripts/cloud-setup.mjs --check
```

The proxy is per-machine (`cloud.json`); other Macs can connect directly.

## Operate

- **Schema changes:** add `migrations/0002_....sql` (never edit an applied
  migration), then `npx wrangler d1 migrations apply dsh-project-memory --remote`.
- **Rotate the token:** `npx wrangler secret put MEMORY_TOKEN`, then update the
  Keychain value on every Mac (`security add-generic-password -U ... -w`).
  The old token stops working as soon as the secret is updated.
- **Logs:** `npx wrangler tail` (observability is enabled in `wrangler.toml`).
  The Worker never logs the bearer token.
- **Local D1 console:** `npx wrangler d1 execute dsh-project-memory --remote --command "SELECT ..."`
  (read-only commands are safest).
- **Tear down:** `npx wrangler delete` and `npx wrangler d1 delete dsh-project-memory`.

## Tests

```sh
npm test
```

Tests run locally with `node --test` (Node >= 22.18, TypeScript type stripping)
against `worker/test/d1-shim.ts`, an in-memory D1 shim over the built-in
`node:sqlite` module. No network, `wrangler` or Cloudflare account is needed.
`node:sqlite` prints an experimental-feature warning; it is harmless.

Wrangler is **not** installed by the test script and this repository does not
deploy itself: `wrangler deploy`, `d1 migrations apply --remote` and running
the Worker in `workerd` can only be verified against a real Cloudflare account.
