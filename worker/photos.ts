import { Hono } from 'hono'
import { z } from 'zod'
import {
  type AppEnv,
  type Ctx,
  type User,
  ApiError,
  intParam,
  isoDate,
  jpegSize,
  jsonBody,
  nowIso,
  parse,
  randomHex,
  requireUser,
} from './lib'
import {
  type CompetitionRow,
  applicationStatus,
  likesUsed,
  loadCompetition,
  photoCounts,
  requireAdmin,
  submissionsOpen,
  uploadBlockedReason,
} from './competitions'

export const photos = new Hono<AppEnv>()
/** Routes under /api/competitions/:id/photos */
export const competitionPhotos = new Hono<AppEnv>()

const MAX_FULL_BYTES = 4 * 1024 * 1024
const MAX_THUMB_BYTES = 400 * 1024

interface PhotoRow {
  id: number
  competition_id: number
  category_id: number
  user_id: number
  title: string
  taken_at: string | null
  latitude: number | null
  longitude: number | null
  location_name: string | null
  width: number
  height: number
  full_key: string
  thumb_key: string
  hidden: number
  winner_label: string | null
  created_at: string
}

/** Load a photo plus its competition, hiding anything the viewer is not allowed to see. */
async function loadPhoto(c: Ctx, id: number, user: User | null) {
  const photo = await c.env.DB.prepare('SELECT * FROM photos WHERE id = ?').bind(id).first<PhotoRow>()
  if (!photo) throw new ApiError(404, 'Photo not found.')
  const comp = await loadCompetition(c, photo.competition_id, user) // 404 for drafts
  const isAdmin = comp.admin_id === user?.id
  if (photo.hidden && !isAdmin && photo.user_id !== user?.id) throw new ApiError(404, 'Photo not found.')
  return { photo, comp, isAdmin }
}

/** Public fields for a photo in a grid. Vote counts are only selected for the admin, or once results are published. */
function listSql(showVotes: boolean, where: string) {
  const votes = showVotes
    ? ', (SELECT COUNT(*) FROM votes v2 WHERE v2.photo_id = p.id) AS vote_count, (SELECT COALESCE(SUM(points), 0) FROM judge_votes j WHERE j.photo_id = p.id) AS judge_points'
    : ''
  return `SELECT p.id, p.category_id, p.title, p.width, p.height, p.user_id AS uploader_id, u.name AS uploader_name,
      p.taken_at, p.hidden, p.winner_label, p.created_at,
      EXISTS (SELECT 1 FROM votes v WHERE v.photo_id = p.id AND v.user_id = ?) AS liked_by_me,
      (SELECT COUNT(*) FROM comments cm WHERE cm.photo_id = p.id AND cm.hidden = 0) AS comment_count${votes}
    FROM photos p JOIN users u ON u.id = p.user_id WHERE ${where} ORDER BY p.id DESC`
}

competitionPhotos.get('/', async (c) => {
  const user = c.get('user')
  const comp = await loadCompetition(c, intParam(c, 'id'), user)
  const isAdmin = comp.admin_id === user?.id
  const showVotes = isAdmin || !!comp.results_published_at
  const { results } = await c.env.DB.prepare(listSql(showVotes, `p.competition_id = ? AND (? = 1 OR p.hidden = 0 OR p.user_id = ?)`))
    .bind(user?.id ?? 0, comp.id, isAdmin ? 1 : 0, user?.id ?? 0)
    .all<Record<string, unknown>>()
  return c.json({
    photos: results.map((p) => ({
      ...p,
      ...(showVotes && { total_score: (p.vote_count as number) + (p.judge_points as number) }),
      hidden: !!p.hidden,
      liked_by_me: !!p.liked_by_me,
      is_mine: p.uploader_id === user?.id,
    })),
  })
})

const metaSchema = z.object({
  title: z.string().trim().min(1, 'Please give the photo a title').max(200),
  taken_at: z.preprocess((v) => (v === '' ? null : v), isoDate.nullable().default(null)),
  latitude: z.preprocess((v) => (v === '' || v == null ? null : Number(v)), z.number().min(-90).max(90).nullable()),
  longitude: z.preprocess((v) => (v === '' || v == null ? null : Number(v)), z.number().min(-180).max(180).nullable()),
  location_name: z.string().trim().max(200).default(''),
})

const uploadSchema = metaSchema.extend({ category_id: z.coerce.number().int() })

