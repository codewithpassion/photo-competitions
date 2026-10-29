import { Hono } from 'hono'
import { z } from 'zod'
import { type AppEnv, type Ctx, type User, ApiError, intParam, isoDate, jsonBody, nowIso, parse, requireUser } from './lib'

export const competitions = new Hono<AppEnv>()

export interface CompetitionRow {
  id: number
  admin_id: number
  admin_name: string
  title: string
  description: string
  status: 'draft' | 'published'
  submissions_open_at: string
  submissions_close_at: string
  max_photos_per_person: number
  max_likes_per_person: number | null
  results_published_at: string | null
  created_at: string
}

const COMP_SELECT = `SELECT c.*, u.name AS admin_name FROM competitions c JOIN users u ON u.id = c.admin_id`

/** Load a competition the viewer is allowed to see (drafts only for their admin). Throws 404 otherwise. */
export async function loadCompetition(c: Ctx, id: number, user: User | null): Promise<CompetitionRow> {
  const comp = await c.env.DB.prepare(`${COMP_SELECT} WHERE c.id = ?`).bind(id).first<CompetitionRow>()
  if (!comp || (comp.status === 'draft' && comp.admin_id !== user?.id)) throw new ApiError(404, 'Competition not found.')
  return comp
}

export function requireAdmin(comp: CompetitionRow, user: User) {
  if (comp.admin_id !== user.id) throw new ApiError(403, 'Only the competition admin can do that.')
}

export const submissionsOpen = (comp: CompetitionRow) =>
  comp.status === 'published' && comp.submissions_open_at <= nowIso() && nowIso() < comp.submissions_close_at

interface CategoryRow {
  id: number
  name: string
  description: string
  max_photos_per_person: number | null
}

async function loadCategories(c: Ctx, competitionId: number) {
  const { results } = await c.env.DB.prepare(
    'SELECT id, name, description, max_photos_per_person FROM categories WHERE competition_id = ? ORDER BY position, id',
  )
    .bind(competitionId)
    .all<CategoryRow>()
  return results
}

/** How many photos a user has in a competition (total and per category). */
export async function photoCounts(c: Ctx, competitionId: number, userId: number) {
  const { results } = await c.env.DB.prepare(
    'SELECT category_id, COUNT(*) AS n FROM photos WHERE competition_id = ? AND user_id = ? GROUP BY category_id',
  )
    .bind(competitionId, userId)
    .all<{ category_id: number; n: number }>()
  const by_category: Record<number, number> = {}
  let total = 0
  for (const r of results) {
    by_category[r.category_id] = r.n
    total += r.n
  }
  return { total, by_category }
}

/** How many likes a user has currently given in a competition. */
export async function likesUsed(c: Ctx, competitionId: number, userId: number) {
  const row = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM votes v JOIN photos p ON p.id = v.photo_id WHERE p.competition_id = ? AND v.user_id = ?',
  )
    .bind(competitionId, userId)
    .first<{ n: number }>()
  return row!.n
}

export async function applicationStatus(c: Ctx, competitionId: number, userId: number) {
  const row = await c.env.DB.prepare('SELECT status FROM applications WHERE competition_id = ? AND user_id = ?')
    .bind(competitionId, userId)
    .first<{ status: string }>()
  return row?.status ?? null
}

/** Returns a plain-words reason why the user cannot upload now, or null when allowed (ignoring quotas). */
export function uploadBlockedReason(comp: CompetitionRow, user: User | null, appStatus: string | null): string | null {
  if (!user) return 'Sign in to upload photos.'
  if (comp.status !== 'published') return 'This competition is not published yet.'
  if (nowIso() < comp.submissions_open_at) return 'Submissions have not opened yet.'
  if (nowIso() >= comp.submissions_close_at) return 'Submissions are closed.'
  if (comp.admin_id !== user.id && appStatus !== 'approved') {
    return appStatus === 'pending'
      ? 'Your application is waiting for approval.'
      : appStatus === 'rejected'
        ? 'Your application was not approved.'
        : 'Apply to enter this competition first.'
  }
  return null
}

const categorySchema = z.object({
  id: z.number().int().optional(),
  name: z.string().trim().min(1, 'Category name is required').max(60),
  description: z.string().trim().max(300).default(''),
  max_photos_per_person: z.number().int().min(1).max(1000).nullable().default(null),
})

const competitionSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required').max(120),
    description: z.string().trim().max(5000).default(''),
    submissions_open_at: isoDate,
    submissions_close_at: isoDate,
    max_photos_per_person: z.number().int().min(1).max(1000),
    max_likes_per_person: z.number().int().min(1).max(100000).nullable().default(null),
    categories: z.array(categorySchema).max(30).optional(),
  })
  .refine((v) => v.submissions_close_at > v.submissions_open_at, {
    message: 'The close date must be after the open date.',
    path: ['submissions_close_at'],
  })


