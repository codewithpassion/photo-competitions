import type { Competition } from './types'

export const fmtDateTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ''

/** ISO (UTC) -> value for <input type="datetime-local"> in the browser's local time. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Value from <input type="datetime-local"> (local time) -> ISO UTC string. */
export const fromLocalInput = (value: string) => new Date(value).toISOString()

export type Phase = 'draft' | 'upcoming' | 'open' | 'closed' | 'results'

export function phaseOf(c: Pick<Competition, 'submissions_open_at' | 'submissions_close_at' | 'results_published_at'> & { status?: string }): Phase {
  const now = new Date().toISOString()
  if (c.status === 'draft') return 'draft'
  if (c.results_published_at) return 'results'
  if (now < c.submissions_open_at) return 'upcoming'
  if (now < c.submissions_close_at) return 'open'
  return 'closed'
}

export const phaseLabel: Record<Phase, string> = {
  draft: 'Draft',
  upcoming: 'Upcoming',
  open: 'Open now',
  closed: 'Closed - judging',
  results: 'Results published',
}
