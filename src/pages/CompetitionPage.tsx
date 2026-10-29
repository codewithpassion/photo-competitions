import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { api, useLoad, useMe } from '../api'
import { fmtDateTime, phaseOf } from '../format'
import type { Category, CompetitionDetail, PhotoSummary } from '../types'
import { Badge, ErrorBox, Loading, PhaseBadge, PhotoGrid, SignInLink } from '../ui'

export default function CompetitionPage() {
  const id = useParams().id!
  const { user } = useMe()
  const detail = useLoad(() => api<CompetitionDetail>(`/competitions/${id}`), [id, user?.id])
  const photos = useLoad(() => api<{ photos: PhotoSummary[] }>(`/competitions/${id}/photos`), [id, user?.id])
  const [tab, setTab] = useState<number | 'all'>('all')

  if (detail.error) return <ErrorBox message={detail.error} />
  if (!detail.data) return <Loading />
  const { competition: c, categories, is_admin, application, my_counts, upload_blocked, likes_used } = detail.data
  const phase = phaseOf(c)
  const all = photos.data?.photos ?? []
  const shown = tab === 'all' ? all : all.filter((p) => p.category_id === tab)
  const canVote = !!user && c.status === 'published' && !c.results_published_at
  const reloadAll = () => {
    photos.reload()
    detail.reload()
  }

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{c.title}</h1>
          <PhaseBadge phase={phase} />
        </div>
        <p className="text-sm text-stone-500">
          Run by {c.admin_name} · Submissions {fmtDateTime(c.submissions_open_at)} to {fmtDateTime(c.submissions_close_at)} · up to{' '}
          {c.max_photos_per_person} photo{c.max_photos_per_person === 1 ? '' : 's'} per person
        </p>
        {c.description && <p className="whitespace-pre-line">{c.description}</p>}
      </header>

      {is_admin ? (
        <div className="flex flex-wrap gap-2">
          <Link to={`/c/${c.id}/admin`} className="btn-secondary">Manage (applications, photos, results)</Link>
          <Link to={`/c/${c.id}/edit`} className="btn-secondary">Edit competition</Link>
          {!upload_blocked && <Link to={`/c/${c.id}/upload`} className="btn">Upload photos</Link>}
        </div>
      ) : (
        c.status === 'published' && (
          <EntryPanel
            competitionId={c.id}
            signedIn={!!user}
            application={application}
            phase={phase}
            uploadBlocked={upload_blocked}
            used={my_counts.total}
            max={c.max_photos_per_person}
            onApplied={detail.reload}
          />
        )
      )}
      {c.status === 'draft' && <p className="card text-sm">This competition is a draft. Open "Edit competition" to publish it.</p>}

      {canVote && (
        <p className="text-sm text-stone-600" data-testid="likes-left">
          {c.max_likes_per_person === null
            ? 'You can like as many photos as you want (not your own).'
            : `You have ${Math.max(0, c.max_likes_per_person - likes_used)} like${c.max_likes_per_person - likes_used === 1 ? '' : 's'} left.`}
        </p>
      )}

      <CategoryTabs categories={categories} tab={tab} setTab={setTab} />
      {tab !== 'all' && categories.find((k) => k.id === tab)?.description && (
        <p className="text-sm text-stone-600">{categories.find((k) => k.id === tab)?.description}</p>
      )}

      <ErrorBox message={photos.error} />
      {!photos.data && !photos.error && <Loading />}
      {photos.data &&
        (c.results_published_at ? (
          <Results categories={categories.filter((k) => tab === 'all' || k.id === tab)} photos={shown} />
        ) : (
          <PhotoGrid photos={shown} canVote={canVote} onChange={reloadAll} />
        ))}
    </div>
  )
}

