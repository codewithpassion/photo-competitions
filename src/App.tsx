import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { Link, Route, Routes, useNavigate } from 'react-router'
import { MeContext, api, useMe } from './api'
import type { User } from './types'
import { SignInLink } from './ui'
import Home from './pages/Home'
import MyCompetitions from './pages/MyCompetitions'
import CompetitionForm from './pages/CompetitionForm'
import CompetitionPage from './pages/CompetitionPage'
import UploadPage from './pages/UploadPage'
import AdminPage from './pages/AdminPage'
import PhotoPage from './pages/PhotoPage'

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const refresh = useCallback(() => {
    api<{ user: User | null }>('/me')
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false))
  }, [])
  useEffect(refresh, [refresh])

  return (
    <MeContext.Provider value={{ user, loading, refresh }}>
      <Header />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/my" element={<MyCompetitions />} />
          <Route path="/c/new" element={<CompetitionForm />} />
          <Route path="/c/:id/edit" element={<CompetitionForm />} />
          <Route path="/c/:id" element={<CompetitionPage />} />
          <Route path="/c/:id/upload" element={<UploadPage />} />
          <Route path="/c/:id/admin" element={<AdminPage />} />
          <Route path="/p/:id" element={<PhotoPage />} />
          <Route path="*" element={<p className="py-8 text-center">Page not found.</p>} />
        </Routes>
      </main>
    </MeContext.Provider>
  )
}

function Header() {
  const { user, loading, refresh } = useMe()
  const navigate = useNavigate()
  return (
    <header className="border-b border-stone-200 bg-white">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-3">
        <Link to="/" className="text-lg font-semibold">
          Photo Competitions
        </Link>
        <nav className="flex flex-wrap items-center gap-3 text-sm">
          {user && <Link to="/my">My competitions</Link>}
          {user ? (
            <>
              <span className="text-stone-600" data-testid="user-name">
                {user.name}
              </span>
              <button
                className="btn-secondary"
                onClick={async () => {
                  await api('/auth/logout', 'POST')
                  refresh()
                  navigate('/')
                }}
              >
                Sign out
              </button>
            </>
          ) : (
            !loading && (
              <>
                <SignInLink />
                {import.meta.env.DEV && <DevLogin onDone={refresh} />}
              </>
            )
          )}
        </nav>
      </div>
    </header>
  )
}

/** Local development only: sign in without Google. Not included in production builds. */
function DevLogin({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('dev@example.com')
  async function submit(e: FormEvent) {
    e.preventDefault()
    await api('/auth/dev-login', 'POST', { email, name: email.split('@')[0] })
    onDone()
  }
  return (
    <form onSubmit={submit} className="flex gap-1">
      <input className="input w-44" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Dev email" />
      <button className="btn-secondary">Dev login</button>
    </form>
  )
}
