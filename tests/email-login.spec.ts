import { expect, test, type Page } from '@playwright/test'

const BASE = 'http://localhost:5199'
const run = Math.random().toString(36).slice(2, 8)
const mail = (who: string) => `${who}-${run}@example.com`

async function post(page: Page, path: string, data: unknown) {
  const res = await page.request.post(`/api${path}`, { headers: { origin: BASE }, data })
  return { status: res.status(), body: await res.json().catch(() => ({})) }
}

/** Ask for a code through the API (dev mode returns it instead of emailing). */
async function start(page: Page, email: string, returnTo?: string) {
  const res = await post(page, '/auth/email/start', { email, returnTo })
  expect(res.status).toBe(200)
  expect(res.body.devCode).toMatch(/^\d{6}$/)
  expect(res.body.devToken).toMatch(/^[0-9a-f]{64}$/)
  return res.body as { devCode: string; devToken: string }
}

test('code sign-in: wrong code rejected, right code signs in, name prompt, code is single use', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: BASE })
  const page = await ctx.newPage()
  const email = mail('Carol')

  await page.goto('/c/new')
  await page.getByRole('link', { name: 'Sign in' }).first().click()
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fc%2Fnew$/)

  const startResponse = page.waitForResponse((r) => r.url().endsWith('/api/auth/email/start'))
  await page.getByLabel('Email', { exact: true }).fill(email.toUpperCase()) // emails are normalised to lowercase
  await page.getByRole('button', { name: 'Email me a code' }).click()
  const { devCode } = await (await startResponse).json()
  await expect(page.getByRole('heading', { name: "We've emailed you a 6-digit code" })).toBeVisible()
  const codeInput = page.getByLabel('6-digit code')
  await expect(codeInput).toHaveAttribute('autocomplete', 'one-time-code')
  await expect(codeInput).toHaveAttribute('inputmode', 'numeric')

  // Wrong code
  await codeInput.fill(devCode === '000000' ? '111111' : '000000')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toContainText('not right')
  expect((await (await page.request.get('/api/me')).json()).user).toBeNull()

  // Right code, then the name step, then back to where we were going
  await codeInput.fill(devCode)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'What should we call you?' })).toBeVisible()
  await page.getByLabel('Your name').fill('Carol')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByTestId('user-name')).toHaveText('Carol')
  await expect(page).toHaveURL(/\/c\/new$/)
  await expect(page.getByRole('heading', { name: /New competition|Create competition/i }).first()).toBeVisible()

  // Single use: the same code cannot sign in again
  const other = await browser.newContext({ baseURL: BASE })
  const otherPage = await other.newPage()
  expect((await post(otherPage, '/auth/email/verify', { email, code: devCode })).status).toBe(400)
  expect((await (await otherPage.request.get('/api/me')).json()).user).toBeNull()

  // Change name on /my
  await page.goto('/my')
  await page.getByLabel(/Your name/).fill('Carol C')
  await page.getByRole('button', { name: 'Save name' }).click()
  await expect(page.getByTestId('user-name')).toHaveText('Carol C')

  // A returning user with a name goes straight in (no name step) and keeps the name.
  const again = await start(otherPage, email)
  const ok = await post(otherPage, '/auth/email/verify', { email, code: again.devCode })
  expect(ok.status).toBe(200)
  expect(ok.body.user.name).toBe('Carol C')
  expect(ok.body.returnTo).toBe('/')
  await ctx.close()
  await other.close()
})

test('magic link works once, in the browser', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: BASE })
  const page = await ctx.newPage()
  const email = mail('Dave')
  const { devCode, devToken } = await start(page, email, '/my')

  // A plain GET of the link (what an email scanner does) must not use the token up.
  expect((await page.request.get(`/login/verify?token=${devToken}&email=${encodeURIComponent(email)}`)).status()).toBe(200)

  await page.goto(`/login/verify?token=${devToken}&email=${encodeURIComponent(email)}`)
  await expect(page.getByRole('heading', { name: 'What should we call you?' })).toBeVisible()
  await expect(page).toHaveURL(/\/my$/)
  await page.getByLabel('Your name').fill('Dave')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByTestId('user-name')).toHaveText('Dave')

  // Link and code are both spent now.
  const other = await browser.newContext({ baseURL: BASE })
  const otherPage = await other.newPage()
  expect((await post(otherPage, '/auth/email/verify-link', { token: devToken })).status).toBe(400)
  expect((await post(otherPage, '/auth/email/verify', { email, code: devCode })).status).toBe(400)
  await otherPage.goto(`/login/verify?token=${devToken}`)
  await expect(otherPage.getByRole('alert')).toContainText('expired or was already used')
  await ctx.close()
  await other.close()
})

test('five wrong guesses burn the code; a new code replaces the old one; starts are rate limited', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: BASE })
  const page = await ctx.newPage()
  const email = mail('Erin')

  const first = await start(page, email)
  const wrong = first.devCode === '123456' ? '654321' : '123456'
  for (let i = 0; i < 5; i++) expect((await post(page, '/auth/email/verify', { email, code: wrong })).status).toBe(400)
  expect((await post(page, '/auth/email/verify', { email, code: first.devCode })).status).toBe(400) // burned
  expect((await post(page, '/auth/email/verify-link', { token: first.devToken })).status).toBe(400)

  const second = await start(page, email)
  const third = await start(page, email) // resend: only the newest works
  expect((await post(page, '/auth/email/verify', { email, code: second.devCode })).status).toBe(400)
  expect((await post(page, '/auth/email/verify', { email, code: third.devCode })).status).toBe(200)

  // 3 starts so far; the 4th and 5th are allowed, the 6th is refused with a friendly message
  await start(page, email)
  await start(page, email)
  const limited = await post(page, '/auth/email/start', { email })
  expect(limited.status).toBe(429)
  expect(limited.body.error).toContain('Please wait')

  // Bad input, and no difference between known and unknown emails
  expect((await post(page, '/auth/email/start', { email: 'nope' })).status).toBe(400)
  expect((await post(page, '/auth/email/verify', { email: mail('nobody'), code: '123456' })).status).toBe(400)
  await ctx.close()
})

test('start needs the right origin, and dev-login still works', async ({ request }) => {
  const res = await request.post('/api/auth/email/start', { headers: { origin: 'https://evil.example' }, data: { email: mail('x') } })
  expect(res.status()).toBe(403)
  const dev = await request.post('/api/auth/dev-login', { headers: { origin: BASE }, data: { email: mail('Dev'), name: 'Dev' } })
  expect(dev.status()).toBe(200)
})
