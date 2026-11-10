/**
 * Address discovery and pairing-text rendering for the suite installer.
 *
 * The functions are pure over a snapshot shaped like `os.networkInterfaces()`
 * so the address classification and URL rendering are testable without a
 * network. `installer.mjs` supplies the live snapshot and the optional
 * `tailscale ip` hint.
 *
 * @module dsh-suite/scripts/lib/net
 */

import { hostForUrl, isLoopbackHost, isWildcardHost } from './plan.mjs'

/** True for an IPv4 address in Tailscale's CGNAT range (100.64.0.0/10). */
export function isTailscaleIpv4(address) {
  const match = /^100\.(\d+)\./.exec(address)
  if (match === null) return false
  const second = Number(match[1])
  return second >= 64 && second <= 127
}

/** True for an IPv6 address in Tailscale's ULA prefix (fd7a:115c:a1e0::/48). */
export function isTailscaleIpv6(address) {
  return address.toLowerCase().startsWith('fd7a:115c:a1e0:')
}

/** True for link-local or benchmarking ranges no phone can reach usefully. */
function isUnroutable(address) {
  return address.startsWith('169.254.') || address.startsWith('198.18.') || address.startsWith('198.19.')
}

/**
 * Split the machine's addresses into LAN and tailnet candidates.
 * @param {Record<string, Array<{ address: string, family: string | number, internal: boolean }> | undefined>} interfaces
 *   an `os.networkInterfaces()` snapshot
 * @returns {{ lan: Array<{ address: string, iface: string }>, tailscale: Array<{ address: string, iface: string }> }}
 *   candidates in interface order, without loopback or unroutable addresses
 */
export function classifyAddresses(interfaces = {}) {
  const lan = []
  const tailscale = []
  const push = (list, address, iface) => {
    if (!list.some(entry => entry.address === address)) list.push({ address, iface })
  }
  for (const [iface, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue
      const family = entry.family === 'IPv6' || entry.family === 6 ? 6 : 4
      if (family === 4) {
        if (isUnroutable(entry.address)) continue
        if (isTailscaleIpv4(entry.address)) push(tailscale, entry.address, iface)
        else push(lan, entry.address, iface)
      } else if (isTailscaleIpv6(entry.address)) {
        push(tailscale, entry.address, iface)
      }
    }
  }
  return { lan, tailscale }
}

/**
 * Format one reachable endpoint URL.
 * @param {string} host address or hostname (a wildcard is not a destination)
 * @param {number} port listen port
 * @param {string} pathPrefix URL prefix served by dsh-remote
 * @returns {string} `http://host:port/prefix`
 */
export function formatUrl(host, port, pathPrefix) {
  const target = isWildcardHost(host) ? '127.0.0.1' : host
  return `http://${hostForUrl(target)}:${port}${pathPrefix}`
}

/**
 * Build every URL the user may type into the DSH Remote app, best first.
 *
 * Loopback always works on the Mac itself; LAN and tailnet entries are only
 * meaningful when the endpoint is not loopback-only. When it is, the entries
 * are still returned with a note so the user sees why the phone will fail —
 * a silent omission is a worse pairing experience.
 *
 * @param {object} input
 * @param {string} input.listenHost configured listen address
 * @param {number} input.port configured port
 * @param {string} input.pathPrefix configured URL prefix
 * @param {Array<{ address: string, iface: string }>} [input.lan] LAN candidates
 * @param {Array<{ address: string, iface: string }>} [input.tailscale] tailnet candidates
 * @returns {Array<{ kind: string, label: string, url: string, note?: string }>} ordered entries
 */
export function renderPairingUrls({
  listenHost, port, pathPrefix, lan = [], tailscale = [],
}) {
  const loopbackOnly = isLoopbackHost(listenHost) && listenHost !== 'localhost'
  const urls = [{
    kind: 'loopback',
    label: '本机（Mac 自己）',
    url: formatUrl('127.0.0.1', port, pathPrefix),
  }]
  const unreachableNote = loopbackOnly
    ? `插件当前只监听 ${listenHost}，手机无法连接；在 profile 的 cordis.patch.yml 里把 listen.host 改成 0.0.0.0 或 tailnet 地址后重启`
    : undefined
  const withNote = (entry) => {
    const rendered = {
      kind: entry.kind,
      label: entry.label,
      url: formatUrl(entry.address, port, pathPrefix),
    }
    return unreachableNote === undefined ? rendered : { ...rendered, note: unreachableNote }
  }
  for (const entry of lan) {
    urls.push(withNote({ kind: 'lan', label: `局域网 · ${entry.iface}`, address: entry.address }))
  }
  for (const entry of tailscale) {
    urls.push(withNote({ kind: 'tailscale', label: `Tailscale · ${entry.iface}`, address: entry.address }))
  }
  return urls
}

/**
 * Render the block a user reads to pair the phone.
 * @param {object} input
 * @param {string} input.profile installed profile name
 * @param {string} input.listenHost configured listen address
 * @param {number} input.port configured port
 * @param {string} input.pathPrefix configured URL prefix
 * @param {string} input.token bearer token
 * @param {Array<object>} input.urls entries from {@link renderPairingUrls}
 * @param {string} [input.tokenFile] token path, for the summary line
 * @returns {string} the printable pairing block
 */
export function formatPairingBlock({
  profile, listenHost, port, pathPrefix, token, urls, tokenFile,
}) {
  const lines = []
  lines.push('')
  lines.push('=== 在 iPhone 的 DSH Remote 里添加这台机器 ===')
  lines.push('')
  lines.push(`  Profile : ${profile}`)
  lines.push(`  监听    : ${listenHost}:${port}   前缀: ${pathPrefix}`)
  if (tokenFile !== undefined) lines.push(`  Token 文件: ${tokenFile}`)
  lines.push('')
  lines.push('  服务器地址（App 里填其中一条）：')
  for (const entry of urls) {
    lines.push(`    ${entry.label}`)
    lines.push(`      ${entry.url}`)
    if (entry.note !== undefined) lines.push(`      ! ${entry.note}`)
  }
  lines.push('')
  lines.push('  Bearer Token（App 的 Token 字段）：')
  lines.push(`    ${token}`)
  lines.push('')
  lines.push('  App 里：Add Server（新增服务器）→ 粘贴上面的地址和 Token → 保存 →')
  lines.push('  点开这台机器的服务器卡片即可切换；两台机器各存一条记录，随时来回切。')
  lines.push('')
  lines.push('  ⚠️  Token 等于这台机器的完整控制权（可读写文件、跑命令、改配置）。')
  lines.push('     只填进自己的手机，不要发到聊天、截图或仓库；怀疑泄漏就删除')
  lines.push(`     ${tokenFile ?? 'token 文件'} 后重启 DSH，会生成新 token。`)
  lines.push('')
  return lines.join('\n')
}
