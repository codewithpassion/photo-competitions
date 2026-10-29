# Photo Competitions app - build spec

Real hosted web app. Owner is non-technical. Keep code simple, readable, small dependency list.

## Stack (fixed, do not change)
- Cloudflare Workers, single Worker serving API + static SPA (wrangler 4.x, `assets` with
  `not_found_handling: "single-page-application"`, `run_worker_first: ["/api/*"]`).
- API: Hono (TypeScript) in `worker/`. DB: Cloudflare D1 (binding `DB`), SQL migrations in `migrations/`.
- Photos: Cloudflare R2 (binding `PHOTOS`), served through the Worker at `/api/photos/:id/full` and `/thumb`
  with long cache headers. Hidden photos only served to the competition admin and the uploader.
- Frontend: React + Vite + react-router + Tailwind (v4 via @tailwindcss/vite) in `src/`.
  Use @cloudflare/vite-plugin so `npm run dev` runs everything locally with local D1/R2.
- Image processing happens IN THE BROWSER (no paid image services): exifr for EXIF, canvas
  (createImageBitmap with imageOrientation 'from-image') for resize.
- wrangler.jsonc: name `photo-competitions`, D1 database_name `photo-competitions-db`
  (database_id placeholder `REPLACE_WITH_D1_ID`), R2 bucket `photo-competitions-photos`.
  vars: `APP_ENV` ("development" locally via .dev.vars, "production" in wrangler.jsonc).
  `EMAIL_FROM` (sender address of sign-in emails, placeholder `login@REPLACE_WITH_DOMAIN`), and the
  Cloudflare Email Service binding `"send_email": [{ "name": "EMAIL" }]`. No secrets are needed.
  `.dev.vars.example` holds `APP_ENV=development`.

## Auth
- Passwordless email sign-in only (no passwords, no third-party identity provider, no auth library).
  The user enters an email and receives ONE email with a 6-digit code and a "Sign in" button (magic link).
  - `POST /api/auth/email/start {email, returnTo?}`: email trimmed + lowercased; creates a `login_codes` row
    (6-digit code from `crypto.getRandomValues`, uniform; 32-byte random link token; only SHA-256 hashes stored;
    expires after 15 minutes; `return_to` must be a same-site path). Max 5 starts per email per hour (429).
    Starting a new code retires older unused ones. The response is the same whether or not the email has an
    account (accounts are created on first successful sign-in). The email is sent with the Cloudflare Email
    Service Workers binding `env.EMAIL.send({ to, from: { email: env.EMAIL_FROM, name }, subject, html, text })`;
    failures are logged with `console.error` (including the error `code`) and returned as a plain-words 502.
    With `APP_ENV=development` nothing is sent: the response contains `{ devCode, devToken }` (also logged).
  - `POST /api/auth/email/verify {email, code}`: constant-time hash compare against the newest unused,
    unexpired code; after 5 wrong attempts that code is burned; single use.
  - `POST /api/auth/email/verify-link {token}`: same checks for the link token. The link opens the SPA route
    `/login/verify?token=...&email=...`, which POSTs the token, so mail scanners that GET the link don't use it up.
  - On success: upsert the user by email, create the session row (random 32-byte id, 30-day expiry), set cookie
    `sid` HttpOnly Secure SameSite=Lax Path=/, return `{ user, returnTo }`.
  - New accounts have an empty `name`; the SPA shows "What should we call you?" before anything else.
    `PATCH /api/me {name}` sets it; users can also change it on `/my`.
- `POST /api/auth/logout`, `GET /api/me`.
- DEV ONLY: `POST /api/auth/dev-login {email,name}` creates/logs in a user (by email). Must return 404 unless
  `APP_ENV === "development"`. This exists purely for local testing.
- All state-changing endpoints require a session and a JSON content-type or multipart (CSRF:
  check `Origin` header matches request host for non-GET requests).

## Domain model
- Anyone signed in can create competitions; the creator is that competition's admin.
- Competition: title, description (plain text, render with line breaks), status
  `draft | published`, `submissions_open_at`, `submissions_close_at` (the judging date: no new
  submissions after it), `max_photos_per_person` (int >= 1), `max_likes_per_person` (nullable int >= 1; null = unlimited), `results_published_at` (null until
  admin publishes results), created_at. Drafts visible only to the admin. Only admin edits.
  Times stored as ISO UTC strings; UI shows/edits in the browser's local time.
- Categories per competition: name, optional description, `max_photos_per_person` nullable
  (null = no category limit, only the competition total applies). At least one category required
  to publish. Admin can add/edit/delete categories (delete blocked if photos exist in it).
- Entry applications: a signed-in user applies to enter a competition (optional message).
  Status `pending | approved | rejected`. Admin sees the list and approves/rejects. The admin is
  automatically allowed to enter their own competition? No - admin can also apply-and-self-approve;
  simplest: admin is always allowed to upload.
- Photos: competition, category, uploader, title (required), taken_at (nullable, prefilled from
  EXIF DateTimeOriginal), latitude/longitude (nullable, from EXIF GPS, user can clear them),
  location_name (free text, optional), width, height, full R2 key, thumb R2 key, hidden (bool),
  created_at. Upload allowed only if: competition published, now between open and close,
  user approved (or admin), user's total in competition < competition max, user's count in
  category < category max (if set). Enforce all of these SERVER-SIDE. Uploader can delete their own
  photo while submissions are open, and edit title/date/location.
