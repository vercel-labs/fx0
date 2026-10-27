import { resolve } from 'node:path'
import timers from 'node:timers/promises'
import type OpenAI from 'openai'
import { createAmpersandClient, deleteSession, redactedErrorMessage } from './ampersand'
import { runDesignGroup } from './group'
import { InputsChangedError, SessionCleanupError } from './input-batch'
import { collabLimits, HourlyCounter, type CollabLimits } from './limits'
import { createRoomStore, type RoomStore } from './store'
import { MISSING_API_KEY_MESSAGE } from './types'

const SWEEP_INTERVAL_MS = 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
// Each expired room costs two session deletes, which share the account's request rate with running rooms.
const MAX_ROOMS_PER_SWEEP = 50
// A room whose session delete failed waits this long, so rooms that keep failing can't fill every sweep.
const FAILED_SWEEP_RETRY_MS = DAY_MS
// Collect a short burst before starting the next turn.
const INPUT_QUIET_MS = 250

interface ActiveBatch {
  controller: AbortController
  /** Newest human message this batch can settle; assistant replies never move it. */
  throughId: number
}

interface DrainResult {
  /** The inputs a known failure attempted; only a newer admitted message may restart it. */
  failedThroughId: number | null
  /** An uncertain create or failed cleanup needs an explicit retry, preserving its saved IDs. */
  cleanupBlocked: boolean
}

export interface CollabRuntime {
  store: RoomStore
  limits: CollabLimits
  running: Map<string, Promise<void>>
  /** The active batch, separate from the worker that owns its durable pending queue. */
  currentRuns: Map<string, ActiveBatch>
  /** Rooms that had pending messages when this process started; a member's read resumes each one once. */
  resumable: Set<string>
  /** This hour's messages per browser and address, and rooms per address. */
  messageUsage: HourlyCounter
  roomUsage: HourlyCounter
  /** Batches whose agents are running, and the batches waiting for one of them to finish. */
  activeRuns: number
  runQueue: Array<() => void>
  lastSweep: number
  /** Rooms whose session delete failed, and when; the sweep skips them for a day. */
  sweepFailures: Map<string, number>
  /** Created on first use, once the key is configured. */
  client?: OpenAI
}

const state = globalThis as unknown as { __fx0CollabRuntime?: CollabRuntime }

export function createCollabRuntime(store: RoomStore, limits: CollabLimits): CollabRuntime {
  return {
    store, limits, running: new Map(), currentRuns: new Map(), resumable: new Set(store.roomsWithPendingMessages()),
    messageUsage: new HourlyCounter(), roomUsage: new HourlyCounter(), activeRuns: 0, runQueue: [], lastSweep: 0, sweepFailures: new Map(),
  }
}

export function collabRuntime(): CollabRuntime {
  if (!state.__fx0CollabRuntime) {
    let limits: CollabLimits
    try {
      limits = collabLimits()
    } catch (error) {
      // Our own configuration text, so it is safe to log, unlike request failures.
      console.error('[fx0] collab configuration is invalid:', (error as Error).message)
      throw error
    }
    const database = resolve(/* turbopackIgnore: true */ process.env.FX0_COLLAB_DATABASE ?? '.collab-data/rooms.sqlite')
    state.__fx0CollabRuntime = createCollabRuntime(createRoomStore(database), limits)
  }
  return state.__fx0CollabRuntime
}

export function collabConfiguration(): { configured: boolean; model: string; baseUrl: string } {
  return {
    configured: Boolean(process.env.AMPERSAND_API_KEY),
    // An empty value means unset, as it does for the limits, so the default stays Ampersand's model.
    model: process.env.AMPERSAND_MODEL || 'ampersand-v0.1',
    baseUrl: process.env.AMPERSAND_BASE_URL || 'https://ampersand.humansand.ai/v1',
  }
}

function ampersandClient(runtime: CollabRuntime): OpenAI {
  const apiKey = process.env.AMPERSAND_API_KEY
  if (!apiKey) throw new Error(MISSING_API_KEY_MESSAGE)
  runtime.client ??= createAmpersandClient({ baseUrl: collabConfiguration().baseUrl, apiKey })
  return runtime.client
}

// Batches past the cap wait in arrival order, so a burst queues instead of meeting the account's rate limits.
async function takeRunSlot(runtime: CollabRuntime): Promise<() => void> {
  const limit = runtime.limits.maxRunningRooms
  if (limit !== null && runtime.activeRuns >= limit) await new Promise<void>((resolve) => { runtime.runQueue.push(resolve) })
  else runtime.activeRuns++
  // A finished batch hands its slot straight to the longest waiter, so no batch that asks later can take it first.
  return () => {
    const next = runtime.runQueue.shift()
    if (next) next()
    else runtime.activeRuns--
  }
}

// A single process owns each room's queue; messages accepted during a run remain pending.
export function runRoom(id: string): Promise<void> {
  const runtime = collabRuntime()
  const current = runtime.running.get(id)
  if (current) {
    const batch = runtime.currentRuns.get(id)
    if (batch && newestPendingId(runtime.store, id) > batch.throughId) batch.controller.abort(new InputsChangedError())
    return current
  }
  // Start after registering ownership, so even an immediate failure cannot race the map entry.
  const task: Promise<void> = Promise.resolve().then(() => drainRoom(id)).then((result) => {
    if (runtime.running.get(id) === task) runtime.running.delete(id)
    // An after() callback may arrive just as drainRoom returns. Hand off its accepted input
    // while callers still await this worker. A new, admitted message may also follow a
    // known failure, but the same failed batch and uncertain cleanup never auto-retry.
    const pendingThrough = newestPendingId(runtime.store, id)
    const mayRestart = runtime.store.snapshotInternal(id).status === 'idle'
      || (result.failedThroughId !== null && !result.cleanupBlocked && pendingThrough > result.failedThroughId)
    if (!runtime.limits.paused && pendingThrough && mayRestart) return runRoom(id)
  }).finally(() => {
    if (runtime.running.get(id) === task) runtime.running.delete(id)
  })
  runtime.running.set(id, task)
  return task
}