// Upload: multipart with `full`, `thumb` and the fields above.
competitionPhotos.post('/', async (c) => {
  const user = requireUser(c)
  const comp = await loadCompetition(c, intParam(c, 'id'), user)

  const blocked = uploadBlockedReason(comp, user, await applicationStatus(c, comp.id, user.id))
  if (blocked) throw new ApiError(403, blocked)

  if (Number(c.req.header('content-length') ?? 0) > MAX_FULL_BYTES + MAX_THUMB_BYTES + 100_000) {
    throw new ApiError(413, 'The upload is too large.')
  }
  const form = await c.req.formData().catch(() => {
    throw new ApiError(400, 'The upload could not be read.')
  })
  const full = form.get('full')
  const thumb = form.get('thumb')
  if (!(full instanceof File) || !(thumb instanceof File)) throw new ApiError(400, 'Both the photo and its thumbnail are required.')
  const fields = parse(uploadSchema, Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === 'string')))

  // Category and quota checks (re-checked atomically in the INSERT below).
  const category = await c.env.DB.prepare('SELECT id, name, max_photos_per_person FROM categories WHERE id = ? AND competition_id = ?')
    .bind(fields.category_id, comp.id)
    .first<{ id: number; name: string; max_photos_per_person: number | null }>()
  if (!category) throw new ApiError(400, 'Please choose a category.')
  const counts = await photoCounts(c, comp.id, user.id)
  if (counts.total >= comp.max_photos_per_person) {
    throw new ApiError(409, `You have reached the limit of ${comp.max_photos_per_person} photos for this competition.`)
  }
  const catLimit = category.max_photos_per_person
  if (catLimit !== null && (counts.by_category[category.id] ?? 0) >= catLimit) {
    throw new ApiError(409, `You have reached the limit of ${catLimit} photos in "${category.name}".`)
  }

  // File checks.
  if (full.size > MAX_FULL_BYTES) throw new ApiError(413, 'The photo is larger than 4 MB after processing.')
  if (thumb.size > MAX_THUMB_BYTES) throw new ApiError(413, 'The thumbnail is too large.')
  const fullBytes = new Uint8Array(await full.arrayBuffer())
  const thumbBytes = new Uint8Array(await thumb.arrayBuffer())
  const fullSize = jpegSize(fullBytes)
  const thumbSize = jpegSize(thumbBytes)
  if (!fullSize || !thumbSize) throw new ApiError(400, 'Photos must be JPEG images.')
  const longSide = Math.max(fullSize.width, fullSize.height)
  if (longSide < 1080) throw new ApiError(400, 'The photo is too small: the long side must be at least 1080 pixels.')
  if (longSide > 1920) throw new ApiError(400, 'The photo is too large: the long side can be at most 1920 pixels.')
  if (Math.max(thumbSize.width, thumbSize.height) > 480) throw new ApiError(400, 'The thumbnail is too large.')

  const base = `photos/${comp.id}/${randomHex(16)}`
  const fullKey = `${base}-full.jpg`
  const thumbKey = `${base}-thumb.jpg`
  await c.env.PHOTOS.put(fullKey, fullBytes, { httpMetadata: { contentType: 'image/jpeg' } })
  await c.env.PHOTOS.put(thumbKey, thumbBytes, { httpMetadata: { contentType: 'image/jpeg' } })

  // The quota checks are repeated inside the INSERT so two parallel uploads cannot exceed a limit.
  const row = await c.env.DB.prepare(
    `INSERT INTO photos (competition_id, category_id, user_id, title, taken_at, latitude, longitude, location_name,
        width, height, full_key, thumb_key, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
     WHERE (SELECT COUNT(*) FROM photos WHERE competition_id = ?1 AND user_id = ?3) < ?14
       AND (?15 IS NULL OR (SELECT COUNT(*) FROM photos WHERE category_id = ?2 AND user_id = ?3) < ?15)
     RETURNING id`,
  )
    .bind(
      comp.id, category.id, user.id, fields.title, fields.taken_at, fields.latitude, fields.longitude, fields.location_name || null,
      fullSize.width, fullSize.height, fullKey, thumbKey, nowIso(), comp.max_photos_per_person, catLimit,
    )
    .first<{ id: number }>()
  if (!row) {
    await c.env.PHOTOS.delete([fullKey, thumbKey])
    throw new ApiError(409, 'You have reached your photo limit.')
  }
  return c.json({ id: row.id }, 201)
})

// Single photo ---------------------------------------------------------------

