import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { after } from 'next/server'
import { createSessionEventStream } from '../../../lib/event-stream'
import { assertPromptFunding, followChat, getSessionGenerationOptions, submitPrompt } from '../../../lib/agent'
import { parseDesignMdRequest, type DesignMdInput } from '../../../lib/design-md'
import { withPromptRoute, type SessionRouteContext } from '../../../lib/route-auth'
import { touchOwnedSession } from '../../../lib/accounts'
import { checkBotId } from 'botid/server'
import { trialEnabled, trialIpHash, trialStore, type TrialCredential, type TrialReservation } from '../../../lib/trial'
import { TRIAL_MODEL, usesFreePrompts } from '../../../lib/trial-policy'
import { DEFAULT_MODEL, log } from '../../../lib/session'
import { validatePromptImages, validatePromptPreviews } from '../../../lib/prompt-images'
import { DesignAssetLimitError, retryDesignAssetCleanup, startDesignAssets, type PendingDesignAssets } from '../../../lib/design-assets'
import { PROMPT_TEXT_LIMIT_ERROR, PROMPT_TEXT_MAX_BYTES, promptTextBytes } from '../../../lib/prompt-limits'

export const maxDuration = 800

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
  // Checked whole before any reservation or write: a refusal leaves the composer's draft.
  const checkedImages = validatePromptImages(body?.images)
  if ('error' in checkedImages) return Response.json({ error: checkedImages.error }, { status: 413 })
  const images = checkedImages.images.length ? checkedImages.images : undefined
  if (!text && !images) return Response.json({ error: 'empty prompt' }, { status: 400 })
  // Rejected whole, never cut: the composer keeps the draft and shows this error.
  if (promptTextBytes(text) > PROMPT_TEXT_MAX_BYTES) return Response.json({ error: PROMPT_TEXT_LIMIT_ERROR }, { status: 413 })

  // Thumbnails persisted with the user's event so a reload still shows the images.
  // The full images above go to the model; these are display-only and bounded.
  const previews = validatePromptPreviews(body?.previews, images?.length ?? 0)

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
    // Funding is checked first, so nothing is stored for a prompt that could not run.
    // The caps are taken here; the upload then runs while libfx admits the prompt.
    let assets: PendingDesignAssets | undefined
    if (images) {
      after(() => retryDesignAssetCleanup().catch(() => console.error('[fx0] asset cleanup retry unavailable')))
      assertPromptFunding(activated.host, funding, 'kind' in session ? undefined : session)
      assets = await startDesignAssets(activated.id, user.id, images)
    }
    submitted = await submitPrompt(
      activated.host,
      author,
      text,
      clientId,
      images?.length ? images : undefined,
      initial,
      previews.length ? previews : undefined,
      funding,
      'kind' in session ? undefined : session,
      assets,
      images ? checkedImages.sizes : undefined,
    )
  } catch (error) {
    if (reservation) await trialStore().release(reservation).catch(() => console.error('[fx0] free prompt release failed'))
    if (error instanceof DesignAssetLimitError) return Response.json({ error: error.message }, { status: 429 })
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
