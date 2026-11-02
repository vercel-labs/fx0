import { checkDesignMdUpload, DESIGN_MD_CATALOG, DESIGN_MD_MAX_BYTES } from '../lib/design-md'
import { PROMPT_TEXT_MAX_BYTES } from '../lib/prompt-limits'
import { parseImageSource } from '../lib/image-source'
import type { AttachedImage, DesignMdPick } from './composer'

export interface GuestDraft {
  text: string
  images: AttachedImage[]
  designMd?: DesignMdPick | null
  // Set when sign-in interrupted a send: the prompt goes out once the visitor is back.
  submit?: boolean
}

export const GUEST_DRAFT_KEY = 'fx0-guest-draft:v2'
export const GUEST_DRAFT_TTL = 15 * 60 * 1000
// Escaping can double the text's and the design.md's bytes in JSON.
export const GUEST_DRAFT_MAX_BYTES = 3 * 1024 * 1024 + 2 * PROMPT_TEXT_MAX_BYTES + 2 * DESIGN_MD_MAX_BYTES
const TEXT_CAP = PROMPT_TEXT_MAX_BYTES
const IMAGE_CAP = 3 * 1024 * 1024

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const byteLength = (text: string) => new TextEncoder().encode(text).byteLength
const exactKeys = (value: object, keys: string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))

// Store only unsent input, never identity, tokens, session IDs or conversation history.
export function parseGuestDraft(raw: string, now = Date.now()): GuestDraft | null {
  if (raw.length > GUEST_DRAFT_MAX_BYTES || byteLength(raw) > GUEST_DRAFT_MAX_BYTES) return null
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || !exactKeys(value, ['version', 'expiresAt', 'text', 'images', 'designMd', 'submit'])) return null
    if (typeof value.submit !== 'boolean') return null
    const designMd = parseDesignMd(value.designMd)
    if (designMd === undefined) return null
    if (value.version !== 2 || !Number.isFinite(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + GUEST_DRAFT_TTL) return null
    if (typeof value.text !== 'string' || byteLength(value.text) > TEXT_CAP || !Array.isArray(value.images) || value.images.length > 8) return null
    let imageBytes = 0
    const images: AttachedImage[] = []
    for (const image of value.images) {
      if (!image || typeof image !== 'object' || !(exactKeys(image, ['data', 'mimeType']) || exactKeys(image, ['data', 'mimeType', 'source']))) return null
      if (typeof image.data !== 'string' || typeof image.mimeType !== 'string' || !/^image\/[a-z0-9.+-]{1,64}$/.test(image.mimeType)) return null
      if (!image.data || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data) || image.data.length % 4 !== 0) return null
      imageBytes += image.data.length
      if (imageBytes > IMAGE_CAP) return null
      const source = parseImageSource(image.source)
      images.push({ data: image.data, mimeType: image.mimeType, preview: `data:${image.mimeType};base64,${image.data}`, ...(source ? { source } : {}) })
    }
    return { text: value.text, images, designMd, submit: value.submit }
  } catch {
    return null
  }
}

// A catalog pick by id, or an upload that passes the same check as the picker.
// undefined means invalid; null means none.
function parseDesignMd(value: unknown): DesignMdPick | null | undefined {
  if (value === null) return null
  if (!value || typeof value !== 'object') return undefined
  if (exactKeys(value, ['id', 'name'])) {
    const { id, name } = value as { id: unknown; name: unknown }
    const option = DESIGN_MD_CATALOG.find((entry) => entry.id === id)
    return option && name === option.name ? { id: option.id, name: option.name } : undefined
  }
  if (exactKeys(value, ['name', 'text'])) {
    const { name, text } = value as { name: unknown; text: unknown }
    const checked = checkDesignMdUpload(name, text)
    return 'error' in checked || checked.name !== name ? undefined : { name: checked.name, text: checked.text }
  }
  return undefined
}

export function saveGuestDraft(storage: DraftStorage, draft: GuestDraft, now = Date.now()): boolean {
  try {
    storage.removeItem(GUEST_DRAFT_KEY)
    const raw = JSON.stringify({
      version: 2, expiresAt: now + GUEST_DRAFT_TTL, text: draft.text,
      images: draft.images.map(({ data, mimeType, source }) => ({ data, mimeType, source: parseImageSource(source) })),
      designMd: draft.designMd ?? null, submit: draft.submit ?? false,
    })
    if (!parseGuestDraft(raw, now)) return false
    storage.setItem(GUEST_DRAFT_KEY, raw)
    return true
  } catch {
    return false
  }
}

export function takeGuestDraft(storage: DraftStorage, now = Date.now()): GuestDraft | null {
  try {
    const raw = storage.getItem(GUEST_DRAFT_KEY)
    storage.removeItem(GUEST_DRAFT_KEY)
    return raw ? parseGuestDraft(raw, now) : null
  } catch {
    return null
  }
}

export function clearGuestDraft(storage: DraftStorage): void {
  try { storage.removeItem(GUEST_DRAFT_KEY) } catch { /* Storage is optional. */ }
}
