import { readTranscript } from '../../../lib/journal'
import { deleteDesignSession } from '../../../lib/agent'
import { retryDesignAssetCleanup } from '../../../lib/design-assets'
import { removeOwnedSession } from '../../../lib/accounts'
import { withSessionRoute } from '../../../lib/route-auth'
import { after } from 'next/server.js'

export const maxDuration = 300

export const GET = withSessionRoute(async (_request, { id }) => {
  return Response.json(await readTranscript(id, after))
})

export const DELETE = withSessionRoute(async (_request, { host, id, user }) => {
  after(() => retryDesignAssetCleanup().catch(() => console.error('[fx0] asset cleanup retry unavailable')))
  // Runtime owns cancellation, config/agent-start fencing, and durable Redis
  // deletion. An exception or busy result retains Neon ownership for retry.
  if (!await deleteDesignSession(host)) {
    return Response.json({ error: 'Chat is busy; stop the active turn and retry' }, { status: 409 })
  }
  await removeOwnedSession(user.id, id)
  return Response.json({ ok: true })
})
