import type { RoomSnapshot, RoomSummary } from '../lib/collab/types'

const ENDPOINT = '/api/ampersand'

export interface Workspace {
  configured: boolean
  model: string
  rooms: RoomSummary[]
}

export interface RoomResponse {
  room: RoomSnapshot
}

// A poll that already has the room's current version.
export interface UnchangedRoom {
  unchanged: true
}

// A new room comes back with its creator's first invite.
export interface CreatedRoom extends RoomResponse {
  invite: string
}

export interface InviteResponse {
  invite: string
}

export interface InviteLink {
  roomId: string | null
  invite: string
}

type RoomAction =
  | { action: 'create'; name: string; title: string }
  | { action: 'join'; id: string; invite: string; name: string }
  | { action: 'message'; id: string; text: string; requestId: string }
  | { action: 'retry'; id: string }
  | { action: 'invite'; id: string }
  | { action: 'review'; id: string; enabled: boolean }

export class RequestError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export function readWorkspace(): Promise<Workspace> {
  return fetchJson(ENDPOINT, { method: 'GET' })
}

export function readRoom(id: string): Promise<RoomResponse>
export function readRoom(id: string, since: number): Promise<RoomResponse | UnchangedRoom>
export function readRoom(id: string, since?: number): Promise<RoomResponse | UnchangedRoom> {
  const query = new URLSearchParams({ room: id, ...(since === undefined ? {} : { since: String(since) }) })
  return fetchJson(`${ENDPOINT}?${query}`, { method: 'GET' })
}

export function readRevisionSource(roomId: string, revisionId: number): Promise<{ html: string }> {
  return fetchJson(`${ENDPOINT}?${new URLSearchParams({ room: roomId, revision: String(revisionId) })}`, { method: 'GET' })
}

// Keyed by action, so each call site gets its own response type.
interface RoomResults {
  create: CreatedRoom
  join: RoomResponse
  message: RoomResponse
  retry: RoomResponse
  invite: InviteResponse
  review: RoomResponse
}

export function postRoom<Action extends RoomAction>(body: Action): Promise<RoomResults[Action['action']]> {
  return fetchJson(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

// Room state changes every poll, so no response may come from the HTTP cache.
async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: 'no-store' })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new RequestError(typeof data?.error === 'string' ? data.error : 'Could not reach the room. Please try again.', response.status)
  return data as T
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}

export function roomUrl(roomId: string): URL {
  const url = new URL(window.location.href)
  url.search = ''
  url.searchParams.set('room', roomId)
  url.hash = ''
  return url
}

// The invite rides in the fragment, which browsers never send to the server.
export function inviteLink(roomId: string, invite: string): string {
  const url = roomUrl(roomId)
  url.hash = new URLSearchParams({ invite }).toString()
  return url.toString()
}

export function readInviteLink(url: URL): InviteLink {
  return { roomId: url.searchParams.get('room'), invite: new URLSearchParams(url.hash.slice(1)).get('invite') ?? '' }
}
