// @ts-expect-error Node strip-types tests require the source extension.
import { imageDimensions, sniffImageType } from './image-sniff.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { PROMPT_IMAGE_MAX_COUNT, PROMPT_IMAGE_TYPES, PROMPT_IMAGES_MAX_BASE64 } from './prompt-limits.ts'

// @ts-expect-error Node strip-types tests require the source extension.
import { parseImageSource, type ImageSource } from './image-source.ts'

export interface PromptImage { type: 'image'; data: string; mimeType: string }

/** The transmitted dimensions, before any provider-side resizing, and optional file metadata. */
export interface PromptImageSize { width: number; height: number; source?: ImageSource }

// libfx takes at most 3.75 MiB per image and drops one wider or taller than 8000 px.
const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024
const MAX_SIDE = 8000

function imageSource(value: unknown, sent: { width: number; height: number }): ImageSource | undefined {
  const source = parseImageSource(value)
  if (!source || source.width < sent.width || source.height < sent.height) return undefined
  // Both sides are rounded independently by the composer. Allow one sent pixel of error.
  const scale = Math.max(sent.width, sent.height) / Math.max(source.width, source.height)
  if (Math.abs(source.width * scale - sent.width) > 1 || Math.abs(source.height * scale - sent.height) > 1) return undefined
  return source
}

/** What the model is told about the images' real size, since it sees them downscaled. */
export function describeImageSizes(sizes: PromptImageSize[] = []): string {
  const notes = sizes.flatMap(({ width, height, source }, index) => {
    const sent = `sent at ${width}×${height} px (the model provider may resize it further)`
    if (!source) return [`Image #${index + 1}: ${sent}; original size and capture density unknown`]
    const density = source.density
      ? `filename suggests ${source.density}x; at that scale the captured area is ${Math.round(source.width / source.density)}×${Math.round(source.height / source.density)} CSS px, not necessarily the full viewport`
      : 'capture density unknown; original pixel dimensions alone do not determine CSS size'
    return [`Image #${index + 1}: original ${source.width}×${source.height} px; ${sent}; ${density}`]
  })
  return notes.length ? `\n\n[${notes.join('. ')}.]` : ''
}

/**
 * A prompt's images, or the reason they are refused. Each must be canonical base64 of
 * a PNG, JPEG, GIF or WebP whose bytes match its declared type and whose header gives
 * sane dimensions, so nothing malformed reaches the journal or the model.
 */
export function validatePromptImages(value: unknown): { images: PromptImage[]; sizes: PromptImageSize[] } | { error: string } {
  if (value == null) return { images: [], sizes: [] }
  if (!Array.isArray(value)) return { error: 'images must be a list' }
  if (value.length > PROMPT_IMAGE_MAX_COUNT) return { error: `prompt cannot contain more than ${PROMPT_IMAGE_MAX_COUNT} images` }
  const images: PromptImage[] = []
  const sizes: PromptImageSize[] = []
  let total = 0
  for (const [index, image] of value.entries()) {
    const label = `image ${index + 1}`
    if (!image || image.type !== 'image' || typeof image.data !== 'string' || typeof image.mimeType !== 'string') return { error: `${label} is invalid` }
    if (!(PROMPT_IMAGE_TYPES as readonly string[]).includes(image.mimeType)) return { error: `${label} must be PNG, JPEG, GIF or WebP` }
    total += image.data.length
    if (total > PROMPT_IMAGES_MAX_BASE64) return { error: 'prompt images exceed the 3 MiB limit' }
    if (!image.data || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) return { error: `${label} is not valid base64` }
    const bytes = Buffer.from(image.data, 'base64')
    if (bytes.toString('base64') !== image.data) return { error: `${label} is not valid base64` }
    if (bytes.length > MAX_IMAGE_BYTES) return { error: `${label} is larger than 3.75 MiB` }
    const type = sniffImageType(bytes)
    if (!type || type !== image.mimeType) return { error: `${label} is not the ${image.mimeType.slice(6).toUpperCase()} it claims to be` }
    const size = imageDimensions(bytes, type)
    if (!size || !size.width || !size.height) return { error: `${label} is damaged or truncated` }
    if (size.width > MAX_SIDE || size.height > MAX_SIDE) return { error: `${label} is larger than ${MAX_SIDE} px on a side` }
    images.push({ type: 'image', data: image.data, mimeType: image.mimeType })
    const source = imageSource(image.source, size)
    sizes.push({ width: size.width, height: size.height, ...(source ? { source } : {}) })
  }
  return { images, sizes }
}

const PREVIEW = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/

/** Display thumbnails, one per image in order, or none: a missing one would shift the rest. */
export function validatePromptPreviews(value: unknown, count: number): string[] {
  if (!Array.isArray(value) || value.length !== count) return []
  return value.every((preview) => typeof preview === 'string' && preview.length <= 96 * 1024 && PREVIEW.test(preview)) ? value : []
}
