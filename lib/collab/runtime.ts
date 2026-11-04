import { randomUUID } from 'node:crypto'
import timers from 'node:timers/promises'
import type OpenAI from 'openai'
import { neon, type NeonQueryFunction } from '@neondatabase/serverless'
import { createAmpersandClient, deleteSession, redactedErrorMessage } from './ampersand'
import { runDesignGroup } from './group'
import { InputsChangedError, SessionCleanupError } from './input-batch'
import { collabLimits, type CollabLimits } from './limits'
import { createRoomStore, LeaseLostError, type RoomQuery, type RoomStore, type RunGuard } from './store'
import { MISSING_API_KEY_MESSAGE } from './types'

const SWEEP_INTERVAL_MS = 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
// Each expired room costs two session deletes, which share the account's request rate with running rooms.
const MAX_ROOMS_PER_SWEEP = 50
// A room whose session delete failed waits this long, so rooms that keep failing can't fill every sweep.
const FAILED_SWEEP_RETRY_MS = DAY_MS
// Collect a short burst before starting the next turn.
const INPUT_QUIET_MS = 250
// One invocation works a room's queue at a time. It renews its lease while it runs; an
// invocation that ends mid-run lets the lease lapse, and a member's next poll resumes the queue.
const LEASE_MS = 60_000
const RENEW_MS = 20_000
/** How long accepted work may wait without a runner before a member's poll restarts it. */
export const STALL_MS = 15_000

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
  /** How long accepted work may wait without a runner before a member's poll restarts it. */
  stallMs: number
  running: Map<string, Promise<void>>
  /** The active batch, separate from the worker that owns its durable pending queue. */
  currentRuns: Map<string, ActiveBatch>
  lastSweep: number
  /** Rooms whose session delete failed, and when; the sweep skips them for a day. */
  sweepFailures: Map<string, number>
  /** Created on first use, once the key is configured. */
  client?: OpenAI
}

const state = globalThis as unknown as { __fx0CollabRuntime?: CollabRuntime }

export function createCollabRuntime(store: RoomStore, limits: CollabLimits): CollabRuntime {
  return { store, limits, stallMs: STALL_MS, running: new Map(), currentRuns: new Map(), lastSweep: 0, sweepFailures: new Map() }
}

