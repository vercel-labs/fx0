import { after, connection } from 'next/server.js'
import ChatApp, { type AccountBoot, type ChatBoot } from '../components/chat-app'
import type { PagePreference } from '../components/composer'
import { DEFAULT_MODEL } from '../lib/session'
import { readSession, readTranscript } from '../lib/journal'
import { AuthError, assertSessionOwner, validSessionId } from '../lib/accounts'
import { publicUser, requireUserSession } from '../lib/auth'
import { listOwnedSessions } from '../lib/route-auth'
import { compactTranscript } from '../lib/transcript'
import { DEFAULT_VIEW } from '../components/chat-state'
import { cookies, headers } from 'next/headers'
import { getGuestSession, guestUser, remainingFreePrompts, trialEnabled } from '../lib/trial'
import { claimGuestSessions } from '../lib/accounts'

async function loadAccount(): Promise<AccountBoot> {
  await connection()
  const guest = await getGuestSession()
  try {
    const session = await requireUserSession()
    if (guest) await claimGuestSessions(guest.userId, session.userId)
    return { user: publicUser(session), team: session.teamSlug || session.teamId || null, freePrompts: null }
  } catch (error) {
    if (!(error instanceof AuthError) || error.status !== 401) throw error
    // Only a visitor without an account is offered free prompts.
    const freePrompts = trialEnabled() ? await remainingFreePrompts(await headers()).catch(() => null) : null
    return { user: guest ? guestUser(guest) : freePrompts !== null
      ? { id: 'guest:new', name: 'You', email: null, picture: null, guest: true } : null, team: null, freePrompts }
  }
}

async function loadChat(account: Promise<AccountBoot>, searchParams: PageProps<'/'>['searchParams']): Promise<ChatBoot> {
  const [{ user }, params] = await Promise.all([account, searchParams])
  const draft: ChatBoot = { sessionId: 'draft', snapshot: { transcript: compactTranscript([], DEFAULT_VIEW), summary: null }, now: Date.now(), missing: false }
  if (!user || user.id === 'guest:new') return draft
  const requested = Array.isArray(params.s) ? params.s[0] : params.s
  if (!requested) return draft
  if (!validSessionId(requested)) return { ...draft, missing: true }
  try {
    await assertSessionOwner(user.id, requested)
  } catch (error) {
    if (!(error instanceof AuthError) || error.status !== 404) throw error
    return { ...draft, missing: true }
  }
  return { sessionId: requested, snapshot: await readTranscript(requested, after), now: Date.now(), missing: false }
}

// The model the page opens with, so the streamed HTML names it instead of the app
// default: an owned chat's stored settings (the chat loader checked ownership), or
// for a new design the viewer's last picks, which live in cookies.
async function loadPreference(chat: Promise<ChatBoot>): Promise<PagePreference> {
  const { sessionId } = await chat
  if (sessionId !== 'draft') {
    const stored = await readSession(sessionId)
    return { sessionId, model: stored?.preferredModel ?? '', effort: stored?.preferredEffort ?? '', fast: stored?.preferredFast ?? false }
  }
  await connection()
  const jar = await cookies()
  return { sessionId, model: jar.get('fx0-model')?.value ?? '', effort: jar.get('fx0-effort')?.value ?? '', fast: jar.get('fx0-fast')?.value === '1' }
}

// Consumers stream independently; only the chat awaits its ownership and journal.
export default function Page({ searchParams }: PageProps<'/'>) {
  const account = loadAccount()
  const sidebar = account.then(({ user }) => user && user.id !== 'guest:new' ? listOwnedSessions(user.id) : { sessions: [], nextCursor: null })
  const boot = loadChat(account, searchParams)
  return <ChatApp account={account} sidebar={sidebar} boot={boot} preference={loadPreference(boot)} defaultModel={process.env.FX0_MODEL ?? DEFAULT_MODEL} />
}
