import { type ReactNode, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { api, useMe } from './api'
import { type Phase, phaseLabel } from './format'
import type { PhotoSummary } from './types'

export const ErrorBox = ({ message }: { message: string | null }) =>
  message ? (
    <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      {message}
    </p>
  ) : null

export const Loading = () => <p className="py-8 text-center text-sm text-stone-500">Loading...</p>

const phaseColors: Record<Phase, string> = {
  draft: 'bg-stone-200 text-stone-700',
  upcoming: 'bg-amber-100 text-amber-800',
  open: 'bg-green-100 text-green-800',
  closed: 'bg-stone-200 text-stone-700',
  results: 'bg-indigo-100 text-indigo-800',
}
export const PhaseBadge = ({ phase }: { phase: Phase }) => (
  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${phaseColors[phase]}`}>{phaseLabel[phase]}</span>
)

export const Badge = ({ children, tone = 'stone' }: { children: ReactNode; tone?: 'stone' | 'gold' | 'red' }) => (
  <span
    className={`rounded px-2 py-0.5 text-xs font-medium ${
      tone === 'gold' ? 'bg-amber-200 text-amber-900' : tone === 'red' ? 'bg-red-100 text-red-800' : 'bg-stone-200 text-stone-700'
    }`}
  >
    {children}
  </span>
)

/** Shown instead of a page that needs an account. */
export function SignInPrompt({ what }: { what: string }) {
  return (
    <div className="card text-center">
      <p className="mb-3">Please sign in to {what}.</p>
      <SignInLink />
    </div>
  )
}

export function SignInLink({ className = 'btn' }: { className?: string }) {
  const { pathname, search } = useLocation()
  const back = pathname.startsWith('/login') ? '/' : pathname + search
  return (
    <Link className={className} to={`/login?returnTo=${encodeURIComponent(back)}`}>
      Sign in
    </Link>
  )
}

export function LikeButton({ photo, onChange }: { photo: { id: number; liked_by_me: boolean }; onChange: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { user } = useMe()
  if (!user) return null
  return (
    <span className="inline-flex flex-col items-end gap-1">
    <button
      type="button"
      disabled={busy}
      aria-pressed={photo.liked_by_me}
      aria-label={photo.liked_by_me ? 'Unlike' : 'Like'}
      className={`rounded-full border px-3 py-1 text-sm ${photo.liked_by_me ? 'border-rose-300 bg-rose-50 text-rose-700' : 'border-stone-300 bg-white text-stone-700 hover:bg-stone-100'}`}
      onClick={async (e) => {
        e.preventDefault()
        setBusy(true)
        setError(null)
        try {
          await api(`/photos/${photo.id}/like`, photo.liked_by_me ? 'DELETE' : 'POST')
          onChange()
        } catch (err) {
          setError((err as Error).message)
        } finally {
          setBusy(false)
        }
      }}
    >
      {photo.liked_by_me ? '♥ Liked' : '♡ Like'}
    </button>
    {error && <span role="alert" className="max-w-48 text-right text-xs text-red-700">{error}</span>}
    </span>
  )
}

/** Thumbnail grid. `canVote` shows a like button on each photo that is not the viewer's own. */
export function PhotoGrid({ photos, canVote, onChange }: { photos: PhotoSummary[]; canVote: boolean; onChange: () => void }) {
  if (!photos.length) return <p className="py-8 text-center text-stone-500">No photos yet.</p>
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {photos.map((p) => (
        <li key={p.id} className="overflow-hidden rounded-lg border border-stone-200 bg-white" data-testid="photo-card">
          <Link to={`/p/${p.id}`} className="block">
            <div className="relative aspect-[4/3] bg-stone-200">
              <img src={`/api/photos/${p.id}/thumb`} alt={p.title} loading="lazy" className="h-full w-full object-cover" />
              <div className="absolute left-1 top-1 flex flex-wrap gap-1">
                {p.winner_label && <Badge tone="gold">{p.winner_label}</Badge>}
                {p.hidden && <Badge tone="red">Hidden by moderator</Badge>}
              </div>
            </div>
            <div className="px-3 pt-2">
              <p className="truncate text-sm font-medium">{p.title}</p>
              <p className="truncate text-xs text-stone-500">by {p.uploader_name}</p>
            </div>
          </Link>
          <div className="flex items-center justify-between px-3 pb-2 pt-1 text-xs text-stone-500">
            <span>{p.vote_count !== undefined ? `${p.vote_count} like${p.vote_count === 1 ? '' : 's'}` : `${p.comment_count} comment${p.comment_count === 1 ? '' : 's'}`}</span>
            {canVote && !p.is_mine && !p.hidden && <LikeButton photo={p} onChange={onChange} />}
          </div>
        </li>
      ))}
    </ul>
  )
}