// fx0's database, over Neon HTTP like its accounts.
function neonQuery(): RoomQuery {
  let sql: NeonQueryFunction<false, false> | undefined
  const database = () => {
    if (!sql) {
      const connectionString = process.env.DATABASE_URL
      if (!connectionString) throw new Error('DATABASE_URL is required')
      sql = neon(connectionString)
    }
    return sql
  }
  return Object.assign(
    async (text: string, values: unknown[] = []) => await database().query(text, values),
    {
      transaction: async (statements: Parameters<RoomQuery['transaction']>[0]) => {
        const sql = database()
        // Lock first, then read with a fresh snapshot in the SAME HTTP transaction.
        return await sql.transaction(statements.map(({ text, values = [] }) => sql.query(text, values)), { isolationLevel: 'ReadCommitted' })
      },
    },
  )
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
    state.__fx0CollabRuntime = createCollabRuntime(createRoomStore(neonQuery()), limits)
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

// One worker per room in this process, and one lease holder across processes; messages accepted during a run remain pending.
export function runRoom(id: string): Promise<void> {
  const runtime = collabRuntime()
  const current = runtime.running.get(id)
  if (current) {
    const batch = runtime.currentRuns.get(id)
    if (batch) {
      void runtime.store.newestPendingId(id).then((newest) => {
        if (newest > batch.throughId) batch.controller.abort(new InputsChangedError())
      }, () => {})
    }
    return current
  }
  // Start after registering ownership, so even an immediate failure cannot race the map entry.
  const task: Promise<void> = Promise.resolve().then(() => leasedDrain(id)).then(async (result) => {
    if (runtime.running.get(id) === task) runtime.running.delete(id)
    // No lease: another runner owns the queue, or the running-room cap is full and a member's poll resumes it later.
    if (!result) return
    // The lease is released by now. A message accepted while it was held found it taken, so this
    // worker hands that input off. A new, admitted message may also follow a known failure, but
    // the same failed batch and uncertain cleanup never auto-retry.
    const pendingThrough = await runtime.store.newestPendingId(id)
    const mayRestart = (await runtime.store.snapshotInternal(id)).status === 'idle'
      || (result.failedThroughId !== null && !result.cleanupBlocked && pendingThrough > result.failedThroughId)
    if (!runtime.limits.paused && pendingThrough && mayRestart) return runRoom(id)
  }).finally(() => {
    if (runtime.running.get(id) === task) runtime.running.delete(id)
  })
  runtime.running.set(id, task)
  return task
}

async function leasedDrain(id: string): Promise<DrainResult | null> {
  const runtime = collabRuntime()
  const { store, limits } = runtime
  // A token belongs to one run, not the process: an expired invocation cannot
  // accidentally regain authority when this process starts the next run.
  const runner = randomUUID()
  const now = Date.now()
  if (!await store.claimRun(id, runner, now, now + LEASE_MS, limits.maxRunningRooms)) return null
  const lease = { lost: false, runner }
  const loseLease = () => {
    lease.lost = true
    runtime.currentRuns.get(id)?.controller.abort(new LeaseLostError())
  }
  const renew = setInterval(() => {
    store.renewRun(id, runner, LEASE_MS).then((held) => {
      if (!held) loseLease()
    }, loseLease)
  }, RENEW_MS)
  renew.unref?.()
  try {
    return await drainRoom(id, lease)
  } catch (error) {
    if (error instanceof LeaseLostError) return null
    throw error
  } finally {
    clearInterval(renew)
    await store.releaseRun(id, runner).catch(() => console.error('[fx0] collab lease release failed'))
  }
}

async function waitForQuietInputs(store: RoomStore, id: string): Promise<number> {
  let throughId = await store.newestPendingId(id)
  while (true) {
    await timers.setTimeout(INPUT_QUIET_MS)
    const latest = await store.newestPendingId(id)
    if (latest === throughId) return throughId
    throughId = latest
  }
}

async function drainRoom(id: string, lease: { lost: boolean; runner: string }): Promise<DrainResult> {
  const runtime = collabRuntime()
  const { store, limits } = runtime
  const owner: RunGuard = { runner: lease.runner }
  let attemptedThrough = await store.newestPendingId(id)
  try {
    const client = ampersandClient(runtime)
    // A pause leaves accepted messages pending until it lifts.
    while (!limits.paused && (await store.pendingMessages(id)).length) {
      if (lease.lost) throw new LeaseLostError()
      await store.setStatus(id, 'working', null, owner)
      await waitForQuietInputs(store, id)
      let batch: ActiveBatch | undefined
      try {
        if (limits.paused) break
        const pending = await store.pendingMessages(id)
        if (!pending.length) continue
        batch = { controller: new AbortController(), throughId: pending[pending.length - 1].id }
        attemptedThrough = batch.throughId
        runtime.currentRuns.set(id, batch)
        const active = batch
        const guard: RunGuard = { ...owner, throughId: active.throughId }
        const assertCurrent = async () => {
          if (lease.lost) active.controller.abort(new LeaseLostError())
          active.controller.signal.throwIfAborted()
          try {
            await store.assertRun(id, guard)
          } catch (error) {
            active.controller.abort(error)
            throw error
          }
        }
        const room = await store.snapshotInternal(id)
        const design = await store.latestDesign(id)
        await runDesignGroup({
          client,
          model: collabConfiguration().model,
          signal: active.controller.signal,
          room: {
            title: room.title, review: room.review, members: room.members, messages: room.messages, pending,
            html: design.html, revision: design.revision, sessions: await store.agentSessions(id),
          },
          hooks: {
            assertCurrent,
            // Retain a newly reported session ID even after input supersedes this batch,
            // but never overwrite a replacement runner's saved session.
            onSession: (seat, session) => store.saveAgentSession(id, seat, session, owner),
            // Each effect rechecks ownership AND inputs under the write's room lock;
            // the earlier assertCurrent check alone cannot fence a later commit.
            onText: (text) => store.appendAssistant(id, text, guard),
            onPublish: async (html) => { await store.publishDesign(id, html, guard) },
            onActivity: (event) => store.recordActivity(id, event, guard),
          },
        })
        await assertCurrent()
        await store.markProcessed(id, active.throughId, guard)
      } catch (error) {
        // Preserve an uncertain provider cleanup so the outer handler can persist
        // its barrier, including when a renewal transport failure stopped the run.
        if (error instanceof SessionCleanupError) throw error
        if (lease.lost) throw new LeaseLostError()
        // Superseded inputs remain durable. Once both agents have stopped, the next batch
        // rereads all of them with the current page; this costs no extra admission unit.
        if (!(error instanceof InputsChangedError)) throw error
      } finally {
        if (runtime.currentRuns.get(id) === batch) runtime.currentRuns.delete(id)
      }
    }
    // markProcessed commits the successful batch AND idle status together. There
    // is no later finalization write that can turn settled work into an error.
    if (limits.paused) await store.setStatus(id, 'idle', null, owner)
    return { failedThroughId: null, cleanupBlocked: false }
  } catch (error) {
    const message = redactedErrorMessage(error, process.env.AMPERSAND_API_KEY)
    if (error instanceof SessionCleanupError) {
      // Uncertain cancellation must survive even a renewal transport failure. The
      // DB may still recognize this owner; never clear its barrier just because
      // our local lease flag is lost. A successor's ownership is never overwritten.
      await store.blockRunCleanup(id, owner.runner, message, attemptedThrough)
      return { failedThroughId: attemptedThrough, cleanupBlocked: true }
    }
    if (error instanceof LeaseLostError || lease.lost) throw new LeaseLostError()
    await store.setStatus(id, 'error', message, owner, false, attemptedThrough)
    return { failedThroughId: attemptedThrough, cleanupBlocked: false }
  }
}

/** Deletes rooms idle past the TTL, with their Ampersand sessions so they stop counting against the account. At most hourly per process. */
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
  for (const id of await store.idleRooms(cutoff, MAX_ROOMS_PER_SWEEP, [...sweepFailures.keys()])) {
    const cleaner = randomUUID()
    // Claim BEFORE touching external sessions. Returning members cannot start a run
    // or admit input while the room is being retired, even if this function dies.
    if (!await store.claimCleanup(id, cleaner, cutoff, LEASE_MS)) continue
    try {
      const sessions = Object.values(await store.agentSessions(id))
      await store.assertCleanup(id, cleaner)
      const deleted = await Promise.all(sessions.map((session) => deleteSession(client, session.sessionId)))
      if (!deleted.every(Boolean)) {
        // Keep ownership as a durable barrier until another sweep retires ALL sessions.
        sweepFailures.set(id, now)
        counts.kept++
      } else if (await store.deleteIdleRoom(id, cutoff, cleaner)) {
        counts.deleted++
      } else {
        // A still-kept room is safe to reopen only once every saved session is gone.
        await store.releaseCleanup(id, cleaner)
      }
    } catch (error) {
      sweepFailures.set(id, now)
      counts.kept++
      console.warn('[fx0] collab sweep deferred', { name: error instanceof Error ? error.name : 'UnknownError' })
    }
  }
  if (counts.deleted || counts.kept) console.info('[fx0] collab sweep', { ...counts, waiting: (await store.idleRooms(cutoff, Number.MAX_SAFE_INTEGER, [])).length })
}
