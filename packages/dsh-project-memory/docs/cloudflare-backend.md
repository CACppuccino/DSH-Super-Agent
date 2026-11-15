# Cloudflare shared-memory backend — design

Goal: two Macs share **project memory only** (registry, per-project summary, detail notes),
while conversations, sessions, worker transcripts and workspaces stay local. The local
filesystem store remains the source of truth on each machine; a Cloudflare Worker + D1
database is the sync rendezvous.

```
Mac A                                    Mac B
┌────────────────────────────┐           ┌────────────────────────────┐
│ DSH + plugin               │           │ DSH + plugin               │
│  local store (cache/WAL)   │           │  local store (cache/WAL)   │
│  outbox (append-only)      │           │  outbox (append-only)      │
└─────────────┬──────────────┘           └─────────────┬──────────────┘
              │ HTTPS + bearer (Keychain)              │
              └──────────────► Worker + D1 ◄───────────┘
                       (projects, notes, summaries,
                        summary_versions)
```

**Scope boundaries.** Synced: registry identity/title/path hints, `summary.md`,
`notes.jsonl`. Never synced: `bindings.json`, conversation/session state, worker
transcripts, workspaces, the `locks/` directory. The cloud has no session concept.

## 1. Project identity (not the absolute path)

The two Macs may mount the same repo at different paths, so the directory path is only a
hint:

| Priority | Identity | Example |
|---|---|---|
| 1 | git remote URL, normalized | `git:github.com/mike/quantresearch` |
| 2 | normalized title | `title:quantresearch` |
| 3 | explicit override (`DSH_PROJECT_MEMORY_IDENTITY` or `project.json.identity`) | `git:github.com/me/repo` |

Normalization for a git remote: lowercase, strip credentials, `.git`, trailing slash and
default ports; `git@github.com:Foo/Bar.git`, `ssh://git@github.com/Foo/Bar` and
`https://github.com/Foo/Bar.git` all become `github.com/foo/bar`. The Worker derives the
stable project id as `<slug>-<sha256(identity)[:10]>`; the client never invents ids.

Every project row stores both machines' path hints as non-identity metadata:
`path_hints = [{machineId, path, at}, …]` (deduped, capped). If a hint exists on the other
Mac and its git remote matches, the client links the cloud project to that local checkout;
otherwise it caches the project under `$DSH_HOME/state/dsh-project-memory/.cloud/remote/<id>`.
A `title:` identity is a documented best-effort fallback (two unrelated projects with the
same basename would merge); adding a git remote upgrades the identity.

## 2. D1 schema (`cloudflare/migrations/0001_init.sql`)

- `projects(id PK, identity UNIQUE, identity_source, title, created_at, updated_at,
  last_note_at, summary_version, summary_updated_at, summary_updated_by, summary_chars,
  path_hints JSON)`.
- `notes(seq INTEGER PK AUTOINCREMENT, id UNIQUE, project_id, at, author_role, author_id,
  machine_id, title, tags JSON, body, created_at, updated_at)`.
- `summaries(project_id PK, content, chars, version, updated_at, updated_by, client_op_id)`.
- `summary_versions(project_id, version, content, chars, updated_at, updated_by,
  client_op_id, PK(project_id, version))` — every replaced summary.
- Indexes: `notes(project_id, seq)`, `notes(project_id, at)`, `projects(updated_at)`.
- `note_count` / `last_seq` are computed with subqueries, so no racy counters.

## 3. Worker API (`https://<worker>/v1`)

All requests: `Authorization: Bearer <MEMORY_TOKEN>` (Worker secret). Writes also send
`X-Machine-Id: <machine>`. JSON errors are `{"error":{"code","message"}}`.

| Method | Path | Meaning |
|---|---|---|
| GET | `/health` | token + DB check |
| GET | `/projects?limit=` | registry with note count, last note seq, summary version |
| POST | `/projects` | register/upsert by `identity`; merges `pathHint` |
| GET | `/projects/:id?notesSinceSeq=&notesLimit=&sinceAt=&includeSummary=` | project + summary + paged notes |
| POST | `/projects/:id/notes` | append `{note}` or `{notes:[…]}`; **idempotent by note id** |
| PUT | `/projects/:id/summary` | replace summary with `{content, clientOpId, baseVersion?}`; version +1 |
| GET | `/projects/:id/summary/versions` | version history metadata |
| GET | `/projects/:id/summary/versions/:version` | one historical summary body |

Limits mirror the local store: title ≤ 200, body ≤ 64 Ki chars, summary ≤ 32 Ki chars,
≤ 50 notes per append call, ≤ 200 notes per page, tags from the closed vocabulary.

## 4. Conflicts

- **Notes: append-only union.** The note id (globally random, created locally) is the
  idempotency key. `INSERT OR IGNORE`, so replays and two machines never overwrite or
  duplicate a note. Cursors use the server-assigned monotonic `seq`, not wall-clock time,
  so clock skew cannot skip a note.
- **Summaries: last-write-wins, previous version kept.** Each accepted write appends the
  current summary to `summary_versions` and increments `version` in one D1 batch
  (transaction). The response reports `previousVersion`, `conflict` when the client's
  `baseVersion` was stale, and `archivedVersion`. If the same `clientOpId` is replayed,
  the write is idempotent (no new version), which makes the offline replay safe.
