import net from 'net'
import dns from 'dns/promises'

export async function resolveHost(hostname) {
  const v4 = await dns.lookup(hostname, { family: 4, all: true }).catch(() => null)
  const v6 = await dns.lookup(hostname, { family: 6, all: true }).catch(() => null)
  return [...(v4 || []), ...(v6 || [])].map(a => a.address)
}

function isPrivateIpv4(ip) {
  const [a, b] = ip.split('.').map(Number)
  if (a === 10 || a === 127 || a === 169 || a === 0) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a === 192 && (b === 0 || b === 88 || b === 175)) return true
  if (a === 203 && b === 0) return true
  return false
}

function isPrivateIpv6(ip) {
  const lower = ip.toLowerCase()
  if (lower === '::1' || lower === '::') return true
  if (lower.startsWith('::ffff:')) {
    const mapped = lower.replace('::ffff:', '')
    return net.isIP(mapped) === 4 ? isPrivateIpv4(mapped) : false
  }
  return lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8') ||
    lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb') ||
    lower.startsWith('ff') || lower.startsWith('2001:db8') || lower.startsWith('2002:') ||
    lower.startsWith('fec0')
}

function isNonPublic(ip) {
  const type = net.isIP(ip)
  if (!type) return true
  return type === 4 ? isPrivateIpv4(ip) : isPrivateIpv6(ip)
}

export async function assertPublicUrl(rawUrl) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('Invalid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${url.protocol}`)
  }

  const hostname = url.hostname
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    hostname === '::1'
  ) {
    throw new Error('Localhost/loopback URLs are not allowed')
  }

  const ips = await resolveHost(hostname)
  for (const ip of ips) {
    if (isNonPublic(ip)) {
      throw new Error(`URL resolves to a private/loopback address: ${ip}`)
    }
  }
}
