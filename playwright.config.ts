import { defineConfig } from '@playwright/test'

const PORT = 5199

export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  workers: 1,
  expect: { timeout: 8_000 },
  reporter: [['list']],
  use: {
    actionTimeout: 10_000,
    baseURL: `http://localhost:${PORT}`,
    // Use the preinstalled Chromium instead of downloading a browser.
    launchOptions: { executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' },
  },
  webServer: {
    command: `npm run db:migrate:local && npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/api/me`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