function newestPendingId(store: RoomStore, id: string): number {
  return store.pendingMessages(id).at(-1)?.id ?? 0
}

async function waitForQuietInputs(store: RoomStore, id: string): Promise<number> {
  let throughId = newestPendingId(store, id)
  while (true) {
    await timers.setTimeout(INPUT_QUIET_MS)
    const latest = newestPendingId(store, id)
    if (latest === throughId) return throughId
    throughId = latest
  }
}

async function drainRoom(id: string): Promise<DrainResult> {
  const runtime = collabRuntime()
  const { store, limits } = runtime
  let attemptedThrough = newestPendingId(store, id)
  try {
    const client = ampersandClient(runtime)
    // A pause leaves accepted messages pending until it lifts.
    while (!limits.paused && store.pendingMessages(id).length) {
      store.setStatus(id, 'working')
      const quietThrough = await waitForQuietInputs(store, id)
      // One slot per batch, so a busy room goes back behind the rooms already waiting.
      const releaseSlot = await takeRunSlot(runtime)
      let batch: ActiveBatch | undefined
      try {
        // Read after any wait in the queue, so messages that arrived meanwhile join this batch.
        if (newestPendingId(store, id) !== quietThrough) await waitForQuietInputs(store, id)
        if (limits.paused) break
        const pending = store.pendingMessages(id)
        if (!pending.length) continue
        batch = { controller: new AbortController(), throughId: pending[pending.length - 1].id }
        attemptedThrough = batch.throughId
        runtime.currentRuns.set(id, batch)
        const active = batch
        const assertCurrent = () => {
          // The route persists before its deferred after() callback runs. Check SQLite at
          // every visible effect, rather than depending on that callback to cancel us.
          if (newestPendingId(store, id) > active.throughId) active.controller.abort(new InputsChangedError())
          active.controller.signal.throwIfAborted()
        }
        const room = store.snapshotInternal(id)
        const design = store.latestDesign(id)
        await runDesignGroup({
          client,
          model: collabConfiguration().model,
          signal: active.controller.signal,
          room: {
            title: room.title, review: room.review, members: room.members, messages: room.messages, pending,
            html: design.html, revision: design.revision, sessions: store.agentSessions(id),
          },
          hooks: {
            assertCurrent,
            onSession: (seat, session) => { store.saveAgentSession(id, seat, session) },
            onText: (text) => { assertCurrent(); store.appendAssistant(id, text) },
            onPublish: (html) => { assertCurrent(); store.publishDesign(id, html) },
            onActivity: (event) => { assertCurrent(); store.recordActivity(id, event) },
          },
        })
        assertCurrent()
        store.markProcessed(id, active.throughId)
      } catch (error) {
        // Superseded inputs remain durable. Once both agents have stopped, the next batch
        // rereads all of them with the current page; this costs no extra admission unit.
        if (!(error instanceof InputsChangedError)) throw error
      } finally {
        if (runtime.currentRuns.get(id) === batch) runtime.currentRuns.delete(id)
        releaseSlot()
      }
    }
    store.setStatus(id, 'idle')
    return { failedThroughId: null, cleanupBlocked: false }
  } catch (error) {
    // Every member sees this text, so it is redacted here, at the one place it is stored.
    store.setStatus(id, 'error', redactedErrorMessage(error, process.env.AMPERSAND_API_KEY))
    return { failedThroughId: attemptedThrough, cleanupBlocked: error instanceof SessionCleanupError }
  }
}

/** Deletes rooms idle past the TTL, with their Ampersand sessions so they stop counting against the account. At most hourly. */
export async function sweepIdleRooms(): Promise<void> {
  const runtime = collabRuntime()
  const { store, limits, sweepFailures } = runtime
  const now = Date.now()
  // Only the key can delete the rooms' sessions, so without it rooms wait for a later sweep.
  if (limits.roomTtlDays === null || !collabConfiguration().configured || now - runtime.lastSweep < SWEEP_INTERVAL_MS) return
  runtime.lastSweep = now
  for (const [id, failedAt] of sweepFailures) if (now - failedAt >= FAILED_SWEEP_RETRY_MS) sweepFailures.delete(id)
  const client = ampersandClient(runtime)
  const cutoff = now - limits.roomTtlDays * DAY_MS
  const counts = { deleted: 0, kept: 0 }
  // A room that starts running is 'working', and a member's message or join is new activity, so deleteIdleRoom's own check keeps both.
  for (const id of store.idleRooms(cutoff, MAX_ROOMS_PER_SWEEP, [...sweepFailures.keys()])) {
    const sessions = Object.values(store.agentSessions(id))
    const deleted = await Promise.all(sessions.map((session) => deleteSession(client, session.sessionId)))
    // A failed delete keeps the room, and with it the session IDs, for a later sweep.
    if (!deleted.every(Boolean)) {
      sweepFailures.set(id, now)
      counts.kept++
    } else if (store.deleteIdleRoom(id, cutoff)) counts.deleted++
  }
  if (counts.deleted || counts.kept) console.info('[fx0] collab sweep', { ...counts, waiting: store.idleRooms(cutoff, Number.MAX_SAFE_INTEGER, []).length })
}
