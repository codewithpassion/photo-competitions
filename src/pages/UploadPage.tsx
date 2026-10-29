import { useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { api, useLoad, useMe } from '../api'
import { fromLocalInput, toLocalInput } from '../format'
import { ImageProblem, processImage } from '../image'
import type { CompetitionDetail } from '../types'
import { ErrorBox, Loading, SignInPrompt } from '../ui'

interface Item {
  key: number
  fileName: string
  state: 'processing' | 'ready' | 'uploading' | 'done' | 'error'
  message: string | null
  full?: Blob
  thumb?: Blob
  previewUrl?: string
  title: string
  takenAt: string // datetime-local value, '' = unknown
  location: string
  latitude: number | null
  longitude: number | null
}

let nextKey = 1

export default function UploadPage() {
  const id = useParams().id!
  const { user, loading } = useMe()
  const detail = useLoad(() => api<CompetitionDetail>(`/competitions/${id}`), [id, user?.id])
  const [categoryId, setCategoryId] = useState<number | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [uploading, setUploading] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  if (loading || (!detail.data && !detail.error)) return <Loading />
  if (!user) return <SignInPrompt what="upload photos" />
  if (detail.error) return <ErrorBox message={detail.error} />
  const { competition: comp, categories, my_counts, upload_blocked } = detail.data!
  if (upload_blocked) return <ErrorBox message={upload_blocked} />

  const category = categories.find((k) => k.id === (categoryId ?? categories[0]?.id))!
  const usedTotal = my_counts.total
  const usedInCategory = my_counts.by_category[category.id] ?? 0
  const remainingTotal = comp.max_photos_per_person - usedTotal
  const remainingCategory = category.max_photos_per_person === null ? Infinity : category.max_photos_per_person - usedInCategory
  const remaining = Math.max(0, Math.min(remainingTotal, remainingCategory))
  const ready = items.filter((i) => i.state === 'ready')
  const readyCount = ready.length

  const patch = (key: number, p: Partial<Item>) => setItems((list) => list.map((i) => (i.key === key ? { ...i, ...p } : i)))

  async function addFiles(files: FileList | null) {
    if (!files) return
    for (const file of Array.from(files)) {
      const key = nextKey++
      const stem = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ')
      setItems((list) => [
        ...list,
        { key, fileName: file.name, state: 'processing', message: null, title: stem, takenAt: '', location: '', latitude: null, longitude: null },
      ])
      try {
        const r = await processImage(file)
        patch(key, {
          state: 'ready',
          full: r.full,
          thumb: r.thumb,
          previewUrl: r.previewUrl,
          takenAt: r.takenAt ? toLocalInput(r.takenAt) : '',
          latitude: r.latitude,
          longitude: r.longitude,
        })
      } catch (err) {
        patch(key, { state: 'error', message: err instanceof ImageProblem ? err.message : 'Could not read this image.' })
      }
    }
    if (input.current) input.current.value = ''
  }

  async function uploadAll() {
    setUploading(true)
    for (const item of items.filter((i) => i.state === 'ready')) {
      patch(item.key, { state: 'uploading', message: null })
      const form = new FormData()
      form.set('full', item.full!, 'full.jpg')
      form.set('thumb', item.thumb!, 'thumb.jpg')
      form.set('category_id', String(category.id))
      form.set('title', item.title)
      form.set('taken_at', item.takenAt ? fromLocalInput(item.takenAt) : '')
      form.set('location_name', item.location)
      form.set('latitude', item.latitude === null ? '' : String(item.latitude))
      form.set('longitude', item.longitude === null ? '' : String(item.longitude))
      try {
        await api(`/competitions/${id}/photos`, 'POST', form)
        patch(item.key, { state: 'done' })
      } catch (err) {
        patch(item.key, { state: 'ready', message: (err as Error).message })
        break // most likely a limit was hit: stop and let the user decide
      }
    }
    detail.reload()
    setUploading(false)
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Link to={`/c/${comp.id}`} className="text-sm text-stone-600 hover:underline">← {comp.title}</Link>
      <h1 className="text-2xl font-semibold">Upload photos</h1>

      <div className="card space-y-1 text-sm">
        <p>
          In this competition: <strong>{usedTotal} of {comp.max_photos_per_person}</strong> photos used.
        </p>
        {categories.map((k) => (
          <p key={k.id} className="text-stone-600">
            {k.name}: {my_counts.by_category[k.id] ?? 0}
            {k.max_photos_per_person !== null ? ` of ${k.max_photos_per_person}` : ''} used
          </p>
        ))}
      </div>

      <div>
        <label className="label" htmlFor="category">Category</label>
        <select id="category" className="input" value={category.id} onChange={(e) => setCategoryId(Number(e.target.value))}>
          {categories.map((k) => (
            <option key={k.id} value={k.id}>{k.name}</option>
          ))}
        </select>
        <p className="mt-1 text-xs text-stone-500">
          You can add {remaining === 0 ? 'no more photos' : `${remaining} more photo${remaining === 1 ? '' : 's'}`} to this category.
        </p>
      </div>

      <div>
        <label className="label" htmlFor="files">Photos (JPEG, PNG, WebP; at least 1080 px on the long side)</label>
        <input id="files" ref={input} type="file" accept="image/*" multiple className="input" onChange={(e) => addFiles(e.target.files)} />
      </div>

      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.key} className="card space-y-2" data-testid="upload-item">
            <div className="flex gap-3">
              <div className="h-20 w-28 shrink-0 overflow-hidden rounded bg-stone-200">
                {item.previewUrl && <img src={item.previewUrl} alt="" className="h-full w-full object-cover" />}
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                <p className="truncate text-xs text-stone-500">{item.fileName} · {item.state === 'ready' ? 'ready' : item.state}</p>
                {item.state !== 'error' && item.state !== 'processing' && (
                  <input className="input" aria-label="Title" placeholder="Title" value={item.title} disabled={item.state !== 'ready'} onChange={(e) => patch(item.key, { title: e.target.value })} />
                )}
              </div>
              {item.state !== 'uploading' && item.state !== 'done' && (
                <button type="button" className="btn-danger h-fit" onClick={() => setItems((l) => l.filter((i) => i.key !== item.key))}>Remove</button>
              )}
            </div>
            {item.state === 'ready' && (
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <label className="label">Date taken</label>
                  <input type="datetime-local" aria-label="Date taken" className="input" value={item.takenAt} onChange={(e) => patch(item.key, { takenAt: e.target.value })} />
                </div>
                <div>
                  <label className="label">Location name (optional)</label>
                  <input className="input" aria-label="Location name (optional)" value={item.location} onChange={(e) => patch(item.key, { location: e.target.value })} />
                </div>
                {item.latitude !== null && item.longitude !== null && (
                  <p className="text-xs text-stone-600 sm:col-span-2">
                    GPS from the photo: {item.latitude}, {item.longitude}{' '}
                    <button type="button" className="underline" onClick={() => patch(item.key, { latitude: null, longitude: null })}>
                      Remove GPS location
                    </button>
                  </p>
                )}
              </div>
            )}
            {item.state === 'done' && <p className="text-sm text-green-700">Uploaded.</p>}
            <ErrorBox message={item.message} />
          </li>
        ))}
      </ul>

      {readyCount > remaining && (
        <ErrorBox message={`You selected ${readyCount} photos but can only add ${remaining} more to this category. Remove some or pick another category.`} />
      )}
      <div className="flex items-center gap-3">
        <button className="btn" disabled={uploading || readyCount === 0 || readyCount > remaining || ready.some((i) => !i.title.trim())} onClick={uploadAll}>
          {uploading ? 'Uploading...' : `Upload ${readyCount || ''} photo${readyCount === 1 ? '' : 's'}`}
        </button>
        {items.some((i) => i.state === 'done') && <Link to={`/c/${comp.id}`} className="btn-secondary">Back to competition</Link>}
      </div>
    </div>
  )
}
