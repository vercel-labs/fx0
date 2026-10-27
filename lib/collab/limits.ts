/** Limits for a publicly hosted demo. Each one is off unless its variable is set. */
export interface CollabLimits {
  /** FX0_COLLAB_PAUSED=1 refuses all new agent work while rooms stay readable. */
  paused: boolean
  /** Messages, retries and resumed runs per UTC day, across every room. */
  dailyMessages: number | null
  /** Messages and retries per hour for each browser. */
  hourlyMessages: number | null
  maxMembers: number | null
  /** Rooms whose agents run at once; later batches wait their turn. */
  maxRunningRooms: number | null
  /** Rooms with no join, message or agent activity this long are deleted, with their Ampersand sessions. */
  roomTtlDays: number | null
  /** Set behind trusted proxies, which make the client's address knowable, so limits can also apply per address. */
  addresses: {
    /** How many X-Forwarded-For entries the trusted proxies append after the client's. */
    trustedProxies: number
    /** Messages and retries per hour for each client address, which a whole office or venue may share. */
    hourlyMessages: number | null
    /** Rooms created or joined per hour for each client address. */
    hourlyRooms: number | null
  } | null
}

/** One hourly allowance: the key it is counted under and that key's limit. */
export interface HourlyUse {
  key: string
  limit: number
}

export const PAUSED_MESSAGE = 'The demo is paused. Please try again later.'
export const DAILY_LIMIT_MESSAGE = 'The demo has reached today’s message limit. Please try again tomorrow.'
export const HOURLY_MESSAGE_LIMIT_MESSAGE = 'Too many messages were sent from here this hour. Please try again later.'
export const HOURLY_ROOM_LIMIT_MESSAGE = 'Too many rooms were opened from your network this hour. Please try again later.'
export const ROOM_FULL_MESSAGE = 'This room is full.'

const HOUR_MS = 60 * 60 * 1000

function whole(env: NodeJS.ProcessEnv, name: string, minimum: number): number | null {
  const value = env[name]
  if (value === undefined || value === '') return null
  if (!/^\d+$/.test(value) || Number(value) < minimum) throw new Error(`${name} must be a whole number of at least ${minimum}`)
  return Number(value)
}

export function collabLimits(env: NodeJS.ProcessEnv = process.env): CollabLimits {
  if (![undefined, '', '0', '1'].includes(env.FX0_COLLAB_PAUSED)) throw new Error('FX0_COLLAB_PAUSED must be 1 or 0')
  const trustedProxies = whole(env, 'FX0_COLLAB_TRUSTED_PROXIES', 0)
  const addressMessages = whole(env, 'FX0_COLLAB_HOURLY_ADDRESS_MESSAGES', 1)
  const hourlyRooms = whole(env, 'FX0_COLLAB_HOURLY_ROOMS', 1)
  // Without the proxy count there is no trustworthy client address to limit by.
  if ((addressMessages !== null || hourlyRooms !== null) && trustedProxies === null) {
    throw new Error('FX0_COLLAB_HOURLY_ADDRESS_MESSAGES and FX0_COLLAB_HOURLY_ROOMS limit each client address, so they need FX0_COLLAB_TRUSTED_PROXIES')
  }
  return {
    paused: env.FX0_COLLAB_PAUSED === '1',
    dailyMessages: whole(env, 'FX0_COLLAB_DAILY_MESSAGES', 1),
    hourlyMessages: whole(env, 'FX0_COLLAB_HOURLY_MESSAGES', 1),
    maxMembers: whole(env, 'FX0_COLLAB_MAX_MEMBERS', 1),
    maxRunningRooms: whole(env, 'FX0_COLLAB_MAX_RUNNING_ROOMS', 1),
    roomTtlDays: whole(env, 'FX0_COLLAB_ROOM_TTL_DAYS', 1),
    addresses: trustedProxies === null ? null : { trustedProxies, hourlyMessages: addressMessages, hourlyRooms },
  }
}

/** The address the trusted proxies received the request from; entries before it were written by the client. */
export function clientAddress(request: Request, trustedProxies: number): string {
  const entries = (request.headers.get('x-forwarded-for') ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)
  const address = entries.at(-1 - trustedProxies)
  // A shorter header means the proxy count is wrong or the request skipped the proxies; limiting by a guess would pool every visitor.
  if (!address) {
    console.error('[fx0] collab X-Forwarded-For has fewer entries than FX0_COLLAB_TRUSTED_PROXIES expects', { entries: entries.length, trustedProxies })
    throw new Error('Client address unavailable')
  }
  return address
}

/** Fixed hourly windows in memory, cleared each hour: one process serves every room, and a restart forgets only the current hour. */
export class HourlyCounter {
  #hour = 0
  #counts = new Map<string, number>()

  #roll(now: number): void {
    const hour = Math.floor(now / HOUR_MS)
    if (hour === this.#hour) return
    this.#hour = hour
    this.#counts.clear()
  }

  /** Whether every use is still under its limit this hour. */
  allows(uses: HourlyUse[], now = Date.now()): boolean {
    this.#roll(now)
    return uses.every((use) => (this.#counts.get(use.key) ?? 0) < use.limit)
  }

  /** Counts one use of each key. */
  add(uses: HourlyUse[], now = Date.now()): void {
    this.#roll(now)
    for (const use of uses) this.#counts.set(use.key, (this.#counts.get(use.key) ?? 0) + 1)
  }
}