photos.get('/:id', async (c) => {
  const user = c.get('user')
  const { photo, comp, isAdmin } = await loadPhoto(c, intParam(c, 'id'), user)
  const uploader = await c.env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(photo.user_id).first<{ name: string }>()
  const category = await c.env.DB.prepare('SELECT name FROM categories WHERE id = ?').bind(photo.category_id).first<{ name: string }>()
  const liked = user
    ? await c.env.DB.prepare('SELECT 1 AS x FROM votes WHERE photo_id = ? AND user_id = ?').bind(photo.id, user.id).first()
    : null
  const isMine = photo.user_id === user?.id
  const result: Record<string, unknown> = {
    id: photo.id,
    competition: { id: comp.id, title: comp.title, results_published_at: comp.results_published_at },
    category_id: photo.category_id,
    category_name: category?.name,
    title: photo.title,
    uploader_id: photo.user_id,
    uploader_name: uploader?.name,
    taken_at: photo.taken_at,
    latitude: photo.latitude,
    longitude: photo.longitude,
    location_name: photo.location_name,
    width: photo.width,
    height: photo.height,
    hidden: !!photo.hidden,
    winner_label: photo.winner_label,
    liked_by_me: !!liked,
    is_mine: isMine,
    is_admin: isAdmin,
    can_vote: !!user && !isMine && comp.status === 'published' && !comp.results_published_at && !photo.hidden,
    can_edit: isMine && submissionsOpen(comp),
    can_delete: isAdmin || (isMine && submissionsOpen(comp)),
  }
  if (comp.results_published_at || isAdmin) {
    const n = await c.env.DB.prepare(
      'SELECT (SELECT COUNT(*) FROM votes WHERE photo_id = ?1) AS likes, (SELECT COALESCE(SUM(points), 0) FROM judge_votes WHERE photo_id = ?1) AS judge',
    )
      .bind(photo.id)
      .first<{ likes: number; judge: number }>()
    result.vote_count = n!.likes
    result.judge_points = n!.judge
    result.total_score = n!.likes + n!.judge
  }
  return c.json(result)
})

// Edit title/date/location (uploader, while submissions are open).
photos.patch('/:id', async (c) => {
  const user = requireUser(c)
  const { photo, comp } = await loadPhoto(c, intParam(c, 'id'), user)
  if (photo.user_id !== user.id) throw new ApiError(403, 'You can only edit your own photos.')
  if (!submissionsOpen(comp)) throw new ApiError(403, 'Photos can only be edited while submissions are open.')
  const m = parse(metaSchema, await jsonBody(c))
  await c.env.DB.prepare('UPDATE photos SET title = ?, taken_at = ?, latitude = ?, longitude = ?, location_name = ? WHERE id = ?')
    .bind(m.title, m.taken_at, m.latitude, m.longitude, m.location_name || null, photo.id)
    .run()
  return c.json({ ok: true })
})

photos.delete('/:id', async (c) => {
  const user = requireUser(c)
  const { photo, comp, isAdmin } = await loadPhoto(c, intParam(c, 'id'), user)
  const ownerMayDelete = photo.user_id === user.id && submissionsOpen(comp)
  if (!isAdmin && !ownerMayDelete) throw new ApiError(403, 'You can only delete your own photos while submissions are open.')
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM votes WHERE photo_id = ?').bind(photo.id),
    c.env.DB.prepare('DELETE FROM judge_votes WHERE photo_id = ?').bind(photo.id),
    c.env.DB.prepare('DELETE FROM comments WHERE photo_id = ?').bind(photo.id),
    c.env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(photo.id),
  ])
  await c.env.PHOTOS.delete([photo.full_key, photo.thumb_key])
  return c.json({ ok: true })
})

// Admin moderation.
photos.post('/:id/hidden', async (c) => {
  const user = requireUser(c)
  const { photo, comp } = await loadPhoto(c, intParam(c, 'id'), user)
  requireAdmin(comp, user)
  const { hidden } = parse(z.object({ hidden: z.boolean() }), await jsonBody(c))
  await c.env.DB.prepare('UPDATE photos SET hidden = ? WHERE id = ?').bind(hidden ? 1 : 0, photo.id).run()
  return c.json({ ok: true })
})

