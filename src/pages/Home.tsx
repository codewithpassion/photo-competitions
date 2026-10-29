import { Link } from 'react-router'
import { api, useLoad, useMe } from '../api'
import { fmtDateTime, phaseOf } from '../format'
import { ErrorBox, Loading, PhaseBadge } from '../ui'

interface Item {
  id: number
  title: string
  admin_name: string
  submissions_open_at: string
  submissions_close_at: string
  results_published_at: string | null
  cover_photo_id: number | null
}

export default function Home() {
  const { user } = useMe()
  const { data, error } = useLoad(() => api<{ competitions: Item[] }>('/competitions'), [])
  const params = new URLSearchParams(location.search)
  const loginError = params.get('login_error')

  const groups = [
    { title: 'Open now', phases: ['open'] },
    { title: 'Upcoming', phases: ['upcoming'] },
    { title: 'Closed', phases: ['closed', 'results'] },
  ]

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Photo competitions</h1>
        <Link to="/c/new" className="btn">
          Create competition
        </Link>
      </div>
      <ErrorBox message={loginError} />
      <ErrorBox message={error} />
      {!data && !error && <Loading />}
      {data && data.competitions.length === 0 && (
        <p className="text-stone-600">No competitions yet.{user ? ' Create the first one!' : ' Sign in to create one.'}</p>
      )}
      {data &&
        groups.map((g) => {
          const items = data.competitions.filter((c) => g.phases.includes(phaseOf(c)))
          if (!items.length) return null
          return (
            <section key={g.title}>
              <h2 className="mb-3 text-lg font-medium">{g.title}</h2>
              <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((c) => (
                  <li key={c.id} className="overflow-hidden rounded-lg border border-stone-200 bg-white">
                    <Link to={`/c/${c.id}`} className="block">
                      <div className="aspect-[16/9] bg-stone-200">
                        {c.cover_photo_id && (
                          <img src={`/api/photos/${c.cover_photo_id}/thumb`} alt="" className="h-full w-full object-cover" />
                        )}
                      </div>
                      <div className="space-y-1 p-4">
                        <PhaseBadge phase={phaseOf(c)} />
                        <h3 className="font-medium">{c.title}</h3>
                        <p className="text-xs text-stone-500">
                          Submissions close {fmtDateTime(c.submissions_close_at)} · run by {c.admin_name}
                        </p>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
    </div>
  )
}
