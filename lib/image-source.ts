// Shared by attachment normalization, the sign-in draft and prompt admission.
// These are advisory file dimensions, not measurements of the user's browser viewport.
export interface ImageSource { width: number; height: number; density?: 1 | 2 | 3 }

export function parseImageSource(value: unknown): ImageSource | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { width, height, density } = value as Record<string, unknown>
  const side = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n <= 60_000_000
  // Match normalizeImage's decoded-pixel cap, including tall or wide captures.
  if (!side(width) || !side(height) || width * height > 60_000_000) return undefined
  return { width, height, ...(density === 1 || density === 2 || density === 3 ? { density } : {}) }
}
