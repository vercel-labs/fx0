import { connection } from 'next/server'
import { AuthError } from '../../../../lib/accounts'
import { collabRuntime } from '../../../../lib/collab/runtime'
import { requireBrowserToken, revisionId, withCollabRoute } from '../../../../lib/collab/http'
import { DESIGN_ARTIFACT_EMBEDDED_CSP, prepareDesignArtifactHtml } from '../../../../lib/design-artifact'

// Model-written HTML: the CSP sandbox keeps it in an opaque origin even when opened directly.
const artifact = withCollabRoute(async (request) => {
  const params = new URL(request.url).searchParams
  const id = params.get('room')
  if (!id) throw new AuthError(404, 'Design not found')
  const source = await collabRuntime().store.revisionHtml(id, requireBrowserToken(request), revisionId(params.get('revision')))
  const html = prepareDesignArtifactHtml(source, DESIGN_ARTIFACT_EMBEDDED_CSP, crypto.randomUUID())
  if (!html) throw new AuthError(422, 'Invalid design')
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': `${DESIGN_ARTIFACT_EMBEDDED_CSP}; frame-ancestors 'self'; sandbox allow-scripts`,
      'cache-control': 'private, no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  })
})

export async function GET(request: Request) {
  // Awaited outside the route's catch, so the build's prerender bail-out is not logged as a failure.
  await connection()
  return artifact(request)
}