function CategoryTabs({ categories, tab, setTab }: { categories: Category[]; tab: number | 'all'; setTab: (t: number | 'all') => void }) {
  const tabs: { key: number | 'all'; label: string }[] = [{ key: 'all', label: 'All' }, ...categories.map((k) => ({ key: k.id, label: k.name }))]
  return (
    <div role="tablist" className="flex flex-wrap gap-2 border-b border-stone-200 pb-2">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={tab === t.key}
          onClick={() => setTab(t.key)}
          className={`rounded-full px-3 py-1 text-sm ${tab === t.key ? 'bg-stone-900 text-white' : 'bg-stone-200 text-stone-800 hover:bg-stone-300'}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

function EntryPanel(props: {
  competitionId: number
  signedIn: boolean
  application: CompetitionDetail['application']
  phase: string
  uploadBlocked: string | null
  used: number
  max: number
  onApplied: () => void
}) {
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const closed = props.phase === 'closed' || props.phase === 'results'

  if (!props.signedIn) {
    return (
      <div className="card flex flex-wrap items-center gap-3">
        <span className="text-sm">Want to enter? Sign in to apply.</span>
        <SignInLink />
      </div>
    )
  }
  if (props.application === null) {
    if (closed) return null
    return (
      <form
        className="card space-y-2"
        onSubmit={async (e) => {
          e.preventDefault()
          try {
            await api(`/competitions/${props.competitionId}/apply`, 'POST', { message })
            props.onApplied()
          } catch (err) {
            setError((err as Error).message)
          }
        }}
      >
        <label className="label" htmlFor="apply-message">Apply to enter this competition</label>
        <textarea id="apply-message" className="input" rows={2} placeholder="Message to the organiser (optional)" value={message} onChange={(e) => setMessage(e.target.value)} />
        <ErrorBox message={error} />
        <button className="btn">Apply</button>
      </form>
    )
  }
  return (
    <div className="card flex flex-wrap items-center gap-3">
      <span className="text-sm">
        Your application: <Badge>{props.application}</Badge>
      </span>
      {props.application === 'approved' && (
        <>
          <span className="text-sm text-stone-600">
            You have uploaded {props.used} of {props.max} photos.
          </span>
          {props.uploadBlocked ? (
            <span className="text-sm text-stone-600">{props.uploadBlocked}</span>
          ) : (
            <Link to={`/c/${props.competitionId}/upload`} className="btn">Upload photos</Link>
          )}
        </>
      )}
    </div>
  )
}

/** Ranking per category by total score: public likes + judge points (ties share a rank). */
function Results({ categories, photos }: { categories: Category[]; photos: PhotoSummary[] }) {
  return (
    <div className="space-y-8">
      {categories.map((cat) => {
        const ranked = photos
          .filter((p) => p.category_id === cat.id && !p.hidden)
          .sort((a, b) => (b.total_score ?? 0) - (a.total_score ?? 0) || a.id - b.id)
        return (
          <section key={cat.id} data-testid="results-category">
            <h2 className="mb-3 text-lg font-medium">{cat.name}</h2>
            {ranked.length === 0 && <p className="text-sm text-stone-500">No photos in this category.</p>}
            <ol className="space-y-2">
              {ranked.map((p) => {
                const rank = ranked.findIndex((q) => q.total_score === p.total_score) + 1
                return (
                  <li key={p.id} className="card flex items-center gap-3" data-testid="ranking-row">
                    <span className="w-8 text-center text-xl font-semibold text-stone-500">{rank}</span>
                    <Link to={`/p/${p.id}`}>
                      <img src={`/api/photos/${p.id}/thumb`} alt={p.title} className="h-16 w-24 rounded object-cover" />
                    </Link>
                    <div className="min-w-0 flex-1">
                      <Link to={`/p/${p.id}`} className="block truncate font-medium hover:underline">{p.title}</Link>
                      <p className="text-xs text-stone-500">by {p.uploader_name}</p>
                    </div>
                    {p.winner_label && <Badge tone="gold">{p.winner_label}</Badge>}
                    <div className="text-right text-sm">
                      <p className="font-medium">{p.total_score} point{p.total_score === 1 ? '' : 's'}</p>
                      <p className="text-xs text-stone-500">{p.vote_count} like{p.vote_count === 1 ? '' : 's'} + {p.judge_points} judge</p>
                    </div>
                  </li>
                )
              })}
            </ol>
          </section>
        )
      })}
    </div>
  )
}
