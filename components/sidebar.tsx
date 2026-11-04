'use client'

import { memo, useState, type ReactNode } from 'react'
import type { SessionInfo } from '../lib/events'
import AccountMenu, { type AccountUser } from './account-menu'
import SourceLink from './source-link'
import Brand from './brand'
import HowItWorks from './how-it-works'
import NewChat from './new-chat'
import { fastClick } from '../lib/fast-click'
import { ScrollArea } from './ui/scroll-area'
import { Skeleton } from './ui/skeleton'
import { cn } from '../lib/utils'

const relativeTime = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'narrow' })
const skeletonWidths = ['w-3/4', 'w-1/2', 'w-5/6', 'w-2/3', 'w-3/5']

function timeAgo(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000))
  if (seconds < 60) return relativeTime.format(-seconds, 'second')
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return relativeTime.format(-minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return relativeTime.format(-hours, 'hour')
  return relativeTime.format(-Math.floor(hours / 24), 'day')
}

function Sidebar({
  sessions,
  activeId,
  loadingId,
  now,
  onSelect,
  onPrefetch,
  onNew,
  onDelete,
  homeHref,
  help,
  user,
  team,
  onSignIn,
  onSignOut,
  signOutStatus,
  onSwitchTeam,
  onGrantTeams,
  account,
  loading = false,
  nextCursor = null,
  loadingMore = false,
  onLoadMore,
}: {
  // Only what a row shows, so rooms fit as well as chats.
  sessions: Pick<SessionInfo, 'id' | 'title' | 'lastActivity' | 'busy'>[]
  activeId: string
  loadingId: string | null
  now: number
  onSelect: (id: string) => void
  onPrefetch: (id: string) => void
  onNew: () => void
  onDelete?: (id: string) => void
  // Another entry point's home link and help dialog; fx0's own when left out.
  homeHref?: string
  help?: ReactNode
  user: AccountUser | null | undefined
  team: string | null
  onSignIn: () => void
  onSignOut: () => void
  signOutStatus?: 'pending' | 'failed' | null
  onSwitchTeam: (teamId: string) => Promise<void>
  onGrantTeams: () => void
  account?: ReactNode
  loading?: boolean
  nextCursor?: string | null
  loadingMore?: boolean
  onLoadMore?: () => void
}) {
  // The row whose delete is armed; leaving the row disarms it.
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  return (
    <aside className="flex h-full w-[min(82vw,280px)] shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground [contain:layout] md:w-[var(--sidebar-expanded-width)]">
      {/* Text in this column starts 24px from the edge, like the composer's text: a
          12px gutter (px-3) plus 12px inside each row's highlight (px-3). */}
      <div className="flex h-12 items-center justify-between gap-6 pl-6 pr-4.5">
        <Brand href={homeHref} onHome={onNew} />
        <div className="flex items-center">
          <SourceLink />
          {help ?? <HowItWorks />}
        </div>
      </div>

      <div className="px-3 pt-3">
        <NewChat onNew={onNew} />
      </div>

      <ScrollArea aria-busy={loading || undefined} className="min-h-0 w-full flex-1" viewportClassName="sidebar-fade-scroll">
        <div className="min-w-0 pb-2 pt-2">
          {loading && sessions.length === 0 && (
            // A visitor (html.guest) has no chats to load: show the empty state at once.
            <div role="status" className="[html.guest_&]:hidden">
              <span className="sr-only">Loading chats…</span>
              <div aria-hidden="true">
                {skeletonWidths.map((width) => (
                  <div key={width} className="px-6 py-1.5">
                    <div className="flex h-5 items-center"><Skeleton className={`h-3 ${width}`} /></div>
                    <div className="mt-px flex h-4 items-center"><Skeleton className="h-2.5 w-12" /></div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {sessions.length === 0 && (
            <p className={`px-6 py-1.5 text-[13px] leading-5 text-foreground-tertiary ${loading ? 'hidden [html.guest_&]:block' : ''}`}>No chats yet.</p>
          )}
          {sessions.map((session) => {
            const active = session.id === activeId
            const loading = session.id === loadingId
            const status = loading ? 'loading' : session.busy ? 'working' : null
            const confirming = session.id === confirmingId
            return (
              <div
                key={session.id}
                className="group/row relative"
                onPointerLeave={() => { if (confirming) setConfirmingId(null) }}
                onBlur={(event) => {
                  if (confirming && !event.currentTarget.contains(event.relatedTarget as Node | null)) setConfirmingId(null)
                }}
              >
              {/* The button spans the full row, gutters included, so there is no dead
                  space between chats; the highlight is the inset span inside it. */}
              <button
                type="button"
                aria-current={active ? 'page' : undefined}
                aria-busy={loading || undefined}
                disabled={loading}
                {...fastClick(() => onSelect(session.id))}
                onPointerEnter={() => onPrefetch(session.id)}
                onFocus={() => onPrefetch(session.id)}
                className="group/item block w-full min-w-0 max-w-full px-3 text-left outline-none"
              >
                <span
                  className={cn(
                    'block min-w-0 overflow-hidden px-3 py-1.5 group-focus-visible/item:ring-2 group-focus-visible/item:ring-ring',
                    active
                      ? 'bg-sidebar-accent text-foreground'
                      : 'text-foreground-secondary group-hover/item:bg-sidebar-accent group-hover/item:text-foreground',
                  )}
                >
                <span
                  title={session.title ?? 'new chat'}
                  className={cn(
                    'block w-full min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[13px] leading-5',
                    onDelete && 'group-focus-within/row:pr-6 group-hover/row:pr-6',
                    active ? 'font-semibold' : 'font-normal',
                    confirming && 'pr-14 group-focus-within/row:pr-14 group-hover/row:pr-14',
                  )}
                >
                  {session.title ?? 'new chat'}
                </span>
                <span className="mt-px flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11px] leading-4 text-foreground-tertiary">
                  {status && (
                    <>
                      <span
                        className={cn('size-1.5 shrink-0 rounded-full bg-current', (loading || session.busy) && 'pulse-dot')}
                        aria-hidden="true"
                      />
                      <span>{status}</span>
                      <span aria-hidden="true">·</span>
                    </>
                  )}
                  <span className="tabular-nums">{timeAgo(session.lastActivity, now)}</span>
                </span>
                </span>
              </button>
              {/* A plain click, not fastClick: sliding off the row cancels a delete. */}
              {onDelete && <button
                type="button"
                aria-label={confirming ? `confirm delete ${session.title ?? 'new chat'}` : `delete ${session.title ?? 'new chat'}`}
                onClick={() => {
                  if (!confirming) {
                    setConfirmingId(session.id)
                    return
                  }
                  setConfirmingId(null)
                  onDelete(session.id)
                }}
                className={cn(
                  'absolute right-4 top-1 h-6 place-items-center outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/row:grid group-focus-within/row:grid',
                  confirming
                    ? 'grid px-1.5 text-[11px] text-error'
                    : 'hidden w-6 text-foreground-tertiary hover:text-foreground',
                )}
              >
                {confirming ? 'delete' : (
                  <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                    <path d="m4 4 8 8M12 4l-8 8" />
                  </svg>
                )}
              </button>}
              </div>
            )
          })}
          {nextCursor && <button type="button" disabled={loadingMore} {...fastClick(() => onLoadMore?.())}
            className="group/item block w-full px-3 text-left text-[13px] text-foreground-secondary outline-none disabled:opacity-50">
            <span className="block px-3 py-2 group-hover/item:bg-sidebar-accent group-focus-visible/item:ring-2 group-focus-visible/item:ring-ring">
              {loadingMore ? 'Loading…' : 'Load more chats'}
            </span>
          </button>}
        </div>
      </ScrollArea>

      {/* pb-4 centers this row on the composer's toolbar beside it (its padding is 8px + 8px). */}
      <div className="pb-4 pl-3 pr-3 pt-2">
        {account ?? <AccountMenu sidebar user={user} team={team} onSignIn={onSignIn} onSignOut={onSignOut} signOutStatus={signOutStatus} onSwitchTeam={onSwitchTeam} onGrantTeams={onGrantTeams} />}
      </div>
    </aside>
  )
}

export default memo(
  Sidebar,
  (previous, next) =>
    previous.sessions === next.sessions &&
    previous.activeId === next.activeId &&
    previous.loadingId === next.loadingId &&
    previous.now === next.now &&
    previous.user === next.user &&
    previous.team === next.team &&
    previous.loading === next.loading &&
    previous.nextCursor === next.nextCursor && previous.loadingMore === next.loadingMore,
)