- Upload processing in browser: accept image/* (JPEG, PNG, WebP, HEIC where the browser can decode
  it; show a friendly error otherwise). Read EXIF first from the original file. Minimum size: the
  long side of the original must be >= 1080 px, else reject with a friendly message. Resize so the
  long side is at most 1920 (never upscale), encode JPEG quality 0.85. Thumbnail: long side 480,
  JPEG 0.8. Upload via multipart (`full`, `thumb`, plus fields). Server checks: both parts are JPEG
  (magic bytes FF D8 FF), full <= 4 MB, thumb <= 400 KB, parse JPEG SOF marker to read real
  dimensions, reject if long side > 1920 or < 1080 (allow a few px tolerance is not needed; client
  guarantees). Store width/height from the parsed values. Allow selecting several files at once;
  each gets its own title field (default from filename) before uploading.
- Votes: any signed-in user can like any visible photo, once per photo, not their own. Toggle on/off.
  Voting allowed while competition is published and results are not yet published.
  Likes limit: if the competition has `max_likes_per_person`, the server rejects a like beyond that limit
  with a friendly error; the UI shows "You have N likes left". Unliking gives the like back.
  PRIVACY: like counts are never returned by any API to anyone except the competition admin (who can see
  them at any time, on the admin page and on photos) until results_published_at is set. Before that, other
  users only get whether the current user liked it.
- Judge votes: the admin can add judge votes to any photo to represent external judges or extra judging
  criteria. Table `judge_votes` (photo_id, judge_name text, points int >= 1, created_at); the admin can
  add/edit/remove entries on the admin page. A photo's total score = public likes + sum of judge points.
  Judge votes are admin-only until results are published, same as likes.
- Results: admin can publish results only after submissions_close_at. After publishing, the
  competition page shows a ranking per category by total score (likes + judge points, with the breakdown likes / judge points / total), and admin can mark/unmark photos as
  winners with a label (e.g. "1st", "Highly commended"). Voting then closes.
- Comments: signed-in users comment on visible photos (max 1000 chars). Shown with author name and
  time. Author or competition admin can delete. Admin can hide a comment.
- Moderation: competition admin can hide/unhide and delete any photo in their competition
  (delete removes R2 objects too). Hidden photos disappear for everyone except admin and uploader,
  who see a "Hidden by moderator" badge. No approval needed by default.
- Public viewing: anyone (no account) can view published competitions, photo galleries, photo pages
  and comments. Voting, commenting, applying, uploading need sign-in.

## Pages (keep it clean, mobile-friendly, photo-first; neutral dark-on-light design)
- `/login` sign-in: email field, then "We've emailed you a 6-digit code" with a 6-digit input
  (`autocomplete=one-time-code`, numeric), resend, and "use a different email". `/login/verify` is the magic-link page.
- `/` list of published competitions (open now / upcoming / closed), "Create competition" button.
- `/my` my competitions (as admin, incl. drafts) and competitions I entered.
- `/c/new`, `/c/:id/edit` competition form incl. categories editor, publish/unpublish button.
- `/c/:id` competition page: description, dates, status badge, categories as tabs/filter, thumbnail
  grid, apply / application status / "Upload photos" button, results view after publishing.
- `/c/:id/upload` upload page (category picker, multi-file, preview, per-file title/date/location,
  shows remaining quota per competition and category).
- `/c/:id/admin` admin page: applications (approve/reject), all photos incl. hidden with
  hide/unhide/delete, publish results, mark winners.
- `/p/:id` photo page: large image, title, photographer, date taken, location (with
  "open in map" link to https://www.openstreetmap.org/?mlat=..&mlon=.. when coords exist),
  like button, comments.
- Header: app name "Photo Competitions", "Sign in" link (to `/login?returnTo=<current path>`) / user menu with sign out.

## Quality
- Validate all inputs server-side (zod is fine). Return JSON errors `{error: "..."}` with sensible
  status codes; show them in the UI in plain words.
- Use prepared statements only. Check authorisation on every endpoint (admin = competition owner).
- `npm run build`, `npm run typecheck` must pass. Add `npm run db:migrate:local`.
- Tests: an end-to-end Playwright test (`tests/e2e.spec.ts`, run against `npm run dev` or
  `vite preview`/wrangler dev) using dev-login with two/three users (a second spec, `tests/email-login.spec.ts`, covers the email sign-in flow via `devCode`/`devToken`) covering: create competition
  with 2 categories and limits, publish, user B applies, admin approves, B uploads photos (generate
  test JPEGs with EXIF in a fixture, e.g. with `piexifjs` or a committed small fixture made via
  sharp in a script), limits enforced, C likes and comments, counts hidden, admin hides a photo,
  admin publishes results after close date (allow the test to set close date in the past via edit),
  ranking visible. Playwright and Chromium are preinstalled globally: use
  `require('playwright')`/`@playwright/test` with `executablePath: '/opt/pw-browsers/chromium'` if a
  different version gets installed. Do not run `playwright install`.
- README.md in plain English: what it is, how to run locally, how deploy works.
