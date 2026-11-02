// @ts-expect-error Node strip-types tests require the source extension.
import { imageDimensions, sniffImageType } from './image-sniff.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { PROMPT_IMAGE_MAX_COUNT, PROMPT_IMAGE_TYPES, PROMPT_IMAGES_MAX_BASE64 } from './prompt-limits.ts'

export interface PromptImage { type: 'image'; data: string; mimeType: string }

/** An image as the model gets it, and the file it came from when the composer said so. */
export interface PromptImageSize { width: number; height: number; source?: { width: number; height: number; density?: 2 | 3 } }

// libfx takes at most 3.75 MiB per image and drops one wider or taller than 8000 px.
const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024
const MAX_SIDE = 8000
// The composer refuses sources over 60 MP before drawing them.
const MAX_SOURCE_SIDE = 20_000

// The original file's size and pixel density, as the composer reports them. Advisory, so
// anything implausible (smaller than what was sent, another shape) is dropped, not refused.
function imageSource(value: unknown, sent: { width: number; height: number }): PromptImageSize['source'] {
  if (!value || typeof value !== 'object') return undefined
  const { width, height, density } = value as Record<string, unknown>
  const side = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0 && (n as number) <= MAX_SOURCE_SIDE
  if (!side(width) || !side(height) || width < sent.width || height < sent.height) return undefined
  if (Math.abs(width / height - sent.width / sent.height) > 0.02 * (sent.width / sent.height)) return undefined
  return { width, height, ...(density === 2 || density === 3 ? { density } : {}) }
}

/** What the model is told about the images' real size, since it sees them downscaled. */
export function describeImageSizes(sizes: PromptImageSize[] = []): string {
  const notes = sizes.flatMap(({ width, height, source }, index) => {
    if (!source) return []
    const original = source.density
      ? `a ${source.width}×${source.height} px screenshot at ${source.density}x, so a ${Math.round(source.width / source.density)}×${Math.round(source.height / source.density)} CSS px layout`
      : `${source.width}×${source.height} px originally`
    const seen = source.width > width ? `; you see it downscaled to ${width}×${height}` : ''
    return [`Image #${index + 1} is ${original}${seen}`]
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
