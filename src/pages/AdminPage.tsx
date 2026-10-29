import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { api, useLoad, useMe } from '../api'
import { fmtDateTime, phaseOf } from '../format'
import type { CompetitionDetail, PhotoSummary } from '../types'
import { Badge, ErrorBox, Loading, SignInPrompt } from '../ui'

interface JudgeVote {
  id: number
  judge_name: string
  points: number
}

interface Application {
  id: number
  name: string
  email: string
  message: string
  status: 'pending' | 'approved' | 'rejected'
  created_at: string
}

export default function AdminPage() {
  const id = useParams().id!
  const { user, loading } = useMe()
  const detail = useLoad(() => api<CompetitionDetail>(`/competitions/${id}`), [id, user?.id])
  const isAdmin = detail.data?.is_admin
  const apps = useLoad(() => (isAdmin ? api<{ applications: Application[] }>(`/competitions/${id}/applications`) : Promise.resolve(null)), [id, isAdmin])
  const photos = useLoad(() => api<{ photos: PhotoSummary[] }>(`/competitions/${id}/photos`), [id, user?.id])
  const [error, setError] = useState<string | null>(null)

  if (loading || (!detail.data && !detail.error)) return <Loading />
  if (!user) return <SignInPrompt what="manage this competition" />
  if (detail.error) return <ErrorBox message={detail.error} />
  if (!detail.data!.is_admin) return <ErrorBox message="Only the competition admin can open this page." />
  const { competition: c, categories } = detail.data!
  const phase = phaseOf(c)
  const categoryName = (cid: number) => categories.find((k) => k.id === cid)?.name ?? ''

  /** Run an admin action, show any error, then refresh the data. */
  async function act(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    }
    detail.reload()
    apps.reload()
    photos.reload()
  }

  return (
    <div className="space-y-8">
      <div>
        <Link to={`/c/${c.id}`} className="text-sm text-stone-600 hover:underline">← {c.title}</Link>
        <h1 className="text-2xl font-semibold">Manage competition</h1>
      </div>
      <ErrorBox message={error} />

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Applications</h2>
        {apps.data?.applications.length === 0 && <p className="text-sm text-stone-500">No applications yet.</p>}
        <ul className="space-y-2">
          {apps.data?.applications.map((a) => (
            <li key={a.id} className="card flex flex-wrap items-center justify-between gap-2" data-testid="application">
              <div>
                <p className="font-medium">{a.name} <span className="text-xs font-normal text-stone-500">{a.email}</span></p>
                {a.message && <p className="text-sm text-stone-600">"{a.message}"</p>}
                <p className="text-xs text-stone-500">Applied {fmtDateTime(a.created_at)}</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge>{a.status}</Badge>
                {a.status !== 'approved' && <button className="btn" onClick={() => act(() => api(`/applications/${a.id}`, 'PATCH', { status: 'approved' }))}>Approve</button>}
                {a.status !== 'rejected' && <button className="btn-danger" onClick={() => act(() => api(`/applications/${a.id}`, 'PATCH', { status: 'rejected' }))}>Reject</button>}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Results</h2>
        {c.results_published_at ? (
          <p className="text-sm">Results were published on {fmtDateTime(c.results_published_at)}. Voting is closed. You can mark winners below.</p>
        ) : (
          <>
            <p className="text-sm text-stone-600">
              Publishing results shows how many likes each photo got, ranks the photos, and closes voting. This is only possible after
              the submissions close time ({fmtDateTime(c.submissions_close_at)}).
            </p>
            <button
              className="btn"
              disabled={phase !== 'closed'}
              onClick={() => confirm('Publish results? Voting will close.') && act(() => api(`/competitions/${c.id}/results`, 'POST'))}
            >
              Publish results
            </button>
          </>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Photos</h2>
        {photos.data?.photos.length === 0 && <p className="text-sm text-stone-500">No photos yet.</p>}
        <ul className="space-y-2">
          {photos.data?.photos.map((p) => (
            <PhotoRow
              key={p.id}
              photo={p}
              category={categoryName(p.category_id)}
              resultsPublished={!!c.results_published_at}
              act={act}
            />
          ))}
        </ul>
      </section>
    </div>
  )
}

function PhotoRow({ photo: p, category, resultsPublished, act }: { photo: PhotoSummary; category: string; resultsPublished: boolean; act: (fn: () => Promise<unknown>) => void }) {
  const [label, setLabel] = useState(p.winner_label ?? '')
  return (
    <li className="card flex flex-wrap items-center gap-3" data-testid="admin-photo">
      <Link to={`/p/${p.id}`}>
        <img src={`/api/photos/${p.id}/thumb`} alt={p.title} className="h-16 w-24 rounded object-cover" />
      </Link>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{p.title}</p>
        <p className="text-xs text-stone-500" data-testid="scores">
          {category} · by {p.uploader_name}
          {p.vote_count !== undefined && ` · ${p.vote_count} likes + ${p.judge_points} judge = ${p.total_score} total`}
        </p>
        {p.hidden && <Badge tone="red">Hidden by moderator</Badge>}
      </div>
      {resultsPublished && !p.hidden && (
        <form
          className="flex gap-1"
          onSubmit={(e) => {
            e.preventDefault()
            act(() => api(`/photos/${p.id}/winner`, 'PUT', { label: label.trim() || null }))
          }}
        >
          <input className="input w-36" placeholder="Winner label" aria-label="Winner label" value={label} onChange={(e) => setLabel(e.target.value)} />
          <button className="btn-secondary">Save</button>
          {p.winner_label && (
            <button type="button" className="btn-secondary" onClick={() => { setLabel(''); act(() => api(`/photos/${p.id}/winner`, 'PUT', { label: null })) }}>
              Unmark
            </button>
          )}
        </form>
      )}
      <JudgeVotes photoId={p.id} act={act} />
      <button className="btn-secondary" onClick={() => act(() => api(`/photos/${p.id}/hidden`, 'POST', { hidden: !p.hidden }))}>
        {p.hidden ? 'Unhide' : 'Hide'}
      </button>
      <button className="btn-danger" onClick={() => confirm(`Delete "${p.title}" permanently?`) && act(() => api(`/photos/${p.id}`, 'DELETE'))}>
        Delete
      </button>
    </li>
  )
}

/** Admin-only list of judge points for one photo: add, edit, remove. */
function JudgeVotes({ photoId, act }: { photoId: number; act: (fn: () => Promise<unknown>) => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [points, setPoints] = useState('1')
  const votes = useLoad(() => (open ? api<{ judge_votes: JudgeVote[] }>(`/photos/${photoId}/judge-votes`) : Promise.resolve(null)), [open, photoId])
  const [error, setError] = useState<string | null>(null)

  /** Run a change, refresh this list, and let the page refresh its scores. */
  async function change(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
      votes.reload()
      act(async () => {})
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="w-full">
      <button type="button" className="btn-secondary" onClick={() => setOpen(!open)}>
        {open ? 'Close judge votes' : 'Judge votes'}
      </button>
      {open && (
        <div className="mt-2 space-y-2 rounded-md bg-stone-50 p-3" data-testid="judge-panel">
          <ErrorBox message={error ?? votes.error} />
          {votes.data?.judge_votes.map((v) => (
            <JudgeRow key={`${v.id}-${v.judge_name}-${v.points}`} vote={v} change={change} />
          ))}
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              change(async () => {
                await api(`/photos/${photoId}/judge-votes`, 'POST', { judge_name: name, points: Number(points) })
                setName('')
              })
            }}
          >
            <input className="input w-48" placeholder="Judge name" aria-label="Judge name" required value={name} onChange={(e) => setName(e.target.value)} />
            <input className="input w-24" type="number" min={1} aria-label="Points" required value={points} onChange={(e) => setPoints(e.target.value)} />
            <button className="btn">Add judge points</button>
          </form>
        </div>
      )}
    </div>
  )
}

function JudgeRow({ vote, change }: { vote: JudgeVote; change: (fn: () => Promise<unknown>) => void }) {
  const [name, setName] = useState(vote.judge_name)
  const [points, setPoints] = useState(String(vote.points))
  return (
    <div className="flex flex-wrap gap-2" data-testid="judge-row">
      <input className="input w-48" aria-label="Judge name" value={name} onChange={(e) => setName(e.target.value)} />
      <input className="input w-24" type="number" min={1} aria-label="Points" value={points} onChange={(e) => setPoints(e.target.value)} />
      <button className="btn-secondary" onClick={() => change(() => api(`/judge-votes/${vote.id}`, 'PUT', { judge_name: name, points: Number(points) }))}>Save</button>
      <button className="btn-danger" onClick={() => change(() => api(`/judge-votes/${vote.id}`, 'DELETE'))}>Remove</button>
    </div>
  )
}
