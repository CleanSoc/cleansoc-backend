# CleanSoc Backend

Fastify 5 API for CleanSoc: OAuth with X, post caching, filtering, safe bulk deletion, archive import, and activity logging. Uses PostgreSQL as its primary database.

## Stack

- Node.js 24, TypeScript (ES2022 modules)
- Fastify 5 with `@fastify/cookie`, `cors`, `multipart`, `rate-limit`, `static`
- PostgreSQL via `pg` (connection pooling, async queries, transactions)
- Zod for request validation
- AES-256-GCM token encryption (`node:crypto`)
- `yauzl` for X archive ZIP parsing

## Folder structure

```
src/
  app.ts            Fastify bootstrap, hooks, error handler
  index.ts          entrypoint: migrate, seed demo, start worker, listen
  config.ts         environment configuration
  db/
    index.ts        PostgreSQL pool, query helpers, migrations
    migrate.ts      standalone migration runner
  auth/             session + account resolution
  routes/           one file per resource (auth, accounts, activity, cleanup, dashboard, history, rules, archive, settings)
  services/         business logic (cleanup worker, archive import, dashboard, demo, activity)
  posts/            filters, mapper (X post -> storage row -> DTO)
  x/                OAuth helpers, X API client, sync
  lib/              crypto, errors, time, types
```

## Prerequisites

- Node.js 20+ (developed on 24.x)
- npm 10+
- PostgreSQL 14+ (local or hosted; Neon works without changes)

## Environment variables

Copy `.env.example` to `.env` and fill in values.

| Variable | Required | Description |
| --- | --- | --- |
| `NODE_ENV` | no | `development` or `production`. |
| `PORT` | no | HTTP port (default `8787`). |
| `APP_URL` | no | Frontend origin for redirects/CSRF (default `http://localhost:5173`). |
| `DATABASE_URL` | **yes in prod** | PostgreSQL connection string. Defaults to `postgres://postgres:postgres@localhost:5432/cleansoc` in dev. |
| `DATABASE_POOL_MAX` | no | Pool size (default `10`). |
| `DATABASE_SSL` | no | `true` to enable TLS (required for Neon/RDS). |
| `DATABASE_SSL_REJECT_UNAUTHORIZED` | no | Set `false` only if your provider uses a self-signed cert. |
| `TOKEN_ENCRYPTION_KEY` | **yes in prod** | Base64-encoded 32-byte key. Generated and persisted in dev. |
| `X_CLIENT_ID` | for real X | OAuth client id. |
| `X_CLIENT_SECRET` | optional | Client secret (omit for public/PKCE clients). |
| `X_REDIRECT_URI` | no | Must match the X app config (default `http://localhost:8787/api/auth/x/callback`). |
| `MAX_JOB_ITEMS` | no | Hard cap per cleanup job (default `1000`). |
| `SYNC_MAX_PAGES` | no | Timeline pages per sync, 100 posts each (default `32`, API caps at 3200). |
| `DEMO_MODE` | no | `true` to expose the demo workspace (default `true`). |

## Database setup

1. Create a database (or use the default `cleansoc`).
2. Set `DATABASE_URL` in `.env`.
3. Run migrations:

```bash
npm run db:migrate
```

Migrations are idempotent and tracked in `schema_migrations`. The schema is created on first run; subsequent runs are no-ops.

### Tables

`users`, `accounts`, `sessions`, `oauth_states`, `posts`, `jobs`, `job_items`, `activity_log`, `saved_filters`, `archive_imports`.

Key constraints and indexes:
- `posts (account_id, x_post_id)` is unique.
- `accounts.x_user_id` is unique when present.
- Foreign keys cascade on user/account deletion.
- `job_items.seq` is an identity column used for stable ordering (replaces SQLite `rowid`).
- Indexes cover account+created, account+kind, account+deleted, engagement, jobs by account/status/resume, activity by account.

### SQLite -> PostgreSQL

The previous SQLite backend is not migrated automatically. Reconnect your X account (which re-syncs the recent timeline) or import an X data archive after switching to PostgreSQL.

## Running locally

```bash
npm install
npm run db:migrate
npm run dev          # tsx watch on src/index.ts
```

Or build and run:

```bash
npm run build
npm start
```

## API reference

All endpoints are under `/api`. Authenticated routes require the `cleansoc_session` cookie.

### Health & auth

- `GET /api/health`
- `GET /api/auth/capabilities`
- `GET /api/auth/session`
- `GET /api/auth/x/start` — begins OAuth
- `GET /api/auth/x/callback` — OAuth callback
- `POST /api/auth/demo` — create a demo workspace
- `POST /api/auth/logout`
- `GET /api/auth/me`

### Accounts

