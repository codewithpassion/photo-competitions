import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import { type AppEnv, type Ctx, ApiError, nowIso, parse, jsonBody, randomHex } from './lib'

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

async function upsertUser(c: Ctx, sub: string, email: string, name: string, picture: string | null) {
  const row = await c.env.DB.prepare(
    `INSERT INTO users (google_sub, email, name, picture, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(google_sub) DO UPDATE SET email = excluded.email, name = excluded.name, picture = excluded.picture
     RETURNING id`,
  )
    .bind(sub, email, name, picture, nowIso())
    .first<{ id: number }>()
  return row!.id
}

const redirectUri = (c: Ctx) => `${new URL(c.req.url).origin}/api/auth/google/callback`

// Step 1: send the browser to Google.
auth.get('/google', (c) => {
  const state = randomHex(16)
  // Where to go after signing in (only same-site paths).
  const back = c.req.query('return') ?? '/'
  const returnTo = back.startsWith('/') && !back.startsWith('//') ? back : '/'
  setCookie(c, 'oauth_state', state, cookieOptions(c, 600))
  setCookie(c, 'oauth_return', returnTo, cookieOptions(c, 600))
  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(c),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  })
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
})

// Step 2: Google sends the user back here with a code.
auth.get('/google/callback', async (c) => {
  const state = c.req.query('state')
  const code = c.req.query('code')
  const savedState = getCookie(c, 'oauth_state')
  const returnTo = getCookie(c, 'oauth_return') ?? '/'
  deleteCookie(c, 'oauth_state', { path: '/' })
  deleteCookie(c, 'oauth_return', { path: '/' })
  const fail = (reason: string) => c.redirect(`/?login_error=${encodeURIComponent(reason)}`)

  if (!state || !savedState || state !== savedState) return fail('Sign-in expired. Please try again.')
  if (!code) return fail('Sign-in was cancelled.')

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(c),
      grant_type: 'authorization_code',
    }),
  })
  if (!tokenRes.ok) return fail('Google did not accept the sign-in.')
  const { id_token } = (await tokenRes.json()) as { id_token?: string }
  if (!id_token) return fail('Google did not return an identity.')

  // The id_token came straight from Google over TLS, so we can read its payload without checking the signature.
  let claims: { sub: string; email: string; email_verified: boolean | string; name?: string; picture?: string; aud?: string }
  try {
    const payload = id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload), (ch) => ch.charCodeAt(0))))
  } catch {
    return fail('Could not read the Google identity.')
  }
  if (claims.aud !== c.env.GOOGLE_CLIENT_ID) return fail('Google identity was for a different app.')
  if (claims.email_verified !== true && claims.email_verified !== 'true') return fail('Your Google email is not verified.')

  const name = claims.name || claims.email.split('@')[0]
  const userId = await upsertUser(c, claims.sub, claims.email, name, claims.picture ?? null)
  await startSession(c, userId)
  return c.redirect(returnTo)
})

auth.post('/logout', async (c) => {
  const sid = getCookie(c, 'sid')
  if (sid) await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run()
  deleteCookie(c, 'sid', { path: '/' })
  return c.json({ ok: true })
})

// DEV ONLY: lets tests and local development sign in without Google.
auth.post('/dev-login', async (c) => {
  if (c.env.APP_ENV !== 'development') throw new ApiError(404, 'Not found.')
  const { email, name } = parse(z.object({ email: z.email(), name: z.string().min(1).max(100) }), await jsonBody(c))
  const userId = await upsertUser(c, `dev:${email}`, email, name, null)
  await startSession(c, userId)
  return c.json({ ok: true })
})

export const me = new Hono<AppEnv>()
me.get('/', (c) => {
  const user = c.get('user')
  return c.json({ user: user && { id: user.id, name: user.name, email: user.email, picture: user.picture } })
})

