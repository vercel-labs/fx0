/** Maximum UTF-16 length of one persisted chat message; long enough for a detailed brief. */
export const MAX_MESSAGE_LENGTH = 16_000

/** Names appear in member lists and transcript bylines, so they stay short. */
export const MAX_MEMBER_NAME_LENGTH = 48
/** Titles fit one sidebar row and the room header. */
export const MAX_ROOM_TITLE_LENGTH = 120

/** Longest stored activity text: teammate messages and review summaries. */
export const MAX_ACTIVITY_LENGTH = 4_000

/** Longest stored room error; errors are status lines, never provider bodies. */
export const MAX_ERROR_LENGTH = 2_000

export const MISSING_API_KEY_MESSAGE = 'Configure AMPERSAND_API_KEY on the server to start Ampersand.'

export type RoomStatus = 'idle' | 'working' | 'error'

export const AGENT_SEATS = ['Builder', 'Reviewer'] as const
export type AgentSeat = (typeof AGENT_SEATS)[number]

export function teammateOf(seat: AgentSeat): AgentSeat {
  return seat === 'Builder' ? 'Reviewer' : 'Builder'
}

// Model tool arguments and stored room text pass the same rule, so neither side can drift.
export function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= max && !value.includes('\0')
}

export interface Member {
  id: string
  name: string
  joinedAt: number
}

export interface Message {
  id: number
  authorId: string
  author: string
  role: 'user' | 'assistant'
  text: string
  createdAt: number
}

/** A saved version of the shared page. Snapshots list these without their HTML, which is read one revision at a time. */
export interface Revision {
  id: number
  createdAt: number
}

export interface RoomSummary {
  id: string
  title: string
  lastActivity: number
  busy: boolean
}

/** Explicit coordination events only; model reasoning never enters this log. */
export interface AgentActivity {
  id: number
  agent: AgentSeat
  kind: 'message' | 'publish' | 'review'
  text: string
  revision?: number
  createdAt: number
}

/** A seat's persistent Ampersand session and the newest room message it has been sent. */
export interface SeatSession {
  sessionId: string
  deliveredThrough: number
}

export interface RoomSnapshot {
  id: string
  title: string
  /** Whether the Reviewer checks each change before the Builder replies; off, the Builder works alone. */
  review: boolean
  members: Member[]
  messages: Message[]
  revisions: Revision[]
  activity: AgentActivity[]
  status: RoomStatus
  error: string | null
  version: number
  /** Empty only in server-internal snapshots. Browser snapshots always identify their member. */
  viewerId: string
}