function insertCategory(c: Ctx, competitionId: number, cat: z.infer<typeof categorySchema>, position: number) {
  return c.env.DB.prepare(
    'INSERT INTO categories (competition_id, name, description, max_photos_per_person, position) VALUES (?, ?, ?, ?, ?)',
  ).bind(competitionId, cat.name, cat.description, cat.max_photos_per_person, position)
}

// List published competitions (with a cover photo, newest upload).
competitions.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT c.id, c.title, c.submissions_open_at, c.submissions_close_at, c.results_published_at, u.name AS admin_name,
       (SELECT p.id FROM photos p WHERE p.competition_id = c.id AND p.hidden = 0 ORDER BY p.id DESC LIMIT 1) AS cover_photo_id
     FROM competitions c JOIN users u ON u.id = c.admin_id
     WHERE c.status = 'published' ORDER BY c.submissions_close_at DESC`,
  ).all()
  return c.json({ competitions: results })
})

competitions.post('/', async (c) => {
  const user = requireUser(c)
  const input = parse(competitionSchema, await jsonBody(c))
  const row = await c.env.DB.prepare(
    `INSERT INTO competitions (admin_id, title, description, submissions_open_at, submissions_close_at, max_photos_per_person, max_likes_per_person, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(user.id, input.title, input.description, input.submissions_open_at, input.submissions_close_at, input.max_photos_per_person, input.max_likes_per_person, nowIso())
    .first<{ id: number }>()
  const cats = input.categories ?? []
  if (cats.length) await c.env.DB.batch(cats.map((cat, i) => insertCategory(c, row!.id, cat, i)))
  return c.json({ id: row!.id }, 201)
})

competitions.get('/:id', async (c) => {
  const user = c.get('user')
  const comp = await loadCompetition(c, intParam(c, 'id'), user)
  const categories = await loadCategories(c, comp.id)
  const is_admin = comp.admin_id === user?.id
  const application = user ? await applicationStatus(c, comp.id, user.id) : null
  const counts = user ? await photoCounts(c, comp.id, user.id) : { total: 0, by_category: {} }
  const likes_used = user ? await likesUsed(c, comp.id, user.id) : 0
  return c.json({
    competition: comp,
    categories,
    is_admin,
    application,
    my_counts: counts,
    likes_used,
    upload_blocked: uploadBlockedReason(comp, user, application),
  })
})

competitions.put('/:id', async (c) => {
  const user = requireUser(c)
  const comp = await loadCompetition(c, intParam(c, 'id'), user)
  requireAdmin(comp, user)
  const input = parse(competitionSchema, await jsonBody(c))
  const statements = [
    c.env.DB.prepare(
      `UPDATE competitions SET title = ?, description = ?, submissions_open_at = ?, submissions_close_at = ?, max_photos_per_person = ?, max_likes_per_person = ? WHERE id = ?`,
    ).bind(input.title, input.description, input.submissions_open_at, input.submissions_close_at, input.max_photos_per_person, input.max_likes_per_person, comp.id),
  ]

  if (input.categories) {
    const existing = await loadCategories(c, comp.id)
    const keepIds = new Set(input.categories.map((cat) => cat.id).filter((id) => id !== undefined))
    for (const cat of input.categories) {
      if (cat.id !== undefined && !existing.some((e) => e.id === cat.id)) throw new ApiError(400, 'Unknown category.')
    }
    // Deleting a category is blocked while it still has photos.
    for (const old of existing.filter((e) => !keepIds.has(e.id))) {
      const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM photos WHERE category_id = ?').bind(old.id).first<{ n: number }>()
      if (n!.n > 0) throw new ApiError(409, `The category "${old.name}" has photos, so it can't be deleted.`)
      statements.push(c.env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(old.id))
    }
    input.categories.forEach((cat, i) => {
      statements.push(
        cat.id === undefined
          ? insertCategory(c, comp.id, cat, i)
          : c.env.DB.prepare(
              'UPDATE categories SET name = ?, description = ?, max_photos_per_person = ?, position = ? WHERE id = ? AND competition_id = ?',
            ).bind(cat.name, cat.description, cat.max_photos_per_person, i, cat.id, comp.id),
      )
    })
    if (comp.status === 'published' && input.categories.length === 0) {
      throw new ApiError(400, 'A published competition needs at least one category.')
    }
  }
  await c.env.DB.batch(statements)
  return c.json({ ok: true })
})

