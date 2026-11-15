import test from 'node:test'
import assert from 'node:assert/strict'
import { TokenProvider } from '../lib/backends/keychain.js'

function fakeSecurity({ token, error, platform = 'darwin' } = {}) {
  const calls = []
  const execFileImpl = (command, args, options, callback) => {
    calls.push({ command, args, options })
    if (error) {
      callback(error, '')
      return
    }
    callback(null, `${token}\n`)
  }
  return { provider: new TokenProvider({ service: 'svc', account: 'acct', execFileImpl, platform }), calls }
}

test('the environment token is used without touching the Keychain', async () => {
  const execFileImpl = () => {
    throw new Error('must not run security')
  }
  const provider = new TokenProvider({ service: 'svc', account: 'acct', envToken: 'env-token', execFileImpl })
  assert.equal(provider.source, 'env')
  assert.equal(await provider.get(), 'env-token')
})

test('reads the Keychain, caches the token, and never exposes it in the command hint', async () => {
  const { provider, calls } = fakeSecurity({ token: 'keychain-token-value' })
  assert.equal(await provider.get(), 'keychain-token-value')
  assert.equal(await provider.get(), 'keychain-token-value')
  assert.equal(calls.length, 1, 'the second read comes from memory')
  assert.equal(calls[0].command, 'security')
  assert.deepEqual(calls[0].args, ['find-generic-password', '-s', 'svc', '-a', 'acct', '-w'])
  assert.match(provider.commandHint(), /security add-generic-password -U -s 'svc' -a 'acct' -w/)
  assert.equal(provider.commandHint().includes('keychain-token-value'), false)
  provider.invalidate()
  await provider.get()
  assert.equal(calls.length, 2)
})

test('missing or malformed Keychain items produce actionable, token-free errors', async () => {
  const missing = fakeSecurity({ error: Object.assign(new Error('item not found'), { code: 44 }) })
  await assert.rejects(() => missing.provider.get(), (error) => {
    assert.equal(error.kind, 'config')
    assert.equal(error.retriable, false)
    assert.match(error.message, /no bearer token in the macOS Keychain/)
    assert.match(error.message, /security add-generic-password/)
    assert.equal(error.message.includes('item not found'), false)
    return true
  })

  const short = fakeSecurity({ token: 'abc' })
  await assert.rejects(() => short.provider.get(), /does not contain a usable bearer token/)
})

test('keychain failures are cooled down instead of spawning security on every call', async () => {
  let calls = 0
  let now = 1_000
  const provider = new TokenProvider({
    service: 'svc',
    account: 'acct',
    clock: () => now,
    execFileImpl: (_command, _args, _options, callback) => {
      calls += 1
      callback(new Error('denied'), '')
    },
  })
  await assert.rejects(() => provider.get())
  await assert.rejects(() => provider.get())
  assert.equal(calls, 1)
  now += 60_000
  await assert.rejects(() => provider.get())
  assert.equal(calls, 2)
})

test('non-macOS hosts must use the environment token', async () => {
  const provider = new TokenProvider({ service: 'svc', account: 'acct', platform: 'linux' })
  await assert.rejects(() => provider.get(), /set DSH_PROJECT_MEMORY_TOKEN/)
})
