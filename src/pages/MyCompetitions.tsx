import { Link } from 'react-router'
import { api, useLoad, useMe } from '../api'
import { fmtDateTime, phaseOf } from '../format'
import { ErrorBox, Loading, PhaseBadge, SignInPrompt } from '../ui'

interface Item {
  id: number
  title: string
  status: 'draft' | 'published'
  submissions_open_at: string
  submissions_close_at: string
  results_published_at: string | null
  application_status?: string
}

function List({ items, empty }: { items: Item[]; empty: string }) {
  if (!items.length) return <p className="text-sm text-stone-500">{empty}</p>
  return (
    <ul className="space-y-2">
      {items.map((c) => (
        <li key={c.id} className="card flex flex-wrap items-center justify-between gap-2">
          <div>
            <Link to={`/c/${c.id}`} className="font-medium hover:underline">
              {c.title}
            </Link>
            <p className="text-xs text-stone-500">Closes {fmtDateTime(c.submissions_close_at)}</p>
          </div>
          <div className="flex items-center gap-2">
            {c.application_status && <span className="text-xs text-stone-600">Application: {c.application_status}</span>}
            <PhaseBadge phase={phaseOf(c)} />
          </div>
        </li>
      ))}
    </ul>
  )
}

export default function MyCompetitions() {
  const { user, loading } = useMe()
  const { data, error } = useLoad(() => (user ? api<{ admin: Item[]; entered: Item[] }>('/my') : Promise.resolve(null)), [user?.id])
  if (loading) return <Loading />
  if (!user) return <SignInPrompt what="see your competitions" />
  return (
    <div className="space-y-8">
      <ErrorBox message={error} />
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Competitions I run</h1>
          <Link to="/c/new" className="btn">
            Create competition
          </Link>
        </div>
        {data ? <List items={data.admin} empty="You haven't created a competition yet." /> : <Loading />}
      </section>
      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Competitions I entered</h2>
        {data ? <List items={data.entered} empty="You haven't applied to any competition yet." /> : <Loading />}
      </section>
    </div>
  )
}