photos.put('/:id/winner', async (c) => {
  const user = requireUser(c)
  const { photo, comp } = await loadPhoto(c, intParam(c, 'id'), user)
  requireAdmin(comp, user)
  if (!comp.results_published_at) throw new ApiError(400, 'Publish the results before choosing winners.')
  const { label } = parse(z.object({ label: z.string().trim().max(40).nullable() }), await jsonBody(c))
  await c.env.DB.prepare('UPDATE photos SET winner_label = ? WHERE id = ?').bind(label || null, photo.id).run()
  return c.json({ ok: true })
})

// Image files: served through the Worker so hidden photos stay private.
for (const kind of ['full', 'thumb'] as const) {
  photos.get(`/:id/${kind}`, async (c) => {
    const { photo } = await loadPhoto(c, intParam(c, 'id'), c.get('user'))
    const object = await c.env.PHOTOS.get(kind === 'full' ? photo.full_key : photo.thumb_key)
    if (!object) throw new ApiError(404, 'Image file not found.')
    return new Response(object.body, {
      headers: {
        'content-type': 'image/jpeg',
        etag: object.httpEtag,
        'cache-control': photo.hidden ? 'private, no-store' : 'public, max-age=31536000, immutable',
      },
    })
  })
}

// Likes ------------------------------------------------------------------------
// Responses never contain vote counts: those stay secret until results are published.

/** Likes the user can still give (null = unlimited). */
async function likesLeft(c: Ctx, comp: CompetitionRow, userId: number) {
  return comp.max_likes_per_person === null ? null : comp.max_likes_per_person - (await likesUsed(c, comp.id, userId))
}

async function votablePhoto(c: Ctx) {
  const user = requireUser(c)
  const { photo, comp } = await loadPhoto(c, intParam(c, 'id'), user)
  if (comp.status !== 'published' || comp.results_published_at) throw new ApiError(403, 'Voting is closed.')
  if (photo.hidden) throw new ApiError(403, 'This photo is hidden.')
  if (photo.user_id === user.id) throw new ApiError(403, "You can't like your own photo.")
  return { user, photo, comp }
}

photos.post('/:id/like', async (c) => {
  const { user, photo, comp } = await votablePhoto(c)
  const already = await c.env.DB.prepare('SELECT 1 AS x FROM votes WHERE photo_id = ? AND user_id = ?').bind(photo.id, user.id).first()
  if (already) return c.json({ liked: true, likes_left: await likesLeft(c, comp, user.id) })
  const limit = comp.max_likes_per_person
  // The limit is re-checked inside the INSERT so parallel requests cannot exceed it.
  const result = await c.env.DB.prepare(
    `INSERT INTO votes (photo_id, user_id, created_at) SELECT ?1, ?2, ?3
     WHERE ?4 IS NULL OR (SELECT COUNT(*) FROM votes v JOIN photos p ON p.id = v.photo_id WHERE p.competition_id = ?5 AND v.user_id = ?2) < ?4`,
  )
    .bind(photo.id, user.id, nowIso(), limit, comp.id)
    .run()
  if (!result.meta.changes) throw new ApiError(409, `You have used all ${limit} of your likes. Unlike another photo to give a like here.`)
  return c.json({ liked: true, likes_left: await likesLeft(c, comp, user.id) })
})

photos.delete('/:id/like', async (c) => {
  const { user, photo, comp } = await votablePhoto(c)
  await c.env.DB.prepare('DELETE FROM votes WHERE photo_id = ? AND user_id = ?').bind(photo.id, user.id).run()
  return c.json({ liked: false, likes_left: await likesLeft(c, comp, user.id) })
})

// Comments ---------------------------------------------------------------------

photos.get('/:id/comments', async (c) => {
  const user = c.get('user')
  const { photo, isAdmin } = await loadPhoto(c, intParam(c, 'id'), user)
  const { results } = await c.env.DB.prepare(
    `SELECT cm.id, cm.user_id, u.name AS author_name, cm.body, cm.hidden, cm.created_at
     FROM comments cm JOIN users u ON u.id = cm.user_id
     WHERE cm.photo_id = ? AND (cm.hidden = 0 OR ? = 1 OR cm.user_id = ?) ORDER BY cm.id`,
  )
    .bind(photo.id, isAdmin ? 1 : 0, user?.id ?? 0)
    .all<{ id: number; user_id: number; hidden: number }>()
  return c.json({
    comments: results.map((r) => ({
      ...r,
      hidden: !!r.hidden,
      can_delete: isAdmin || r.user_id === user?.id,
      can_hide: isAdmin,
    })),
  })
})

