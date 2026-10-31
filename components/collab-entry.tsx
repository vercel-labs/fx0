'use client'

import type { FormEvent, Ref } from 'react'
import { MAX_MEMBER_NAME_LENGTH, MAX_ROOM_TITLE_LENGTH } from '../lib/collab/types'
import { PRIMARY_BUTTON, SPINNER } from './collab-classes'

const LABEL = 'mb-1.5 text-[11px] text-foreground-secondary'
// The ! sizes beat globals.css's unlayered font reset and its coarse-pointer 16px rule.
const FIELD = 'mb-3.5 h-10 min-w-0 border border-border bg-background px-[9px] py-2 text-[16px]! text-foreground placeholder:text-foreground-tertiary md:h-9 md:text-[12px]! [@media(max-height:600px)]:mb-2.5'

export default function CollabEntry({
  ref,
  joining,
  name,
  title,
  error,
  starting,
  entering,
  onNameChange,
  onTitleChange,
  onSubmit,
}: {
  ref?: Ref<HTMLInputElement>
  // The page opened on a room, so this person joins it instead of creating one.
  joining: boolean
  name: string
  title: string
  error: string
  starting: boolean
  entering: boolean
  onNameChange: (name: string) => void
  onTitleChange: (title: string) => void
  onSubmit: (event: FormEvent) => void
}) {
  return (
    <div className="shrink-0 border-t border-border px-6 pt-4 pb-5 md:pt-[18px] [@media(max-height:600px)]:pt-3 [@media(max-height:600px)]:pb-3">
      <form onSubmit={onSubmit} className="flex flex-col">
        <label htmlFor="collab-name" className={LABEL}>Your name</label>
        <input
          ref={ref}
          id="collab-name"
          autoComplete="given-name"
          placeholder="e.g. Alex"
          value={name}
          maxLength={MAX_MEMBER_NAME_LENGTH}
          required
          disabled={starting || entering}
          onChange={(event) => onNameChange(event.target.value)}
          className={FIELD}
        />
        {!joining && (
          <>
            <label htmlFor="collab-title" className={LABEL}>
              Design name <span className="ml-[7px] text-foreground-tertiary">optional</span>
            </label>
            <input
              id="collab-title"
              placeholder="What are we building?"
              value={title}
              maxLength={MAX_ROOM_TITLE_LENGTH}
              disabled={starting || entering}
              onChange={(event) => onTitleChange(event.target.value)}
              className={FIELD}
            />
          </>
        )}
        {error && <p role="alert" className="mb-3 text-[11px] leading-[1.7] text-error wrap-anywhere">{error}</p>}
        <div className="mt-0.5 flex items-center justify-between gap-4 text-[11px]">
          <span className="max-w-[180px] text-[9px] text-foreground-tertiary md:text-[10px]">
            {joining ? 'You’re invited to a shared design.' : 'Share a room with your collaborators.'}
          </span>
          <button type="submit" disabled={starting || entering || !name.trim()} className={PRIMARY_BUTTON}>
            {entering ? (
              <>
                <span className={SPINNER} />
                {joining ? 'joining…' : 'creating…'}
              </>
            ) : joining ? 'join room' : 'create room'}
          </button>
        </div>
      </form>
    </div>
  )
}