- The client never imports a remote summary over a local summary that still has a pending
  upsert; after replay it pulls the server result.

## 5. Local cache, write-ahead queue, offline reads

- Local files remain exactly as today (`registry.json`, `projects/<key>/…`), so local
  mode and the plugin tests are unchanged. In cloud mode they are the cache.
- On first cloud registration, a project's existing local notes are uploaded once in
  batches (union by note id, idempotent); the local summary is uploaded only when the
  cloud has no summary yet. A `cloudBackfilledAt` marker in `project.json` prevents
  repeated backfill across restarts.
- `<root>/.cloud/outbox.jsonl` is an append-only WAL. Every local write is committed to
  the local store **first**, then a record is appended:
  `project.register`, `note.append`, `summary.upsert`. Successes append `ack` records;
  the queue is compacted atomically. A crash after a successful push but before the ack
  replays idempotently (note id / `clientOpId`).
- Replay happens on the next tool call (bounded budget) and on an unref'd 30 s timer.
  Transient failures (timeout, 5xx, 429, network) keep the record and back off
  exponentially; `401/403` pauses sync but keeps the queue. Permanent failures
  (`400/404/413`) move the record to `outbox-dead.jsonl` with the error, counted in results.
  A write is never silently dropped.
- Reads try a bounded sync first, then serve the local cache. If the cloud is unreachable
  the result carries `sync: {online:false, stale:true, lastSyncAt, pendingWrites, error}`.
  Nothing is written to the cache on a failed fetch.
- Timeouts: 2.5 s default per request, 3 attempts, jittered backoff (250→2000 ms cap),
  overall sync budget ~4 s so tool calls stay responsive. A failed sync never mutates the
  cache; imports use the store's atomic writes and append-only note import.
- Networks that block `*.workers.dev` directly (DNS poisoning or SNI reset) can set a
  per-machine HTTP CONNECT proxy in `cloud.json` (`--proxy http://127.0.0.1:<port>`).
  Node 22 fetch ignores `HTTPS_PROXY`, so the client ships a dependency-free CONNECT
  transport; TLS still validates the Worker hostname. The Worker and D1 are unchanged.

## 6. Auth

- One shared bearer token per installation, stored in the **macOS Keychain** on each Mac:
  service `dsh-project-memory`, account `cloudflare-token`. The Worker holds the same
  value as the `MEMORY_TOKEN` secret. Nothing is written to the repo, `cloud.json`, logs
  or tool output.
- Optional env override `DSH_PROJECT_MEMORY_TOKEN` (headless/CI); not recommended for the
  desktop.
- Per-machine id (`macbook-a`, `macbook-b`, …) is sent as `X-Machine-Id`, stored in
  `cloud.json` and per note (`machine_id`) / summary (`updated_by`) / path hints. It is
  attribution, not authentication.
- Cloudflare Access service tokens were considered; a plain bearer secret is simpler,
  works with HTTPS-only egress, and needs no Access application/audience configuration.
  The Worker can be locked down to one hostname; rotate by `wrangler secret put` and
  updating both Keychains.

## 7. What the user must do

One-time, per Mac (exact commands in `cloudflare/README.md`):

```sh
# 1. deploy once (any machine)
cd packages/dsh-project-memory/cloudflare
npm install
npx wrangler login                 # interactive browser login
npx wrangler d1 create dsh-project-memory
#    copy database_id into wrangler.toml
npx wrangler d1 migrations apply dsh-project-memory --remote
openssl rand -base64 48            # the shared bearer token
npx wrangler secret put MEMORY_TOKEN   # paste that token
npx wrangler deploy

# 2. on EACH Mac (same token value)
security add-generic-password -U -s dsh-project-memory -a cloudflare-token -w
node scripts/cloud-setup.mjs --url https://<worker-url> --machine-id macbook-a
#    restart DSH; the plugin auto-selects cloudflare when cloud.json + Keychain exist
```

`cloud.json` contains only the URL, machine id and Keychain names (mode 0600). The token
is never passed as a command-line argument or chat message.

## 8. Failure modes

| Failure | Behaviour |
|---|---|
| Worker down / no network | local reads from cache with `stale:true`; writes queued and replayed |
| Wrong/revoked token | sync pauses with `auth` error in tool results; local writes continue; queue retained |
| D1 missing migrations | Worker returns 500 with a clear `db_error`; client retries, cache untouched |
| Duplicate/retried write | idempotent by note id / `clientOpId`; no duplicates, no lost summary |
| Conflicting summaries | LWW + previous version archived; client reports `conflict` |
| Local cache corrupt | existing store rebuild logic (corrupt index moved aside, log re-read) |
| Outbox corrupt line | line skipped with a warning, rest of queue preserved (never fatal) |

## 9. Verification plan

1. Worker unit tests on a real SQLite (`node:sqlite` D1 shim): auth, identity upsert,
   idempotent notes, paging, summary versions/conflicts, limits.
2. Client tests with a fake fetch **and** an end-to-end two-machine test against the real
   Worker handler: A writes a note → B pulls it; B writes a summary → A pulls it; A and B
   write summaries from the same base → LWW, previous versions archived, conflict flagged.
3. Offline test: A with the network blocked writes a note and a summary, restarts, then
   reconnects → queue replay, no loss, B sees both.
4. Manual: create a note on Mac A, read it on Mac B; conflict summaries; disable Wi-Fi,
   write, restore, confirm replay.
