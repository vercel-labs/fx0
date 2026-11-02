import { imageThumbnail } from './image-thumbnail'

export interface NormalizedImage {
  data: string
  mimeType: string
  preview: string
  thumbnail: string | null
  /** The picked file's own size, before any downscaling, and its density when its name says. */
  source: ImageSource
}

export interface ImageSource { width: number; height: number; density?: 2 | 3 }

// Retina captures are named for it (CleanShot "…@2x.png", Xcode "…@3x.png").
export function imageSource(name: string, width: number, height: number): ImageSource {
  const density = Number(/@([23])x\.[a-z0-9]+$/i.exec(name)?.[1])
  return { width, height, ...(density === 2 || density === 3 ? { density } : {}) }
}

// What the composer sends for one attached image: at most 2048 px on a side, usually
// WebP, small enough that several fit the prompt's 3 MiB. The same bytes go to the model.
const MAX_SIDE = 2048
const TARGET_BYTES = 700 * 1024
const MAX_SOURCE_BYTES = 40 * 1024 * 1024
// Refused before drawing: a tiny file can decode to an enormous bitmap.
const MAX_SOURCE_PIXELS = 60_000_000
const KEPT_AS_IS = ['image/png', 'image/jpeg', 'image/webp']
const UNSUPPORTED = 'this image format is not supported here. use PNG, JPEG, GIF or WebP.'

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('unable to read the selected image.'))
    reader.readAsDataURL(blob)
  })
}

async function decode(file: File): Promise<CanvasImageSource & { width: number; height: number }> {
  try {
    return await createImageBitmap(file)
  } catch {
    const url = URL.createObjectURL(file)
    try {
      const image = new Image()
      image.src = url
      await image.decode()
      return Object.assign(image, { width: image.naturalWidth, height: image.naturalHeight })
    } catch {
      throw new Error(UNSUPPORTED)
    } finally {
      URL.revokeObjectURL(url)
    }
  }
}

function hasTransparency(context: CanvasRenderingContext2D, width: number, height: number): boolean {
  const pixels = context.getImageData(0, 0, width, height).data
  for (let index = 3; index < pixels.length; index += 4 * 16) if (pixels[index] < 255) return true
  return false
}

function encode(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

async function finish(blob: Blob, source: ImageSource): Promise<NormalizedImage> {
  const preview = await readDataUrl(blob)
  return { data: preview.slice(preview.indexOf(',') + 1), mimeType: blob.type, preview, thumbnail: await imageThumbnail(preview), source }
}

/** One picked, pasted or dropped file as the composer sends it, or an error to show. */
export async function normalizeImage(file: File, { webp = true } = {}): Promise<NormalizedImage> {
  if (file.size > MAX_SOURCE_BYTES) throw new Error('the selected image is larger than 40 MB.')
  const source = await decode(file)
  if (source.width * source.height > MAX_SOURCE_PIXELS) throw new Error('the selected image has too many pixels.')
  const original = imageSource(file.name, source.width, source.height)
  // Already small enough: sent as is, so a GIF keeps its animation and nothing is re-encoded.
  const small = file.size <= TARGET_BYTES && Math.max(source.width, source.height) <= MAX_SIDE
  if (small && (KEPT_AS_IS.includes(file.type) || file.type === 'image/gif')) return finish(file, original)

  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) throw new Error('unable to read the selected image.')
  let transparent: boolean | null = null
  let smallest: Blob | null = null
  for (const side of [MAX_SIDE, 1600, 1200]) {
    const scale = Math.min(1, side / Math.max(source.width, source.height))
    canvas.width = Math.max(1, Math.round(source.width * scale))
    canvas.height = Math.max(1, Math.round(source.height * scale))
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.drawImage(source, 0, 0, canvas.width, canvas.height)
    for (const quality of [0.82, 0.7, 0.55]) {
      let blob = webp ? await encode(canvas, 'image/webp', quality) : null
      // Safari can hand back PNG for WebP; then PNG keeps transparency, JPEG the rest.
      if (!blob || blob.type !== 'image/webp') {
        transparent ??= hasTransparency(context, canvas.width, canvas.height)
        if (transparent) blob = await encode(canvas, 'image/png', 1)
        else {
          context.globalCompositeOperation = 'destination-over'
          context.fillStyle = '#fff'
          context.fillRect(0, 0, canvas.width, canvas.height)
          context.globalCompositeOperation = 'source-over'
          blob = await encode(canvas, 'image/jpeg', quality)
        }
      }
      if (!blob) continue
      if (!smallest || blob.size < smallest.size) smallest = blob
      if (blob.size <= TARGET_BYTES) return finish(blob, original)
      if (blob.type === 'image/png') break
    }
  }
  if (!smallest) throw new Error('unable to read the selected image.')
  return finish(smallest, original)
}
