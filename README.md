# Photo Competitions

A small website where anyone who signs in with their email can run a photo competition: set the dates and
categories, approve who may enter, let people upload photos, let the public like and comment,
add scores from outside judges, then publish the results. Anyone can browse published competitions
without an account.

It runs entirely on Cloudflare (one Worker for the website and API, a D1 database, and an R2 bucket
for the photos). Photos are resized in the visitor's browser before upload, so no paid image service
is needed.

## How the rules work (short version)

- The person who creates a competition is its admin. Drafts are only visible to them until published.
- People apply to enter; the admin approves or rejects. The admin can always upload.
- Uploads: long side at least 1080 px (smaller photos are refused), stored at most 1920 px. Limits per
  person (whole competition and per category) and the open/close dates are checked on the server.
- Likes: once per photo, never your own, optionally limited per person. Like counts are secret until the
  admin publishes the results (only the admin can see them earlier).
- Judges: the admin can add points per photo for external judges. Total score = likes + judge points.
- Results can be published only after the close date. Then voting closes and the ranking is shown.

## Run it on your computer

You need Node.js 22 or newer.

```sh
npm install
npm run db:migrate:local   # creates the local database (first time, and after new migrations)
npm run dev                # http://localhost:5173
```

`npm run dev` creates a `.dev.vars` file from `.dev.vars.example` on first run. It sets
`APP_ENV=development`, which turns on a "Dev login" box in the header, so you can sign in as any email
without email. In this mode the sign-in page also doesn't send email: the code is returned to the page's API call and printed in the terminal. (Dev login answers 404 in production.) Local data lives in `.wrangler/` and can be
deleted to start fresh.

Other commands: `npm run build`, `npm run typecheck`, and `npm test` (end-to-end browser test with
Playwright; it starts its own server on port 5199 and uses Chromium at `/opt/pw-browsers/chromium`,
override with `CHROMIUM_PATH`).

## Deploy

One-time setup (needs a Cloudflare account and `npx wrangler login`):

1. `npx wrangler d1 create photo-competitions-db` and put the printed id into `wrangler.jsonc`
   (replace `REPLACE_WITH_D1_ID`).
2. `npx wrangler r2 bucket create photo-competitions-photos`.
3. Set up the sender for sign-in emails (Cloudflare Email Service). People sign in with a 6-digit code or a
   link emailed to them, so email has to work:
   - In the Cloudflare dashboard, onboard your sending domain in Email Service (Compute & AI / Email Service,
     add the domain and add the DNS records it shows). The domain must show as verified.
   - In `wrangler.jsonc`, set `EMAIL_FROM` to an address on that domain, for example `login@yourdomain.com`
     (replace `login@REPLACE_WITH_DOMAIN`). The `send_email` binding named `EMAIL` is already there.
   - If emails don't arrive, check the Worker logs (`npx wrangler tail`): errors such as `E_SENDER_NOT_VERIFIED`
     mean the domain isn't onboarded or `EMAIL_FROM` doesn't match it.
4. There are no secrets to set.
5. `npm run db:migrate:remote` to create the tables.

Every deploy: `npm run deploy` (builds the site, then publishes the Worker). Run
`npm run db:migrate:remote` first whenever a new file appears in `migrations/`.

## Code map

- `worker/` - the API (Hono): `auth.ts` (email sign-in), `competitions.ts`, `photos.ts` (photos, likes, comments, judge votes), `lib.ts`.
- `migrations/` - database tables.
- `src/` - the website (React): `pages/` has one file per page, `image.ts` does the in-browser resizing.
- `tests/e2e.spec.ts` - the end-to-end test; `tests/email-login.spec.ts` - the email sign-in tests.
