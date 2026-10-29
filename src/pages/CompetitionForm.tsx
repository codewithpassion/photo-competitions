import { type FormEvent, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api, useLoad, useMe } from '../api'
import { fromLocalInput, toLocalInput } from '../format'
import type { CompetitionDetail } from '../types'
import { ErrorBox, Loading, SignInPrompt } from '../ui'

interface CategoryDraft {
  id?: number
  name: string
  description: string
  limit: string // empty = no category limit
}

const inDays = (days: number) => toLocalInput(new Date(Date.now() + days * 86400_000).toISOString())

export default function CompetitionForm() {
  const { id } = useParams()
  const editing = id !== undefined
  const { user, loading } = useMe()
  const navigate = useNavigate()
  const { data, error: loadError, reload } = useLoad(
    () => (editing ? api<CompetitionDetail>(`/competitions/${id}`) : Promise.resolve(null)),
    [id],
  )

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [openAt, setOpenAt] = useState(inDays(0))
  const [closeAt, setCloseAt] = useState(inDays(30))
  const [maxPhotos, setMaxPhotos] = useState('3')
  const [maxLikes, setMaxLikes] = useState('') // empty = unlimited
  const [categories, setCategories] = useState<CategoryDraft[]>([{ name: '', description: '', limit: '' }])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Fill the form when editing an existing competition.
  useEffect(() => {
    if (!data) return
    const c = data.competition
    setTitle(c.title)
    setDescription(c.description)
    setOpenAt(toLocalInput(c.submissions_open_at))
    setCloseAt(toLocalInput(c.submissions_close_at))
    setMaxPhotos(String(c.max_photos_per_person))
    setMaxLikes(c.max_likes_per_person?.toString() ?? '')
    setCategories(data.categories.map((k) => ({ id: k.id, name: k.name, description: k.description, limit: k.max_photos_per_person?.toString() ?? '' })))
  }, [data])

  if (loading || (editing && !data && !loadError)) return <Loading />
  if (!user) return <SignInPrompt what="create a competition" />
  if (loadError) return <ErrorBox message={loadError} />
  if (data && !data.is_admin) return <ErrorBox message="Only the competition admin can edit it." />

  const update = (i: number, patch: Partial<CategoryDraft>) =>
    setCategories(categories.map((c, j) => (j === i ? { ...c, ...patch } : c)))

  async function save(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const body = {
        title,
        description,
        submissions_open_at: fromLocalInput(openAt),
        submissions_close_at: fromLocalInput(closeAt),
        max_photos_per_person: Number(maxPhotos),
        max_likes_per_person: maxLikes.trim() === '' ? null : Number(maxLikes),
        categories: categories.map((c) => ({
          id: c.id,
          name: c.name,
          description: c.description,
          max_photos_per_person: c.limit.trim() === '' ? null : Number(c.limit),
        })),
      }
      if (editing) {
        await api(`/competitions/${id}`, 'PUT', body)
        navigate(`/c/${id}`)
      } else {
        const r = await api<{ id: number }>('/competitions', 'POST', body)
        navigate(`/c/${r.id}/edit`) // next step: publish
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function setPublished(publish: boolean) {
    setError(null)
    try {
      await api(`/competitions/${id}/${publish ? 'publish' : 'unpublish'}`, 'POST')
      reload()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const comp = data?.competition
  return (
    <form onSubmit={save} className="mx-auto max-w-2xl space-y-5">
      <h1 className="text-2xl font-semibold">{editing ? 'Edit competition' : 'New competition'}</h1>
      <ErrorBox message={error} />

      <div>
        <label className="label" htmlFor="title">Title</label>
        <input id="title" className="input" required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor="description">Description</label>
        <textarea id="description" className="input" rows={5} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="open">Submissions open</label>
          <input id="open" type="datetime-local" className="input" required value={openAt} onChange={(e) => setOpenAt(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="close">Submissions close (judging date)</label>
          <input id="close" type="datetime-local" className="input" required value={closeAt} onChange={(e) => setCloseAt(e.target.value)} />
        </div>
      </div>
      <p className="-mt-3 text-xs text-stone-500">Times are in your local time zone. No new photos can be submitted after the close time.</p>
      <div>
        <label className="label" htmlFor="max">Photos allowed per person (whole competition)</label>
        <input id="max" type="number" min={1} className="input w-32" required value={maxPhotos} onChange={(e) => setMaxPhotos(e.target.value)} />
      </div>

      <div>
        <label className="label" htmlFor="likes">Likes allowed per person (blank = unlimited)</label>
        <input id="likes" type="number" min={1} className="input w-32" value={maxLikes} onChange={(e) => setMaxLikes(e.target.value)} />
        <p className="mt-1 text-xs text-stone-500">Each person can like a photo once and never their own. Taking a like back gives it back.</p>
      </div>

      <fieldset className="space-y-3">
        <legend className="label">Categories</legend>
        {categories.map((c, i) => (
          <div key={c.id ?? `new-${i}`} className="card grid gap-3 sm:grid-cols-[1fr_1fr_8rem_auto]" data-testid="category-row">
            <input className="input" placeholder="Name" aria-label="Category name" required value={c.name} onChange={(e) => update(i, { name: e.target.value })} />
            <input className="input" placeholder="Description (optional)" aria-label="Category description" value={c.description} onChange={(e) => update(i, { description: e.target.value })} />
            <input className="input" type="number" min={1} placeholder="Limit" aria-label="Category limit per person" title="Photos per person in this category (blank = no limit)" value={c.limit} onChange={(e) => update(i, { limit: e.target.value })} />
            <button type="button" className="btn-danger" onClick={() => setCategories(categories.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        ))}
        <button type="button" className="btn-secondary" onClick={() => setCategories([...categories, { name: '', description: '', limit: '' }])}>
          Add category
        </button>
        <p className="text-xs text-stone-500">Leave a category's limit blank to only apply the competition-wide limit. A category with photos can't be removed.</p>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <button className="btn" disabled={saving}>
          {saving ? 'Saving...' : editing ? 'Save changes' : 'Create competition'}
        </button>
        <Link to={editing ? `/c/${id}` : '/'} className="btn-secondary">
          Cancel
        </Link>
      </div>

      {comp && (
        <div className="card space-y-2">
          <p className="text-sm">
            Status: <strong>{comp.status === 'published' ? 'Published' : 'Draft (only you can see it)'}</strong>
          </p>
          {comp.status === 'draft' ? (
            <button type="button" className="btn" onClick={() => setPublished(true)}>
              Publish competition
            </button>
          ) : (
            <button type="button" className="btn-secondary" onClick={() => setPublished(false)}>
              Unpublish (back to draft)
            </button>
          )}
          <p className="text-xs text-stone-500">Save your changes before publishing. Publishing needs at least one category.</p>
        </div>
      )}
    </form>
  )
}
