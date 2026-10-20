import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { after } from 'next/server'
import { createSessionEventStream } from '../../../lib/event-stream'
import { followChat, getSessionGenerationOptions, submitPrompt } from '../../../lib/agent'
import { parseDesignMdRequest, type DesignMdInput } from '../../../lib/design-md'
import { withPromptRoute, type SessionRouteContext } from '../../../lib/route-auth'
import { touchOwnedSession } from '../../../lib/accounts'
import { checkBotId } from 'botid/server'
import { trialEnabled, trialIpHash, trialStore, type TrialCredential, type TrialReservation } from '../../../lib/trial'
import { TRIAL_MODEL, usesFreePrompts } from '../../../lib/trial-policy'
import { DEFAULT_MODEL, log } from '../../../lib/session'

export const maxDuration = 800

// libfx stores each prompt, images included, before it acknowledges it; this
// keeps one prompt's images well inside its stored-input limits.
const MAX_DURABLE_IMAGE_BYTES = 3 * 1024 * 1024

// Catalog files ship with this route (outputFileTracingIncludes in next.config.mjs).
async function catalogDesignMd(id: string, name: string): Promise<DesignMdInput> {
  const text = await readFile(path.join(process.cwd(), 'lib', 'design-md', `${id}.md`), 'utf8')
  return { name, source: `getdesign:${id}`, text }
}