- `GET /api/accounts`
- `POST /api/accounts/:id/activate`
- `POST /api/accounts/:id/sync`
- `GET /api/accounts/:id/export`
- `DELETE /api/accounts/:id?confirm=DELETE`
- `DELETE /api/me/data`
- `GET /api/accounts/:id/sync-status`

### Activity

- `GET /api/activity?accountId=&category=&q=&from=&to=&mediaType=&minLikes=&maxLikes=&minEngagement=&maxEngagement=&source=&sort=&page=&pageSize=&includeDeleted=`
- `POST /api/activity/ids` — materialise all matching post ids (capped)
- `GET /api/posts/:id`

### Cleanup

- `POST /api/cleanup/preview` — `{ accountId?, filters?, postIds? }`
- `POST /api/cleanup/jobs` — `{ accountId?, filters?, postIds?, name?, confirmation: "DELETE", acknowledgeIrreversible: true }`
- `GET /api/cleanup/jobs?accountId=`
- `GET /api/cleanup/jobs/:id`
- `POST /api/cleanup/jobs/:id/cancel`
- `POST /api/cleanup/jobs/:id/retry-failed`
- `POST /api/cleanup/jobs/:id/resume`
- `GET /api/cleanup/summary?accountId=`
- `GET /api/cleanup/limits`

### Dashboard, history, rules, archive, settings

- `GET /api/dashboard?accountId=`
- `GET /api/history?accountId=&limit=`
- `GET /api/history/overview?accountId=`
- `GET /api/rules?accountId=`
- `POST /api/rules`
- `DELETE /api/rules/:id`
- `GET /api/archive?accountId=`
- `POST /api/archive/import?accountId=` (multipart, `.zip`)
- `GET /api/settings`

### Example: preview + create a job

```bash
# Preview
curl -s -b cookies.txt -X POST -H 'Content-Type: application/json' \
  http://localhost:8787/api/cleanup/preview \
  -d '{"accountId":"acc_...","filters":{"category":"replies","to":"2022-01-01"}}'

# Create (requires confirmation)
curl -s -b cookies.txt -X POST -H 'Content-Type: application/json' \
  http://localhost:8787/api/cleanup/jobs \
  -d '{"accountId":"acc_...","filters":{"category":"replies","to":"2022-01-01"},"confirmation":"DELETE","acknowledgeIrreversible":true}'
```

## X API capabilities and limitations

Documented honestly — CleanSoc does not fake capabilities the API does not have.

**Can do**
- Read the authenticated user's recent timeline (up to 3,200 posts) and mentions (up to 800).
- Read public metrics (likes, replies, reposts, quotes, impressions).
- Delete a post owned by the authenticated user (`DELETE /2/tweets/:id`).
- Undo a repost (`DELETE /2/users/:id/retweets/:source_tweet_id`).
- Refresh access tokens via `offline.access`.

**Cannot do**
- Read posts older than the 3,200 most recent (use an X data archive import instead — there is no archive API; archives are user-downloaded ZIP files).
- Restore deleted posts — deletion is permanent.
- Bulk-delete endpoints — deletions are one at a time; CleanSoc paces them (X allows ~50 deletes per 15 minutes per user) and pauses/resumes automatically.
- Access other users' private data or act on accounts the token does not own.
- Edit or un-delete content.

**Rate limits**
- Timeline reads: paginated, 100 per page.
- Deletes: ~50 per 15 minutes per user (enforced by X, surfaced to the user as pause/resume).
- CleanSoc's worker processes one delete at a time for real accounts and batches of 12 for the demo dataset.

## Testing

- `npm run typecheck` — TypeScript strict check.
- `npm run build` — compile to `dist/`.
- Demo flow (end-to-end, no X credentials): start the server, `POST /api/auth/demo`, then exercise `/api/dashboard`, `/api/activity`, preview, job creation, retry, history.

## Deployment

1. Provision a PostgreSQL database and set `DATABASE_URL` (enable `DATABASE_SSL=true` for managed providers).
2. Set `NODE_ENV=production`, `TOKEN_ENCRYPTION_KEY`, `APP_URL`, and X credentials.
3. Run `npm install && npm run build && npm run db:migrate`.
4. Start with `npm start` (or under a process manager). Serve the built frontend from `cleansoc/dist` or behind a reverse proxy; the backend serves `cleansoc/dist` when `NODE_ENV=production`.

## Security notes

- OAuth only; no passwords stored.
- Tokens encrypted with AES-256-GCM, AAD bound to the account id.
- Session tokens hashed (SHA-256) before storage; `httpOnly`, `SameSite=Lax` cookie.
- OAuth state bound to a browser nonce; Origin/CSRF checks on state-changing requests.
- Per-user data isolation in every query.
- Deletions require `confirmation === "DELETE"` and `acknowledgeIrreversible === true` server-side.
