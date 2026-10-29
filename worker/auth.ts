import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import { type AppEnv, type Ctx, type User, ApiError, nowIso, parse, jsonBody, randomHex, requireUser } from './lib'

export const auth = new Hono<AppEnv>()

const SESSION_DAYS = 30

function cookieOptions(c: Ctx, maxAge: number) {
  return {
    httpOnly: true,
    // Secure everywhere except plain-http local development.
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax' as const,
    path: '/',
    maxAge,
  }
}

async function startSession(c: Ctx, userId: number) {
  const id = randomHex(32)
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString()
  await c.env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(id, userId, expires)
    .run()
  setCookie(c, 'sid', id, cookieOptions(c, SESSION_DAYS * 86400))
}

/** Find or create the user for an email address (accounts are created on first successful sign-in). */
async function upsertUser(c: Ctx, email: string, name: string) {
  const row = await c.env.DB.prepare(
    `INSERT INTO users (email, name, created_at) VALUES (?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE users.name END
     RETURNING id, email, name, picture`,
  )
    .bind(email, name, nowIso())
    .first<User>()
  return row!
}

// ---- Passwordless email sign-in -------------------------------------------------------------

const CODE_MINUTES = 15
const MAX_STARTS_PER_HOUR = 5
const MAX_WRONG_CODES = 5

const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email('Please enter a valid email address.'))

/** Only same-site paths are allowed as a place to go after signing in. */
function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length > 500) return '/'
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/'
  return value
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Compare two equal-length hex hashes without stopping at the first difference. */
function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** A uniformly random 6-digit code (rejection sampling avoids modulo bias). */
function randomCode(): string {
  const limit = 4294967296 - (4294967296 % 1000000)
  const buf = new Uint32Array(1)
  do crypto.getRandomValues(buf)
  while (buf[0] >= limit)
  return String(buf[0] % 1000000).padStart(6, '0')
}

const hashCode = (email: string, code: string) => sha256Hex(`code:${email}:${code}`)
const hashToken = (token: string) => sha256Hex(`token:${token}`)

function loginEmail(code: string, link: string) {
  const subject = `${code} is your Photo Competitions sign-in code`
  const text = `Your Photo Competitions sign-in code is ${code}\n\nOr open this link to sign in:\n${link}\n\nThe code and link work once and expire in ${CODE_MINUTES} minutes. If you didn't ask for this, you can ignore this email.`
  const html = `<!doctype html><html><body style="margin:0;background:#fafaf9;font-family:Arial,Helvetica,sans-serif;color:#1c1917">
<div style="max-width:440px;margin:0 auto;padding:32px 16px">
<div style="background:#ffffff;border:1px solid #e7e5e4;border-radius:8px;padding:24px">
<p style="margin:0 0 8px;font-size:16px;font-weight:bold">Photo Competitions</p>
<p style="margin:0 0 16px;font-size:14px">Your sign-in code is:</p>
<p style="margin:0 0 20px;font-size:36px;font-weight:bold;letter-spacing:8px;font-family:'Courier New',monospace">${code}</p>
<p style="margin:0 0 16px;font-size:14px">Or just click the button:</p>
<p style="margin:0 0 20px"><a href="${link}" style="display:inline-block;background:#1c1917;color:#ffffff;text-decoration:none;font-size:14px;font-weight:bold;padding:10px 20px;border-radius:6px">Sign in</a></p>
<p style="margin:0;font-size:12px;color:#78716c">The code and link work once and expire in ${CODE_MINUTES} minutes. If you didn't ask for this, you can ignore this email.</p>
</div></div></body></html>`
  return { subject, text, html }
}

