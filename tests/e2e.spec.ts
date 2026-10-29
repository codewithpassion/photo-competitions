import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import sharp from 'sharp'
import { makePhoto, makePng } from './fixtures'

const BASE = `http://localhost:5199`
const run = Math.random().toString(36).slice(2, 8) // keeps data unique between runs
const email = (who: string) => `${who}-${run}@example.com`

/** datetime-local value (browser local time) for now + hours. */
function localInput(hoursFromNow: number) {
  const d = new Date(Date.now() + hoursFromNow * 3600_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

async function signIn(browser: Browser, who: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL: BASE })
  const page = await ctx.newPage()
  page.on('dialog', (d) => d.accept())
  const res = await page.request.post('/api/auth/dev-login', { headers: { origin: BASE }, data: { email: email(who), name: who } })
  expect(res.ok()).toBeTruthy()
  await page.goto('/')
  await expect(page.getByTestId('user-name')).toHaveText(who)
  return { ctx, page }
}

/** Call the JSON API from a page (sends the right Origin header and the page's cookies). */
async function call(page: Page, method: string, path: string, data?: unknown) {
  const res = await page.request.fetch(`/api${path}`, { method, headers: { origin: BASE, 'content-type': 'application/json' }, data: data ?? {} })
  return { status: res.status(), body: await res.json().catch(() => ({})) }
}

/** Upload straight to the API, bypassing the browser UI, to test server-side rules. */
async function rawUpload(page: Page, compId: string, categoryId: number, full: Buffer, thumb: Buffer, title = 'API upload') {
  const res = await page.request.post(`/api/competitions/${compId}/photos`, {
    headers: { origin: BASE },
    multipart: {
      category_id: String(categoryId),
      title,
      full: { name: 'full.jpg', mimeType: 'image/jpeg', buffer: full },
      thumb: { name: 'thumb.jpg', mimeType: 'image/jpeg', buffer: thumb },
    },
  })
  return { status: res.status(), body: await res.json().catch(() => ({})) }
}

