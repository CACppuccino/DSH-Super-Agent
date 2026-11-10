/**
 * Tests for address classification and the pairing block the installer prints.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classifyAddresses, formatPairingBlock, formatUrl, isTailscaleIpv4, isTailscaleIpv6, renderPairingUrls,
} from '../scripts/lib/net.mjs'

const INTERFACES = {
  lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  en0: [{ address: '192.168.1.23', family: 'IPv4', internal: false }],
  en1: [{ address: '169.254.10.2', family: 'IPv4', internal: false }],
  utun4: [
    { address: '100.101.102.103', family: 'IPv4', internal: false },
    { address: 'fd7a:115c:a1e0:ab12::1', family: 'IPv6', internal: false },
  ],
  bridge0: [{ address: '198.18.0.1', family: 'IPv4', internal: false }],
  awdl0: [{ address: 'fe80::1', family: 'IPv6', internal: false }],
}

test('LAN and tailnet addresses are classified from an interface snapshot', () => {
  const { lan, tailscale } = classifyAddresses(INTERFACES)
  assert.deepEqual(lan, [{ address: '192.168.1.23', iface: 'en0' }])
  assert.deepEqual(tailscale, [
    { address: '100.101.102.103', iface: 'utun4' },
    { address: 'fd7a:115c:a1e0:ab12::1', iface: 'utun4' },
  ])
})

test('tailnet ranges are recognized and other CGNAT-free addresses are not', () => {
  assert.equal(isTailscaleIpv4('100.64.0.1'), true)
  assert.equal(isTailscaleIpv4('100.127.255.254'), true)
  assert.equal(isTailscaleIpv4('100.63.0.1'), false)
  assert.equal(isTailscaleIpv4('192.168.1.1'), false)
  assert.equal(isTailscaleIpv6('fd7a:115c:a1e0::1'), true)
  assert.equal(isTailscaleIpv6('fd00::1'), false)
})

test('URLs bracket IPv6 and never advertise a wildcard address', () => {
  assert.equal(formatUrl('192.168.1.23', 3443, '/remote-api'), 'http://192.168.1.23:3443/remote-api')
  assert.equal(formatUrl('::1', 3443, '/remote-api'), 'http://[::1]:3443/remote-api')
  assert.equal(formatUrl('fd7a:115c:a1e0::1', 3443, '/remote-api'), 'http://[fd7a:115c:a1e0::1]:3443/remote-api')
  assert.equal(formatUrl('0.0.0.0', 3443, '/remote-api'), 'http://127.0.0.1:3443/remote-api')
})

test('pairing URLs list loopback, LAN, then tailnet', () => {
  const urls = renderPairingUrls({
    listenHost: '0.0.0.0',
    port: 3443,
    pathPrefix: '/remote-api',
    lan: [{ address: '192.168.1.23', iface: 'en0' }],
    tailscale: [{ address: '100.101.102.103', iface: 'utun4' }],
  })
  assert.deepEqual(urls.map(entry => entry.kind), ['loopback', 'lan', 'tailscale'])
  assert.equal(urls[0].url, 'http://127.0.0.1:3443/remote-api')
  assert.equal(urls[1].url, 'http://192.168.1.23:3443/remote-api')
  assert.equal(urls[2].url, 'http://100.101.102.103:3443/remote-api')
  assert.equal(urls[1].note, undefined)
})

test('a loopback-only listener flags LAN entries as unreachable', () => {
  const urls = renderPairingUrls({
    listenHost: '127.0.0.1',
    port: 3443,
    pathPrefix: '/remote-api',
    lan: [{ address: '192.168.1.23', iface: 'en0' }],
  })
  assert.match(urls[1].note, /listen\.host/)
})

test('the pairing block includes every URL, the token, and the security warning', () => {
  const urls = renderPairingUrls({
    listenHost: '0.0.0.0',
    port: 3443,
    pathPrefix: '/remote-api',
    lan: [{ address: '192.168.1.23', iface: 'en0' }],
    tailscale: [{ address: '100.101.102.103', iface: 'utun4' }],
  })
  const text = formatPairingBlock({
    profile: 'desktop',
    listenHost: '0.0.0.0',
    port: 3443,
    pathPrefix: '/remote-api',
    token: 'a'.repeat(64),
    tokenFile: '/Users/tester/.dsh/remote/token',
    urls,
  })
  assert.ok(text.includes('http://192.168.1.23:3443/remote-api'))
  assert.ok(text.includes('http://100.101.102.103:3443/remote-api'))
  assert.ok(text.includes('a'.repeat(64)))
  assert.ok(text.includes('Add Server'))
  assert.ok(text.includes('完整控制权'))
})
