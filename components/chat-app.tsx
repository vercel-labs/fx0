'use client'

import { applyDesignDraft, EMPTY_DRAFT, type DraftState } from '../lib/design-draft'
import { createEventDelivery } from '../lib/event-delivery'

import {
  Suspense,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import Brand from './brand'
import AccountMenu, { type AccountUser } from './account-menu'
import { AUTH_REQUIRED_EVENT, AuthRouteError, fetchUi, readEventStream, signOutAccount } from './auth-ui'
import { fastClick } from '../lib/fast-click'
import { focusPrompt } from '../lib/prompt-focus'
import { signedInHintCookie, SIGNED_IN_HINT_COOKIE, SIGN_OUT_PENDING_COOKIE } from '../lib/session-cookies'
import { cn } from '../lib/utils'
import Composer, { type AttachedImage, type ComposerHandle, type PagePreference, type GenerationOptions } from './composer'
import SignInDialog from './sign-in-dialog'
import { clearGuestDraft, saveGuestDraft, takeGuestDraft } from './guest-draft'
import { invalidateCached } from './cached-fetch'
import { imageThumbnail } from './image-thumbnail'
import dynamic from 'next/dynamic.js'
import type { LocalLogEntry } from './debug-panel'
import NewChat from './new-chat'

// Rarely opened and pulls in Sheet and Tabs; loaded on first open, not with the page.
const DebugPanel = dynamic(() => import('./debug-panel'), { ssr: false })
import DesignExport from './design-export'
import { Skeleton } from './ui/skeleton'
import PreviewPane, { type PreviewSource } from './preview-pane'
import Sidebar from './sidebar'
import SidebarGestures, { type SidebarGestureControls } from './sidebar-gestures'
import { Button } from './ui/button'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import SourceLink from './source-link'
import {
  DEFAULT_VIEW,
  applyStreamItem,
  endActivity,
  isPreviewOpenFromSearch,
  joinedMessageId,
  mergeSessionView,
  projectSessionView,
  renameActivity,
  replayEvents,
  startActivity,
  upsertSession,
  type ActivityStarts,
} from './chat-state'
import type { ChatEntry } from './thread'
import Transcript from './transcript'
import { compactTranscript, transcriptState, type SessionSnapshot } from '../lib/transcript'
import type { SessionInfo, SessionPage, SessionView, StreamItem } from '../lib/events'
import { urlChat } from '../lib/session-id'
import { TRIAL_MODEL } from '../lib/trial-policy'

function newClientId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function mergeSessions(previous: SessionInfo[], incoming: SessionInfo[]): SessionInfo[] {
  const byId = new Map(previous.map((session) => [session.id, session]))
  for (const session of incoming) {
    const old = byId.get(session.id)
    if (!old || session.lastActivity >= old.lastActivity) byId.set(session.id, session)
  }
  return [...byId.values()].sort((a, b) => b.lastActivity - a.lastActivity)
}

function without(sessions: SessionInfo[], ids: Set<string>): SessionInfo[] {
  return ids.size ? sessions.filter((session) => !ids.has(session.id)) : sessions
}

function sameSessions(previous: SessionInfo[], next: SessionInfo[]): boolean {
  return (
    previous.length === next.length &&
    previous.every((session, index) => {
      const candidate = next[index]
      return (
        session.id === candidate?.id &&
        session.title === candidate.title &&
        session.lastActivity === candidate.lastActivity &&
        session.busy === candidate.busy
      )
    })
  )
}


// The minimum keeps a clear gap between the brand and the how it works link.
const SIDEBAR_WIDTH = { default: 240, min: 224, max: 320 }
const AGENT_WIDTH = { default: 420, min: 320, max: 640 }
type Pane = 'sidebar' | 'agent'

// Cross half the minimum width and the pane snaps shut in one step; cross back and
// it snaps open again. There is no in-between width.
const PANE = {
  sidebar: { width: SIDEBAR_WIDTH, cssVar: '--sidebar-width', expandedVar: '--sidebar-expanded-width' },
  agent: { width: AGENT_WIDTH, cssVar: '--agent-width', expandedVar: '--agent-expanded-width' },
} as const

function collapseThreshold(pane: Pane): number {
  return PANE[pane].width.min / 2
}
const MIN_PREVIEW_WIDTH = 320
const RESIZE_STEP = 16

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

const CHEVRON_LEFT = 'm9.25 12.06-.53-.53L5.9 8.71a1 1 0 0 1 0-1.42l2.82-2.82.53-.53L10.31 5l-.53.53L7.31 8l2.47 2.47.53.53z'

function ResizeHandle({
  label,
  value,
  min,
  max,
  className,
  active,
  onPointerDown,
  onKeyDown,
}: {
  label: string
  value: number
  min: number
  max: number
  className: string
  active: boolean
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void
}) {
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${value} pixels`}
      tabIndex={0}
      title="Click to collapse. Drag to resize. Arrow keys also work."
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className={`group cursor-col-resize touch-none select-none items-center justify-center outline-none ${className}`}
    >
      {/* Same affordance as the session rail's edge, from the vercel.com dashboard. */}
      <span
        className={`pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border-strong ${
          active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:bg-ring group-focus-visible:opacity-100'
        }`}
        style={{ transition: 'opacity 100ms ease 75ms' }}
      />
      <span
        className={`relative grid size-6 shrink-0 cursor-pointer place-content-center rounded-full border border-border-strong bg-background text-foreground group-hover:border-foreground-tertiary group-hover:bg-secondary ${
          active ? 'opacity-0' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'
        }`}
        style={{ transition: 'opacity 150ms ease 150ms' }}
      >
        <svg viewBox="0 0 16 16" className="size-4 scale-90 group-hover:scale-100" style={{ transition: 'transform 150ms ease' }} aria-hidden="true">
          <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d={CHEVRON_LEFT} />
        </svg>
      </span>
    </div>
  )
}

export interface AccountBoot {
  user: AccountUser | null
  team: string | null
  freePrompts?: number | null
}

export interface ChatBoot {
  sessionId: string
  snapshot: SessionSnapshot
  now: number
  missing: boolean
}

interface ChatAppProps {
  account: Promise<AccountBoot>
  sidebar: Promise<SessionPage>
  boot: Promise<ChatBoot>
  preference?: Promise<PagePreference>
  defaultModel: string
}

function BootLoader<T>({ boot, onBoot }: { boot: Promise<T>; onBoot: (data: T) => void }) {
  const data = use(boot)
  useLayoutEffect(() => onBoot(data), [data, onBoot])
  return null
}

function BootRegion<T>({ boot, live, children }: { boot: Promise<T>; live: T | undefined; children: (view: T) => ReactNode }) {
  return children(live === undefined ? use(boot) : live)
}

interface InteractionNotice {
  tone: 'status' | 'error'
  text: string
}

function isSessionView(value: unknown): value is SessionView {
  if (value == null || typeof value !== 'object') return false
  return typeof (value as Partial<SessionView>).artifactRevision === 'number'
}

function withCurrentSession(
  sessions: SessionInfo[],
  sessionId: string,
  now: number,
  events: StreamItem[] = [],
  view?: SessionView,
): SessionInfo[] {
  const current = sessions.find((session) => session.id === sessionId)
  const firstUser = events.find((event) => event.type === 'user')
  if (!current && !firstUser) return sessions
  const lastPromptAt = events.reduce((latest, event) => event.type === 'user' ? Math.max(latest, event.at ?? 0) : latest, 0)
  const replayed = replayEvents(events, view)
  const summary: SessionInfo = {
    id: sessionId,
    title: current?.title ?? firstUser?.text?.slice(0, 40) ?? null,
    createdAt: current?.createdAt ?? firstUser?.at ?? now,
    lastActivity: current || events.length > 0 ? Math.max(current?.lastActivity ?? 0, lastPromptAt) : now,
    busy: replayed.activeTurnId != null,
    ...(current?.trialChat ? { trialChat: true } : {}),
  }
  const next = current
    ? sessions.map((session) => (session.id === sessionId ? summary : session))
    : [summary, ...sessions]
  return next.toSorted((a, b) => b.lastActivity - a.lastActivity)
}

// startedAt comes from the turn_start event, so a refresh mid-turn keeps counting
// from when the turn opened instead of from when this component mounted.
function ActivityLine({ label, startedAt }: { label: string; startedAt: number | null }) {
  // A fallback fixed at mount: Date.now() per render reset the counter to 0s on
  // every re-render, which during streaming is constantly.
  const [mountedAt] = useState(() => Date.now())
  const since = startedAt ?? mountedAt
  const [elapsed, setElapsed] = useState(() => Math.max(0, Math.floor((Date.now() - since) / 1000)))
  useEffect(() => {
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - since) / 1000)))
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [since])
  return (
    <p className="my-2 flex items-center gap-1.5 font-mono text-xs leading-5 tabular-nums">
      <span aria-hidden="true" className="pulse-dot text-muted-foreground">
        •
      </span>
      <span className="text-foreground-secondary">{label}</span>
      <span className="text-muted-foreground">({elapsed}s)</span>
    </p>
  )
}

export default function ChatApp({ account, sidebar, boot, preference, defaultModel }: ChatAppProps) {
  const [initialState] = useState(() => replayEvents([], DEFAULT_VIEW))
  const [initialGeneration] = useState<GenerationOptions>(() => ({ model: '', effort: '', fast: false, defaultModel }))
  // undefined until the request's data arrives; null has no chat identity.
  const [user, setUser] = useState<AccountUser | null | undefined>(undefined)
  const [team, setTeam] = useState<string | null>(null)
  const [freePrompts, setFreePrompts] = useState<number | null>(null)
  const [sessionId, setSessionId] = useState('draft')
  const [trialChat, setTrialChat] = useState(false)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [entries, setEntries] = useState<ChatEntry[]>(initialState.entries)
  const [artifactRevision, setArtifactRevision] = useState(initialState.view.artifactRevision)
  const [designDraft, setDesignDraft] = useState<{ id: string; html: string } | null>(null)
  const [viewedRevision, setViewedRevision] = useState<{ sessionId: string; revision: number; latest: number } | null>(null)
  const [activeTurnId, setActiveTurnId] = useState<number | null>(initialState.activeTurnId)
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(initialState.activeTurnStartedAt)
  // The wait the user feels starts at send, not at the server's turn_start, so the
  // counter runs through "sending" and "thinking" instead of sitting at 0s. Kept
  // per chat, so switching to another chat and back doesn't restart it.
  const [activityStarts, setActivityStarts] = useState<ActivityStarts>(() => new Map())
  const [awaiting, setAwaiting] = useState(false)
  // The server accepted the awaited prompt: it is stored and its turn is
  // starting, so the activity line says "thinking" before turn_start arrives.
  const [sendAccepted, setSendAccepted] = useState(false)
  const [authStatus, setAuthStatus] = useState<401 | 403 | null>(null)
  const [signOutStatus, setSignOutStatus] = useState<'pending' | 'failed' | null>(null)
  const signOutPending = useRef(false)
  const signedOut = useRef(false)
  const authBlocked = authStatus != null
  const [chatReady, setChatReady] = useState(false)
  const bootAbandoned = useRef(false)
  const [sidebarReady, setSidebarReady] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const booting = user === undefined || !chatReady
  const hasIdentity = user != null && authStatus !== 401
  const isAuthenticated = hasIdentity && !user.guest
  useEffect(() => {
    if (user === undefined) return
    document.documentElement.classList.toggle('guest', !isAuthenticated)
    const hinted = document.cookie.split(';').some((cookie) => cookie.trim() === `${SIGNED_IN_HINT_COOKIE}=1`)
    if (hinted !== isAuthenticated) {
      document.cookie = signedInHintCookie(isAuthenticated, window.location.protocol === 'https:')
    }
  }, [user, isAuthenticated])
  const canAccessSession = hasIdentity && !authBlocked && !booting && sessionId !== 'draft'
  const authAllowed = useRef(hasIdentity && !authBlocked && !booting)
  authAllowed.current = hasIdentity && !authBlocked && !booting
  const [preparingPrompt, setPreparingPrompt] = useState(false)
  const preparingPromptRef = useRef(false)
  const privateAccess = useRef(canAccessSession)
  privateAccess.current = canAccessSession
  const [signInOpen, setSignInOpen] = useState(false)
  const [draftError, setDraftError] = useState('')
  const composerRef = useRef<ComposerHandle>(null)
  const restoredDraft = useRef(false)
  // True while the sign-in dialog was opened by a send, so the draft goes out after sign-in.
  const signInSends = useRef(false)
  const [resumeSend, setResumeSend] = useState(false)

  useEffect(() => {
    if (!isAuthenticated || authBlocked || restoredDraft.current) return
    restoredDraft.current = true
    try {
      const draft = takeGuestDraft(window.sessionStorage)
      if (!draft) return
      composerRef.current?.restoreDraft(draft)
      if (draft.submit) setResumeSend(true)
    } catch { /* Session storage is optional. */ }
  }, [isAuthenticated, authBlocked])

  const accountUser = user === undefined ? undefined : isAuthenticated ? user : null

  function openSignIn() {
    // After a failed sign-out the old grant is unusable (the pending marker hides it)
    // and retrying may keep failing. A fresh sign-in is the way out: the callback
    // clears the marker and issues a new login id.
    if (signedOut.current) {
      if (signOutStatus === 'failed') window.location.assign('/api/auth/signin')
      return
    }
    signInSends.current = false
    setDraftError('')
    setSignInOpen(true)
  }

  // Vercel's consent screen grants every team at once, so the billing team is
  // chosen here. The page reloads under the new team; the unsent draft survives
  // the reload exactly as it does a sign-in round trip.
  async function switchTeam(teamId: string) {
    const response = await fetchUi('/api/teams', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ teamId }),
    })
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? 'Unable to switch team. Try again.')
    prepareSignIn()
    window.location.reload()
  }

  // A team missing from the list has not granted this app Gateway access yet;
  // Vercel's consent screen is where that permission is given.
  function grantTeams() {
    if (!prepareSignIn()) return
    // A new consent can add teams; the cached list must not hide them.
    invalidateCached('fx0:cache:teams:')
    window.location.assign('/api/auth/signin?reauth=true')
  }

  function prepareSignIn(submit = false): boolean {
    if (signedOut.current) return false
    setDraftError('')
    const draft = composerRef.current?.getDraft() ?? { text: '', images: [] }
    try {
      if (saveGuestDraft(window.sessionStorage, { ...draft, submit })) return true
    } catch { /* Keep the in-memory draft when storage is blocked. */ }
    if (!draft.text && !draft.images.length) return true
    setDraftError('Unable to preserve this draft for sign-in. Copy the text and remove attachments, or allow session storage, then try again.')
    return false
  }
  const [interactionNotice, setInteractionNotice] = useState<InteractionNotice | null>(null)
  const [stopPending, setStopPending] = useState(false)
  const [debugOpen, setDebugOpen] = useState(false)
  const [chatMenuOpen, setChatMenuOpen] = useState(false)
  // Deleting takes a second press on the same item, so a stray click never loses a chat.
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  function toggleChatMenu(open: boolean) {
    setChatMenuOpen(open)
    setConfirmingDelete(false)
  }
  // On a phone the conversation and the preview take turns, so the visitor picks one;
  // a wide screen shows both and the preview is always open.
  const [previewChosen, setPreviewChosen] = useState(true)
  const [wide, setWide] = useState(true)
  const previewOpen = previewChosen || wide
  const [startedTurns, setStartedTurns] = useState<Set<number>>(initialState.startedTurns)
  const [streamStartSeq, setStreamStartSeq] = useState(initialState.lastSeq)
  const [switchingTo, setSwitchingTo] = useState<string | null>(null)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  // The session rail drags through SidebarGestures; this tracks the conversation pane.
  const [agentResizing, setAgentResizing] = useState(false)
  const [clock, setClock] = useState(0)
  const [collapsed, setCollapsed] = useState<Record<Pane, boolean>>({ sidebar: false, agent: false })
  const [agentWidth, setAgentWidth] = useState(AGENT_WIDTH.default)
  const mainRef = useRef<HTMLElement>(null)
  const sidebarWidthRef = useRef(SIDEBAR_WIDTH.default)
  const agentWidthRef = useRef(AGENT_WIDTH.default)
  const threadRef = useRef<HTMLDivElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const previewButtonRef = useRef<HTMLButtonElement>(null)
  const mobileSidebarRef = useRef<HTMLDivElement>(null)
  const sidebarContentRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const [threadSettled, setThreadSettled] = useState(false)
  const threadContentRef = useRef<HTMLDivElement>(null)
  const [eventDelivery] = useState(() => createEventDelivery(initialState.lastSeq, initialState.view.artifactRevision))
  const eventCache = useRef(new Map<string, SessionSnapshot>())
  // Chats deleted from this tab; list refreshes in flight must not bring them back.
  const deletingSessions = useRef(new Set<string>())
  const prefetches = useRef(new Map<string, Promise<SessionSnapshot>>())
  const clientLog = useRef<LocalLogEntry[]>([])
  const serverInstance = useRef<string | null>(initialState.serverInstance)
  const activeSession = useRef('draft')
  const currentView = useRef<SessionView>(initialState.view)
  const wideViewport = useRef(true)
  const lastDraftId = useRef<string | null>(null)
  const draftState = useRef<DraftState>(EMPTY_DRAFT)
  const switchSessionRef = useRef<(id: string, pushHistory?: boolean) => Promise<void>>(async () => {})
  const returnToDraftRef = useRef<(missing: boolean) => void>(() => {})
  activeSession.current = sessionId
  const applyCurrentView = useCallback((view: SessionView) => {
    currentView.current = view
    setArtifactRevision(view.artifactRevision)
  }, [])

  useEffect(() => {
    const onAuthRequired = (event: Event) => {
      privateAccess.current = false
      authAllowed.current = false
      setAuthStatus((event as CustomEvent<401 | 403>).detail)
    }
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired)
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired)
  }, [])

  function clearSessionCaches() {
    signedOut.current = true
    privateAccess.current = false
    authAllowed.current = false
    bootAbandoned.current = true
    pendingSend.current = false
    invalidateCached('fx0:')
    eventCache.current.clear()
    prefetches.current.clear()
    clientLog.current = []
    setEntries([])
    setSessions([])
    setUser(null)
    setTeam(null)
    setFreePrompts(null)
    setChatReady(true)
    setSidebarReady(true)
    setNextCursor(null)
    setLoadingMore(false)
    setSwitchingTo(null)
    setViewedRevision(null)
    setMobileSidebarOpen(false)
    setPreparingPrompt(false)
    preparingPromptRef.current = false
    setSignInOpen(false)
    setAuthStatus(401)
    resetLocalDraft()
  }

  async function signOut() {
    if (signOutPending.current) return
    signOutPending.current = true
    setSignOutStatus('pending')
    try {
      await signOutAccount(clearSessionCaches)
    } catch {
      // Keep the private UI hidden. The server may still have a session; offer
      // an explicit retry instead of silently claiming that revocation worked.
      setSignOutStatus('failed')
    } finally {
      signOutPending.current = false
    }
  }

  useEffect(() => {
    // A refresh may interrupt the first POST before its Set-Cookie arrives.
    // Normal server readers already render a guest; resume revocation here.
    if (document.cookie.split(';').some((cookie) => cookie.trim() === `${SIGN_OUT_PENDING_COOKIE}=1`)) {
      void signOut()
    }
  }, [])

  const adoptSessionView = useCallback(
    (id: string, view: SessionView) => {
      const snapshot = eventCache.current.get(id)
      const current = snapshot?.transcript.view ?? (activeSession.current === id ? currentView.current : view)
      const next = mergeSessionView(current, view)
      if (snapshot) snapshot.transcript = { ...snapshot.transcript, view: next }
      if (activeSession.current === id) applyCurrentView(next)
    },
    [applyCurrentView],
  )

  // Widths and collapse live in cookies, which the layout's inline script already
  // applied to the first paint. This only mirrors them into React state.
  useLayoutEffect(() => {
    setCollapsed({
      sidebar: document.cookie.includes('fx0-sidebar-collapsed=1'),
      agent: document.cookie.includes('fx0-agent-collapsed=1'),
    })
    setPreviewChosen(isPreviewOpenFromSearch(window.location.search))
    setClock(Date.now())
  }, [])

  useEffect(() => {
    const read = (name: string, fallback: number, min: number, max: number) => {
      const raw = document.cookie.match(new RegExp(`${name}=(\\d+)`))?.[1]
      const value = Number(raw)
      return Number.isFinite(value) && value > 0 ? clamp(value, min, max) : fallback
    }
    const nextSidebar = read('fx0-sidebar-width', SIDEBAR_WIDTH.default, SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max)
    const nextAgent = read('fx0-agent-width', AGENT_WIDTH.default, AGENT_WIDTH.min, AGENT_WIDTH.max)
    sidebarWidthRef.current = nextSidebar
    agentWidthRef.current = nextAgent
    setAgentWidth(nextAgent)

    const timer = setInterval(() => setClock(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  // The server already titled the first paint; this keeps up with client-side
  // session switches and with a title the first turn assigns.
  useEffect(() => {
    const title = sessions.find((session) => session.id === sessionId)?.title
    if (title) document.title = `${title} · fx0`
  }, [sessionId, sessions])

  useEffect(() => {
    const onPopState = () => {
      const next = urlChat(window.location.search)
      setPreviewChosen(isPreviewOpenFromSearch(window.location.search))
      if (next.kind === 'chat') {
        if (next.id !== activeSession.current) void switchSessionRef.current(next.id, false)
      } else if (next.kind === 'invalid' || activeSession.current !== 'draft') {
        returnToDraftRef.current(next.kind === 'invalid')
      }
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    const media = window.matchMedia('(min-width: 768px)')
    const reconcileDrawer = () => {
      if (media.matches) setMobileSidebarOpen(false)
    }
    media.addEventListener('change', reconcileDrawer)
    return () => media.removeEventListener('change', reconcileDrawer)
  }, [])

  useEffect(() => {
    // Read the cookie rather than state: this runs on mount, possibly before the
    // effect that mirrors the cookie into state, and it was reopening a pane the
    // server had just painted shut.
    const isCollapsed = (pane: Pane) => document.cookie.includes(`fx0-${pane}-collapsed=1`)
    const reconcilePaneWidths = () => {
      // Clamped to fit the window, not committed: the cookie keeps the chosen width.
      if (window.innerWidth >= 768 && !isCollapsed('sidebar')) {
        applyPaneWidth('sidebar', sidebarWidthRef.current, false)
      }
      if (previewOpen && window.innerWidth >= 1024 && !isCollapsed('agent')) {
        applyPaneWidth('agent', agentWidthRef.current, false)
        setAgentWidth(agentWidthRef.current)
      }
    }
    reconcilePaneWidths()
    window.addEventListener('resize', reconcilePaneWidths)
    return () => window.removeEventListener('resize', reconcilePaneWidths)
  }, [previewOpen])

  useEffect(() => {
    if (!canAccessSession) return
    let inFlight = false
    let ready = false
    let cancelled = false
    let controller: AbortController | null = null
    const readyTimer = setTimeout(() => {
      ready = true
    }, 1000)
    // Focus and visibilitychange both fire on a tab return; one refresh per 30s is
    // enough for titles and busy dots, which the live stream already updates.
    let lastRevalidated = Date.now()
    const revalidate = async () => {
      if (!privateAccess.current || !ready || inFlight || document.visibilityState !== 'visible') return
      if (Date.now() - lastRevalidated < 30_000) return
      lastRevalidated = Date.now()
      inFlight = true
      controller = new AbortController()
      try {
        const response = await fetchUi('/api/sessions', { signal: controller.signal })
        if (!response.ok || cancelled) return
        const data = (await response.json()) as { sessions?: SessionInfo[] }
        if (cancelled || signedOut.current) return
        const next = data.sessions ?? []
        setSessions((previous) => { const merged = mergeSessions(previous, without(next, deletingSessions.current)); return sameSessions(previous, merged) ? previous : merged })
      } catch (error) {
        if ((error as Error)?.name !== 'AbortError') {
          console.error('[fx0] session metadata refresh failed', { error })
        }
      } finally {
        inFlight = false
        controller = null
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void revalidate()
    }
    window.addEventListener('focus', revalidate)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      controller?.abort()
      clearTimeout(readyTimer)
      window.removeEventListener('focus', revalidate)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [sessionId, canAccessSession])

  useEffect(() => {
    if (!mobileSidebarOpen) return
    const panel = mobileSidebarRef.current
    const focusable = () =>
      Array.from(
        panel?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled])',
        ) ?? [],
      )
    focusable()[0]?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setMobileSidebarOpen(false)
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      menuButtonRef.current?.focus()
    }
  }, [mobileSidebarOpen])

  const applyEvent = useCallback(
    (sourceSessionId: string, item: StreamItem) => {
      if (!privateAccess.current || sourceSessionId !== activeSession.current) return

      // Provisional bytes have their own generation and UTF-16 offset. Replayed
      // prefixes overlap safely; they never concatenate a second copy of the HTML.
      if (item.type === 'design_draft') {
        const next = applyDesignDraft(draftState.current, item, currentView.current.artifactRevision)
        if (next === draftState.current) return
        draftState.current = next
        setDesignDraft(next.draft)
        if (next.draft && lastDraftId.current !== next.draft.id) {
          lastDraftId.current = next.draft.id
          if (wideViewport.current) setPreviewVisibility(true)
        }
        return
      }

      if (item.instance) serverInstance.current = item.instance
      clientLog.current.push({
        at: item.at ?? Date.now(),
        type: item.type,
        summary: (item.text ?? item.delta ?? item.command ?? item.stopReason ?? '').slice(0, 90),
        instance: item.instance,
      })
      if (clientLog.current.length > 150) clientLog.current.splice(0, clientLog.current.length - 150)

      // The stream reports journal read failures without a sequence. They describe
      // the connection, not the turn; reconnecting must keep its running state.
      if (item.type === 'error' && typeof item.seq !== 'number') {
        setInteractionNotice({ tone: 'error', text: item.text ?? 'Chat connection interrupted. Reconnecting…' })
        return
      }

      const snapshot = eventCache.current.get(sourceSessionId) ?? {
        transcript: compactTranscript([], currentView.current), summary: null,
      }
      const nextView = projectSessionView(snapshot.transcript.view, item)
      if (nextView !== snapshot.transcript.view) adoptSessionView(sourceSessionId, nextView)
      // Only journaled events belong to the snapshot restored on a chat switch.
      if (typeof item.seq === 'number') {
        snapshot.transcript = compactTranscript([item], nextView, snapshot.transcript)
        if (snapshot.summary) snapshot.summary = upsertSession([snapshot.summary], sourceSessionId, item)[0]
        eventCache.current.set(sourceSessionId, snapshot)
      }

      if (item.type === 'artifact' && item.artifactRevision != null) {
        if (wideViewport.current) {
          setPreviewVisibility(true)
        } else {
          setInteractionNotice({ tone: 'status', text: 'Design preview ready. Open Preview when you are ready.' })
        }
      }
      if (item.type === 'heartbeat') return
      if (item.type === 'turn_start') {
        setAwaiting(false)
        setActiveTurnId(item.id ?? null)
        setTurnStartedAt(item.at ?? Date.now())
        if (item.id != null) setStartedTurns((prev) => new Set(prev).add(item.id!))
      }
      const joined = joinedMessageId(item)
      if (joined != null) setStartedTurns((prev) => new Set(prev).add(joined))
      if (item.type === 'artifact' || item.type === 'done' || item.type === 'error') {
        draftState.current = applyDesignDraft(draftState.current, item, currentView.current.artifactRevision)
        setDesignDraft(draftState.current.draft)
      }
      if (item.type === 'done' || item.type === 'error') {
        setActiveTurnId(null)
        setTurnStartedAt(null)
      }

      if (item.type === 'user' || item.type === 'turn_start' || item.type === 'done' || item.type === 'error') {
        setSessions((prev) => {
          const seeded = item.type === 'user'
            ? withCurrentSession(prev, sourceSessionId, item.at ?? Date.now(), [item], nextView)
            : prev
          return upsertSession(seeded, sourceSessionId, item)
        })
      }
      setEntries((prev) => applyStreamItem(prev, item))
    },
    [adoptSessionView],
  )

  const ingest = useCallback((sourceSessionId: string, item: StreamItem, afterSeq?: number) => {
    // Reject another chat before mutating either the queue or its cursor.
    if (!privateAccess.current || sourceSessionId !== activeSession.current) return
    for (const ready of eventDelivery.push(item, afterSeq)) applyEvent(sourceSessionId, ready)
  }, [applyEvent, eventDelivery])

  // The background stream sleeps when the chat is idle: open while the tab is visible
  // and a turn is live, or for 30s after the last activity; closed when the tab hides.
  // Returning to the tab or sending wakes it, resuming from the last seen seq, so
  // nothing that happened meanwhile (another tab, another device) is missed, and an
  // idle open tab does not poll the journal.
  const chatStreamWake = useRef<() => void>(() => {})
  const turnLive = useRef(false)
  turnLive.current = activeTurnId != null || awaiting
  useEffect(() => {
    if (!canAccessSession) return
    const IDLE_MS = 30_000
    let after = streamStartSeq
    let controller: AbortController | null = null
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let lastActivity = Date.now()
    let disposed = false
    async function connect(stream: AbortController) {
      if (!privateAccess.current || stream.signal.aborted) return
      try {
        const response = await fetchUi(`/api/events?session=${encodeURIComponent(sessionId)}&after=${Math.min(after, eventDelivery.cursor)}`, {
          signal: stream.signal,
          headers: { accept: 'text/event-stream' },
        })
        if (!response.ok) throw new Error(`Chat stream failed with ${response.status}`)
        await readEventStream(response, (data) => {
          try {
            const item = JSON.parse(data) as StreamItem
            lastActivity = Date.now()
            ingest(sessionId, item, after)
            if (item.seq != null) after = Math.max(after, item.seq)
          } catch (error) {
            console.error('[fx0] invalid chat event', { sessionId, error })
          }
        })
      } catch (error) {
        if (stream.signal.aborted || error instanceof AuthRouteError) return
        console.error('[fx0] chat stream disconnected', { sessionId, error })
      }
      if (!stream.signal.aborted) retryTimer = setTimeout(() => { if (controller === stream) void connect(stream) }, 1000)
    }
    const open = () => {
      lastActivity = Date.now()
      if (disposed || controller || document.visibilityState !== 'visible') return
      controller = new AbortController()
      void connect(controller)
    }
    const close = () => {
      controller?.abort()
      controller = null
      clearTimeout(retryTimer)
    }
    const idleCheck = setInterval(() => {
      if (controller && !turnLive.current && Date.now() - lastActivity > IDLE_MS) close()
    }, 5_000)
    const onVisibility = () => (document.visibilityState === 'visible' ? open() : close())
    document.addEventListener('visibilitychange', onVisibility)
    chatStreamWake.current = open
    open()
    return () => {
      disposed = true
      close()
      clearInterval(idleCheck)
      document.removeEventListener('visibilitychange', onVisibility)
      chatStreamWake.current = () => {}
    }
  }, [sessionId, streamStartSeq, ingest, canAccessSession, eventDelivery])

  useEffect(() => {
    if (activeTurnId != null || awaiting) chatStreamWake.current()
  }, [activeTurnId, awaiting])

  // Tokens renew only on API requests. A long turn makes none, so a prompt
  // queued behind it could start with a token near expiry. While a turn is live, a
  // light request every 4 minutes renews the grant and rebinds the chat's
  // runtime to the fresh grant (warm returns early for a busy runtime).
  const turnRunning = activeTurnId != null
  useEffect(() => {
    if (!turnRunning || !canAccessSession || !isAuthenticated) return
    const keepalive = setInterval(() => {
      void fetchUi(`/api/warm?session=${encodeURIComponent(activeSession.current)}`, { method: 'POST' }).catch(() => {})
    }, 4 * 60_000)
    return () => clearInterval(keepalive)
  }, [turnRunning, canAccessSession, isAuthenticated])

  // Until the client takes over, the transcript is anchored at its end by layout
  // alone (a reversed flex column scrolls from its end), so it opens there however
  // much of the page the browser has parsed and painted. The first client frame
  // returns it to normal flow and pins it before painting.
  useLayoutEffect(() => setThreadSettled(true), [])
  const threadDisplay = threadSettled
    ? previewOpen ? 'hidden lg:block' : ''
    : previewOpen ? 'hidden flex-col-reverse lg:flex' : 'flex flex-col-reverse'

  // While the reader is at the end, the transcript stays there: before each paint
  // when entries change, and whenever it or its viewport changes size between
  // entries (fonts, markdown, images, the composer growing).
  useLayoutEffect(() => {
    if (!stickToBottom.current) return
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries, activeTurnId, threadSettled])

  useEffect(() => {
    const el = threadRef.current
    const content = threadContentRef.current
    if (!el || !content || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight
    })
    observer.observe(el)
    observer.observe(content)
    // Expanding something in the transcript (a tool's output) grows it under the
    // reader, who is now reading that spot: stop following the end so it doesn't jump
    // away. Scrolling back to the end follows again (onThreadScroll).
    const onToggle = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('[aria-expanded]')) stickToBottom.current = false
    }
    content.addEventListener('pointerdown', onToggle, true)
    content.addEventListener('click', onToggle, true)
    return () => {
      observer.disconnect()
      content.removeEventListener('pointerdown', onToggle, true)
      content.removeEventListener('click', onToggle, true)
    }
  }, [])

  function onThreadScroll() {
    const el = threadRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }

  function cacheSession(id: string, snapshot: SessionSnapshot) {
    if (signedOut.current) return
    eventCache.current.delete(id)
    eventCache.current.set(id, snapshot)
    while (eventCache.current.size > 5) {
      const oldest = eventCache.current.keys().next().value as string | undefined
      if (!oldest) break
      if (oldest === activeSession.current) {
        const current = eventCache.current.get(oldest)!
        eventCache.current.delete(oldest)
        eventCache.current.set(oldest, current)
        continue
      }
      eventCache.current.delete(oldest)
    }
  }

  // Opening an owned chat needs an identity; both guests and signed-in viewers
  // can return to an older design from the new-chat draft.
  function loadSession(id: string): Promise<SessionSnapshot> {
    if (!hasIdentity || authBlocked || id === 'draft') return Promise.reject(new Error('No reserved session.'))
    const cached = eventCache.current.get(id)
    if (cached) return Promise.resolve(cached)
    const pending = prefetches.current.get(id)
    if (pending) return pending
    const request = fetchUi(`/api/session?session=${encodeURIComponent(id)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`session failed: ${response.status}`)
        const snapshot = (await response.json()) as SessionSnapshot
        if (snapshot.transcript?.version !== 1 || !isSessionView(snapshot.transcript.view)) throw new Error('session response is missing its transcript')
        cacheSession(id, snapshot)
        return snapshot
      })
      .finally(() => prefetches.current.delete(id))
    prefetches.current.set(id, request)
    return request
  }

  function prefetchSession(id: string) {
    if (hasIdentity && !authBlocked && id !== 'draft' && id !== sessionId) void loadSession(id).catch(() => {})
  }

  async function switchSession(id: string, pushHistory = true) {
    focusPrompt()
    if (!hasIdentity || authBlocked || id === 'draft' || id === activeSession.current || switchingTo) return
    if (!chatReady) bootAbandoned.current = true
    pendingSend.current = false
    const cached = eventCache.current.get(id)
    if (!cached) setSwitchingTo(id)
    setInteractionNotice(null)
    try {
      const snapshot = cached ?? (await loadSession(id))
      if (signedOut.current) return
      showSession(id, snapshot)
      setChatReady(true)
      if (pushHistory) {
        const url = new URL(window.location.href)
        url.searchParams.set('s', id)
        window.history.pushState(null, '', url)
      }
      setInteractionNotice({ tone: 'status', text: 'Session loaded.' })
    } catch (error) {
      if (error instanceof AuthRouteError) return
      console.error('[fx0] session load failed', { sessionId: id, error })
      setInteractionNotice({ tone: 'error', text: 'Unable to load that session. Try again.' })
      if (!chatReady) setChatReady(true)
    } finally {
      setSwitchingTo(null)
    }
  }

  function showSession(id: string, snapshot: SessionSnapshot, now = Date.now()) {
    if (signedOut.current) return
    document.documentElement.classList.remove('chat-url')
    const state = transcriptState(snapshot.transcript)
    cacheSession(id, snapshot)
    activeSession.current = id
    eventDelivery.reset(state.lastSeq, state.view.artifactRevision)
    // Joined follow-up message IDs can exceed the active turn's ID. Only
    // earlier IDs may fence drafts while that turn is still running.
    const closedTurns = [...state.startedTurns].filter(turn => state.activeTurnId == null || turn < state.activeTurnId)
    draftState.current = { ...EMPTY_DRAFT, closedTurn: Math.max(0, ...closedTurns) }
    setDesignDraft(null)
    clientLog.current = []
    serverInstance.current = state.serverInstance
    stickToBottom.current = true
    setEntries(state.entries)
    applyCurrentView(state.view)
    setPreviewChosen(isPreviewOpenFromSearch(window.location.search))
    setDebugOpen(false)
    setChatMenuOpen(false)
    setActiveTurnId(state.activeTurnId)
    setTurnStartedAt(state.activeTurnStartedAt)
    setAwaiting(false)
    setStopPending(false)
    setStartedTurns(state.startedTurns)
    setStreamStartSeq(state.lastSeq)
    setSessionId(id)
    setTrialChat(snapshot.summary?.trialChat === true)
    setSessions((previous) => snapshot.summary && state.entries.length ? mergeSessions(previous, [snapshot.summary]) : previous)
  }

  switchSessionRef.current = switchSession
  returnToDraftRef.current = returnToDraft

  // A send before the account is known waits for it instead of gating sign-in; the
  // composer keeps the text meanwhile, so later edits go with it.
  const pendingSend = useRef(false)
  const sendRef = useRef(send)
  sendRef.current = send
  const sendFromTranscript = useCallback((text: string) => sendRef.current(text), [])

  const adoptAccount = useCallback((data: AccountBoot) => {
    if (signedOut.current) return
    setTeam(data.team)
    setUser(data.user)
    setFreePrompts(data.freePrompts ?? null)
  }, [])

  const adoptSidebar = useCallback((data: SessionPage) => {
    if (signedOut.current) return
    setSessions((previous) => mergeSessions(without(data.sessions, deletingSessions.current), previous))
    setNextCursor(data.nextCursor)
    setSidebarReady(true)
  }, [])

  const adoptBoot = useCallback((data: ChatBoot) => {
    if (bootAbandoned.current) return
    document.documentElement.classList.remove('chat-url')
    setClock(data.now)
    if (data.sessionId !== 'draft') showSession(data.sessionId, data.snapshot, data.now)
    if (data.missing) {
      const url = new URL(window.location.href)
      url.searchParams.delete('s')
      window.history.replaceState(null, '', url)
      setInteractionNotice({ tone: 'error', text: 'That chat does not exist or is not yours.' })
    }
    setChatReady(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadMoreSessions() {
    if (!nextCursor || loadingMore || !hasIdentity || authBlocked) return
    setLoadingMore(true)
    try {
      const response = await fetchUi(`/api/sessions?cursor=${encodeURIComponent(nextCursor)}`)
      if (!response.ok) throw new Error('Unable to load more chats.')
      const page = await response.json() as SessionPage
      if (signedOut.current) return
      setSessions((previous) => mergeSessions(without(page.sessions, deletingSessions.current), previous))
      setNextCursor(page.nextCursor)
    } catch (error) {
      if (!(error instanceof AuthRouteError)) setInteractionNotice({ tone: 'error', text: 'Unable to load more chats. Try again.' })
    } finally { setLoadingMore(false) }
  }

  // The draft restored after a sign-in that interrupted a send goes out now. It runs
  // after the composer has rendered the restored draft, so its handle sees it; while
  // the chat still boots, send() queues it like any other early send.
  useEffect(() => {
    if (!resumeSend) return
    setResumeSend(false)
    const draft = composerRef.current?.getDraft()
    const text = draft?.text.trim() ?? ''
    if (!draft || (!text && !draft.images.length)) return
    if (!sendRef.current(text, draft.images)) return
    composerRef.current?.clearDraft()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeSend])

  useEffect(() => {
    if (booting || !pendingSend.current) return
    pendingSend.current = false
    const draft = composerRef.current?.getDraft()
    const text = draft?.text.trim() ?? ''
    if (!draft || (!text && !draft.images.length)) return
    composerRef.current?.clearDraft()
    if (!sendRef.current(text, draft.images)) composerRef.current?.restoreDraft(draft)
  }, [booting])

  function resetLocalDraft(pushHistory = false, { keepTyping = false } = {}) {
    if (!keepTyping) {
      composerRef.current?.clearDraft()
      try { clearGuestDraft(window.sessionStorage) } catch { /* Storage is optional. */ }
    }
    setEntries([])
    setArtifactRevision(0)
    setActiveTurnId(null)
    setTurnStartedAt(null)
    setAwaiting(false)
    setStopPending(false)
    setDebugOpen(false)
    setChatMenuOpen(false)
    setSessionId('draft')
    setTrialChat(false)
    activeSession.current = 'draft'
    currentView.current = DEFAULT_VIEW
    // A draft is a chat with no events. Reset the per-chat stream state the way
    // switchSession does; otherwise the reserved chat's events (numbered from 1)
    // were dropped as already seen when the previous chat had as many events.
    eventDelivery.reset(0, 0)
    draftState.current = EMPTY_DRAFT
    clientLog.current = []
    serverInstance.current = null
    setDesignDraft(null)
    setStartedTurns(new Set())
    setStreamStartSeq(0)
    setInteractionNotice(null)
    const url = new URL(window.location.href)
    url.searchParams.delete('s')
    if (pushHistory) window.history.pushState(null, '', url)
    else window.history.replaceState(null, '', url)
  }

  // Typing in a draft is a strong signal a prompt follows, so its chat is reserved
  // in the background on the first keystroke and the send doesn't wait for it. An
  // unused reservation is invisible (lists show only chats with messages) and is
  // kept for the next draft rather than discarded.
  const draftReservation = useRef<Promise<string | null> | null>(null)
  function reserveDraftChat() {
    if (!isAuthenticated || draftReservation.current) return
    draftReservation.current = fetchUi('/api/sessions', { method: 'POST' })
      .then(async (response) => (response.ok ? String((await response.json()).id ?? '') || null : null))
      .catch(() => null)
    void draftReservation.current.then((id) => { if (id) warmChat(id) })
  }

  // Warming binds the runtime and builds the agent ahead of the send. Once a minute
  // per chat is plenty: the agent stays loaded between turns.
  const warmedAt = useRef(new Map<string, number>())
  function warmChat(id: string) {
    if (!isAuthenticated || !authAllowed.current || id === 'draft' || Date.now() - (warmedAt.current.get(id) ?? 0) < 60_000) return
    warmedAt.current.set(id, Date.now())
    void fetchUi(`/api/warm?session=${encodeURIComponent(id)}`, { method: 'POST' }).catch(() => {})
  }

  function onComposerInput(text: string) {
    if (!text.trim() || !isAuthenticated || !authAllowed.current) return
    if (activeSession.current === 'draft') reserveDraftChat()
    else warmChat(activeSession.current)
  }

  // Instant: a new design is a local draft, reserved on the server by its first
  // keystroke (reserveDraftChat), so nothing waits on a round trip here.
  function newDesign() {
    document.documentElement.classList.remove('chat-url')
    focusPrompt()
    bootAbandoned.current = true
    pendingSend.current = false
    setChatReady(true)
    resetLocalDraft(hasIdentity && activeSession.current !== 'draft')
  }

  // Back or Forward to a URL that opens no chat: show a new chat as New chat does,
  // but keep what's typed, as switching chats does. The URL is already in history,
  // so this adds no entry; an `s` that cannot name a chat is dropped with the
  // notice the first paint shows.
  function returnToDraft(missing: boolean) {
    document.documentElement.classList.remove('chat-url')
    focusPrompt()
    bootAbandoned.current = true
    pendingSend.current = false
    setChatReady(true)
    resetLocalDraft(false, { keepTyping: true })
    if (missing) setInteractionNotice({ tone: 'error', text: 'That chat does not exist or is not yours.' })
  }

  async function removeSession(id: string) {
    // Gated on the account, not the open chat: the sidebar deletes other chats.
    if (!hasIdentity || authBlocked || id === 'draft') return
    // Optimistic: the row goes at once; a refused delete puts it back where it was.
    const index = sessions.findIndex((session) => session.id === id)
    const removed = sessions[index]
    const remaining = sessions.filter((session) => session.id !== id)
    deletingSessions.current.add(id)
    setSessions(remaining)
    // While the page boots, the open chat is the one its URL is still loading;
    // leaving it abandons that load so it cannot reopen the deleted chat.
    const fromUrl = urlChat(window.location.search)
    const openId = chatReady ? activeSession.current : fromUrl.kind === 'chat' ? fromUrl.id : 'draft'
    let leaving: Promise<void> | undefined
    if (id === openId) {
      const next = remaining[0]
      if (next) leaving = switchSession(next.id)
      else newDesign()
    }
    const restore = async (text: string | null) => {
      if (signedOut.current) return
      deletingSessions.current.delete(id)
      if (removed) {
        setSessions((current) => current.some((session) => session.id === id)
          ? current
          : [...current.slice(0, index), removed, ...current.slice(index)])
      }
      // Leaving the chat ends with its own notice; the failure must replace it.
      await leaving
      if (text) setInteractionNotice({ tone: 'error', text })
    }
    try {
      const response = await fetchUi(`/api/session?session=${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!response.ok) {
        const data = await response.json().catch(() => null)
        await restore(data?.error ?? 'Unable to delete this chat.')
        return
      }
      eventCache.current.delete(id)
    } catch (error) {
      await restore(error instanceof AuthRouteError ? null : 'Unable to delete this chat. Try again.')
    }
  }

  function send(value: string, images: AttachedImage[] = []): boolean {
    if (signedOut.current) return false
    if (booting) {
      // A suggestion fills an empty composer; it never replaces an unsent draft.
      const draft = composerRef.current?.getDraft()
      if (draft && !draft.text.trim() && !draft.images.length) composerRef.current?.restoreDraft({ text: value, images })
      else if (draft && draft.text.trim() !== value.trim()) return false
      pendingSend.current = true
      return false
    }
    if (!hasIdentity || authBlocked || (user?.guest && freePrompts === 0)) {
      // Suggestions and the composer use this same gate. Do not replace an
      // existing unsent draft with a suggestion.
      composerRef.current?.restoreDraft({ text: value, images })
      signInSends.current = true
      setDraftError('')
      setSignInOpen(true)
      return false
    }
    if (preparingPromptRef.current || switchingTo) return false
    void sendPrompt(value, images)
    return true
  }

  async function sendPrompt(value: string, images: AttachedImage[]) {
    if (!user || !authAllowed.current) return
    let targetSession = sessionId
    const afterSeq = targetSession === 'draft' ? 0 : eventDelivery.cursor
    focusPrompt()
    const name = user.name
    const clientId = newClientId()
    const turnWasActive = activeTurnId != null
    // Only a draft's first prompt can start the chat with a DESIGN.md.
    const designPick = targetSession === 'draft' ? composerRef.current?.getDesignMd() ?? null : null
    // The bubble shows at once, before a draft's chat is reserved on the server.
    setAwaiting(true)
    setSendAccepted(false)
    setActivityStarts((starts) => startActivity(starts, targetSession, Date.now()))
    setInteractionNotice(null)
    setEntries((prev) => [
      ...prev,
      {
        key: `c${clientId}`,
        type: 'user',
        clientId,
        author: name,
        text: value,
        images,
        designMd: designPick?.name,
        pending: true,
        waiting: true,
      },
    ])
    stickToBottom.current = true
    // A draft's first prompt goes to the chat reserved while typing, or creates one
    // in the same request (?session=new), and carries the settings picked on the draft.
    const creating = targetSession === 'draft'
    let firstGeneration: GenerationOptions | null = user.guest
      ? { model: TRIAL_MODEL, effort: 'low', fast: true, defaultModel }
      : null
    let reservedId: string | null = null
    if (creating) {
      preparingPromptRef.current = true
      setPreparingPrompt(true)
      firstGeneration ??= composerRef.current?.getGeneration() ?? initialGeneration
      const pending = draftReservation.current
      draftReservation.current = null
      reservedId = pending ? await pending : null
    }
    console.info('[fx0] prompt submit', {
      sessionId: targetSession,
      clientId,
      textLength: value.length,
      imageCount: images.length,
      activeTurnId,
    })

    let lastEventAt = Date.now()
    let sawTurnStart = false
    let promptAdmitted = false
    let watchdog: ReturnType<typeof setInterval> | null = null

    const markDeliveryFailed = (message: string) => {
      setEntries((current) => [
        ...current.map((entry) =>
          entry.type === 'user' && entry.clientId === clientId ? { ...entry, pending: false, failed: true } : entry,
        ),
        { key: `delivery-${clientId}`, type: 'error', text: message },
      ])
      setInteractionNotice({ tone: 'error', text: message })
    }

    if (!turnWasActive) {
      watchdog = setInterval(() => {
        const silence = Date.now() - lastEventAt
        if (!sawTurnStart && silence > 30_000) {
          console.warn('[fx0] watchdog: send still pending after 30s', { sessionId: targetSession, promptAdmitted })
          if (activeSession.current === targetSession) {
            setInteractionNotice({ tone: 'status', text: 'Still connecting to this chat. Please wait—do not resend yet.' })
          }
          if (watchdog) clearInterval(watchdog)
          watchdog = null
        }
      }, 5000)
    }

    try {
      const previews = images.length
        ? (await Promise.all(images.map((image) => imageThumbnail(image.preview)))).filter((preview): preview is string => !!preview)
        : []
      const promptSession = !creating ? targetSession : reservedId ?? 'new'
      const response = await fetchUi(`/api/prompt?session=${encodeURIComponent(promptSession)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          author: name,
          text: value,
          clientId,
          afterSeq,
          images: images.length ? images.map(({ data, mimeType }) => ({ type: 'image', data, mimeType })) : undefined,
          previews: previews.length ? previews : undefined,
          generation: firstGeneration
            ? { model: firstGeneration.model || null, effort: firstGeneration.effort || null, fast: firstGeneration.fast }
            : undefined,
          designMd: !designPick
            ? undefined
            : 'id' in designPick
              ? { id: designPick.id }
              : { name: designPick.name, text: designPick.text },
        }),
      })
      if (signedOut.current) return
      if (firstGeneration) {
        preparingPromptRef.current = false
        setPreparingPrompt(false)
      }
      console.info('[fx0] prompt response', {
        sessionId: targetSession,
        clientId,
        status: response.status,
        requestId: response.headers.get('x-vercel-id'),
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        let code: string | undefined
        try { code = JSON.parse(detail)?.code } catch { /* Other errors can be plain text. */ }
        if (user.guest && response.status === 402 && code === 'trial_exhausted') {
          setFreePrompts(0)
          composerRef.current?.restoreDraft({ text: value, images, designMd: designPick })
          setEntries((current) => current.filter((entry) => entry.type !== 'user' || entry.clientId !== clientId))
          signInSends.current = true
          setDraftError('')
          setSignInOpen(true)
          return
        }
        throw new Error(`prompt failed: ${response.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`)
      }
      const remaining = response.headers.get('x-fx0-free-prompts')
      if (remaining != null && /^\d+$/.test(remaining)) setFreePrompts(Number(remaining))
      const acceptedAt = Date.now()
      const acceptedUser: StreamItem = { type: 'user', text: value, at: acceptedAt }
      let createdSummary: SessionInfo | null = null
      if (creating) {
        const created = reservedId ?? response.headers.get('x-fx0-session')
        if (!created) throw new Error('the server did not return the new chat id')
        const admittedTrialChat = response.headers.get('x-fx0-trial-chat') === '1'
        createdSummary = withCurrentSession([], created, acceptedAt, [acceptedUser], DEFAULT_VIEW)[0]
        if (admittedTrialChat) createdSummary.trialChat = true
        // Promote the draft in place, unless the user already moved elsewhere.
        cacheSession(created, { transcript: compactTranscript([], DEFAULT_VIEW), summary: createdSummary })
        setActivityStarts((starts) => renameActivity(starts, targetSession, created))
        if (activeSession.current === targetSession) {
          activeSession.current = created
          setSessionId(created)
          setTrialChat(admittedTrialChat)
          const url = new URL(window.location.href)
          url.searchParams.set('s', created)
          window.history.replaceState(null, '', url)
        }
        targetSession = created
      }
      promptAdmitted = true
      if (activeSession.current === targetSession) setSendAccepted(true)
      setSessions((prev) => upsertSession(
        withCurrentSession(createdSummary ? mergeSessions(prev, [createdSummary]) : prev, targetSession, acceptedAt, [acceptedUser], currentView.current),
        targetSession,
        acceptedUser,
      ))
      if (!response.body) throw new Error('the accepted message stream is unavailable')
      let responseSeq = afterSeq
      await readEventStream(response, (data) => {
        const parsed = JSON.parse(data) as StreamItem
        // Heartbeats prove the function is alive; they must not reset the
        // watchdog — a turn can hang on the model while heartbeats flow.
        if (parsed.type !== 'heartbeat') lastEventAt = Date.now()
        if (parsed.type === 'turn_start') sawTurnStart = true
        if (parsed.type !== 'text' && parsed.type !== 'reasoning' && parsed.type !== 'heartbeat') {
          console.info('[fx0] prompt event', {
            sessionId: targetSession,
            clientId,
            type: parsed.type,
            seq: parsed.seq,
            id: parsed.id,
            instance: parsed.instance,
          })
        }
        ingest(targetSession, parsed, responseSeq)
        if (parsed.seq != null) responseSeq = Math.max(responseSeq, parsed.seq)
      })
    } catch (error) {
      if (signedOut.current) return
      if (error instanceof AuthRouteError) {
        composerRef.current?.restoreDraft({ text: value, images })
        setSignInOpen(true)
        setEntries((current) => current.map((entry) =>
          entry.type === 'user' && entry.clientId === clientId ? { ...entry, pending: false, failed: true } : entry,
        ))
        return
      }
      console.error('[fx0] prompt failed', { sessionId: targetSession, clientId, sawTurnStart, error })
      if (!promptAdmitted) {
        const detail = String((error as Error)?.message ?? error)
        markDeliveryFailed(`Unable to send the message. ${detail}`)
      } else if (activeSession.current === targetSession) {
        setInteractionNotice({ tone: 'status', text: 'Message accepted. Reconnecting to its updates…' })
      }
    } finally {
      // The prompt created the chat's state by now, so the composer can load and
      // write settings without racing the first turn for the worker lock.
      if (firstGeneration) {
        preparingPromptRef.current = false
        setPreparingPrompt(false)
      }
      console.info('[fx0] prompt stream closed', { sessionId: targetSession, clientId, sawTurnStart })
      if (watchdog) clearInterval(watchdog)
      if (activeSession.current === targetSession) setAwaiting(false)
    }
  }

  async function stop() {
    if (!canAccessSession || stopPending) return
    setStopPending(true)
    setInteractionNotice({ tone: 'status', text: 'Stopping the active turn…' })
    try {
      const response = await fetchUi(`/api/cancel?session=${encodeURIComponent(sessionId)}`, { method: 'POST' })
      if (!response.ok) throw new Error(`Stop request failed with ${response.status}`)
      const { cancelled } = (await response.json()) as { cancelled?: boolean }
      setInteractionNotice({ tone: 'status', text: cancelled ? 'Stop requested.' : 'There\'s no reply to stop.' })
    } catch (error) {
      if (error instanceof AuthRouteError) return
      console.error('[fx0] stop failed', { sessionId, error })
      setInteractionNotice({ tone: 'error', text: 'Unable to stop the turn. Check the connection and try again.' })
    } finally {
      setStopPending(false)
    }
  }

  function setPreviewVisibility(open: boolean) {
    setPreviewChosen(open)
    focusPrompt()
    const url = new URL(window.location.href)
    if (open) url.searchParams.delete('view')
    else url.searchParams.set('view', 'chat')
    window.history.replaceState(null, '', url)
  }

  function paneMax(pane: 'sidebar' | 'agent'): number {
    if (pane === 'sidebar') {
      if (!previewOpen || window.innerWidth < 1024) return SIDEBAR_WIDTH.max
      return Math.min(
        SIDEBAR_WIDTH.max,
        Math.max(SIDEBAR_WIDTH.min, window.innerWidth - agentWidthRef.current - MIN_PREVIEW_WIDTH),
      )
    }
    const available = mainRef.current?.clientWidth ?? window.innerWidth - sidebarWidthRef.current
    return Math.min(AGENT_WIDTH.max, Math.max(AGENT_WIDTH.min, available - MIN_PREVIEW_WIDTH))
  }

  function setPaneCollapse(pane: Pane, next: boolean) {
    setCollapsed((current) => (current[pane] === next ? current : { ...current, [pane]: next }))
    document.cookie = `fx0-${pane}-collapsed=${next ? 1 : 0}; Path=/; Max-Age=31536000; SameSite=Lax`
    const expanded = pane === 'sidebar' ? sidebarWidthRef.current : agentWidthRef.current
    document.documentElement.style.setProperty(PANE[pane].cssVar, `${next ? 0 : expanded}px`)
    if (pane === 'sidebar') document.documentElement.classList.toggle('sidebar-collapsed', next)
    focusPrompt()
  }

  // Like the vercel.com dashboard: reopening restores the default width, and a
  // drag released below the threshold shuts the rail in one step.
  function expandSidebar() {
    applyPaneWidth('sidebar', SIDEBAR_WIDTH.default, true)
    setPaneCollapse('sidebar', false)
  }

  const sidebarControls: SidebarGestureControls = {
    min: SIDEBAR_WIDTH.min,
    isCollapsed: () => document.documentElement.classList.contains('sidebar-collapsed'),
    dragStart: () => {
      document.documentElement.classList.remove('sidebar-collapsed')
      setCollapsed((current) => (current.sidebar ? { ...current, sidebar: false } : current))
    },
    setInterimWidth: (width) => {
      const next = clamp(width, 0, SIDEBAR_WIDTH.max)
      document.documentElement.style.setProperty(PANE.sidebar.cssVar, `${next}px`)
      document.documentElement.style.setProperty(PANE.sidebar.expandedVar, `${Math.max(next, SIDEBAR_WIDTH.min)}px`)
    },
    commitWidth: (width, wasCollapsed) => {
      if (width < SIDEBAR_WIDTH.min * (wasCollapsed ? 0.2 : 0.9)) {
        document.documentElement.style.setProperty(PANE.sidebar.expandedVar, `${sidebarWidthRef.current}px`)
        setPaneCollapse('sidebar', true)
        return
      }
      applyPaneWidth('sidebar', width, true)
      setPaneCollapse('sidebar', false)
    },
    toggle: () => {
      if (document.documentElement.classList.contains('sidebar-collapsed')) expandSidebar()
      else setPaneCollapse('sidebar', true)
    },
    reset: expandSidebar,
  }

  function applyPaneWidth(pane: 'sidebar' | 'agent', width: number, commit: boolean, maximum = paneMax(pane)) {
    const minimum = pane === 'sidebar' ? SIDEBAR_WIDTH.min : AGENT_WIDTH.min
    const nextWidth = clamp(Math.round(width), minimum, maximum)
    // Both vars move together while dragging, so the panel reflows with the
    // pointer and the titles re-truncate live. A collapse toggle moves only the
    // container var, which is what makes the panel slide out instead.
    document.documentElement.style.setProperty(PANE[pane].cssVar, `${nextWidth}px`)
    document.documentElement.style.setProperty(PANE[pane].expandedVar, `${nextWidth}px`)

    if (pane === 'sidebar') sidebarWidthRef.current = nextWidth
    else agentWidthRef.current = nextWidth

    if (!commit) return
    document.cookie = `fx0-${pane}-width=${nextWidth}; Path=/; Max-Age=31536000; SameSite=Lax`
    if (pane === 'agent') setAgentWidth(nextWidth)
  }

  function beginAgentResize(event: ReactPointerEvent<HTMLDivElement>) {
    const pane = 'agent'
    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const threshold = collapseThreshold(pane)
    // From a collapsed pane the drag has to start at 0, or the first pixel jumps
    // back to the remembered width.
    const startWidth = collapsed[pane] ? 0 : agentWidthRef.current
    const maximum = paneMax(pane)
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    let pendingWidth = startWidth
    let animationFrame = 0
    let moved = false
    let previewCollapsed = collapsed[pane]
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    setAgentResizing(true)

    const flushWidth = () => {
      animationFrame = 0
      // Snap: below the threshold the pane is shut, above it the pane is open at
      // its minimum. Crossing back and forth flips it, with nothing in between.
      const shut = pendingWidth < threshold
      // Flip the collapsed state mid-drag so what depends on it — the way back
      // in the header — appears as you cross, not when you let go.
      if (shut !== previewCollapsed) {
        previewCollapsed = shut
        setCollapsed((current) => ({ ...current, [pane]: shut }))
      }
      if (shut) {
        document.documentElement.style.setProperty(PANE[pane].cssVar, '0px')
        return
      }
      applyPaneWidth(pane, pendingWidth, false, maximum)
    }
    const onPointerMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault()
      if (Math.abs(moveEvent.clientX - startX) > 2) moved = true
      pendingWidth = startWidth + moveEvent.clientX - startX
      if (!animationFrame) animationFrame = requestAnimationFrame(flushWidth)
    }
    const finish = () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
      if (animationFrame) cancelAnimationFrame(animationFrame)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      setAgentResizing(false)
      if (!moved) {
        const collapsing = !collapsed[pane]
        setPaneCollapse(pane, collapsing)
        if (collapsing) armDoubleClickReset(startX, event.clientY)
        return
      }
      if (pendingWidth < threshold) {
        setPaneCollapse(pane, true)
        return
      }
      applyPaneWidth(pane, pendingWidth, true, maximum)
      setPaneCollapse(pane, false)
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', finish, { once: true })
    window.addEventListener('pointercancel', finish, { once: true })
    window.addEventListener('blur', finish, { once: true })
  }

  // Like the session rail: a quick second click at the same spot reopens the pane at its default width.
  function armDoubleClickReset(x: number, y: number) {
    const armedAt = Date.now()
    const onSecondPress = (event: PointerEvent) => {
      disarm()
      if (event.button !== 0 || Date.now() - armedAt >= 500 || Math.hypot(event.clientX - x, event.clientY - y) >= 4) return
      event.preventDefault()
      event.stopPropagation()
      window.getSelection()?.removeAllRanges()
      applyPaneWidth('agent', AGENT_WIDTH.default, true)
      setPaneCollapse('agent', false)
    }
    const timer = setTimeout(() => disarm(), 500)
    const disarm = () => {
      clearTimeout(timer)
      window.removeEventListener('pointerdown', onSecondPress, true)
    }
    window.addEventListener('pointerdown', onSecondPress, true)
  }

  function resizeAgentWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    applyPaneWidth('agent', agentWidthRef.current + (event.key === 'ArrowRight' ? RESIZE_STEP : -RESIZE_STEP), true)
  }

  function closePreview() {
    setPreviewVisibility(false)
    requestAnimationFrame(() => previewButtonRef.current?.focus())
  }

  useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)')
    const sync = () => {
      wideViewport.current = query.matches
      setWide(query.matches)
    }
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])

  const activityText =
    awaiting && activeTurnId == null
      ? sendAccepted ? 'thinking' : 'sending'
      : activeTurnId == null
        ? ''
        : entries.at(-1)?.type === 'text'
          ? 'generating'
          : 'thinking'
  const previewSource: PreviewSource = { kind: 'design', sessionId, revision: canAccessSession ? artifactRevision : 0 }
  // A past version stays pinned only for the chat and publish it was picked in;
  // switching chats or a new design snaps the preview back to the latest.
  const viewing = viewedRevision?.sessionId === sessionId && viewedRevision.latest === previewSource.revision
    ? viewedRevision.revision
    : null
  const openRevision = useCallback((revision: number) => {
    setViewedRevision(revision === previewSource.revision ? null : { sessionId, revision, latest: previewSource.revision })
    setPreviewVisibility(true)
  }, [previewSource.revision, sessionId])

  const latestAssistantText = [...entries]
    .reverse()
    .find((entry) => entry.type === 'text')
    ?.text?.trim()

  const announcement = interactionNotice?.text ?? activityText
  // Only the chat on screen can end its activity: leaving one mid-turn keeps its start.
  useEffect(() => {
    if (!activityText) setActivityStarts((starts) => endActivity(starts, sessionId))
  }, [activityText, sessionId])
  const activityStartedAt = activityStarts.get(sessionId) ?? turnStartedAt
  const visibleErrorNotice =
    interactionNotice?.tone === 'error' ? interactionNotice : null

  const liveChat = useMemo<ChatBoot>(() => ({
    sessionId, snapshot: { transcript: { version: 1, entries, view: { artifactRevision: previewSource.revision }, activeTurnId, activeTurnStartedAt: turnStartedAt, startedTurns: [...startedTurns], lastSeq: streamStartSeq, serverInstance: null }, summary: null },
    now: clock, missing: false,
  }), [sessionId, entries, previewSource.revision, activeTurnId, turnStartedAt, startedTurns, streamStartSeq, clock])
  const region = (render: (view: ChatBoot) => ReactNode) => (
    <Suspense fallback={render(liveChat)}>
      <BootRegion boot={boot} live={chatReady ? liveChat : undefined}>{render}</BootRegion>
    </Suspense>
  )
  const accountRegion = (sidebarAccount = false, side?: 'top' | 'bottom') => (
    <Suspense fallback={<AccountMenu user={accountUser} sidebar={sidebarAccount} side={side} team={team} onSignOut={() => void signOut()} signOutStatus={signOutStatus} onSignIn={openSignIn} onSwitchTeam={switchTeam} onGrantTeams={grantTeams} />}>
      <BootRegion boot={account} live={user === undefined ? undefined : { user: accountUser ?? null, team }}>
        {(view) => <AccountMenu user={view.user?.guest ? null : view.user} sidebar={sidebarAccount} side={side} team={view.team} onSignOut={() => void signOut()} signOutStatus={signOutStatus} onSignIn={openSignIn} onSwitchTeam={switchTeam} onGrantTeams={grantTeams} />}
      </BootRegion>
    </Suspense>
  )

  const renderSidebar = (view: SessionPage, loading = false) => (
          <Sidebar
            sessions={view.sessions}
            loading={loading}
            activeId={sessionId}
            loadingId={switchingTo}
            now={view.now ?? clock}
            onPrefetch={prefetchSession}
            onSelect={(id) => {
              setMobileSidebarOpen(false)
              void switchSession(id)
            }}
            onDelete={(id) => void removeSession(id)}
            onNew={() => {
              setMobileSidebarOpen(false)
              newDesign()
            }}
            user={accountUser}
            account={accountRegion(true)}
            nextCursor={view.nextCursor}
            loadingMore={loadingMore}
            onLoadMore={() => void loadMoreSessions()}
            team={team}
            onSwitchTeam={switchTeam}
            onGrantTeams={grantTeams}
            onSignIn={() => {
              setMobileSidebarOpen(false)
              openSignIn()
            }}
            onSignOut={() => void signOut()}
            signOutStatus={signOutStatus}
          />
  )

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      <Suspense fallback={null}><BootLoader boot={account} onBoot={adoptAccount} /></Suspense>
      <Suspense fallback={null}><BootLoader boot={sidebar} onBoot={adoptSidebar} /></Suspense>
      <Suspense fallback={null}>
        <BootLoader boot={boot} onBoot={adoptBoot} />
      </Suspense>
      <a
        href="#main-content"
        className="fixed left-3 top-3 z-[80] -translate-y-20 bg-foreground px-3 py-2 text-sm font-medium text-background transition-transform focus:translate-y-0 motion-reduce:transition-none"
      >
        Skip to conversation
      </a>

      {agentResizing && (
        <div aria-hidden="true" className="fixed inset-0 z-[100] cursor-col-resize touch-none select-none" />
      )}

      {mobileSidebarOpen && (
        <button
          type="button"
          aria-label="close sessions"
          className="fixed inset-0 z-30 bg-background/80 md:hidden"
          {...fastClick(() => setMobileSidebarOpen(false))}
        />
      )}
      <div
        ref={mobileSidebarRef}
        id="session-sidebar"
        role={mobileSidebarOpen ? 'dialog' : undefined}
        aria-modal={mobileSidebarOpen || undefined}
        aria-label={mobileSidebarOpen ? 'sessions' : undefined}
        className={`fixed inset-y-0 left-0 z-40 md:visible md:relative md:z-auto md:w-[var(--sidebar-width)] md:shrink-0 md:animate-none md:pointer-events-auto ${
          mobileSidebarOpen
            ? 'visible pointer-events-auto animate-sidebar-drawer-in motion-reduce:animate-none'
            : 'invisible pointer-events-none'
        }`}
      >
        {/* Right-anchored, so a narrowing drag slides the rail out instead of squeezing it. */}
        <div
          ref={sidebarContentRef}
          inert={(collapsed.sidebar && !mobileSidebarOpen) || undefined}
          className="h-full md:flex md:justify-end md:overflow-hidden"
        >
        <Suspense fallback={renderSidebar({ sessions, nextCursor }, !sidebarReady && sessions.length === 0)}>
          <BootRegion boot={sidebar} live={sidebarReady ? { sessions, nextCursor } : undefined}>{renderSidebar}</BootRegion>
        </Suspense>
        </div>
        <SidebarGestures sidebarRef={sidebarContentRef} controls={sidebarControls} />
      </div>

      <main ref={mainRef} id="main-content" className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row" inert={mobileSidebarOpen || undefined}>
        <section
          aria-label="conversation"
          className={`contents min-w-0 flex-1 flex-col bg-background lg:flex ${
            previewOpen
              ? `lg:w-[var(--agent-width)] lg:flex-none lg:overflow-hidden ${
                  agentResizing
                    ? ''
                    : 'lg:transition-[width] lg:duration-200 lg:ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:lg:transition-none'
                }`
              : ''
          }`}
        >
          {/* Below md the sidebar is a drawer, so the brand needs its own bar. */}
          <div className="flex h-10 shrink-0 items-center border-b border-border px-4 md:hidden">
            <Brand onHome={newDesign} />
          </div>

          <header className="shrink-0 border-b border-border bg-background">
            <div className="flex h-12 items-center gap-1 px-2 md:gap-1.5 md:px-4">
              <Button
                ref={menuButtonRef}
                variant="ghost"
                size="icon-sm"
                aria-label="open sessions"
                aria-expanded={mobileSidebarOpen}
                aria-controls="session-sidebar"
                className="md:hidden"
                {...fastClick(() => {
                  setDebugOpen(false)
                  setChatMenuOpen(false)
                  setPreviewVisibility(false)
                  setMobileSidebarOpen(true)
                })}
              >
                <svg
                  viewBox="0 0 16 16"
                  className="size-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <path d="M2 4h12M2 8h12M2 12h12" />
                </svg>
              </Button>

              {/* The layout script sets visibility before hydration from the saved rail state. */}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="show sessions"
                className="hidden md:[html.sidebar-collapsed_&]:inline-flex"
                {...fastClick(expandSidebar)}
              >
                <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
                  <rect x="2" y="3.5" width="12" height="9" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <rect x="2" y="3.5" width="4.75" height="9" fill="currentColor" />
                </svg>
              </Button>
              <div className="hidden md:[html.sidebar-collapsed_&]:block">
                <NewChat compact onNew={newDesign} />
              </div>

              {/* A draft has no messages yet, so there is nothing to diagnose or delete.
                  The title menu and export render from the streamed chat on first paint. */}
              <div className="min-w-0 flex-1">
                {region((view) => {
                  const title = sessions.find((session) => session.id === view.sessionId)?.title ?? view.snapshot.summary?.title ?? (
                    <>
                      <span className="[html.chat-url_&]:hidden">Design</span>
                      <Skeleton className="hidden h-3.5 w-40 [html.chat-url_&]:block" />
                    </>
                  )
                  if (view.sessionId === 'draft' || view.missing) {
                    return <h1 className="truncate text-sm font-medium tracking-[-0.01em]">{title}</h1>
                  }
                  return (
                    <h1 className="min-w-0 text-sm font-medium tracking-[-0.01em]">
                      <Popover modal open={chatMenuOpen} onOpenChange={toggleChatMenu}>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            onPointerDown={(event) => {
                              if (event.button !== 0) return
                              event.preventDefault()
                              toggleChatMenu(!chatMenuOpen)
                            }}
                            onClick={(event) => {
                              if (event.detail !== 0) event.preventDefault()
                            }}
                            className="-ml-1.5 inline-flex h-8 max-w-full items-center gap-1.5 px-2 text-left text-sm font-medium tracking-[-0.01em] text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent"
                          >
                            <span className="min-w-0 truncate">{title}</span>
                            <svg
                              viewBox="0 0 16 16"
                              className="size-3 shrink-0 text-muted-foreground"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              aria-hidden="true"
                            >
                              <path d="m4 6 4 4 4-4" />
                            </svg>
                          </button>
                        </PopoverTrigger>
                        <PopoverContent align="start" className="w-auto p-1">
                          {/* Until the client adopts the chat, neither action can reach it. */}
                          <button
                            type="button"
                            disabled={!canAccessSession}
                            aria-label="open session diagnostics"
                            aria-expanded={debugOpen}
                            aria-controls="debug-panel"
                            {...fastClick(() => {
                              toggleChatMenu(false)
                              if (canAccessSession) setDebugOpen(true)
                            })}
                            className="flex min-h-8 w-full items-center whitespace-nowrap px-2.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent disabled:opacity-45"
                          >
                            session diagnostics
                          </button>
                          {/* A plain click, not fastClick: sliding off the item cancels a delete. */}
                          <button
                            type="button"
                            disabled={!canAccessSession}
                            onClick={() => {
                              if (!confirmingDelete) {
                                setConfirmingDelete(true)
                                return
                              }
                              toggleChatMenu(false)
                              void removeSession(view.sessionId)
                            }}
                            className={cn(
                              'flex min-h-8 w-full items-center whitespace-nowrap px-2.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent disabled:opacity-45',
                              confirmingDelete && 'text-error',
                            )}
                          >
                            {confirmingDelete ? 'confirm delete' : 'delete chat'}
                          </button>
                        </PopoverContent>
                      </Popover>
                    </h1>
                  )
                })}
              </div>

              {region((view) => !authBlocked && !view.missing && view.snapshot.transcript.view.artifactRevision > 0 && (
                <DesignExport
                  sessionId={view.sessionId}
                  revision={viewing}
                  latest={view.snapshot.transcript.view.artifactRevision}
                  title={sessions.find((session) => session.id === view.sessionId)?.title}
                  onNotice={setInteractionNotice}
                />
              ))}

              {/* Only a phone switches between the conversation and the preview;
                  the label names the pane the tap goes to. */}
              <Button
                ref={previewButtonRef}
                variant="ghost"
                size="sm"
                className="shrink-0 px-2 font-normal lg:hidden"
                aria-expanded={previewOpen}
                aria-controls="preview-pane"
                {...fastClick(() => {
                  setInteractionNotice(null)
                  if (previewOpen) closePreview()
                  else setPreviewVisibility(true)
                })}
              >
                {previewOpen ? 'chat' : 'preview'}
              </Button>
            </div>
            {visibleErrorNotice && (
              <div role="alert" className="bg-error/10 px-4 py-2 text-sm text-error">
                {visibleErrorNotice.text}
              </div>
            )}
            {signOutStatus === 'failed' && (
              <div role="alert" className="flex items-center justify-between gap-3 bg-error/10 px-4 py-2 text-sm text-error">
                <span>Unable to finish signing out.</span>
                <Button variant="ghost" size="sm" {...fastClick(() => void signOut())}>Retry sign out</Button>
              </div>
            )}
          </header>

          <div
            ref={threadRef}
            onScroll={onThreadScroll}
            aria-busy={awaiting || activeTurnId != null}
            className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${threadDisplay}`}
          >
            {/* Full width and pushed to the top in either layout, so a short chat sits
                where it does after the switch and no line rewraps. */}
            <div ref={threadContentRef} className="mx-auto mb-auto w-full max-w-2xl px-4 py-4 sm:px-5">
              {region((view) => (
                <Transcript sessionId={view.sessionId} entries={view.snapshot.transcript.entries}
                  activeTurnId={view.snapshot.transcript.activeTurnId} startedTurns={view.snapshot.transcript.startedTurns}
                  drafting={designDraft != null}
                  onOpenRevision={canAccessSession ? openRevision : undefined} onSend={sendFromTranscript} />
              ))}

              {activityText && <ActivityLine label={activityText} startedAt={activityStartedAt} />}
            </div>
          </div>

          {previewOpen && activityText && (
            <div className="order-2 shrink-0 border-b border-border px-4 py-2 lg:hidden">
              <ActivityLine label={activityText} startedAt={activityStartedAt} />
              {latestAssistantText && (
                <p className="line-clamp-2 font-mono text-[11px] leading-4 text-foreground-tertiary">
                  {latestAssistantText}
                </p>
              )}
            </div>
          )}

          <div className="order-3 shrink-0 lg:order-none">
            <Composer
              ref={composerRef}
              persistSettings={canAccessSession && !preparingPrompt && !user?.guest}
              trial={user?.guest === true}
              freePrompts={freePrompts}
              account={account}
              accountReady={user !== undefined}
              freePromptChat={boot}
              freePromptEligible={chatReady ? sessionId === 'draft' || trialChat : undefined}
              busy={activeTurnId != null}
              stopping={stopPending}
              sessionId={sessionId}
              initialGeneration={initialGeneration}
              sessionReady={chatReady}
              knownGeneration={sessions.find((session) => session.id === sessionId)?.generation}
              preference={preference}
              onSend={send}
              onStop={() => void stop()}
              onNewSession={newDesign}
              onSignIn={openSignIn}
              onDraftInput={onComposerInput}
            />
            {/* The account and the repo link live at the foot of the rail; with the
                rail shut they sit at the foot of the conversation, in line with the prompt. */}
            <footer aria-label="Conversation account" className="hidden border-t border-border bg-background px-3 py-2 md:[html.sidebar-collapsed_&]:block">
              <div className="mx-auto flex h-8 max-w-2xl items-center justify-between gap-2">
                {accountRegion(false, 'top')}
                <SourceLink />
              </div>
            </footer>
          </div>
        </section>

        {/* Keep one preview mounted across breakpoints: CSS places it above the
            composer on mobile and alongside the conversation on desktop. */}
        {previewOpen && (
          <>
            <div className="relative z-30 hidden w-0 lg:block">
              {/* Shut, the edge belongs to the session rail; the way back is a button, as in the rail's header. */}
              {collapsed.agent ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="show conversation"
                  className="absolute left-3 top-2.5 bg-background/80"
                  {...fastClick(() => setPaneCollapse('agent', false))}
                >
                  <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
                    <rect x="2" y="3.5" width="12" height="9" fill="none" stroke="currentColor" strokeWidth="1.5" />
                    <rect x="2" y="3.5" width="4.75" height="9" fill="currentColor" />
                  </svg>
                </Button>
              ) : (
                <ResizeHandle
                  label="Resize conversation and preview"
                  value={agentWidth}
                  min={AGENT_WIDTH.min}
                  max={AGENT_WIDTH.max}
                  className="absolute inset-y-0 -left-2 flex w-4"
                  active={agentResizing}
                  onPointerDown={beginAgentResize}
                  onKeyDown={resizeAgentWithKeyboard}
                />
              )}
            </div>
            {region((view) => (
              <PreviewPane
                source={{ kind: 'design', sessionId: view.sessionId, revision: view.snapshot.transcript.view.artifactRevision }}
                viewing={viewing}
                draft={designDraft?.html ?? null}
                intro={view.snapshot.transcript.entries.length === 0}
                onClose={closePreview}
              />
            ))}
          </>
        )}
      </main>

      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
      <SignInDialog
        open={signInOpen}
        reauthorize={authStatus === 403}
        onOpenChange={setSignInOpen}
        onSignIn={() => prepareSignIn(signInSends.current)}
        error={draftError}
      />
      {debugOpen && canAccessSession && <DebugPanel
        open
        sessionId={sessionId}
        localLog={clientLog.current}
        serverInstance={serverInstance.current}
        onOpenChange={(open) => {
          setDebugOpen(open)
          if (!open) focusPrompt()
        }}
      />}
    </div>
  )
}