auth.post('/email/start', async (c) => {
  const { email, returnTo } = parse(
    z.object({ email: emailSchema, returnTo: z.string().optional() }),
    await jsonBody(c),
  )
  const db = c.env.DB
  const now = nowIso()

  const recent = await db
    .prepare('SELECT COUNT(*) AS n FROM login_codes WHERE email = ? AND created_at > ?')
    .bind(email, new Date(Date.now() - 3600_000).toISOString())
    .first<{ n: number }>()
  if (recent!.n >= MAX_STARTS_PER_HOUR) {
    throw new ApiError(429, "You've asked for a lot of codes. Please wait a while and try again.")
  }

  const code = randomCode()
  const token = randomHex(32)
  // Only the newest code works, so retire any earlier ones.
  await db.prepare('UPDATE login_codes SET used_at = ? WHERE email = ? AND used_at IS NULL').bind(now, email).run()
  const inserted = await db
    .prepare(
      `INSERT INTO login_codes (email, code_hash, token_hash, return_to, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(
      email,
      await hashCode(email, code),
      await hashToken(token),
      safeReturnTo(returnTo),
      new Date(Date.now() + CODE_MINUTES * 60_000).toISOString(),
      now,
    )
    .first<{ id: number }>()

  // Local development: don't send anything, hand the secrets back so tests and developers can sign in.
  if (c.env.APP_ENV === 'development') {
    console.log(`[dev] sign-in for ${email}: code ${code}, token ${token}`)
    return c.json({ ok: true, devCode: code, devToken: token })
  }

  const link = `${new URL(c.req.url).origin}/login/verify?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`
  try {
    await c.env.EMAIL.send({
      to: email,
      from: { email: c.env.EMAIL_FROM, name: 'Photo Competitions' },
      ...loginEmail(code, link),
    })
  } catch (err) {
    console.error('Sending the sign-in email failed', (err as { code?: string }).code, err)
    await db.prepare('DELETE FROM login_codes WHERE id = ?').bind(inserted!.id).run()
    throw new ApiError(502, "We couldn't send the sign-in email right now. Please try again in a few minutes.")
  }
  return c.json({ ok: true })
})

const BAD_CODE = 'That code is not right, or it has expired. Please check it or ask for a new one.'

/** Mark a login_code as used. Returns false if someone else used it first. */
async function consume(c: Ctx, id: number): Promise<boolean> {
  const res = await c.env.DB.prepare('UPDATE login_codes SET used_at = ? WHERE id = ? AND used_at IS NULL')
    .bind(nowIso(), id)
    .run()
  return res.meta.changes === 1
}

async function finishSignIn(c: Ctx, id: number, email: string, returnTo: string) {
  if (!(await consume(c, id))) throw new ApiError(400, BAD_CODE)
  const user = await upsertUser(c, email, '')
  await startSession(c, user.id)
  return c.json({ user: { id: user.id, name: user.name, email: user.email, picture: user.picture }, returnTo })
}

type LoginRow = { id: number; email: string; code_hash: string; token_hash: string; return_to: string; attempts: number }

auth.post('/email/verify', async (c) => {
  const { email, code } = parse(
    z.object({ email: emailSchema, code: z.string().trim().regex(/^\d{6}$/, 'The code is 6 digits.') }),
    await jsonBody(c),
  )
  const row = await c.env.DB.prepare(
    `SELECT id, email, code_hash, token_hash, return_to, attempts FROM login_codes
     WHERE email = ? AND used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1`,
  )
    .bind(email, nowIso())
    .first<LoginRow>()
  if (!row || row.attempts >= MAX_WRONG_CODES) throw new ApiError(400, BAD_CODE)

  if (!sameHash(await hashCode(email, code), row.code_hash)) {
    const after = await c.env.DB.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ? RETURNING attempts')
      .bind(row.id)
      .first<{ attempts: number }>()
    if (after && after.attempts >= MAX_WRONG_CODES) {
      await consume(c, row.id) // too many wrong guesses: burn it
      throw new ApiError(400, 'Too many wrong codes. Please ask for a new one.')
    }
    throw new ApiError(400, BAD_CODE)
  }
  return finishSignIn(c, row.id, row.email, row.return_to)
})

auth.post('/email/verify-link', async (c) => {
  const { token } = parse(z.object({ token: z.string().regex(/^[0-9a-f]{64}$/, 'This sign-in link is not valid.') }), await jsonBody(c))
  const tokenHash = await hashToken(token)
  const row = await c.env.DB.prepare(
    `SELECT id, email, code_hash, token_hash, return_to, attempts FROM login_codes
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
  )
    .bind(tokenHash, nowIso())
    .first<LoginRow>()
  if (!row || !sameHash(tokenHash, row.token_hash)) {
    throw new ApiError(400, 'This sign-in link has expired or was already used. Please ask for a new one.')
  }
  return finishSignIn(c, row.id, row.email, row.return_to)
})

auth.post('/logout', async (c) => {
  const sid = getCookie(c, 'sid')
  if (sid) await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run()
  deleteCookie(c, 'sid', { path: '/' })
  return c.json({ ok: true })
})

// DEV ONLY: lets tests and local development sign in without email.
auth.post('/dev-login', async (c) => {
  if (c.env.APP_ENV !== 'development') throw new ApiError(404, 'Not found.')
  const { email, name } = parse(z.object({ email: emailSchema, name: z.string().min(1).max(100) }), await jsonBody(c))
  const user = await upsertUser(c, email, name)
  await startSession(c, user.id)
  return c.json({ ok: true })
})

export const me = new Hono<AppEnv>()
me.get('/', (c) => {
  const user = c.get('user')
  return c.json({ user: user && { id: user.id, name: user.name, email: user.email, picture: user.picture } })
})

// Set or change the display name (new accounts start without one).
me.patch('/', async (c) => {
  const user = requireUser(c)
  const { name } = parse(z.object({ name: z.string().trim().min(1, 'Please enter a name.').max(60, 'That name is too long.') }), await jsonBody(c))
  await c.env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(name, user.id).run()
  return c.json({ user: { id: user.id, name, email: user.email, picture: user.picture } })
})

