import { type FormEvent, useState } from 'react'
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

function NameForm() {
  const { user, refresh } = useMe()
  const [name, setName] = useState(user?.name ?? '')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  async function save(e: FormEvent) {
    e.preventDefault()
    setMessage(null)
    setError(null)
    try {
      await api('/me', 'PATCH', { name })
      await refresh()
      setMessage('Saved.')
    } catch (err) {
      setError((err as Error).message)
    }
  }
  return (
    <form onSubmit={save} className="card space-y-2">
      <label className="label" htmlFor="display-name">
        Your name (shown with your photos and comments)
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input id="display-name" className="input max-w-xs" required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn-secondary">Save name</button>
        {message && <span className="text-sm text-green-700">{message}</span>}
      </div>
      <ErrorBox message={error} />
      <p className="text-xs text-stone-500">Signed in as {user?.email}</p>
    </form>
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
      <NameForm />
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