export const POST = withPromptRoute(async (request, context) => {
  const started = performance.now()
  const { user, session, existing } = context
  let body: {
    text?: unknown
    clientId?: unknown
    afterSeq?: unknown
    images?: unknown
    previews?: unknown
    generation?: { model?: unknown; effort?: unknown; fast?: unknown }
    designMd?: unknown
  }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'invalid json' }, { status: 400 })
  }

  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  const images = Array.isArray(body?.images)
    ? body.images.filter(
        (i): i is { type: 'image'; data: string; mimeType: string } =>
          i?.type === 'image' && typeof i?.data === 'string' && typeof i?.mimeType === 'string',
      )
    : undefined
  if (!text && !images?.length) return Response.json({ error: 'empty prompt' }, { status: 400 })
  if ((images?.length ?? 0) > 8) return Response.json({ error: 'prompt cannot contain more than 8 images' }, { status: 413 })
  let imageBytes = 0
  for (const [index, image] of (images ?? []).entries()) {
    if (!image.mimeType || image.mimeType.length > 128 || image.data.length > 5 * 1024 * 1024) {
      return Response.json({ error: `invalid or oversized image ${index + 1}` }, { status: 413 })
    }
    imageBytes += image.data.length
  }
  if (imageBytes > MAX_DURABLE_IMAGE_BYTES) {
    return Response.json({ error: 'prompt images exceed the 3 MiB limit' }, { status: 413 })
  }

  // Thumbnails persisted with the user's event so a reload still shows the images.
  // The full images above go to the model; these are display-only and bounded.
  const previews = Array.isArray(body?.previews)
    ? body.previews.filter((preview): preview is string =>
      typeof preview === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(preview) && preview.length <= 96 * 1024)
      .slice(0, images?.length ?? 0)
    : []

  // Settings picked before the chat existed; ignored once the chat has state.
  const generation = body?.generation && typeof body.generation === 'object' ? body.generation : {}
  const designRequest = parseDesignMdRequest(body?.designMd)
  if (designRequest && 'error' in designRequest) return Response.json({ error: designRequest.error }, { status: 400 })
  const designMd = !designRequest
    ? null
    : 'option' in designRequest
      ? await catalogDesignMd(designRequest.option.id, designRequest.option.name)
      : designRequest.upload
  const initial = {
    preferredModel: typeof generation.model === 'string' && generation.model.trim() ? generation.model.trim().slice(0, 200) : null,
    preferredEffort: typeof generation.effort === 'string' && generation.effort.trim() ? generation.effort.trim().slice(0, 32) : null,
    preferredFast: typeof generation.fast === 'boolean' ? generation.fast : null,
    designMd,
  }
  const guest = 'kind' in session
  if (guest) {
    initial.preferredModel = TRIAL_MODEL
    initial.preferredEffort = 'low'
    initial.preferredFast = true
  }
  let reservation: TrialReservation | null = null
  let funding: TrialCredential | undefined
  if (trialEnabled()) {
    const options = !existing ? { model: initial.preferredModel, effort: initial.preferredEffort, fast: initial.preferredFast, trialChat: true, unstarted: true }
      : await getSessionGenerationOptions(existing.host)
    const model = (options.unstarted ? initial.preferredModel : options.model) || (process.env.FX0_MODEL ?? DEFAULT_MODEL)
    const effort = (options.unstarted ? initial.preferredEffort : options.effort) || 'low'
    const fast = (options.unstarted ? initial.preferredFast : options.fast) ?? false
    if ((options.trialChat || options.unstarted) && usesFreePrompts(model, effort, fast)) {
      const store = trialStore()
      const bucket = trialIpHash(request.headers)
      if (await store.remaining(bucket) > 0) {
        const verification = await checkBotId()
        if (verification.isBot) return Response.json({ error: 'Unable to verify this request' }, { status: 403 })
        reservation = await store.reserve(bucket, clientIdForTrial(body.clientId))
        if (reservation) funding = { kind: 'trial', userId: user.id, loginId: session.loginId, expiresAt: Date.now() + 24 * 3600_000 }
      }
    }
  }
  if (guest && !funding) {
    return Response.json({ code: 'trial_exhausted', error: 'Your five free prompts are used. Sign in to continue.' }, { status: 402 })
  }
  const author = (user.name || user.email || user.id).slice(0, 24)
  const clientId = typeof body?.clientId === 'string' ? body.clientId.slice(0, 40) : undefined
  let submitted: { id: number; seq: number; trialChat: boolean }
  let activated: SessionRouteContext
  const checked = performance.now()
  let activatedAt = checked
  try {
    activated = await context.activate()
    activatedAt = performance.now()
    submitted = await submitPrompt(
      activated.host,
      author,
      text.slice(0, 4000),
      clientId,
      images?.length ? images : undefined,
      initial,
      previews.length ? previews : undefined,
      funding,
      'kind' in session ? undefined : session,
    )
  } catch (error) {
    if (reservation) await trialStore().release(reservation).catch(() => console.error('[fx0] free prompt release failed'))
    throw error
  }
  // Once journaled, an admission must keep its slot even if this confirmation
  // fails. Refunding after the worker starts could sponsor more than five turns.
  if (reservation) await trialStore().commit(reservation).catch(() => console.error('[fx0] free prompt confirmation failed'))
  const { id, seq } = submitted
  const { host, id: sessionId, created } = activated
  // Where a prompt's time goes before it is acknowledged, after sign-in.
  log(sessionId, 'prompt:route', {
    id, created,
    checksMs: Math.round(checked - started),
    activateMs: Math.round(activatedAt - checked),
    submitMs: Math.round(performance.now() - activatedAt),
  })

  // libfx runs the turn elsewhere; this function copies its stream into the
  // transcript until the chat goes idle, even after the client disconnects.
  after(() => followChat(host))
  // One activity write per admitted prompt, outside its acknowledgement path.
  // Completed turns also update this row through the durable history writer.
  const activityUpdate = touchOwnedSession(user.id, sessionId, text, Date.now()).catch(() => {
    console.error('[fx0] chat activity update failed', { sessionId })
  })
  after(() => activityUpdate)
  let doneId = id
  const stream = createSessionEventStream(sessionId, {
    maxIdleMs: 300,
    // A current client asks for its missing prefix too, so POST can update the
    // UI immediately without waiting for the background GET to fill a gap.
    // Older clients start from their own user event without another seq read.
    afterSeq: typeof body.afterSeq === 'number' && Number.isSafeInteger(body.afterSeq) && body.afterSeq >= 0
      ? Math.min(body.afterSeq, Math.max(0, seq - 1))
      : Math.max(0, seq - 1),
    wake: () => void followChat(host),
    closeWhen(item) {
      if (item.type === 'status' && item.id === id && item.turnId != null) doneId = item.turnId
      return (
        (item.type === 'done' && item.id === doneId) ||
        (item.type === 'error' && (item.id === id || item.id === doneId))
      )
    },
  })
  return new Response(stream.pipeThrough(new TextEncoderStream()), {
    headers: {
      // A chat created by this request tells the client its id before any event.
      ...(created ? { 'x-fx0-session': sessionId } : {}),
      'x-fx0-trial-chat': submitted.trialChat ? '1' : '0',
      ...(reservation ? { 'x-fx0-free-prompts': String(reservation.remaining) } : {}),
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  })
})

function clientIdForTrial(value: unknown): string {
  return typeof value === 'string' && value ? value.slice(0, 40) : crypto.randomUUID()
}
