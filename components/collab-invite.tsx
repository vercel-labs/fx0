'use client'

import { useState } from 'react'
import type { RoomSnapshot } from '../lib/collab/types'
import { inviteLink } from './collab-api'
import { FOCUS_OUTLINE, PRIMARY_BUTTON, TEXT_BUTTON } from './collab-classes'
import { memberLabel } from './collab-state'
import { IconCopy } from './geist-icons'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { cn } from '../lib/utils'

// The room's members and invite panel; the app makes the invite request, so a pending one outlives the panel.
export default function CollabInvite({
  room,
  invite,
  loading,
  error,
  onRequestInvite,
  onErrorChange,
}: {
  room: RoomSnapshot
  // From the invite URL, the room's creation or an earlier request; empty until one arrives.
  invite: string
  loading: boolean
  error: string
  onRequestInvite: () => void
  onErrorChange: (error: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const url = invite ? inviteLink(room.id, invite) : ''

  function changeOpen(next: boolean) {
    setOpen(next)
    if (!next) return
    setCopied(false)
    onRequestInvite()
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      onErrorChange('')
    } catch {
      onErrorChange('Select and copy the link above.')
    }
  }

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={TEXT_BUTTON}>invite</button>
      </PopoverTrigger>
      {/* Portaled outside main, so it repeats main's focus outline; on phones it spans the screen. */}
      <PopoverContent
        align="end"
        sideOffset={12}
        collisionPadding={12}
        aria-label="Invite people to this room"
        className={cn('w-[calc(100vw-24px)] p-[18px] text-[11px] md:w-[310px]', FOCUS_OUTLINE)}
      >
        <h2 className="text-[13px] font-medium">invite people</h2>
        <p className="mt-2 mb-3.5 text-foreground-tertiary">Anyone with this link can join.</p>
        {loading ? (
          <p role="status" className="mt-2 mb-3.5 text-foreground-tertiary">Creating invite link…</p>
        ) : (
          <>
            <label htmlFor="collab-share-url" className="sr-only">Room invitation link</label>
            {/* The ! size beats globals.css's unlayered font reset and its coarse-pointer 16px rule. */}
            <input
              id="collab-share-url"
              readOnly
              value={url}
              onFocus={(event) => event.target.select()}
              className="mb-2.5 w-full min-w-0 border border-border bg-background p-[9px] text-[11px]! text-foreground"
            />
            <button type="button" disabled={!url} onClick={copy} className={cn(PRIMARY_BUTTON, 'w-full')}>
              <IconCopy />
              {copied ? 'link copied' : 'copy invite link'}
            </button>
          </>
        )}
        {error && <p role="alert" className="mt-2 mb-3 leading-[1.7] text-error wrap-anywhere">{error}</p>}
        <p className="mt-2 border-t border-border pt-3 text-foreground-tertiary wrap-anywhere">
          {room.members.map((member) => memberLabel(member, room.viewerId)).join(', ')}
        </p>
      </PopoverContent>
    </Popover>
  )
}
