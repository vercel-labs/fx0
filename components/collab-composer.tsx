'use client'

import type { Ref } from 'react'
import { MAX_MESSAGE_LENGTH, type RoomSnapshot } from '../lib/collab/types'
import type { Workspace } from './collab-api'
import { SPINNER } from './collab-classes'
import { clockTime } from './collab-state'
import { Textarea } from './ui/textarea'
import { cn } from '../lib/utils'

const NOTE = 'border border-border p-2.5 text-[11px] leading-[1.6]'

export default function CollabComposer({
  ref,
  room,
  workspace,
  actionError,
  draft,
  sending,
  retrying,
  onDraftChange,
  onSend,
  onRetry,
}: {
  ref?: Ref<HTMLTextAreaElement>
  room: RoomSnapshot
  workspace: Workspace | null
  actionError: string
  draft: string
  sending: boolean
  retrying: boolean
  onDraftChange: (draft: string) => void
  onSend: () => void
  onRetry: () => void
}) {
  const { activity } = room
  return (
    <div className="shrink-0">
      {activity.length > 0 && (
        <details className="border-t border-border text-[11px] text-foreground-tertiary">
          <summary className="cursor-pointer px-6 py-[9px] hover:text-foreground">
            agent activity <span className="ml-1.5 text-[10px]">{[...new Set(activity.map((entry) => entry.agent))].join(' + ')}</span>
          </summary>
          <ol className="max-h-[220px] overflow-y-auto px-6 pb-3">
            {activity.map((entry) => (
              <li key={entry.id} className="mt-2.5">
                <div className="flex items-baseline justify-between gap-3 text-foreground-secondary">
                  <span>{entry.agent}</span>
                  <time dateTime={new Date(entry.createdAt).toISOString()} className="shrink-0 text-[9px] text-foreground-tertiary">{clockTime(entry.createdAt)}</time>
                </div>
                <p className="mt-1 leading-[1.65] whitespace-pre-wrap wrap-anywhere">{entry.text}</p>
              </li>
            ))}
          </ol>
        </details>
      )}
      {room.status === 'error' && (
        <div role="alert" className={cn('mx-4 mb-3', NOTE, 'text-error')}>
          <p>{room.error || 'The last update could not be completed.'}</p>
          <button type="button" disabled={retrying} onClick={onRetry} className="mt-[7px] underline underline-offset-3 disabled:opacity-40">
            {retrying ? 'retrying…' : 'retry update'}
          </button>
        </div>
      )}
      {workspace && !workspace.configured && (
        <p className={cn('mx-4 mb-3', NOTE, 'text-foreground-secondary')}>Generation will be available when the model is connected. You can invite people now.</p>
      )}
      {actionError && <p role="alert" className={cn('mx-4 mb-3', NOTE, 'text-error wrap-anywhere')}>{actionError}</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          onSend()
        }}
        className="border-t border-border pt-4 pr-5 pb-2 pl-6"
      >
        <label htmlFor="collab-message" className="sr-only">Message the room</label>
        {/* The ! sizes beat globals.css's unlayered font reset and its coarse-pointer 16px rule. */}
        <Textarea
          ref={ref}
          id="collab-message"
          placeholder="ask fx0 to design"
          value={draft}
          maxLength={MAX_MESSAGE_LENGTH}
          rows={3}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              onSend()
            }
          }}
          className="block h-16 max-h-40 border-0 px-0 py-[3px] text-[16px]! text-foreground placeholder:text-foreground-tertiary focus-visible:ring-0 md:text-[14px]!"
        />
        <div className="flex min-h-9 items-center gap-3 text-[12px] text-foreground-tertiary">
          <span title={workspace?.model} className="flex-1">Ampersand</span>
          <span className="text-[10px]">{room.status === 'working' ? 'next update' : 'shared room'}</span>
          <button
            type="submit"
            disabled={!draft.trim() || sending || !workspace?.configured}
            aria-label={sending ? 'Sending message' : room.status === 'working' ? 'Queue message' : 'Send message'}
            className="grid size-8 shrink-0 place-items-center bg-primary text-primary-foreground disabled:bg-accent-3 disabled:text-foreground-tertiary [&_svg]:size-[15px]"
          >
            {sending ? (
              <span className={SPINNER} />
            ) : (
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 13V3M4 7l4-4 4 4" />
              </svg>
            )}
          </button>
        </div>
      </form>
    </div>
  )
}
