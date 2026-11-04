// @ts-expect-error Node strip-types tests require the source extension.
import { signedInHintCookie, signOutPendingCookie } from '../lib/session-cookies.ts'

export const AUTH_REQUIRED_EVENT = 'fx0:auth-required'

export class AuthRouteError extends Error {
  readonly status: 401 | 403

  constructor(status: 401 | 403) {
    super(status === 401 ? 'Your session has expired.' : 'Team access was denied. Reauthorize your account to continue.')
    this.name = 'AuthRouteError'
    this.status = status
  }
}

// Removes every fx0-owned storage key on sign-out, without deleting unrelated
// storage on the same origin.
export function clearUserStorage() {
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    try {
      const storage = window[name]
      for (let index = storage.length - 1; index >= 0; index--) {
        const key = storage.key(index)
        if (key && /^fx0(?:[-:.]|$)/.test(key)) storage.removeItem(key)
      }
    } catch {
      // Storage can be unavailable; it must not prevent leaving the account.
    }
  }
}

// A full login/reauthorization navigation resets this client-only gate. Queued
// settings writes and focus refreshes must not retry after an auth rejection.
let authFailure: AuthRouteError | null = null
const authRequests = new AbortController()

// Shared path that closes the gate for a 401/403: fetchUi calls it for a JSON response,
// and the preview calls it for a frame that failed with that status (components/preview-pane.tsx).
// signOutAccount closes the gate directly, with its own synthetic 401.
export function signalAuthRequired(status: 401 | 403): AuthRouteError {
  if (authFailure) return authFailure
  const error = new AuthRouteError(status)
  authFailure = error
  window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT, { detail: error.status }))
  return error
}

// The gate's current error, with no side effects: a full document load checks it before
// it starts, since a document load does not go through fetchUi.
export function uiAuthError(): AuthRouteError | null {
  return authFailure
}

// Document-local correlation only, never proof of a session or persisted identity.
let authPage: string | undefined

function authContextHeaders(headers?: HeadersInit): HeadersInit | undefined {
  try {
    if (typeof document === 'undefined') return headers
    const prerendering = (document as Document & { prerendering?: boolean }).prerendering
    const visibility = document.visibilityState
    authPage ??= globalThis.crypto?.randomUUID?.()
    if (!authPage) return headers
    const context = new Headers(headers)
    context.set('x-fx0-auth-page', authPage)
    context.set('x-fx0-auth-prerender', prerendering === true ? '1' : prerendering === false ? '0' : 'unknown')
    context.set('x-fx0-auth-visibility', visibility === 'visible' || visibility === 'hidden' ? visibility : 'unknown')
    return context
  } catch {
    // Optional browser diagnostics must never prevent the underlying request.
    return headers
  }
}

export async function fetchUi(input: string, init?: RequestInit): Promise<Response> {
  if (authFailure) throw authFailure
  const signal = init?.signal ? AbortSignal.any([init.signal, authRequests.signal]) : authRequests.signal
  const headers = input.startsWith('/api/') && !input.includes('\\') ? authContextHeaders(init?.headers) : init?.headers
  const response = await fetch(input, { ...init, headers, signal })
  if (authFailure) {
    void response.body?.cancel().catch(() => {})
    throw authFailure
  }
  if (response.status === 401 || response.status === 403) {
    void response.body?.cancel().catch(() => {})
    // Keep the app visible. The prompt gate owns the optional sign-in dialog;
    // a background request must never navigate away or discard an unsent draft.
    throw signalAuthRequired(response.status)
  }
  return response
}

export async function signOutAccount(onSignedOut: () => void): Promise<void> {
  // Persist intent before any network wait so a reload cannot restore the old
  // account. Only the successful server response clears the pending marker.
  const secure = window.location.protocol === 'https:'
  document.cookie = signOutPendingCookie(true, secure)
  document.cookie = signedInHintCookie(false, secure)
  // Hide private state on the click, before any network wait. Abort existing
  // requests (including response bodies) so they cannot repaint that state.
  authFailure = new AuthRouteError(401)
  authRequests.abort(authFailure)
  clearUserStorage()
  onSignedOut()
  // Signout must still work after the regular UI request gate has closed.
  const response = await fetch('/api/auth/signout', { method: 'POST', keepalive: true })
  if (!response.ok) throw new Error('Unable to sign out. Try again.')
  window.location.assign('/')
}

// Fetch exposes auth status, unlike EventSource. The caller owns reconnection.
export async function readEventStream(response: Response, onData: (data: string) => void): Promise<void> {
  if (!response.body) throw new Error('The event stream is unavailable.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let boundary: RegExpExecArray | null
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary[0].length)
        const data = frame.split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n')
        if (data) onData(data)
      }
      if (done) break
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