competitions.post('/:id/publish', async (c) => {
  const user = requireUser(c)
  const comp = await loadCompetition(c, intParam(c, 'id'), user)
  requireAdmin(comp, user)
  if ((await loadCategories(c, comp.id)).length === 0) throw new ApiError(400, 'Add at least one category before publishing.')
  await c.env.DB.prepare("UPDATE competitions SET status = 'published' WHERE id = ?").bind(comp.id).run()
  return c.json({ ok: true })
})

competitions.post('/:id/unpublish', async (c) => {
  const user = requireUser(c)
  const comp = await loadCompetition(c, intParam(c, 'id'), user)
  requireAdmin(comp, user)
  const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM photos WHERE competition_id = ?').bind(comp.id).first<{ n: number }>()
  if (n!.n > 0 || comp.results_published_at) throw new ApiError(409, "Can't unpublish a competition that already has photos.")
  await c.env.DB.prepare("UPDATE competitions SET status = 'draft' WHERE id = ?").bind(comp.id).run()
  return c.json({ ok: true })
})

// Admin publishes the results once submissions have closed. This also closes voting.
competitions.post('/:id/results', async (c) => {
  const user = requireUser(c)
  const comp = await loadCompetition(c, intParam(c, 'id'), user)
  requireAdmin(comp, user)
  if (comp.status !== 'published') throw new ApiError(400, 'Publish the competition first.')
  if (nowIso() < comp.submissions_close_at) throw new ApiError(400, 'Results can only be published after the submissions close date.')
  if (comp.results_published_at) throw new ApiError(409, 'Results are already published.')
  await c.env.DB.prepare('UPDATE competitions SET results_published_at = ? WHERE id = ?').bind(nowIso(), comp.id).run()
  return c.json({ ok: true })
})

// Applications -------------------------------------------------------------

competitions.post('/:id/apply', async (c) => {
  const user = requireUser(c)
  const comp = await loadCompetition(c, intParam(c, 'id'), user)
  const { message } = parse(z.object({ message: z.string().trim().max(500).default('') }), await jsonBody(c))
  if (comp.status !== 'published') throw new ApiError(400, 'This competition is not open for applications.')
  if (comp.admin_id === user.id) throw new ApiError(400, 'You run this competition, so you can already upload.')
  if (nowIso() >= comp.submissions_close_at) throw new ApiError(400, 'Submissions are closed.')
  const result = await c.env.DB.prepare(
    'INSERT OR IGNORE INTO applications (competition_id, user_id, message, created_at) VALUES (?, ?, ?, ?)',
  )
    .bind(comp.id, user.id, message, nowIso())
    .run()
  if (!result.meta.changes) throw new ApiError(409, 'You have already applied.')
  return c.json({ status: 'pending' }, 201)
})

competitions.get('/:id/applications', async (c) => {
  const user = requireUser(c)
  const comp = await loadCompetition(c, intParam(c, 'id'), user)
  requireAdmin(comp, user)
  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.user_id, a.message, a.status, a.created_at, u.name, u.email
     FROM applications a JOIN users u ON u.id = a.user_id WHERE a.competition_id = ? ORDER BY a.created_at`,
  )
    .bind(comp.id)
    .all()
  return c.json({ applications: results })
})

export const applications = new Hono<AppEnv>()
applications.patch('/:id', async (c) => {
  const user = requireUser(c)
  const { status } = parse(z.object({ status: z.enum(['pending', 'approved', 'rejected']) }), await jsonBody(c))
  const app = await c.env.DB.prepare('SELECT id, competition_id FROM applications WHERE id = ?')
    .bind(intParam(c, 'id'))
    .first<{ id: number; competition_id: number }>()
  if (!app) throw new ApiError(404, 'Application not found.')
  requireAdmin(await loadCompetition(c, app.competition_id, user), user)
  await c.env.DB.prepare('UPDATE applications SET status = ? WHERE id = ?').bind(status, app.id).run()
  return c.json({ ok: true })
})

// My competitions ----------------------------------------------------------

export const my = new Hono<AppEnv>()
my.get('/', async (c) => {
  const user = requireUser(c)
  const select = `SELECT c.id, c.title, c.status, c.submissions_open_at, c.submissions_close_at, c.results_published_at`
  const admin = await c.env.DB.prepare(`${select} FROM competitions c WHERE c.admin_id = ? ORDER BY c.created_at DESC`)
    .bind(user.id)
    .all()
  const entered = await c.env.DB.prepare(
    `${select}, a.status AS application_status FROM competitions c JOIN applications a ON a.competition_id = c.id
     WHERE a.user_id = ? AND c.status = 'published' ORDER BY a.created_at DESC`,
  )
    .bind(user.id)
    .all()
  return c.json({ admin: admin.results, entered: entered.results })
})
