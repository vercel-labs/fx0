'use client'

import { Fragment, useEffect, useRef } from 'react'
import type { RoomSnapshot } from '../lib/collab/types'
import { SPINNER, STATUS_DOT } from './collab-classes'
import { memberLabel, replyMarkdown } from './collab-state'
import { ThreadEntry } from './thread'
import Transcript from './transcript'

export default function CollabTranscript({ room, starting, onStarter }: {
  room: RoomSnapshot | null
  starting: boolean
  onStarter: (prompt: string) => void
}) {
  const messageEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [room?.messages.length, room?.status])

  return (
    <div
      role="log"
      aria-label="Room messages"
      aria-live="polite"
      aria-relevant="additions text"
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5 md:p-6"
    >
      {starting ? (
        <div role="status" className="flex min-h-[180px] items-center justify-center gap-2.5 text-[12px] text-foreground-tertiary">
          <span className={SPINNER} />
          Opening your workspace…
        </div>
      ) : !room?.messages.length && (
        // An empty fx0 transcript is its starter list.
        <Transcript sessionId="" entries={[]} activeTurnId={null} startedTurns={[]} drafting={false} onSend={onStarter} />
      )}
      {room?.messages.map((message) => message.role === 'user' ? (
        <Fragment key={message.id}>
          <p className="mb-1 text-right text-xs text-muted-foreground">{memberLabel({ id: message.authorId, name: message.author }, room.viewerId)}</p>
          <ThreadEntry sessionId="" entry={{ key: String(message.id), type: 'user', text: message.text }} waiting={null} />
        </Fragment>
      ) : (
        <ThreadEntry key={message.id} sessionId="" entry={{ key: String(message.id), type: 'text', text: replyMarkdown(message.text) }} waiting={null} />
      ))}
      {room?.status === 'working' && (
        <div role="status" className="my-3 flex items-center gap-2 text-[12px] text-foreground-tertiary">
          <span className={STATUS_DOT} />
          Ampersand is working
        </div>
      )}
      <div ref={messageEndRef} />
    </div>
  )
}
