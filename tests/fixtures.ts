import sharp from 'sharp'

/** A JPEG with a coloured gradient, optionally with EXIF date + GPS (near the Sydney Opera House). */
export async function makePhoto(opts: { width: number; height: number; hue: number; exif?: boolean }): Promise<Buffer> {
  const { width, height, hue } = opts
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue},70%,45%)"/><stop offset="1" stop-color="hsl(${(hue + 80) % 360},70%,70%)"/>
    </linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 4}" fill="white" opacity="0.6"/>
  </svg>`
  let img = sharp(Buffer.from(svg)).jpeg({ quality: 90 })
  if (opts.exif) {
    img = img.withExif({
      IFD2: { DateTimeOriginal: '2024:03:15 10:30:00' },
      IFD3: {
        GPSLatitudeRef: 'S',
        GPSLatitude: '33/1 51/1 25/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '151/1 12/1 55/1',
      },
    })
  }
  return img.toBuffer()
}

/** A plain PNG (to check non-JPEG files are converted in the browser). */
export const makePng = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#4a90d9' } }).png().toBuffer()
