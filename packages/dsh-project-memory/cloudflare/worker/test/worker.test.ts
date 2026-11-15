import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import worker from '../src/index.ts'
import { createTestD1 } from './d1-shim.ts'

const TOKEN = 'test-token-abc123'
const SERVICE = 'dsh-project-memory'

interface ApiOptions {
  token?: string | null
  machineId?: string | null
  body?: unknown
}

interface ApiResponse {
  status: number
  body: any
}

function setup() {
  const shim = createTestD1()
  const env = { DB: shim.db, MEMORY_TOKEN: TOKEN }

  async function api(method: string, path: string, options: ApiOptions = {}): Promise<ApiResponse> {
    const token = options.token === undefined ? TOKEN : options.token
    const machineId = options.machineId === undefined ? 'macbook-a' : options.machineId
    const headers = new Headers()
    if (token !== null) headers.set('authorization', `Bearer ${token}`)
    if (machineId !== null) headers.set('X-Machine-Id', machineId)
    if (options.body !== undefined) headers.set('content-type', 'application/json')
    const request = new Request(`https://memory.test${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
    const response = await worker.fetch(request, env, {})
    const text = await response.text()
    let body: any = text
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
    return { status: response.status, body }
  }

  return { env, shim, api, close: () => shim.close() }
}

async function scenario(run: (context: ReturnType<typeof setup>) => Promise<void>): Promise<void> {
  const context = setup()
  try {
    await run(context)
  } finally {
    context.close()
  }
}

function expectedProjectId(identity: string): string {
  const tail = identity.split(/[/:]/).pop() ?? ''
  const slug =
    tail
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32)
      .replace(/^-+|-+$/g, '') || 'project'
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 10)
  return `${slug}-${hash}`
}

async function register(
  api: (method: string, path: string, options?: ApiOptions) => Promise<ApiResponse>,
  options: { identity?: string; title?: string; pathHint?: string; machineId?: string | null } = {},
): Promise<any> {
  const identity = options.identity ?? 'git:github.com/acme/quant-research'
  const body: Record<string, unknown> = {
    identity,
    title: options.title ?? 'Quant Research',
  }
  if (options.pathHint !== undefined) body.pathHint = options.pathHint
  const response = await api('POST', '/v1/projects', {
    body,
    machineId: options.machineId === undefined ? 'macbook-a' : options.machineId,
  })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  return response.body
}

function noteInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'note-1',
    at: Date.now() - 1_000,
    title: 'A note',
    tags: ['工程'],
    body: 'body text',
    ...overrides,
  }
}

describe('auth and health', () => {
  test('health succeeds with a valid bearer token', async () => {
    await scenario(async ({ api }) => {
      const response = await api('GET', '/v1/health')
      assert.equal(response.status, 200)
      assert.equal(response.body.ok, true)
      assert.equal(response.body.service, SERVICE)
      assert.equal(response.body.version, 1)
      assert.equal(response.body.machineId, 'macbook-a')
      assert.ok(Number.isFinite(response.body.time))
      assert.ok(response.body.time <= Date.now())
    })
  })

  test('health reports machineId null when the header is absent', async () => {
    await scenario(async ({ api }) => {
      const response = await api('GET', '/v1/health', { machineId: null })
      assert.equal(response.status, 200)
      assert.equal(response.body.machineId, null)
    })
  })

  test('a wrong token is rejected with 401 unauthorized', async () => {
    await scenario(async ({ api }) => {
      const response = await api('GET', '/v1/health', { token: 'definitely-wrong' })
      assert.equal(response.status, 401)
      assert.deepEqual(response.body, {
        error: { code: 'unauthorized', message: 'missing or invalid bearer token' },
      })
    })
  })

  test('a missing token is rejected with 401 unauthorized', async () => {
    await scenario(async ({ api }) => {
      const response = await api('GET', '/v1/health', { token: null })
      assert.equal(response.status, 401)
      assert.equal(response.body.error.code, 'unauthorized')
    })
  })

  test('every route requires auth, including project reads', async () => {
    await scenario(async ({ api }) => {
      const response = await api('GET', '/v1/projects', { token: null })
      assert.equal(response.status, 401)
      assert.equal(response.body.error.code, 'unauthorized')
    })
  })

  test('a missing MEMORY_TOKEN is a 500 config_error', async () => {
    const request = new Request('https://memory.test/v1/health', {
      headers: { authorization: 'Bearer whatever' },
    })
    const response = await worker.fetch(request, { DB: undefined, MEMORY_TOKEN: '' } as any, {})
    assert.equal(response.status, 500)
    const body: any = await response.json()
    assert.equal(body.error.code, 'config_error')
  })

  test('a failed DB check is a 500 db_error', async () => {
    const original = console.error
    console.error = () => {}
    try {
      const request = new Request('https://memory.test/v1/health', {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      const broken = { prepare: () => { throw new Error('d1 unavailable') } }
      const response = await worker.fetch(request, { DB: broken, MEMORY_TOKEN: TOKEN } as any, {})
      assert.equal(response.status, 500)
      const body: any = await response.json()
      assert.equal(body.error.code, 'db_error')
    } finally {
      console.error = original
    }
  })

  test('unknown routes are 404 and unsupported methods on known routes are 405', async () => {
    await scenario(async ({ api }) => {
      const missing = await api('GET', '/v1/nope')
      assert.equal(missing.status, 404)
      assert.equal(missing.body.error.code, 'not_found')

      const wrongMethod = await api('POST', '/v1/health')
      assert.equal(wrongMethod.status, 405)
      assert.equal(wrongMethod.body.error.code, 'method_not_allowed')

      const wrongWrite = await api('PUT', '/v1/projects')
      assert.equal(wrongWrite.status, 405)
      assert.equal(wrongWrite.body.error.code, 'method_not_allowed')
    })
  })
})

describe('project registry', () => {
  test('registration is idempotent, derives a deterministic id and merges path hints', async () => {
    await scenario(async ({ api }) => {
      const identity = 'git:github.com/acme/quant-research'
      const first = await register(api, {
        identity,
        title: 'Quant Research',
        pathHint: '/Users/me/src/quant',
      })
      assert.equal(first.created, true)
      assert.equal(first.project.id, expectedProjectId(identity))
      assert.equal(first.project.identity, identity)
      assert.equal(first.project.identitySource, 'git')
      assert.equal(first.project.title, 'Quant Research')
      assert.equal(first.project.noteCount, 0)
      assert.equal(first.project.lastSeq, 0)
      assert.equal(first.project.summaryVersion, 0)
      assert.deepEqual(first.project.pathHints, [
        { machineId: 'macbook-a', path: '/Users/me/src/quant', at: first.project.pathHints[0].at },
      ])

      const second = await register(api, {
        identity,
        title: 'Quant Research v2',
        pathHint: '/Users/bob/src/quant',
        machineId: 'macbook-b',
      })
      assert.equal(second.created, false)
      assert.equal(second.project.id, first.project.id)
      assert.equal(second.project.title, 'Quant Research v2')
      assert.deepEqual(
        second.project.pathHints.map((hint: any) => [hint.machineId, hint.path]),
        [
          ['macbook-b', '/Users/bob/src/quant'],
          ['macbook-a', '/Users/me/src/quant'],
        ],
      )

      const replayed = await register(api, {
        identity,
        title: 'Quant Research v2',
        pathHint: '/Users/bob/src/quant',
        machineId: 'macbook-b',
      })
      assert.equal(replayed.created, false)
      assert.equal(replayed.project.pathHints.length, 2)
    })
  })

  test('path hints are capped at 20, newest first', async () => {
    await scenario(async ({ api }) => {
      const identity = 'git:github.com/acme/hint-cap'
      for (let index = 0; index < 22; index += 1) {
        await register(api, {
          identity,
          title: `Hint cap ${index}`,
          pathHint: `/p/${index}`,
          machineId: `mac-${index}`,
        })
      }
      const response = await api('GET', '/v1/projects')
      const project = response.body.projects.find((entry: any) => entry.identity === identity)
      assert.equal(project.pathHints.length, 20)
      assert.equal(project.pathHints[0].path, '/p/21')
      assert.equal(project.pathHints[19].path, '/p/2')
    })
  })

  test('machine id can come from the body only when the header is absent', async () => {
    await scenario(async ({ api }) => {
      const viaBody = await api('POST', '/v1/projects', {
        machineId: null,
        body: {
          identity: 'git:github.com/acme/body-machine',
          title: 'Body machine',
          pathHint: '/tmp/body-machine',
          machineId: 'macbook-c',
        },
      })
      assert.equal(viaBody.status, 200)
      assert.equal(viaBody.body.project.pathHints[0].machineId, 'macbook-c')

      const headerWins = await api('POST', '/v1/projects', {
        machineId: 'macbook-a',
        body: {
          identity: 'git:github.com/acme/body-machine',
          title: 'Body machine',
          pathHint: '/tmp/body-machine',
          machineId: 'macbook-z',
        },
      })
      assert.equal(headerWins.status, 200)
      assert.equal(headerWins.body.project.pathHints[0].machineId, 'macbook-a')

      const missing = await api('POST', '/v1/projects', {
        machineId: null,
        body: { identity: 'git:github.com/acme/no-machine', title: 'No machine' },
      })
      assert.equal(missing.status, 400)
      assert.equal(missing.body.error.code, 'machine_id_required')

      const invalid = await api('POST', '/v1/projects', {
        machineId: 'bad machine id!',
        body: { identity: 'git:github.com/acme/no-machine', title: 'No machine' },
      })
      assert.equal(invalid.status, 400)
      assert.equal(invalid.body.error.code, 'machine_id_invalid')

      const invalidBody = await api('POST', '/v1/projects', {
        machineId: null,
        body: { identity: 'git:github.com/acme/no-machine', title: 'No machine', machineId: 'bad id!' },
      })
      assert.equal(invalidBody.status, 400)
      assert.equal(invalidBody.body.error.code, 'machine_id_invalid')
    })
  })

  test('different identities with the same title stay separate projects', async () => {
    await scenario(async ({ api }) => {
      const alice = await register(api, { identity: 'git:github.com/alice/app', title: 'App' })
      const bob = await register(api, { identity: 'git:github.com/bob/app', title: 'App' })
      assert.notEqual(alice.project.id, bob.project.id)

      const list = await api('GET', '/v1/projects')
      assert.equal(list.body.total, 2)
      assert.deepEqual(
        list.body.projects.map((project: any) => project.identity).sort(),
        ['git:github.com/alice/app', 'git:github.com/bob/app'],
      )
    })
  })
})

describe('notes', () => {
  test('single and batch append, tags round-trip and idempotent replays keep counters stable', async () => {
    await scenario(async ({ api }) => {
      const project = (await register(api)).project
      const firstAt = Date.now() - 5_000

      const single = await api('POST', `/v1/projects/${project.id}/notes`, {
        body: {
          note: noteInput({
            id: 'note-single',
            at: firstAt,
            authorRole: 'super',
            authorId: 'super-agent',
            title: 'Decision',
            tags: ['工程', '讨论'],
            body: 'Use D1 batches.',
          }),
        },
      })
      assert.equal(single.status, 200, JSON.stringify(single.body))
      assert.deepEqual(single.body.inserted, ['note-single'])
      assert.deepEqual(single.body.existing, [])
      assert.equal(single.body.project.noteCount, 1)
      assert.equal(single.body.project.lastSeq, 1)
      assert.equal(single.body.project.lastNoteAt, firstAt)
      assert.equal(single.body.paging.nextSinceSeq, 1)

      const batch = await api('POST', `/v1/projects/${project.id}/notes`, {
        body: {
          notes: [
            noteInput({ id: 'note-batch-1', at: firstAt + 1_000, tags: ['经验'], title: 'One' }),
            noteInput({ id: 'note-batch-2', at: firstAt + 2_000, tags: ['教训'], title: 'Two' }),
          ],
        },
      })
      assert.equal(batch.status, 200)
      assert.deepEqual(batch.body.inserted, ['note-batch-1', 'note-batch-2'])
      assert.equal(batch.body.project.noteCount, 3)
      assert.equal(batch.body.project.lastSeq, 3)
      assert.equal(batch.body.paging.nextSinceSeq, 3)

      const detail = await api('GET', `/v1/projects/${project.id}`)
      assert.equal(detail.status, 200)
      assert.equal(detail.body.notes.length, 3)
      const singleNote = detail.body.notes.find((note: any) => note.id === 'note-single')
      assert.deepEqual(singleNote.tags, ['工程', '讨论'])
      assert.equal(singleNote.authorRole, 'super')
      assert.equal(singleNote.authorId, 'super-agent')
      assert.equal(singleNote.machineId, 'macbook-a')
      assert.equal(singleNote.chars, 'Use D1 batches.'.length)
      assert.equal(singleNote.seq, 1)
      assert.equal(singleNote.body, 'Use D1 batches.')

      const replay = await api('POST', `/v1/projects/${project.id}/notes`, {
        body: { note: noteInput({ id: 'note-single', at: firstAt }) },
      })
      assert.equal(replay.status, 200)
      assert.deepEqual(replay.body.inserted, [])
      assert.deepEqual(replay.body.existing, ['note-single'])
      assert.equal(replay.body.project.noteCount, 3)
      assert.equal(replay.body.project.lastSeq, 3)

      const afterReplay = await api('GET', `/v1/projects/${project.id}`)
      assert.equal(afterReplay.body.notes.length, 3)
    })
  })

  test('notes paging uses server seq cursors, hasMore and sinceAt', async () => {
    await scenario(async ({ api }) => {
      const project = (await register(api)).project
      const base = Date.now() - 20_000
      const notes = []
      for (let index = 0; index < 5; index += 1) {
        notes.push(noteInput({ id: `page-${index}`, at: base + index * 1_000, title: `Page ${index}` }))
      }
      const appended = await api('POST', `/v1/projects/${project.id}/notes`, { body: { notes } })
      assert.equal(appended.status, 200)
      assert.deepEqual(appended.body.inserted, ['page-0', 'page-1', 'page-2', 'page-3', 'page-4'])

      const pageOne = await api('GET', `/v1/projects/${project.id}?notesLimit=2`)
      assert.deepEqual(pageOne.body.notes.map((note: any) => note.seq), [1, 2])
      assert.equal(pageOne.body.paging.hasMore, true)
      assert.equal(pageOne.body.paging.limit, 2)
      assert.equal(pageOne.body.paging.nextSinceSeq, 2)

      const pageTwo = await api('GET', `/v1/projects/${project.id}?notesSinceSeq=2&notesLimit=2`)
      assert.deepEqual(pageTwo.body.notes.map((note: any) => note.seq), [3, 4])
      assert.equal(pageTwo.body.paging.hasMore, true)
      assert.equal(pageTwo.body.paging.nextSinceSeq, 4)

      const pageThree = await api('GET', `/v1/projects/${project.id}?notesSinceSeq=4&notesLimit=2`)
      assert.deepEqual(pageThree.body.notes.map((note: any) => note.seq), [5])
      assert.equal(pageThree.body.paging.hasMore, false)
      assert.equal(pageThree.body.paging.nextSinceSeq, 5)

      const empty = await api('GET', `/v1/projects/${project.id}?notesSinceSeq=5&notesLimit=2`)
      assert.deepEqual(empty.body.notes, [])
      assert.equal(empty.body.paging.hasMore, false)
      assert.equal(empty.body.paging.nextSinceSeq, 5)

      const sinceAt = await api('GET', `/v1/projects/${project.id}?sinceAt=${base + 2_000}`)
      assert.deepEqual(sinceAt.body.notes.map((note: any) => note.id), ['page-2', 'page-3', 'page-4'])

      const badSeq = await api('GET', `/v1/projects/${project.id}?notesSinceSeq=-1`)
      assert.equal(badSeq.status, 400)
      assert.equal(badSeq.body.error.code, 'notes_since_invalid')

      const badLimit = await api('GET', `/v1/projects/${project.id}?notesLimit=201`)
      assert.equal(badLimit.status, 400)
      assert.equal(badLimit.body.error.code, 'notes_limit_invalid')
    })
  })

  test('a note id owned by another project is reported existing and never moved', async () => {
    await scenario(async ({ api }) => {
      const projectA = (await register(api, { identity: 'git:github.com/acme/a', title: 'A' })).project
      const projectB = (await register(api, { identity: 'git:github.com/acme/b', title: 'B' })).project

      const created = await api('POST', `/v1/projects/${projectA.id}/notes`, {
        body: { note: noteInput({ id: 'global-note-id', body: 'owned by A', tags: ['研究'] }) },
      })
      assert.deepEqual(created.body.inserted, ['global-note-id'])

      const collision = await api('POST', `/v1/projects/${projectB.id}/notes`, {
        body: { note: noteInput({ id: 'global-note-id', body: 'trying to overwrite', title: 'Collision' }) },
      })
      assert.equal(collision.status, 200)
      assert.deepEqual(collision.body.inserted, [])
      assert.deepEqual(collision.body.existing, ['global-note-id'])
      assert.equal(collision.body.project.noteCount, 0)

      const detailA = await api('GET', `/v1/projects/${projectA.id}`)
      assert.equal(detailA.body.notes.length, 1)
      assert.equal(detailA.body.notes[0].body, 'owned by A')

      const detailB = await api('GET', `/v1/projects/${projectB.id}`)
      assert.equal(detailB.body.notes.length, 0)
      assert.equal(detailB.body.project.noteCount, 0)
    })
  })

  test('note validation rejects bad ids, timestamps, titles, bodies, tags and duplicates', async () => {
    await scenario(async ({ api }) => {
      const project = (await register(api)).project
      const path = `/v1/projects/${project.id}/notes`
      const cases: Array<[string, Record<string, unknown>, string]> = [
        ['bad id', noteInput({ id: '-leading-dash' }), 'note_id_invalid'],
        ['bad at', noteInput({ id: 'valid-1', at: Date.now() + 8 * 24 * 60 * 60 * 1_000 }), 'note_at_invalid'],
        ['bad title', noteInput({ id: 'valid-2', title: 'x'.repeat(201) }), 'note_title_invalid'],
        ['bad body', noteInput({ id: 'valid-3', body: 'x'.repeat(65_537) }), 'note_body_invalid'],
        ['bad tag', noteInput({ id: 'valid-4', tags: ['experience'] }), 'note_tags_invalid'],
        ['empty tags', noteInput({ id: 'valid-5', tags: [] }), 'note_tags_invalid'],
        ['bad role', noteInput({ id: 'valid-6', authorRole: 'admin' }), 'note_author_role_invalid'],
        ['bad author', noteInput({ id: 'valid-7', authorId: 'x'.repeat(201) }), 'note_author_id_invalid'],
      ]
      for (const [label, note, code] of cases) {
        const response = await api('POST', path, { body: { note } })
        assert.equal(response.status, 400, label)
        assert.equal(response.body.error.code, code, label)
      }

      const duplicate = await api('POST', path, {
        body: {
          notes: [noteInput({ id: 'dupe' }), noteInput({ id: 'dupe' })],
        },
      })
      assert.equal(duplicate.status, 400)
      assert.equal(duplicate.body.error.code, 'note_duplicate')

      const tooMany = await api('POST', path, {
        body: {
          notes: Array.from({ length: 51 }, (_value, index) => noteInput({ id: `too-many-${index}` })),
        },
      })
      assert.equal(tooMany.status, 400)
      assert.equal(tooMany.body.error.code, 'notes_too_many')

      const detail = await api('GET', `/v1/projects/${project.id}`)
      assert.equal(detail.body.project.noteCount, 0)

      const missingProject = await api('POST', '/v1/projects/nope-123/notes', {
        body: { note: noteInput({ id: 'orphan' }) },
      })
      assert.equal(missingProject.status, 404)
      assert.equal(missingProject.body.error.code, 'project_not_found')
    })
  })
})

describe('summaries', () => {
  test('summary versions advance, archive, replay idempotently and flag conflicts', async () => {
    await scenario(async ({ api }) => {
      const project = (await register(api)).project
      const summaryPath = `/v1/projects/${project.id}/summary`

      const first = await api('PUT', summaryPath, {
        body: { content: 'v1', clientOpId: 'op-1' },
      })
      assert.equal(first.status, 200, JSON.stringify(first.body))
      assert.equal(first.body.summary.version, 1)
      assert.equal(first.body.summary.chars, 2)
      assert.equal(first.body.summary.updatedBy, 'macbook-a')
      assert.equal(first.body.summary.clientOpId, 'op-1')
      assert.equal(first.body.previousVersion, 0)
      assert.equal(first.body.conflict, false)
      assert.equal(first.body.idempotent, false)
      assert.equal(first.body.archivedVersion, null)

      const detailV1 = await api('GET', `/v1/projects/${project.id}`)
      assert.equal(detailV1.body.summary.content, 'v1')
      assert.equal(detailV1.body.summary.version, 1)
      assert.equal(detailV1.body.project.summaryChars, 2)
      assert.equal(detailV1.body.project.summaryVersion, 1)

      const second = await api('PUT', summaryPath, {
        body: { content: 'v2 content', clientOpId: 'op-2', baseVersion: 1 },
        machineId: 'macbook-b',
      })
      assert.equal(second.body.summary.version, 2)
      assert.equal(second.body.previousVersion, 1)
      assert.equal(second.body.archivedVersion, 1)
      assert.equal(second.body.conflict, false)
      assert.equal(second.body.idempotent, false)
      assert.equal(second.body.summary.updatedBy, 'macbook-b')

      const versionsAfterSecond = await api('GET', `/v1/projects/${project.id}/summary/versions`)
      assert.equal(versionsAfterSecond.status, 200)
      assert.equal(versionsAfterSecond.body.currentVersion, 2)
      assert.deepEqual(
        versionsAfterSecond.body.versions.map((entry: any) => [entry.version, entry.current]),
        [
          [2, true],
          [1, false],
        ],
      )

      const archivedV1 = await api('GET', `/v1/projects/${project.id}/summary/versions/1`)
      assert.equal(archivedV1.status, 200)
      assert.equal(archivedV1.body.content, 'v1')
      assert.equal(archivedV1.body.chars, 2)
      assert.equal(archivedV1.body.clientOpId, 'op-1')

      const currentV2 = await api('GET', `/v1/projects/${project.id}/summary/versions/2`)
      assert.equal(currentV2.status, 200)
      assert.equal(currentV2.body.content, 'v2 content')

      const replay = await api('PUT', summaryPath, {
        body: { content: 'v2 content', clientOpId: 'op-2', baseVersion: 2 },
      })
      assert.equal(replay.body.summary.version, 2)
      assert.equal(replay.body.previousVersion, 2)
      assert.equal(replay.body.idempotent, true)
      assert.equal(replay.body.conflict, false)
      assert.equal(replay.body.archivedVersion, null)

      const versionsAfterReplay = await api('GET', `/v1/projects/${project.id}/summary/versions`)
      assert.equal(versionsAfterReplay.body.versions.length, 2)
      assert.equal(versionsAfterReplay.body.currentVersion, 2)

      const conflict = await api('PUT', summaryPath, {
        body: { content: 'v3 newest', clientOpId: 'op-3', baseVersion: 1 },
      })
      assert.equal(conflict.body.summary.version, 3)
      assert.equal(conflict.body.previousVersion, 2)
      assert.equal(conflict.body.conflict, true)
      assert.equal(conflict.body.idempotent, false)
      assert.equal(conflict.body.archivedVersion, 2)

      const versionsAfterConflict = await api('GET', `/v1/projects/${project.id}/summary/versions`)
      assert.equal(versionsAfterConflict.body.currentVersion, 3)
      assert.deepEqual(
        versionsAfterConflict.body.versions.map((entry: any) => [entry.version, entry.current]),
        [
          [3, true],
          [2, false],
          [1, false],
        ],
      )
      const archivedV2 = await api('GET', `/v1/projects/${project.id}/summary/versions/2`)
      assert.equal(archivedV2.body.content, 'v2 content')

      const detailV3 = await api('GET', `/v1/projects/${project.id}`)
      assert.equal(detailV3.body.summary.content, 'v3 newest')
      assert.equal(detailV3.body.project.summaryVersion, 3)
      assert.equal(detailV3.body.project.summaryChars, 'v3 newest'.length)

      const withoutSummary = await api('GET', `/v1/projects/${project.id}?includeSummary=0`)
      assert.equal(withoutSummary.body.summary, null)
      assert.equal(withoutSummary.body.project.summaryVersion, 3)

      const limited = await api('GET', `/v1/projects/${project.id}/summary/versions?limit=1`)
      assert.deepEqual(limited.body.versions.map((entry: any) => entry.version), [3])
      assert.equal(limited.body.currentVersion, 3)

      const notFound = await api('GET', `/v1/projects/${project.id}/summary/versions/99`)
      assert.equal(notFound.status, 404)
      assert.equal(notFound.body.error.code, 'summary_version_not_found')

      const malformed = await api('GET', `/v1/projects/${project.id}/summary/versions/abc`)
      assert.equal(malformed.status, 404)
      assert.equal(malformed.body.error.code, 'summary_version_not_found')
    })
  })

  test('summary validation enforces content, op id, base version and project existence', async () => {
    await scenario(async ({ api }) => {
      const project = (await register(api)).project
      const path = `/v1/projects/${project.id}/summary`

      const oversized = await api('PUT', path, {
        body: { content: 'x'.repeat(32_769), clientOpId: 'op-big' },
      })
      assert.equal(oversized.status, 400)
      assert.equal(oversized.body.error.code, 'summary_content_invalid')

      const empty = await api('PUT', path, { body: { content: '', clientOpId: 'op-empty' } })
      assert.equal(empty.status, 400)
      assert.equal(empty.body.error.code, 'summary_content_invalid')

      const badOp = await api('PUT', path, { body: { content: 'hello', clientOpId: 'bad op!' } })
      assert.equal(badOp.status, 400)
      assert.equal(badOp.body.error.code, 'summary_op_invalid')

      const badBase = await api('PUT', path, {
        body: { content: 'hello', clientOpId: 'op-base', baseVersion: -1 },
      })
      assert.equal(badBase.status, 400)
      assert.equal(badBase.body.error.code, 'summary_base_invalid')

      const missingProject = await api('PUT', '/v1/projects/nope-123/summary', {
        body: { content: 'hello', clientOpId: 'op-missing' },
      })
      assert.equal(missingProject.status, 404)
      assert.equal(missingProject.body.error.code, 'project_not_found')

      const versionsMissingProject = await api('GET', '/v1/projects/nope-123/summary/versions')
      assert.equal(versionsMissingProject.status, 404)
      assert.equal(versionsMissingProject.body.error.code, 'project_not_found')
    })
  })
})

describe('D1 shim', () => {
  test('batch is atomic and prepared statements are reusable', async () => {
    const shim = createTestD1()
    try {
      const insert = shim.db.prepare(
        `INSERT INTO projects (id, identity, identity_source, title, created_at, updated_at)
         VALUES (?, ?, 'git', 'title', 1, 1)`,
      )

      const results = await shim.db.batch([
        insert.bind('id-a', 'git:example.com/a'),
        insert.bind('id-b', 'git:example.com/b'),
      ])
      assert.equal(results.length, 2)
      assert.equal(results[0].meta.changes, 1)
      assert.equal(results[1].meta.changes, 1)

      const count = await shim.db.prepare('SELECT COUNT(*) AS n FROM projects').first<{ n: number }>()
      assert.equal(count?.n, 2)

      // The unbound statement can be bound again with different values.
      assert.equal(
        (await insert.bind('id-c', 'git:example.com/c').run()).meta.changes,
        1,
      )
      assert.equal(await shim.db.prepare('SELECT 42 AS value').first('value'), 42)

      // A failing statement rolls the whole batch back.
      await assert.rejects(
        shim.db.batch([
          insert.bind('id-d', 'git:example.com/d'),
          shim.db.prepare('INSERT INTO projects (id) VALUES (?)').bind('id-e'),
        ]),
      )
      const after = await shim.db.prepare('SELECT COUNT(*) AS n FROM projects').first<{ n: number }>()
      assert.equal(after?.n, 3)
      assert.equal(
        await shim.db.prepare('SELECT * FROM projects WHERE id = ?').bind('id-d').first(),
        null,
      )
    } finally {
      shim.close()
    }
  })
})

describe('registry reads and input limits', () => {
  test('project list reports counters from real note/summary rows', async () => {
    await scenario(async ({ api }) => {
      const projectA = (await register(api, { identity: 'git:github.com/acme/list-a', title: 'List A' })).project
      const projectB = (await register(api, { identity: 'git:github.com/acme/list-b', title: 'List B' })).project

      const at = Date.now() - 1_000
      const notes = await api('POST', `/v1/projects/${projectA.id}/notes`, {
        body: {
          notes: [
            noteInput({ id: 'list-note-1', at }),
            noteInput({ id: 'list-note-2', at: at + 500 }),
          ],
        },
      })
      assert.deepEqual(notes.body.inserted, ['list-note-1', 'list-note-2'])

      const summary = await api('PUT', `/v1/projects/${projectA.id}/summary`, {
        body: { content: 'summary text', clientOpId: 'list-op' },
      })
      assert.equal(summary.body.summary.version, 1)

      const list = await api('GET', '/v1/projects')
      assert.equal(list.status, 200)
      assert.equal(list.body.total, 2)
      const a = list.body.projects.find((project: any) => project.id === projectA.id)
      const b = list.body.projects.find((project: any) => project.id === projectB.id)
      assert.equal(a.noteCount, 2)
      assert.equal(a.lastSeq, 2)
      assert.equal(a.lastNoteAt, at + 500)
      assert.equal(a.summaryVersion, 1)
      assert.equal(a.summaryChars, 'summary text'.length)
      assert.equal(a.summaryUpdatedBy, 'macbook-a')
      assert.equal(typeof a.summaryUpdatedAt, 'number')
      assert.equal(b.noteCount, 0)
      assert.equal(b.lastSeq, 0)
      assert.equal(b.summaryVersion, 0)
      assert.equal(b.pathHints.length, 0)

      const limited = await api('GET', '/v1/projects?limit=1')
      assert.equal(limited.body.projects.length, 1)
      assert.equal(limited.body.total, 2)

      for (const bad of ['0', '201', 'abc', '']) {
        const response = await api('GET', `/v1/projects?limit=${bad}`)
        assert.equal(response.status, 400, `limit=${bad}`)
        assert.equal(response.body.error.code, 'limit_invalid')
      }
    })
  })

  test('project registration validation rejects bad identities, titles, sources and hints', async () => {
    await scenario(async ({ api }) => {
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ identity: 'github.com/acme/repo', title: 'x' }, 'identity_invalid'],
        [{ identity: 'git:UPPER/Case', title: 'x' }, 'identity_invalid'],
        [{ identity: 'git:github.com/acme/repo', title: '' }, 'title_invalid'],
        [{ identity: 'git:github.com/acme/repo', title: 'x'.repeat(201) }, 'title_invalid'],
        [
          { identity: 'git:github.com/acme/repo', title: 'x', identitySource: 'other' },
          'identity_source_invalid',
        ],
        [
          { identity: 'git:github.com/acme/repo', title: 'x', pathHint: 'x'.repeat(1_025) },
          'path_hint_invalid',
        ],
      ]
      for (const [body, code] of cases) {
        const response = await api('POST', '/v1/projects', { body })
        assert.equal(response.status, 400, JSON.stringify(body))
        assert.equal(response.body.error.code, code)
      }

      const unknown = await api('GET', '/v1/projects/missing-project')
      assert.equal(unknown.status, 404)
      assert.equal(unknown.body.error.code, 'project_not_found')
    })
  })
})