test('full competition lifecycle', async ({ browser }) => {
  const good1 = await makePhoto({ width: 2400, height: 1600, hue: 20, exif: true }) // needs resizing, has EXIF
  const good2 = await makePhoto({ width: 1600, height: 1200, hue: 120 })
  const good3 = await makePhoto({ width: 1200, height: 1800, hue: 200 }) // portrait
  const tiny = await makePhoto({ width: 800, height: 600, hue: 300 })
  const png = await makePng(1500, 1000)
  const apiFull = await sharp(good2).resize({ width: 1600 }).jpeg().toBuffer()
  const apiThumb = await sharp(good2).resize({ width: 480 }).jpeg().toBuffer()
  const file = (name: string, buffer: Buffer, mimeType = 'image/jpeg') => ({ name, mimeType, buffer })

  // ---- 1. Admin A creates a competition with two categories and limits, then publishes it.
  const A = await signIn(browser, 'Alice')
  await A.page.goto('/c/new')
  await A.page.getByLabel('Title', { exact: true }).fill(`Spring walk ${run}`)
  await A.page.getByLabel('Description', { exact: true }).fill('Line one\nLine two')
  await A.page.getByLabel('Submissions open', { exact: true }).fill(localInput(-48))
  await A.page.getByLabel('Submissions close (judging date)').fill(localInput(24 * 7))
  await A.page.getByLabel('Photos allowed per person (whole competition)').fill('3')
  await A.page.locator('#likes').fill('2') // each person gets 2 likes
  await A.page.getByLabel('Category name').first().fill('Landscape')
  await A.page.getByLabel('Category limit per person').first().fill('2')
  await A.page.getByRole('button', { name: 'Add category' }).click()
  await A.page.getByLabel('Category name').nth(1).fill('Portrait')
  await A.page.getByRole('button', { name: 'Create competition' }).last().click()
  await expect(A.page).toHaveURL(/\/c\/\d+\/edit$/)
  const compId = A.page.url().match(/\/c\/(\d+)\/edit/)![1]

  // Drafts are invisible to everyone but the admin.
  const anon = await browser.newContext({ baseURL: BASE })
  const anonPage = await anon.newPage()
  expect((await anonPage.request.get(`/api/competitions/${compId}`)).status()).toBe(404)
  const publicList = (await (await anonPage.request.get('/api/competitions')).json()).competitions
  expect(publicList.some((c: { id: number }) => c.id === Number(compId))).toBe(false)

  await A.page.getByRole('button', { name: 'Publish competition' }).click()
  await expect(A.page.getByText('Status: Published')).toBeVisible()
  await A.page.goto(`/c/${compId}`)
  await expect(A.page.getByRole('heading', { name: `Spring walk ${run}` })).toBeVisible()
  await expect(A.page.getByText('Open now')).toBeVisible()
  await expect(A.page.getByRole('tab', { name: 'Landscape' })).toBeVisible()
  const detail = (await call(A.page, 'GET', `/competitions/${compId}`)).body
  expect(detail.competition.max_likes_per_person).toBe(2)
  const landscape = detail.categories.find((k: { name: string }) => k.name === 'Landscape').id
  const portrait = detail.categories.find((k: { name: string }) => k.name === 'Portrait').id

  // Published competitions are public, with line breaks kept.
  await anonPage.goto(`/c/${compId}`)
  await expect(anonPage.getByText('Line two')).toBeVisible()
  await expect(anonPage.getByRole('link', { name: 'Sign in' }).first()).toBeVisible()

  // ---- 2. B applies; can't upload until approved.
  const B = await signIn(browser, 'Bob')
  await B.page.goto(`/c/${compId}`)
  expect((await rawUpload(B.page, compId, landscape, apiFull, apiThumb)).status).toBe(403)
  await B.page.getByPlaceholder('Message to the organiser (optional)').fill('Please let me in')
  await B.page.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(B.page.getByText('Your application:')).toContainText('pending')

  // ---- 3. Admin approves.
  await A.page.goto(`/c/${compId}/admin`)
  await expect(A.page.getByTestId('application')).toContainText('Please let me in')
  await A.page.getByRole('button', { name: 'Approve' }).click()
  await expect(A.page.getByTestId('application')).toContainText('approved')

  // ---- 4. B uploads through the browser: EXIF prefill, resize, too-small rejection.
  await B.page.goto(`/c/${compId}/upload`)
  await B.page.setInputFiles('#files', [file('sunrise_hill.jpg', good1), file('creek.jpg', good2), file('tiny.jpg', tiny)])
  await expect(B.page.getByTestId('upload-item')).toHaveCount(3)
  await expect(B.page.getByText('too small')).toBeVisible()
  const first = B.page.getByTestId('upload-item').first()
  await expect(first.getByLabel('Title')).toHaveValue('sunrise hill') // default title from filename
  await expect(first.locator('input[type=datetime-local]')).toHaveValue('2024-03-15T10:30') // from EXIF
  await expect(first.getByText('GPS from the photo: -33.8569')).toBeVisible()
  await first.getByLabel('Title').fill('Sunrise over the hill')
  await first.getByLabel('Location name (optional)').fill('Hill lookout')
  await B.page.getByRole('button', { name: /^Upload 2 photos$/ }).click()
  await expect(B.page.getByText('Uploaded.')).toHaveCount(2)

  // The stored image was resized to <= 1920 px and carries the EXIF-derived location.
  let photos = (await call(B.page, 'GET', `/competitions/${compId}/photos`)).body.photos
  expect(photos).toHaveLength(2)
  const sunrise = photos.find((p: { title: string }) => p.title === 'Sunrise over the hill')
  expect(Math.max(sunrise.width, sunrise.height)).toBe(1920)
  const sunriseDetail = (await call(B.page, 'GET', `/photos/${sunrise.id}`)).body
  expect(sunriseDetail.latitude).toBeCloseTo(-33.857, 2)
  expect(sunriseDetail.location_name).toBe('Hill lookout')
  await B.page.goto(`/p/${sunrise.id}`)
  await expect(B.page.getByRole('link', { name: 'Open in map' })).toHaveAttribute('href', /openstreetmap\.org\/\?mlat=-33\.85\d+&mlon=151\.21\d+/)

  // Category limit (2) is enforced by the server, and the UI shows nothing left.
  expect((await rawUpload(B.page, compId, landscape, apiFull, apiThumb)).body.error).toMatch(/limit of 2 photos in "Landscape"/)
  await B.page.goto(`/c/${compId}/upload`)
  await expect(B.page.getByText('You can add no more photos to this category.')).toBeVisible()
  await B.page.setInputFiles('#files', [file('four.png', png, 'image/png')])
  await expect(B.page.getByText('You selected 1 photos but can only add 0 more')).toBeVisible()
  await expect(B.page.getByRole('button', { name: /^Upload/ })).toBeDisabled()
  await B.page.getByRole('button', { name: 'Remove' }).click()

  // Portrait category (no own limit): a PNG is converted to JPEG in the browser, giving B 3 of 3.
  await B.page.getByLabel('Category', { exact: true }).selectOption(String(portrait))
  await B.page.setInputFiles('#files', [file('portrait.png', png, 'image/png')])
  await expect(B.page.getByText('portrait.png · ready')).toBeVisible()
  await B.page.getByRole('button', { name: /^Upload 1 photo$/ }).click()
  await expect(B.page.getByText('Uploaded.')).toBeVisible()

  // Competition-wide limit (3) is enforced by the server.
  expect((await rawUpload(B.page, compId, portrait, apiFull, apiThumb)).body.error).toMatch(/limit of 3 photos for this competition/)
  // Uploader deletes their own photo; the freed slot can be used again. Bad files are rejected.
  photos = (await call(B.page, 'GET', `/competitions/${compId}/photos`)).body.photos
  const pngPhoto = photos.find((p: { title: string }) => p.title === 'portrait')
  expect(pngPhoto).toBeTruthy()
  expect((await call(B.page, 'DELETE', `/photos/${pngPhoto.id}`)).status).toBe(200)
  const smallFull = await sharp(tiny).jpeg().toBuffer()
  expect((await rawUpload(B.page, compId, portrait, smallFull, apiThumb)).body.error).toMatch(/too small/)
  expect((await rawUpload(B.page, compId, portrait, Buffer.from('not a jpeg at all'), apiThumb)).body.error).toMatch(/JPEG/)
  const portraitBuf = await sharp(good3).resize({ height: 1800 }).jpeg().toBuffer()
  expect((await rawUpload(B.page, compId, portrait, portraitBuf, apiThumb, 'Tall tree')).status).toBe(201)

  photos = (await call(B.page, 'GET', `/competitions/${compId}/photos`)).body.photos
  expect(photos).toHaveLength(3)
  const byTitle = (t: string) => photos.find((p: { title: string }) => p.title === t)
  const creek = byTitle('creek')
  const tree = byTitle('Tall tree')

  // ---- 5. C likes and comments; counts stay hidden from everyone but the admin.
  const C = await signIn(browser, 'Carol')
  await C.page.goto(`/c/${compId}`)
  await expect(C.page.getByTestId('photo-card')).toHaveCount(3)
  await C.page.goto(`/p/${sunrise.id}`)
  await C.page.getByRole('button', { name: 'Like', exact: true }).click()
  await expect(C.page.getByRole('button', { name: 'Unlike' })).toBeVisible()
  await C.page.getByLabel('Add a comment').fill('Gorgeous light!')
  await C.page.getByRole('button', { name: 'Post comment' }).click()
  await expect(C.page.getByTestId('comment')).toContainText('Carol')
  await expect(C.page.getByTestId('comment')).toContainText('Gorgeous light!')
  await expect(C.page.getByTestId('vote-count')).toHaveCount(0)
  // Like toggles off and on.
  await C.page.getByRole('button', { name: 'Unlike' }).click()
  await expect(C.page.getByRole('button', { name: 'Like', exact: true })).toBeVisible()
  await C.page.getByRole('button', { name: 'Like', exact: true }).click()
  await expect(C.page.getByRole('button', { name: 'Unlike' })).toBeVisible()

  // Like limit (2 per person): the second like works, the third is refused, unliking gives a like back.
  await C.page.goto(`/c/${compId}`)
  await expect(C.page.getByTestId('likes-left')).toHaveText('You have 1 like left.')
  expect((await call(C.page, 'POST', `/photos/${creek.id}/like`)).status).toBe(200)
  const over = await call(C.page, 'POST', `/photos/${tree.id}/like`)
  expect(over.status).toBe(409)
  expect(over.body.error).toMatch(/used all 2 of your likes/)
  await C.page.reload()
  await expect(C.page.getByTestId('likes-left')).toHaveText('You have 0 likes left.')
  expect((await call(C.page, 'DELETE', `/photos/${creek.id}/like`)).body.likes_left).toBe(1)
  await C.page.reload()
  await expect(C.page.getByTestId('likes-left')).toHaveText('You have 1 like left.')

  // Counts and judge points stay secret before results: not for C, B (the photographer) or the public...
  for (const page of [C.page, B.page, anonPage]) {
    const list = (await call(page, 'GET', `/competitions/${compId}/photos`)).body.photos
    expect(JSON.stringify(list)).not.toMatch(/vote|likes|judge|score/)
    const one = (await call(page, 'GET', `/photos/${sunrise.id}`)).body
    expect(Object.keys(one).filter((k) => /^(vote_count|like_count|judge_points|total_score)$/.test(k))).toEqual([])
  }
  expect((await call(C.page, 'GET', `/photos/${sunrise.id}/judge-votes`)).status).toBe(403)
  expect((await call(C.page, 'POST', `/photos/${sunrise.id}/judge-votes`, { judge_name: 'x', points: 1 })).status).toBe(403)
  // ...but the admin sees the like counts at any time.
  const adminList = (await call(A.page, 'GET', `/competitions/${compId}/photos`)).body.photos
  expect(adminList.find((p: { id: number }) => p.id === sunrise.id)).toMatchObject({ vote_count: 1, judge_points: 0, total_score: 1 })
  expect(adminList.find((p: { id: number }) => p.id === creek.id)).toMatchObject({ vote_count: 0 })
  await A.page.goto(`/p/${sunrise.id}`)
  await expect(A.page.getByTestId('vote-count')).toContainText('1 like')

  // Can't like your own photo; anonymous can't like. Anonymous visitors can read photos and comments.
  expect((await call(B.page, 'POST', `/photos/${sunrise.id}/like`)).status).toBe(403)
  expect((await call(anonPage, 'POST', `/photos/${sunrise.id}/like`)).status).toBe(401)
  await anonPage.goto(`/p/${sunrise.id}`)
  await expect(anonPage.getByText('Gorgeous light!')).toBeVisible()
  // Over-long comments are rejected.
  expect((await call(C.page, 'POST', `/photos/${sunrise.id}/comments`, { body: 'x'.repeat(1001) })).status).toBe(400)

  // ---- 6. Admin hides a photo.
  await A.page.goto(`/c/${compId}/admin`)
  const row = A.page.getByTestId('admin-photo').filter({ hasText: 'Tall tree' })
  await row.getByRole('button', { name: 'Hide' }).click()
  await expect(row.getByText('Hidden by moderator')).toBeVisible()
  await C.page.goto(`/c/${compId}`)
  await expect(C.page.getByTestId('photo-card')).toHaveCount(2)
  expect((await call(C.page, 'GET', `/photos/${tree.id}`)).status).toBe(404)
  expect((await C.page.request.get(`/api/photos/${tree.id}/full`)).status()).toBe(404)
  await B.page.goto(`/c/${compId}`)
  await expect(B.page.getByTestId('photo-card')).toHaveCount(3)
  await expect(B.page.getByText('Hidden by moderator')).toBeVisible()
  expect((await B.page.request.get(`/api/photos/${tree.id}/full`)).status()).toBe(200)

  // Judge votes: the admin adds, edits and removes points for external judges on the admin page.
  await A.page.goto(`/c/${compId}/admin`)
  const creekRow = A.page.getByTestId('admin-photo').filter({ hasText: 'creek' })
  await expect(creekRow.getByTestId('scores')).toContainText('0 likes + 0 judge = 0 total')
  await creekRow.getByRole('button', { name: 'Judge votes' }).click()
  const panel = creekRow.getByTestId('judge-panel')
  await panel.getByLabel('Judge name').last().fill('Ms Judge')
  await panel.getByLabel('Points').last().fill('5')
  await panel.getByRole('button', { name: 'Add judge points' }).click()
  await expect(panel.getByTestId('judge-row')).toHaveCount(1)
  await panel.getByTestId('judge-row').first().getByLabel('Points').fill('3') // edit 5 -> 3
  await panel.getByTestId('judge-row').first().getByRole('button', { name: 'Save' }).click()
  await panel.getByLabel('Judge name').last().fill('Mr Judge')
  await panel.getByLabel('Points').last().fill('1')
  await panel.getByRole('button', { name: 'Add judge points' }).click()
  await expect(creekRow.getByTestId('scores')).toContainText('0 likes + 4 judge = 4 total')
  await panel.getByTestId('judge-row').last().getByRole('button', { name: 'Remove' }).click() // remove Mr Judge...
  await expect(creekRow.getByTestId('scores')).toContainText('0 likes + 3 judge = 3 total')
  await panel.getByLabel('Judge name').last().fill('Mr Judge') // ...and add him back
  await panel.getByLabel('Points').last().fill('1')
  await panel.getByRole('button', { name: 'Add judge points' }).click()
  await expect(creekRow.getByTestId('scores')).toContainText('0 likes + 4 judge = 4 total')
  expect((await call(B.page, 'GET', `/competitions/${compId}/photos`)).body.photos.find((p: { id: number }) => p.id === creek.id).total_score).toBeUndefined()

  // Admin can hide a comment; others no longer see it.
  await A.page.goto(`/p/${sunrise.id}`)
  await A.page.getByTestId('comment').getByRole('button', { name: 'Hide' }).click()
  await expect(A.page.getByText('Hidden by moderator').first()).toBeVisible()
  await anonPage.goto(`/p/${sunrise.id}`)
  await expect(anonPage.getByText('No comments yet.')).toBeVisible()
  await A.page.getByTestId('comment').getByRole('button', { name: 'Unhide' }).click()

  // ---- 7. Results: not before the close date; then move the close date into the past via edit.
  expect((await call(A.page, 'POST', `/competitions/${compId}/results`)).status).toBe(400)
  expect((await call(B.page, 'POST', `/competitions/${compId}/results`)).status).toBe(403)
  await A.page.goto(`/c/${compId}/edit`)
  await A.page.getByLabel('Submissions open', { exact: true }).fill(localInput(-72))
  await A.page.getByLabel('Submissions close (judging date)').fill(localInput(-1))
  await A.page.getByRole('button', { name: 'Save changes' }).click()
  await expect(A.page).toHaveURL(new RegExp(`/c/${compId}$`))
  await expect(A.page.getByText('Closed - judging')).toBeVisible()
  // Submissions are closed now, even for the admin.
  expect((await rawUpload(A.page, compId, landscape, apiFull, apiThumb)).body.error).toMatch(/closed/)

  await A.page.goto(`/c/${compId}/admin`)
  await A.page.getByRole('button', { name: 'Publish results' }).click()
  await expect(A.page.getByText('Voting is closed')).toBeVisible()
  // Winner label on creek.
  const winRow = A.page.getByTestId('admin-photo').filter({ hasText: 'creek' })
  await expect(winRow.getByTestId('scores')).toContainText('0 likes + 4 judge = 4 total')
  await winRow.getByLabel('Winner label').fill('1st')
  await winRow.getByRole('button', { name: 'Save', exact: true }).first().click()

  // Ranking visible to everyone, by likes + judge points: creek (0 + 4) beats Sunrise (1 like); hidden photo left out.
  await C.page.goto(`/c/${compId}`)
  const ranking = C.page.getByTestId('results-category').filter({ hasText: 'Landscape' }).getByTestId('ranking-row')
  await expect(ranking).toHaveCount(2)
  await expect(ranking.first()).toContainText('creek')
  await expect(ranking.first()).toContainText('4 points')
  await expect(ranking.first()).toContainText('0 likes + 4 judge')
  await expect(ranking.first()).toContainText('1st')
  await expect(ranking.nth(1)).toContainText('Sunrise over the hill')
  await expect(ranking.nth(1)).toContainText('1 point')
  await expect(ranking.nth(1)).toContainText('1 like + 0 judge')
  await expect(C.page.getByTestId('results-category').filter({ hasText: 'Portrait' })).toContainText('No photos in this category')
  await anonPage.goto(`/c/${compId}`)
  await expect(anonPage.getByTestId('ranking-row').first()).toContainText('creek')
  // Voting is closed; B can no longer edit or delete.
  expect((await call(C.page, 'DELETE', `/photos/${sunrise.id}/like`)).status).toBe(403)
  expect((await call(B.page, 'DELETE', `/photos/${creek.id}`)).status).toBe(403)
  expect((await call(B.page, 'PATCH', `/photos/${creek.id}`, { title: 'x' })).status).toBe(403)

  // The competition shows up in each user's "My competitions".
  await B.page.goto('/my')
  await expect(B.page.getByRole('link', { name: `Spring walk ${run}` })).toBeVisible()
  await A.page.goto('/my')
  await expect(A.page.getByRole('link', { name: `Spring walk ${run}` })).toBeVisible()

  for (const c of [A.ctx, B.ctx, C.ctx, anon]) await c.close()
})
