import type { Context } from 'hono'
import { z } from 'zod'

export interface Env {
  DB: D1Database
  PHOTOS: R2Bucket
  ASSETS: Fetcher
  APP_ENV: string
  /** Cloudflare Email Service binding (send_email in wrangler.jsonc). */
  EMAIL: EmailSender
  /** Address login emails come from; its domain must be onboarded in Cloudflare Email Service. */
  EMAIL_FROM: string
}

/** The part of the Email Service Workers binding we use. Errors are thrown as Error with a `code`. */
export interface EmailSender {
  send(message: {
    to: string
    from: { email: string; name?: string }
    subject: string
    html: string
    text: string
  }): Promise<{ messageId: string }>
}

export interface User {
  id: number
  email: string
  name: string
  picture: string | null
}

export type AppEnv = { Bindings: Env; Variables: { user: User | null } }
export type Ctx = Context<AppEnv>

/** An error we want to show the user as `{error: "..."}` with a given HTTP status. */
export class ApiError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 502,
    message: string,
  ) {
    super(message)
  }
}

export const nowIso = () => new Date().toISOString()

export function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes))
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function requireUser(c: Ctx): User {
  const user = c.get('user')
  if (!user) throw new ApiError(401, 'Please sign in first.')
  return user
}

/** Validate input with zod; throws a 400 with the first problem in plain words. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data)
  if (!result.success) {
    const issue = result.error.issues[0]
    const field = issue.path.length ? `${issue.path.join('.')}: ` : ''
    throw new ApiError(400, `${field}${issue.message}`)
  }
  return result.data
}

export async function jsonBody(c: Ctx): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    throw new ApiError(400, 'The request body must be valid JSON.')
  }
}

export function intParam(c: Ctx, name: string): number {
  const n = Number(c.req.param(name))
  if (!Number.isInteger(n) || n < 1) throw new ApiError(404, 'Not found.')
  return n
}

export const isoDate = z.iso.datetime({ offset: true }).transform((s) => new Date(s).toISOString())

/** Read width/height from a JPEG's Start-Of-Frame marker. Returns null if it is not a valid JPEG. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null
  let i = 2
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++
      continue
    }
    const marker = bytes[i + 1]
    if (marker === 0xff) {
      i++
      continue
    }
    // Markers without a length: standalone markers
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    const length = (bytes[i + 2] << 8) | bytes[i + 3]
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      const height = (bytes[i + 5] << 8) | bytes[i + 6]
      const width = (bytes[i + 7] << 8) | bytes[i + 8]
      return width > 0 && height > 0 ? { width, height } : null
    }
    i += 2 + length
  }
  return null
}
