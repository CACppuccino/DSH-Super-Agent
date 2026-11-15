import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  identityForProject,
  identityIsFresh,
  normalizeConfiguredIdentity,
  normalizeGitRemote,
  normalizeProjectTitle,
  readGitRemote,
  resolveProjectIdentity,
} from '../lib/backends/identity.js'

async function gitRepo(remote) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pm-git-')))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir })
  return dir
}

test('git remotes normalize to one identity across URL spellings', () => {
  const expected = 'github.com/mike/quantresearch'
  for (const remote of [
    'git@github.com:mike/QuantResearch.git',
    'git@github.com:mike/quantresearch',
    'ssh://git@github.com/mike/QuantResearch.git',
    'https://github.com/mike/QuantResearch.git',
    'https://user:token@github.com/mike/QuantResearch/',
    'github.com:mike/QuantResearch',
  ]) {
    assert.equal(normalizeGitRemote(remote), expected, remote)
  }
  assert.equal(normalizeGitRemote('https://gitlab.com/group/sub/repo.git'), 'gitlab.com/group/sub/repo')
  assert.equal(normalizeGitRemote(''), undefined)
  assert.equal(normalizeGitRemote('   '), undefined)
})

test('title fallback keeps unicode and is stable', () => {
  assert.equal(normalizeProjectTitle('My Project'), 'my-project')
  assert.equal(normalizeProjectTitle('  DSH   Project__Memory '), 'dsh-project-memory')
  assert.equal(normalizeProjectTitle('项目 记忆'), '项目-记忆')
  assert.equal(normalizeProjectTitle('***'), 'untitled')
})

test('identity prefers git, falls back to title, and honours config', () => {
  const gitIdentity = identityForProject({
    gitRemote: 'git@github.com:Mike/App.git',
    title: 'app',
    path: '/Users/a/app',
  })
  assert.deepEqual(gitIdentity, {
    identity: 'git:github.com/mike/app',
    identitySource: 'git',
    gitRemote: 'git@github.com:Mike/App.git',
  })

  const titleIdentity = identityForProject({ title: 'App', path: '/Users/a/app' })
  assert.equal(titleIdentity.identity, 'title:app')
  assert.equal(titleIdentity.identitySource, 'title')

  const configured = identityForProject({ path: '/x', override: 'github.com/me/shared.git' })
  assert.equal(configured.identity, 'git:github.com/me/shared')
  assert.equal(configured.identitySource, 'config')

  assert.deepEqual(normalizeConfiguredIdentity('title:My App'), { identity: 'title:my-app', identitySource: 'config' })
  assert.deepEqual(normalizeConfiguredIdentity('git@github.com:Me/Repo.git'), {
    identity: 'git:github.com/me/repo',
    identitySource: 'config',
  })
  assert.equal(normalizeConfiguredIdentity('   '), undefined)
})

test('readGitRemote reads origin and tolerates non-git paths', async () => {
  const dir = await gitRepo('git@github.com:example/shared.git')
  assert.equal(await readGitRemote(dir), 'git@github.com:example/shared.git')
  const plain = await mkdtemp(join(tmpdir(), 'pm-plain-'))
  assert.equal(await readGitRemote(plain), undefined)
  assert.equal(await readGitRemote('/definitely/missing/path'), undefined)
})

test('resolveProjectIdentity caches a fresh identity without running git', async () => {
  const now = Date.now()
  const record = {
    identity: 'git:github.com/example/app',
    identitySource: 'git',
    gitRemote: 'git@github.com:example/app.git',
    identityCheckedAt: now - 1_000,
  }
  const identity = await resolveProjectIdentity({
    path: '/tmp/whatever',
    title: 'app',
    record,
    now,
    execFileImpl: () => {
      throw new Error('git must not run for a fresh identity')
    },
  })
  assert.equal(identity.identity, record.identity)
  assert.equal(identity.identityCheckedAt, record.identityCheckedAt)

  const stale = await resolveProjectIdentity({
    path: '/tmp/whatever',
    title: 'app',
    record: { ...record, identityCheckedAt: now - 7 * 60 * 60 * 1000 },
    now,
    execFileImpl: (_command, _args, _options, callback) => callback(new Error('not a repo'), ''),
  })
  assert.equal(stale.identity, 'title:app')
  assert.equal(stale.identitySource, 'title')
  assert.equal(stale.identityCheckedAt, now)
})

test('remote-cache records keep the cloud identity and never re-derive it', async () => {
  const now = Date.now()
  const identity = await resolveProjectIdentity({
    path: '/root/.cloud/remote/app-123',
    title: 'App',
    record: {
      identity: 'git:github.com/example/app',
      identitySource: 'git',
      remote: true,
      identityCheckedAt: now - 7 * 60 * 60 * 1000,
    },
    now,
    execFileImpl: () => {
      throw new Error('git must not run for a remote cache record')
    },
  })
  assert.equal(identity.identity, 'git:github.com/example/app')
  assert.equal(identity.identitySource, 'git')
  assert.equal(identityIsFresh({ identity: 'title:app', identityCheckedAt: 0 }, { now }), false)
  assert.equal(identityIsFresh({ identity: 'bad identity', identityCheckedAt: now }, { now }), false)
})
