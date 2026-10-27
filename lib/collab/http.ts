// @ts-expect-error Node strip-types tests require the source extension.
import { AuthError } from '../accounts.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { isHandle } from './store.ts'

export const COLLAB_COOKIE = 'fx0-collab'
const IDENTITY_TTL_SECONDS = 7 * 24 * 60 * 60

type CollabHandler = (request: Request) => Response | Promise<Response>

// An explicit public origin also works behind a local HTTPS reverse proxy.
function collabOrigin(): string {
  return new URL(process.env.FX0_COLLAB_ORIGIN ?? 'http://127.0.0.1:3025').origin
}

export function browserToken(request: Request): string | null {
  const value = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${COLLAB_COOKIE}=`))?.slice(COLLAB_COOKIE.length + 1)
  return isHandle(value) ? value : null
}

export function requireBrowserToken(request: Request): string {
  const token = browserToken(request)
  if (!token) throw new AuthError(404, 'Room not found')
  return token
}

export function privateJson(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers: { ...headers, 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' } })
}

export function identityCookie(token: string): string {
  return [
    `${COLLAB_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${IDENTITY_TTL_SECONDS}`,
    ...(new URL(collabOrigin()).protocol === 'https:' ? ['Secure'] : []),
  ].join('; ')
}

function collabFailure(error: unknown): Response {
  if (error instanceof AuthError) return privateJson({ error: error.message }, error.status)
  // Name only: an unexpected error's message may carry request or room data.
  console.error('[fx0] collab request failed', { name: error instanceof Error ? error.name : 'UnknownError' })
  return privateJson({ error: 'The room is temporarily unavailable. Please try again.' }, 503)
}

export function withCollabRoute(body: CollabHandler) {
  return async (request: Request): Promise<Response> => {
    try {
      // Not fx0's assertSameOrigin: it requires HTTPS in production, and this local demo also runs `next start` over HTTP.
      if (request.method !== 'GET' && request.method !== 'HEAD' && request.headers.get('origin') !== collabOrigin()) {
        throw new AuthError(403, 'Open the demo in the same browser origin.')
      }
      return await body(request)
    } catch (error) {
      return collabFailure(error)
    }
  }
}

export async function readCollabBody(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AuthError(400, 'Invalid request')
  return body as Record<string, unknown>
}

// Revision IDs are positive integers; anything else names no revision.
export function revisionId(value: string | null): number {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id < 1) throw new AuthError(404, 'Design not found')
  return id
}

export function stringField(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string') throw new AuthError(400, `Missing ${field}`)
  return value
}
