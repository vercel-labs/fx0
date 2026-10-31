'use client'

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { RoomSnapshot } from '../lib/collab/types'
import {
  errorText,
  postRoom,
  readInviteLink,
  readRoom,
  readWorkspace,
  RequestError,
  roomUrl,
  type RoomResponse,
  type Workspace,
} from './collab-api'
import CollabCanvas from './collab-canvas'
import { FOCUS_OUTLINE, TEXT_BUTTON } from './collab-classes'
import CollabComposer from './collab-composer'
import CollabEntry from './collab-entry'
import CollabInvite from './collab-invite'
import CollabTranscript from './collab-transcript'
import Sidebar from './sidebar'
import { Button } from './ui/button'
import { Sheet, SheetContent, SheetTitle } from './ui/sheet'
import { cn } from '../lib/utils'

const NAME_KEY = 'fx0-collab-name'

// fx0's sidebar, chat and preview around one shared room; people join with a name and an invite link instead of signing in.
export default function CollabApp() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [workspaceError, setWorkspaceError] = useState('')
  const [room, setRoom] = useState<RoomSnapshot | null>(null)
  const [starting, setStarting] = useState(true)
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [incoming, setIncoming] = useState<{ id: string; invite: string } | null>(null)
  const [entryError, setEntryError] = useState('')
  const [locationError, setLocationError] = useState('')
  const [entering, setEntering] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [actionError, setActionError] = useState('')
  const [connectionError, setConnectionError] = useState('')
  const [retrying, setRetrying] = useState(false)
  const [savingReview, setSavingReview] = useState(false)
  const [mobilePane, setMobilePane] = useState<'chat' | 'canvas'>('chat')
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [now, setNow] = useState(0)
  const [invite, setInvite] = useState('')
  const [inviteLoading, setInviteLoading] = useState(false)
  const [inviteError, setInviteError] = useState('')
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const entryNameRef = useRef<HTMLInputElement>(null)
  const sidebarButtonRef = useRef<HTMLButtonElement>(null)
  // Resending the same failed text reuses its request ID, so the server stores it once.
  const failedMessage = useRef<{ text: string; requestId: string } | null>(null)
  const activeRoomId = useRef<string | null>(null)
  // The version this tab shows, so polls can skip a room that hasn't changed.
  const shownVersion = useRef(0)
  // Each navigation takes a ticket; a response for an older ticket is ignored.
  const navigation = useRef(0)

  const refreshWorkspace = useCallback(async () => {
    try {
      setWorkspace(await readWorkspace())
      setWorkspaceError('')
    } catch {
      setWorkspaceError('Could not load your rooms or check the model connection.')
    }
  }, [])

  const acceptRoom = useCallback((next: RoomSnapshot) => {
    // A response from an old room must never move the viewer out of the current one.
    if (activeRoomId.current !== next.id) return
    setRoom((current) => current?.id === next.id && current.version >= next.version ? current : next)
  }, [])

  const openLocation = useCallback(async (url: URL) => {
    const ticket = ++navigation.current
    const { roomId: id, invite: secret } = readInviteLink(url)
    activeRoomId.current = id
    setRoom(null)
    setInvite('')
    setInviteError('')
    setEntryError('')
    setLocationError('')
    setActionError('')
    setConnectionError('')
    setDraft('')
    setTitle('')
    failedMessage.current = null
    setIncoming(null)
    setMobilePane('chat')
    setMobileSidebarOpen(false)
    setStarting(Boolean(id))
    if (!id) return
    try {
      const result = await readRoom(id)
      if (ticket !== navigation.current) return
      acceptRoom(result.room)
      if (secret) setInvite(secret)
      window.history.replaceState(null, '', roomUrl(id))
    } catch (error) {
      if (ticket !== navigation.current) return
      const expectedJoin = error instanceof RequestError && ([401, 403].includes(error.status) || (secret && error.status === 404))
      if (expectedJoin) setIncoming({ id, invite: secret })
      else setLocationError(errorText(error))
    } finally {
      if (ticket === navigation.current) setStarting(false)
    }
  }, [acceptRoom])

  useEffect(() => {
    try { setName(localStorage.getItem(NAME_KEY) ?? '') } catch { /* Storage is optional. */ }
    setNow(Date.now())
    void refreshWorkspace()
    void openLocation(new URL(window.location.href))
    const onPopState = () => {
      void openLocation(new URL(window.location.href))
      void refreshWorkspace()
    }
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    window.addEventListener('popstate', onPopState)
    return () => {
      ++navigation.current
      window.clearInterval(timer)
      window.removeEventListener('popstate', onPopState)
    }
  }, [openLocation, refreshWorkspace])

  useEffect(() => {
    if (room?.id) void refreshWorkspace()
  }, [room?.id, room?.status, refreshWorkspace])

  useEffect(() => {
    shownVersion.current = room?.version ?? 0
  }, [room?.version])

  useEffect(() => {
    if (!room?.id) return
    let active = true
    let inFlight = false
    const id = room.id
    const poll = async () => {
      if (inFlight || document.visibilityState === 'hidden') return
      inFlight = true
      try {
        const result = await readRoom(id, shownVersion.current)
        if (active && activeRoomId.current === id) {
          if ('room' in result) acceptRoom(result.room)
          setConnectionError('')
        }
      } catch (error) {
        if (active && activeRoomId.current === id) {
          setConnectionError(error instanceof RequestError && [401, 403, 404].includes(error.status)
            ? 'This room is no longer available. Open an invite link to join again.'
            : 'Connection interrupted. Reconnecting… Your draft is saved in this tab.')
        }
      } finally {
        inFlight = false
      }
    }
    const timer = window.setInterval(poll, 800)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void poll()
        void refreshWorkspace()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      active = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [room?.id, acceptRoom, refreshWorkspace])

  function goHome() {
    window.history.pushState(null, '', '/ampersand')
    void openLocation(new URL(window.location.href))
    void refreshWorkspace()
  }

  function selectRoom(id: string) {
    if (id === room?.id) {
      setMobileSidebarOpen(false)
      return
    }
    window.history.pushState(null, '', roomUrl(id))
    void openLocation(new URL(window.location.href))
  }

  // A starter fills the draft: a visitor still needs a name and room before sending.
  function chooseStarter(prompt: string) {
    setDraft(prompt)
    // A frame later, as in fx0's focusPrompt: the starter fires on pointer-down, before its button takes focus.
    requestAnimationFrame(() => (room ? composerRef.current : entryNameRef.current)?.focus())
  }

  async function enterRoom(event: FormEvent) {
    event.preventDefault()
    if (starting || locationError || entering || !name.trim()) return
    const ticket = navigation.current
    setEntering(true)
    setEntryError('')
    try {
      let result: RoomResponse
      let secret = incoming?.invite ?? ''
      if (incoming) {
        if (!secret) throw new Error('You need an invite link to join this room. Ask someone in the room to share one.')
        result = await postRoom({ action: 'join', id: incoming.id, invite: secret, name: name.trim() })
      } else {
        const created = await postRoom({ action: 'create', name: name.trim(), title: title.trim() || 'Untitled room' })
        result = created
        secret = created.invite
      }
      if (ticket !== navigation.current) return
      activeRoomId.current = result.room.id
      acceptRoom(result.room)
      setInvite(secret)
      setConnectionError('')
      try { localStorage.setItem(NAME_KEY, name.trim()) } catch { /* Storage is optional. */ }
      window.history.pushState(null, '', roomUrl(result.room.id))
      void refreshWorkspace()
      composerRef.current?.focus()
    } catch (error) {
      if (ticket === navigation.current) setEntryError(errorText(error))
    } finally {
      setEntering(false)
    }
  }

  async function sendMessage() {
    const text = draft.trim()
    if (!room || !text || sending || !workspace?.configured) return
    const id = room.id
    const requestId = failedMessage.current?.text === text ? failedMessage.current.requestId : crypto.randomUUID()
    failedMessage.current = { text, requestId }
    setSending(true)
    setActionError('')
    try {
      const result = await postRoom({ action: 'message', id, text, requestId })
      if (activeRoomId.current !== id) return
      acceptRoom(result.room)
      setDraft((current) => current.trim() === text ? '' : current)
      failedMessage.current = null
      composerRef.current?.focus()
      void refreshWorkspace()
    } catch (error) {
      if (activeRoomId.current === id) setActionError(errorText(error))
    } finally {
      setSending(false)
    }
  }

  async function retry() {
    if (!room || retrying) return
    const id = room.id
    setRetrying(true)
    setActionError('')
    try {
      acceptRoom((await postRoom({ action: 'retry', id })).room)
    } catch (error) {
      if (activeRoomId.current === id) setActionError(errorText(error))
    } finally {
      setRetrying(false)
    }
  }

  async function toggleReview() {
    if (!room || savingReview) return
    const id = room.id
    setSavingReview(true)
    setActionError('')
    try {
      const result = await postRoom({ action: 'review', id, enabled: !room.review })
      if (activeRoomId.current === id) acceptRoom(result.room)
    } catch (error) {
      if (activeRoomId.current === id) setActionError(errorText(error))
    } finally {
      setSavingReview(false)
    }
  }

  async function requestInvite() {
    if (!room || invite || inviteLoading) return
    const id = room.id
    setInviteLoading(true)
    setInviteError('')
    try {
      const result = await postRoom({ action: 'invite', id })
      if (activeRoomId.current === id) setInvite(result.invite)
    } catch (error) {
      if (activeRoomId.current === id) setInviteError(errorText(error))
    } finally {
      setInviteLoading(false)
    }
  }

  // fx0's rail with rooms for chats. fx0's help describes its libfx agent, so this page leaves it out.
  const sidebar = (
    <Sidebar
      sessions={workspace?.rooms ?? []}
      activeId={room?.id ?? ''}
      loadingId={null}
      now={now}
      homeHref="/ampersand"
      help={false}
      onSelect={selectRoom}
      onPrefetch={() => {}}
      onNew={goHome}
      // Rooms have no fx0 account, so the account menu and what feeds it are empty.
      account={false}
      user={null}
      team={null}
      onSignIn={() => {}}
      onSignOut={() => {}}
      onSwitchTeam={async () => {}}
      onGrantTeams={() => {}}
    />
  )

  return (
    <main className={cn('flex h-dvh w-full overflow-hidden bg-background text-[13px] text-foreground md:min-h-80', FOCUS_OUTLINE)}>
      <div className="hidden md:flex">{sidebar}</div>
      {/* On phones the same rail opens in fx0's sheet, which traps focus and closes on Escape or an outside tap. */}
      <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
        <SheetContent
          side="left"
          aria-describedby={undefined}
          // Radix returns focus only to a SheetTrigger, and the opening button sits outside the sheet's root.
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            sidebarButtonRef.current?.focus()
          }}
          className={cn('w-auto border-0 md:hidden', FOCUS_OUTLINE)}
        >
          <SheetTitle className="sr-only">Rooms</SheetTitle>
          {sidebar}
        </SheetContent>
      </Sheet>
      {/* Fixed widths: the --agent variable carries the main app's saved pane size. */}
      <section
        aria-label="Shared conversation"
        className={cn(
          'min-w-0 flex-1 flex-col bg-background lg:w-[380px] lg:flex-none lg:border-r lg:border-border min-[75rem]:w-[420px]',
          mobilePane === 'canvas' ? 'hidden lg:flex' : 'flex',
        )}
      >
        <header className="flex h-12 shrink-0 items-center justify-between gap-2.5 border-b border-border px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <Button ref={sidebarButtonRef} variant="ghost" size="icon-sm" aria-label="Open sidebar" aria-expanded={mobileSidebarOpen} onClick={() => setMobileSidebarOpen(true)} className="-ml-2 md:hidden">
              <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <path d="M2 4h12M2 8h12M2 12h12" />
              </svg>
            </Button>
            <h1 title={room?.title} className="font-medium">Design</h1>
          </div>
          <div className="flex min-w-0 items-center gap-3 text-[12px] md:gap-2.5">
            {room && (
              <button
                type="button"
                role="switch"
                aria-checked={room.review}
                disabled={savingReview}
                title="When on, a Reviewer agent checks each change before the Builder replies. Applies from the next message."
                onClick={() => void toggleReview()}
                className={TEXT_BUTTON}
              >
                review {room.review ? 'on' : 'off'}
              </button>
            )}
            {room && (
              <CollabInvite
                room={room}
                invite={invite}
                loading={inviteLoading}
                error={inviteError}
                onRequestInvite={requestInvite}
                onErrorChange={setInviteError}
              />
            )}
            <button type="button" onClick={() => setMobilePane('canvas')} className={cn(TEXT_BUTTON, 'lg:hidden [&_svg]:size-[13px]')}>
              preview
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <path d="M3 8h10M9 4l4 4-4 4" />
              </svg>
            </button>
          </div>
        </header>
        {(connectionError || workspaceError) && (
          <p role="status" className="shrink-0 border-b border-border px-4 py-2.5 text-[11px] leading-[1.6] text-foreground-secondary">
            {connectionError || workspaceError}
          </p>
        )}
        <CollabTranscript room={room} starting={starting} onStarter={chooseStarter} />
        {room ? (
          <CollabComposer
            ref={composerRef}
            room={room}
            workspace={workspace}
            actionError={actionError}
            draft={draft}
            sending={sending}
            retrying={retrying}
            onDraftChange={setDraft}
            onSend={() => void sendMessage()}
            onRetry={retry}
          />
        ) : locationError ? (
          <div className="shrink-0 border-t border-border px-6 py-5">
            <p role="alert" className="mb-3 text-[11px] leading-[1.7] text-error wrap-anywhere">{locationError}</p>
            <button type="button" onClick={() => void openLocation(new URL(window.location.href))} className={TEXT_BUTTON}>
              Try opening room again
            </button>
          </div>
        ) : starting ? null : (
          <CollabEntry
            ref={entryNameRef}
            joining={Boolean(incoming)}
            name={name}
            title={title}
            error={entryError}
            starting={starting}
            entering={entering}
            onNameChange={setName}
            onTitleChange={setTitle}
            onSubmit={enterRoom}
          />
        )}
      </section>
      <CollabCanvas room={room} mobileOpen={mobilePane === 'canvas'} onBack={() => setMobilePane('chat')} />
    </main>
  )
}
