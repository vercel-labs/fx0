import http from 'node:http'
import https from 'node:https'
import dns from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

// web_fetch takes its URL from the model, and the model takes it from whatever it
// read. So a fetch may only reach public addresses: every address a host resolves
// to is checked, the connection goes to the address that was checked (a second DNS
// answer can't swap in a private one), every redirect is checked the same way
// before it connects, and the body is capped.

export const MAX_FETCH_BYTES = 1024 * 1024
const MAX_REDIRECTS = 5
const denied = new BlockList()
for (const [ip, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) denied.addSubnet(ip, prefix, 'ipv4')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
for (const [ip, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  denied.addSubnet(ip, prefix, 'ipv6')
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !denied.check(address, 'ipv4')
  // Only native global unicast: mapped IPv4, NAT64 and transition addresses
  // must not create an alternate path into private IPv4 networks.
  return family === 6 && globalV6.check(address, 'ipv6') && !denied.check(address, 'ipv6')
}

export async function publicDestination(input: string, resolve = dns.lookup) {
  const url = new URL(input)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid public URL')
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!hostname || /(?:^|\.)(?:localhost|local|internal|home|lan)$/.test(hostname)) throw new Error('Private hostname')
  const literal = isIP(hostname)
  const addresses = literal ? [{ address: hostname, family: literal }] : await resolve(hostname, { all: true })
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error('Non-public address')
  return { url, address: addresses[0] }
}

// Remote images fx0 embeds in a design. Only https, every hop. Each one is cached as a
// base64 data: URL in one Runtime Cache entry, which holds at most 2 MB.
export const MAX_IMAGE_FETCH_BYTES = 1.25 * 1024 * 1024

interface FetchOptions { maxBytes: number; httpsOnly?: boolean; accept?: string; userAgent?: string }

export async function fetchPublicText(input: string, signal: AbortSignal) {
  const { status, url, body } = await fetchPublic(input, signal, { maxBytes: MAX_FETCH_BYTES })
  return { status, url, raw: body.toString('utf8') }
}

export async function fetchPublicImage(input: string, signal: AbortSignal) {
  const response = await fetchPublic(input, signal, {
    maxBytes: MAX_IMAGE_FETCH_BYTES, httpsOnly: true, accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif',
  })
  if (response.status < 200 || response.status > 299) throw new Error('Image request failed')
  return response
}

// Google Fonts a design names (lib/google-fonts.ts). Google serves woff2 only to browsers
// it recognizes, so these requests name one. Every hop must stay on Google's font hosts.
export const MAX_FONT_FETCH_BYTES = 256 * 1024
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

export async function fetchGoogleFontsStylesheet(input: string, signal: AbortSignal): Promise<string> {
  const { body } = await fetchGoogleFonts(input, 'fonts.googleapis.com', signal, { maxBytes: MAX_FETCH_BYTES, accept: 'text/css,*/*;q=0.1' })
  return body.toString('utf8')
}

/** One woff2 font file; throws for anything else. */
export async function fetchGoogleFontFile(input: string, signal: AbortSignal): Promise<Buffer> {
  const { body } = await fetchGoogleFonts(input, 'fonts.gstatic.com', signal, { maxBytes: MAX_FONT_FETCH_BYTES, accept: 'font/woff2' })
  if (body.subarray(0, 4).toString('latin1') !== 'wOF2') throw new Error('Not a woff2 font')
  return body
}

async function fetchGoogleFonts(input: string, host: string, signal: AbortSignal, options: FetchOptions) {
  if (new URL(input).hostname !== host) throw new Error('Not a Google Fonts URL')
  const response = await fetchPublic(input, signal, { ...options, httpsOnly: true, userAgent: BROWSER_USER_AGENT })
  if (response.status < 200 || response.status > 299 || new URL(response.url).hostname !== host) throw new Error('Font request failed')
  return response
}

/** DNS validation and the connection share the same address; never resolve again. */
async function fetchPublic(input: string, signal: AbortSignal, options: FetchOptions) {
  let next = input
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    signal.throwIfAborted()
    const destination = await new Promise<Awaited<ReturnType<typeof publicDestination>>>((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      publicDestination(next).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
    signal.throwIfAborted()
    const { url, address } = destination
    if (options.httpsOnly && url.protocol !== 'https:') throw new Error('HTTPS required')
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http
      const request = transport.request(url, {
        signal, agent: false,
        headers: { 'user-agent': options.userAgent ?? 'fx0/1.0', 'accept-encoding': 'identity', ...(options.accept ? { accept: options.accept } : {}) },
        // Keep the URL hostname for Host and TLS certificate verification.
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [address])
          else callback(null, address.address, address.family)
        },
      }, resolve)
      request.on('error', reject)
      request.end()
    })
    const abortBody = () => response.destroy(new Error('Fetch aborted'))
    signal.addEventListener('abort', abortBody, { once: true })
    try {
      signal.throwIfAborted()
      const status = response.statusCode ?? 502
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        if (hop === MAX_REDIRECTS) throw new Error('Too many redirects')
        next = new URL(response.headers.location, url).href
        continue
      }
      if (Number(response.headers['content-length']) > options.maxBytes) throw new Error('Response too large')
      const encoding = response.headers['content-encoding']
      if (encoding && encoding !== 'identity') throw new Error('Unsupported content encoding')
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of response) {
        bytes += chunk.length
        if (bytes > options.maxBytes) throw new Error('Response too large')
        chunks.push(Buffer.from(chunk))
      }
      return { status, url: url.href, body: Buffer.concat(chunks, bytes) }
    } finally {
      signal.removeEventListener('abort', abortBody)
      response.destroy()
    }
  }
  throw new Error('Too many redirects')
}