photos.post('/:id/comments', async (c) => {
  const user = requireUser(c)
  const { photo, comp } = await loadPhoto(c, intParam(c, 'id'), user)
  if (comp.status !== 'published') throw new ApiError(403, 'Comments are closed.')
  const { body } = parse(z.object({ body: z.string().trim().min(1, 'Please write a comment').max(1000, 'Comments can be at most 1000 characters') }), await jsonBody(c))
  const row = await c.env.DB.prepare('INSERT INTO comments (photo_id, user_id, body, created_at) VALUES (?, ?, ?, ?) RETURNING id')
    .bind(photo.id, user.id, body, nowIso())
    .first<{ id: number }>()
  return c.json({ id: row!.id }, 201)
})

export const comments = new Hono<AppEnv>()

async function loadComment(c: Ctx, user: User) {
  const row = await c.env.DB.prepare('SELECT id, photo_id, user_id FROM comments WHERE id = ?')
    .bind(intParam(c, 'id'))
    .first<{ id: number; photo_id: number; user_id: number }>()
  if (!row) throw new ApiError(404, 'Comment not found.')
  const { isAdmin } = await loadPhoto(c, row.photo_id, user)
  return { row, isAdmin }
}

comments.delete('/:id', async (c) => {
  const user = requireUser(c)
  const { row, isAdmin } = await loadComment(c, user)
  if (!isAdmin && row.user_id !== user.id) throw new ApiError(403, 'You can only delete your own comments.')
  await c.env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(row.id).run()
  return c.json({ ok: true })
})

comments.post('/:id/hidden', async (c) => {
  const user = requireUser(c)
  const { row, isAdmin } = await loadComment(c, user)
  if (!isAdmin) throw new ApiError(403, 'Only the competition admin can hide comments.')
  const { hidden } = parse(z.object({ hidden: z.boolean() }), await jsonBody(c))
  await c.env.DB.prepare('UPDATE comments SET hidden = ? WHERE id = ?').bind(hidden ? 1 : 0, row.id).run()
  return c.json({ ok: true })
})

// Judge votes (admin only) ------------------------------------------------------
// Points the admin adds for external judges. Only the admin sees them until results are published.

const judgeSchema = z.object({
  judge_name: z.string().trim().min(1, 'Judge name is required').max(80),
  points: z.number().int().min(1, 'Points must be at least 1').max(1000),
})

photos.get('/:id/judge-votes', async (c) => {
  const user = requireUser(c)
  const { photo, comp } = await loadPhoto(c, intParam(c, 'id'), user)
  requireAdmin(comp, user)
  const { results } = await c.env.DB.prepare('SELECT id, judge_name, points FROM judge_votes WHERE photo_id = ? ORDER BY id').bind(photo.id).all()
  return c.json({ judge_votes: results })
})

photos.post('/:id/judge-votes', async (c) => {
  const user = requireUser(c)
  const { photo, comp } = await loadPhoto(c, intParam(c, 'id'), user)
  requireAdmin(comp, user)
  const v = parse(judgeSchema, await jsonBody(c))
  const row = await c.env.DB.prepare('INSERT INTO judge_votes (photo_id, judge_name, points, created_at) VALUES (?, ?, ?, ?) RETURNING id')
    .bind(photo.id, v.judge_name, v.points, nowIso())
    .first<{ id: number }>()
  return c.json({ id: row!.id }, 201)
})

export const judgeVotes = new Hono<AppEnv>()

async function loadJudgeVote(c: Ctx, user: User) {
  const row = await c.env.DB.prepare('SELECT id, photo_id FROM judge_votes WHERE id = ?').bind(intParam(c, 'id')).first<{ id: number; photo_id: number }>()
  if (!row) throw new ApiError(404, 'Judge vote not found.')
  const { comp } = await loadPhoto(c, row.photo_id, user)
  requireAdmin(comp, user)
  return row
}

judgeVotes.put('/:id', async (c) => {
  const user = requireUser(c)
  const row = await loadJudgeVote(c, user)
  const v = parse(judgeSchema, await jsonBody(c))
  await c.env.DB.prepare('UPDATE judge_votes SET judge_name = ?, points = ? WHERE id = ?').bind(v.judge_name, v.points, row.id).run()
  return c.json({ ok: true })
})

judgeVotes.delete('/:id', async (c) => {
  const user = requireUser(c)
  const row = await loadJudgeVote(c, user)
  await c.env.DB.prepare('DELETE FROM judge_votes WHERE id = ?').bind(row.id).run()
  return c.json({ ok: true })
})
