import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export function randomHandle(): string {
  return randomBytes(32).toString('base64url')
}

export function hashHandle(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

// Purpose-separated HMAC tags correlate logs only within the same kind.
// Missing log key material must not block authentication or expose unkeyed tags.
export function logTag(kind: 'user' | 'login' | 'refresh' | 'cookie' | 'page', value: string): string | null {
  const secret = process.env.SESSION_SECRET
  if (!secret || secret.length < 32) return null
  const key = createHmac('sha256', secret).update('fx0:auth-log-key:v1').digest()
  return createHmac('sha256', key).update(kind).update('\0').update(value).digest('hex').slice(0, 24)
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function equalSecret(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

// Strips anything bearer- or token-shaped from text bound for users or logs.
export function redactSecrets(text: string): string {
  return text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/[A-Za-z0-9_\-.]{40,}/g, '[redacted]')
}
