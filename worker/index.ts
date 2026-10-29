import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { auth, me } from './auth'
import { applications, competitions, my } from './competitions'
import { comments, competitionPhotos, judgeVotes, photos } from './photos'
import { type AppEnv, ApiError, nowIso } from './lib'

const app = new Hono<AppEnv>()

app.use('/api/*', async (c, next) => {
  // CSRF: state-changing requests must come from this site and be JSON or multipart.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('origin')
    if (!origin || new URL(origin).host !== new URL(c.req.url).host) throw new ApiError(403, 'Request blocked: wrong origin.')
    const type = c.req.header('content-type') ?? ''
    if (!type.startsWith('application/json') && !type.startsWith('multipart/form-data')) {
      throw new ApiError(400, 'Requests must be JSON or multipart.')
    }
  }
  // Load the signed-in user (if any) from the session cookie.
  const sid = getCookie(c, 'sid')
  const user = sid
    ? await c.env.DB.prepare(
        `SELECT u.id, u.google_sub, u.email, u.name, u.picture FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id = ? AND s.expires_at > ?`,
      )
        .bind(sid, nowIso())
        .first<AppEnv['Variables']['user'] & {}>()
    : null
  c.set('user', user ?? null)
  await next()
})

app.route('/api/auth', auth)
app.route('/api/me', me)
app.route('/api/my', my)
app.route('/api/competitions/:id/photos', competitionPhotos)
app.route('/api/competitions', competitions)
app.route('/api/applications', applications)
app.route('/api/photos', photos)
app.route('/api/comments', comments)
app.route('/api/judge-votes', judgeVotes)

app.notFound((c) => c.json({ error: 'Not found.' }, 404))
app.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ error: err.message }, err.status)
  console.error(err)
  return c.json({ error: 'Something went wrong on our side. Please try again.' }, 500)
})

export default app
