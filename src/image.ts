import exifr from 'exifr'

export const MIN_LONG_SIDE = 1080
export const MAX_LONG_SIDE = 1920
const MAX_FULL_BYTES = 3.9 * 1024 * 1024

export interface ProcessedImage {
  full: Blob
  thumb: Blob
  previewUrl: string
  takenAt: string | null
  latitude: number | null
  longitude: number | null
}

/** A problem we can explain to the user in plain words. */
export class ImageProblem extends Error {}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new ImageProblem('Could not convert this image.'))), 'image/jpeg', quality),
  )
}

/** Draw the image scaled so its long side is `longSide` (never upscaling) and encode as JPEG. */
async function resize(bitmap: ImageBitmap, longSide: number, quality: number[], maxBytes: number): Promise<Blob> {
  const scale = Math.min(1, longSide / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff' // JPEG has no transparency
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  let blob = await canvasToJpeg(canvas, quality[0])
  for (const q of quality.slice(1)) {
    if (blob.size <= maxBytes) break
    blob = await canvasToJpeg(canvas, q)
  }
  return blob
}

/** Read EXIF from the original file, then make the resized photo and thumbnail in the browser. */
export async function processImage(file: File): Promise<ProcessedImage> {
  if (!file.type.startsWith('image/')) throw new ImageProblem('This file is not an image.')

  // EXIF first, from the untouched original. Missing or broken EXIF is fine.
  let takenAt: string | null = null
  let latitude: number | null = null
  let longitude: number | null = null
  try {
    const exif = await exifr.parse(file, { pick: ['DateTimeOriginal'] })
    if (exif?.DateTimeOriginal instanceof Date && !isNaN(exif.DateTimeOriginal.getTime())) takenAt = exif.DateTimeOriginal.toISOString()
    const gps = await exifr.gps(file)
    if (typeof gps?.latitude === 'number' && typeof gps?.longitude === 'number') {
      latitude = Math.round(gps.latitude * 1e6) / 1e6
      longitude = Math.round(gps.longitude * 1e6) / 1e6
    }
  } catch {
    /* ignore */
  }

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new ImageProblem(
      "Your browser can't open this kind of image. Try a JPEG, PNG or WebP (HEIC photos only work in some browsers).",
    )
  }
  const { width, height } = bitmap
  if (Math.max(width, height) < MIN_LONG_SIDE) {
    bitmap.close()
    throw new ImageProblem(`This photo is too small (${width}x${height}). The long side must be at least ${MIN_LONG_SIDE} pixels.`)
  }

  const full = await resize(bitmap, MAX_LONG_SIDE, [0.85, 0.75, 0.65, 0.55], MAX_FULL_BYTES)
  const thumb = await resize(bitmap, 480, [0.8], Infinity)
  bitmap.close()
  return { full, thumb, previewUrl: URL.createObjectURL(thumb), takenAt, latitude, longitude }
}
