import { type FormEvent, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api, useLoad, useMe } from '../api'
import { fmtDateTime, fromLocalInput, toLocalInput } from '../format'
import type { CommentItem, PhotoDetail } from '../types'
import { Badge, ErrorBox, LikeButton, Loading, SignInLink } from '../ui'

export default function PhotoPage() {
  const id = useParams().id!
  const { user } = useMe()
  const navigate = useNavigate()
  const photo = useLoad(() => api<PhotoDetail>(`/photos/${id}`), [id, user?.id])
  const comments = useLoad(() => api<{ comments: CommentItem[] }>(`/photos/${id}/comments`), [id, user?.id])
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (photo.error) return <ErrorBox message={photo.error} />
  if (!photo.data) return <Loading />
  const p = photo.data
  const mapUrl = p.latitude !== null && p.longitude !== null ? `https://www.openstreetmap.org/?mlat=${p.latitude}&mlon=${p.longitude}#map=15/${p.latitude}/${p.longitude}` : null

  async function run(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
      photo.reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <Link to={`/c/${p.competition.id}`} className="text-sm text-stone-600 hover:underline">← {p.competition.title}</Link>
      <img src={`/api/photos/${p.id}/full`} alt={p.title} className="max-h-[80vh] w-full rounded-lg bg-stone-200 object-contain" />
      <ErrorBox message={error} />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">{p.title}</h1>
          <div className="flex flex-wrap gap-2">
            {p.winner_label && <Badge tone="gold">{p.winner_label}</Badge>}
            {p.hidden && <Badge tone="red">Hidden by moderator</Badge>}
            <Badge>{p.category_name}</Badge>
          </div>
          <p className="text-sm text-stone-600">Photographer: {p.uploader_name}</p>
          {p.taken_at && <p className="text-sm text-stone-600">Taken: {fmtDateTime(p.taken_at)}</p>}
          {(p.location_name || mapUrl) && (
            <p className="text-sm text-stone-600">
              Location: {p.location_name}{' '}
              {mapUrl && <a href={mapUrl} target="_blank" rel="noreferrer" className="underline">Open in map</a>}
            </p>
          )}
          {p.vote_count !== undefined && (
            <p className="text-sm font-medium" data-testid="vote-count">
              {p.vote_count} like{p.vote_count === 1 ? '' : 's'} + {p.judge_points} judge points = {p.total_score} total
              {p.is_admin && !p.competition.results_published_at && <span className="font-normal text-stone-500"> (only you can see this until results are published)</span>}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {p.can_vote && <LikeButton photo={p} onChange={photo.reload} />}
          {!user && !p.competition.results_published_at && <SignInLink className="btn-secondary" />}
          {p.can_edit && <button className="btn-secondary" onClick={() => setEditing(!editing)}>Edit details</button>}
          {p.is_admin && (
            <button className="btn-secondary" onClick={() => run(() => api(`/photos/${p.id}/hidden`, 'POST', { hidden: !p.hidden }))}>
              {p.hidden ? 'Unhide' : 'Hide'}
            </button>
          )}
          {p.can_delete && (
            <button
              className="btn-danger"
              onClick={async () => {
                if (!confirm('Delete this photo permanently?')) return
                try {
                  await api(`/photos/${p.id}`, 'DELETE')
                  navigate(`/c/${p.competition.id}`)
                } catch (e) {
                  setError((e as Error).message)
                }
              }}
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {editing && <EditForm photo={p} onSaved={() => { setEditing(false); photo.reload() }} />}

      <Comments photoId={p.id} data={comments.data?.comments} error={comments.error} reload={comments.reload} />
    </div>
  )
}

function EditForm({ photo: p, onSaved }: { photo: PhotoDetail; onSaved: () => void }) {
  const [title, setTitle] = useState(p.title)
  const [takenAt, setTakenAt] = useState(p.taken_at ? toLocalInput(p.taken_at) : '')
  const [location, setLocation] = useState(p.location_name ?? '')
  const [coords, setCoords] = useState<[number, number] | null>(p.latitude !== null && p.longitude !== null ? [p.latitude, p.longitude] : null)
  const [error, setError] = useState<string | null>(null)

  async function save(e: FormEvent) {
    e.preventDefault()
    try {
      await api(`/photos/${p.id}`, 'PATCH', {
        title,
        taken_at: takenAt ? fromLocalInput(takenAt) : null,
        location_name: location,
        latitude: coords?.[0] ?? null,
        longitude: coords?.[1] ?? null,
      })
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <form onSubmit={save} className="card grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <label className="label" htmlFor="edit-title">Title</label>
        <input id="edit-title" className="input" required value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor="edit-date">Date taken</label>
        <input id="edit-date" type="datetime-local" className="input" value={takenAt} onChange={(e) => setTakenAt(e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor="edit-location">Location name</label>
        <input id="edit-location" className="input" value={location} onChange={(e) => setLocation(e.target.value)} />
      </div>
      {coords && (
        <p className="text-xs text-stone-600 sm:col-span-2">
          GPS: {coords[0]}, {coords[1]}{' '}
          <button type="button" className="underline" onClick={() => setCoords(null)}>Remove GPS location</button>
        </p>
      )}
      <div className="sm:col-span-2"><ErrorBox message={error} /></div>
      <div><button className="btn">Save</button></div>
    </form>
  )
}

function Comments({ photoId, data, error, reload }: { photoId: number; data?: CommentItem[]; error: string | null; reload: () => void }) {
  const { user } = useMe()
  const [body, setBody] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  async function run(fn: () => Promise<unknown>) {
    setFormError(null)
    try {
      await fn()
      reload()
    } catch (e) {
      setFormError((e as Error).message)
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-medium">Comments</h2>
      <ErrorBox message={error} />
      {data?.length === 0 && <p className="text-sm text-stone-500">No comments yet.</p>}
      <ul className="space-y-2">
        {data?.map((c) => (
          <li key={c.id} className="card" data-testid="comment">
            <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500">
              <strong className="text-sm text-stone-800">{c.author_name}</strong>
              <span>{fmtDateTime(c.created_at)}</span>
              {c.hidden && <Badge tone="red">Hidden by moderator</Badge>}
              <span className="flex-1" />
              {c.can_hide && (
                <button className="underline" onClick={() => run(() => api(`/comments/${c.id}/hidden`, 'POST', { hidden: !c.hidden }))}>
                  {c.hidden ? 'Unhide' : 'Hide'}
                </button>
              )}
              {c.can_delete && (
                <button className="underline" onClick={() => confirm('Delete this comment?') && run(() => api(`/comments/${c.id}`, 'DELETE'))}>
                  Delete
                </button>
              )}
            </div>
            <p className="whitespace-pre-line text-sm">{c.body}</p>
          </li>
        ))}
      </ul>
      {user ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            run(async () => {
              await api(`/photos/${photoId}/comments`, 'POST', { body })
              setBody('')
            })
          }}
        >
          <label className="label" htmlFor="comment">Add a comment</label>
          <textarea id="comment" className="input" rows={3} maxLength={1000} required value={body} onChange={(e) => setBody(e.target.value)} />
          <ErrorBox message={formError} />
          <button className="btn">Post comment</button>
        </form>
      ) : (
        <p className="text-sm"><SignInLink className="underline" /> to comment.</p>
      )}
    </section>
  )
}
