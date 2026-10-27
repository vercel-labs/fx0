'use client'

import { useEffect, useState } from 'react'
import type { RoomSnapshot } from '../lib/collab/types'
import { readRevisionSource } from './collab-api'
import { SPINNER, TEXT_BUTTON } from './collab-classes'
import { clockTime } from './collab-state'
import { cn } from '../lib/utils'

const VIEW_TAB = 'relative h-full text-foreground-tertiary'
const VIEW_TAB_ACTIVE = 'relative h-full text-foreground after:absolute after:inset-x-0 after:-bottom-px after:h-px after:bg-foreground'

export default function CollabCanvas({ room, mobileOpen, onBack }: {
  room: RoomSnapshot | null
  // Below lg the canvas and the chat take turns filling the screen.
  mobileOpen: boolean
  onBack: () => void
}) {
  return (
    <section aria-label="Shared artifact" className={cn('min-h-0 min-w-0 flex-1 flex-col bg-background', mobileOpen ? 'flex' : 'hidden lg:flex')}>
      {/* Keyed by room, so every room opens on its latest version in the desktop preview. */}
      <CanvasView key={room?.id} room={room} onBack={onBack} />
    </section>
  )
}

function CanvasView({ room, onBack }: { room: RoomSnapshot | null; onBack: () => void }) {
  const [view, setView] = useState<'preview' | 'source'>('preview')
  const [selectedRevision, setSelectedRevision] = useState<number | null>(null)
  const revision = room?.revisions.find((candidate) => candidate.id === selectedRevision) || room?.revisions.at(-1)
  const revisionNumber = revision && room ? room.revisions.findIndex((candidate) => candidate.id === revision.id) + 1 : 0

  return (
    <>
      <div className={cn('flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-4 text-[12px] md:gap-4', !revision && 'lg:invisible')}>
        <button type="button" onClick={onBack} className={cn(TEXT_BUTTON, 'flex-1 justify-start lg:hidden')}>Design</button>
        <div aria-label="Artifact view" className={cn('h-full items-center gap-3.5 md:gap-5', revision ? 'flex' : 'hidden lg:flex')}>
          <button
            type="button"
            aria-pressed={view === 'preview'}
            onClick={() => setView('preview')}
            className={view === 'preview' ? VIEW_TAB_ACTIVE : VIEW_TAB}
          >
            Preview
          </button>
          <button
            type="button"
            aria-pressed={view === 'source'}
            onClick={() => setView('source')}
            className={view === 'source' ? VIEW_TAB_ACTIVE : VIEW_TAB}
          >
            Source
          </button>
        </div>
        <div className={cn('items-center text-[10px] md:text-[11px]', revision ? 'flex' : 'hidden lg:flex')}>
          {revision && room && (
            <>
              <label htmlFor="collab-version" className="sr-only">Artifact version</label>
              <select
                id="collab-version"
                value={selectedRevision ?? 'latest'}
                onChange={(event) => setSelectedRevision(event.target.value === 'latest' ? null : Number(event.target.value))}
                className="min-w-0 max-w-[104px] bg-background py-1 text-foreground-tertiary md:max-w-40"
              >
                <option value="latest">v{room.revisions.length} · latest</option>
                {[...room.revisions].reverse().slice(1).map((earlier, index) => (
                  <option key={earlier.id} value={earlier.id}>v{room.revisions.length - index - 1} · {clockTime(earlier.createdAt)}</option>
                ))}
              </select>
            </>
          )}
        </div>
      </div>
      {revision && room ? (
        view === 'preview' ? (
          <iframe
            key={`${room.id}-${revision.id}`}
            src={`/api/collab/artifact?room=${encodeURIComponent(room.id)}&revision=${revision.id}`}
            sandbox="allow-scripts"
            title={`${room.title} — version ${revisionNumber}`}
            className="block min-h-0 w-full flex-1 bg-white"
          />
        ) : (
          <RevisionSource roomId={room.id} revisionId={revision.id} label={`HTML source for version ${revisionNumber}`} />
        )
      ) : (
        <div className="flex flex-1 items-center justify-center overflow-y-auto px-6 py-8 md:pb-20">
          {room?.status === 'working' ? (
            <div role="status" className="flex items-center gap-3 text-[12px] text-foreground-tertiary">
              <span className={SPINNER} />
              <p>Your first design will appear here.</p>
            </div>
          ) : (
            // Styled like fx0's empty-preview intro.
            <article className="my-auto w-full max-w-sm text-sm leading-6 text-muted-foreground">
              <h2 className="text-base font-medium text-foreground">fx0 together</h2>
              <p className="mt-2">
                Everyone in this room shares one conversation and one HTML page. Ampersand’s Builder edits the page and
                answers the room. Turn review on in the chat header to have a Reviewer check changes before the Builder replies.
              </p>
              <p className="mt-2">Messages sent while they work join the next update.</p>
              <p className="mt-2">Rooms are stored on this server, and messages are sent to the Ampersand API.</p>
            </article>
          )}
        </div>
      )}
    </>
  )
}

// Snapshots carry no HTML, so the source of the revision on screen is read when this view shows it.
function RevisionSource({ roomId, revisionId, label }: { roomId: string; revisionId: number; label: string }) {
  const [source, setSource] = useState<{ revisionId: number; html: string | null } | null>(null)
  useEffect(() => {
    let active = true
    readRevisionSource(roomId, revisionId).then(
      (result) => { if (active) setSource({ revisionId, html: result.html }) },
      () => { if (active) setSource({ revisionId, html: null }) },
    )
    return () => { active = false }
  }, [roomId, revisionId])
  const shown = source?.revisionId === revisionId ? source : null
  return (
    <div tabIndex={0} aria-label={label} className="min-h-0 flex-1 overflow-auto bg-background p-6 text-[12px] leading-[1.7] text-foreground-secondary [tab-size:2]">
      {!shown ? <p role="status">Loading the source…</p>
        : shown.html === null ? <p role="alert" className="text-error">Could not load the source. Please try again.</p>
          : <pre><code>{shown.html}</code></pre>}
    </div>
  )
}
