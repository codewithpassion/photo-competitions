import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { api, useMe } from '../api'
import type { User } from '../types'
import { ErrorBox } from '../ui'

/** Only same-site paths, and never bounce back to a login page. */
export function cleanReturnTo(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/login')) return '/'
  return value
}

/** Step 1: email. Step 2: the 6-digit code (or the link in the same email). */
export default function LoginPage() {
  const { user, refresh } = useMe()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const returnTo = cleanReturnTo(params.get('returnTo'))
  const [email, setEmail] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (user && !sentTo) {
    return (
      <div className="card mx-auto max-w-sm space-y-3 text-center">
        <p>You're signed in as {user.email}.</p>
        <Link to={returnTo} className="btn">
          Continue
        </Link>
      </div>
    )
  }

  async function sendCode(address: string) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await api('/auth/email/start', 'POST', { email: address, returnTo })
      setSentTo(address.trim().toLowerCase())
      setCode('')
      return true
    } catch (e) {
      setError((e as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }

  async function submitEmail(e: FormEvent) {
    e.preventDefault()
    await sendCode(email)
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await api<{ returnTo: string }>('/auth/email/verify', 'POST', { email: sentTo, code })
      await refresh()
      navigate(cleanReturnTo(res.returnTo), { replace: true })
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  if (!sentTo) {
    return (
      <form onSubmit={submitEmail} className="card mx-auto max-w-sm space-y-4">
        <h1 className="text-xl font-semibold">Sign in</h1>
        <p className="text-sm text-stone-600">Enter your email and we'll send you a code. No password needed.</p>
        <ErrorBox message={error} />
        <div>
          <label className="label" htmlFor="login-email">
            Email
          </label>
          <input
            id="login-email"
            className="input"
            type="email"
            autoComplete="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <button className="btn w-full" disabled={busy}>
          {busy ? 'Sending...' : 'Email me a code'}
        </button>
      </form>
    )
  }

  return (
    <form onSubmit={submitCode} className="card mx-auto max-w-sm space-y-4">
      <h1 className="text-xl font-semibold">We've emailed you a 6-digit code</h1>
      <p className="text-sm text-stone-600">
        We sent it to <strong>{sentTo}</strong>. Type it below, or click the button in the email. It works for 15 minutes.
      </p>
      <ErrorBox message={error} />
      {notice && <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">{notice}</p>}
      <div>
        <label className="label" htmlFor="login-code">
          6-digit code
        </label>
        <input
          id="login-code"
          className="input text-center text-2xl tracking-[0.4em]"
          autoComplete="one-time-code"
          inputMode="numeric"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        />
      </div>
      <button className="btn w-full" disabled={busy || code.length !== 6}>
        {busy ? 'Checking...' : 'Sign in'}
      </button>
      <p className="flex flex-wrap justify-between gap-2 text-sm">
        <button
          type="button"
          className="underline"
          disabled={busy}
          onClick={async () => {
            if (await sendCode(sentTo)) setNotice('We sent you a new code.')
          }}
        >
          Resend code
        </button>
        <button
          type="button"
          className="underline"
          onClick={() => {
            setSentTo(null)
            setError(null)
            setNotice(null)
          }}
        >
          Use a different email
        </button>
      </p>
    </form>
  )
}

/** The page the email's button opens. It POSTs the token, so mail scanners that only GET the link don't use it up. */
export function VerifyLinkPage() {
  const { refresh } = useMe()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    api<{ user: User; returnTo: string }>('/auth/email/verify-link', 'POST', { token: params.get('token') ?? '' }).then(
      async (res) => {
        await refresh()
        navigate(cleanReturnTo(res.returnTo), { replace: true })
      },
      (e: Error) => setError(e.message),
    )
  }, [params, refresh, navigate])

  if (error) {
    return (
      <div className="card mx-auto max-w-sm space-y-3">
        <ErrorBox message={error} />
        <Link to="/login" className="btn">
          Get a new code
        </Link>
      </div>
    )
  }
  return <p className="py-8 text-center text-sm text-stone-500">Signing you in...</p>
}

/** Shown to new accounts (and anyone without a name) before they can carry on. */
export function NameStep() {
  const { user, refresh } = useMe()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api('/me', 'PATCH', { name })
      await refresh()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit} className="card mx-auto max-w-sm space-y-4">
      <h1 className="text-xl font-semibold">What should we call you?</h1>
      <p className="text-sm text-stone-600">Your name is shown next to your photos and comments. You can change it later on "My competitions".</p>
      <ErrorBox message={error} />
      <div>
        <label className="label" htmlFor="your-name">
          Your name
        </label>
        <input id="your-name" className="input" required autoFocus maxLength={60} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <button className="btn w-full" disabled={busy || !name.trim()}>
        Continue
      </button>
      <p className="text-xs text-stone-500">Signed in as {user?.email}</p>
    </form>
  )
}
