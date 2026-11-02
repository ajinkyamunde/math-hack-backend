# MathHack — Backend (Cloudflare Workers + Neon)

API and live updates for MathHack, the real-time maths MCQ competition. It runs as a **Cloudflare Worker**
built with **Hono**, stores data in **Neon PostgreSQL** (via Drizzle), and uses one **Durable Object per
competition** for live events and per-student timers.

The REST API, response shapes, session cookie and CSRF scheme are the same as the old Express/MongoDB backend,
so the existing frontend works with only small changes (see its `cloudflare-workers` branch).

---

## How the game rules map to the code

| Rule | Where |
|---|---|
| 1. Students register and join | `POST /api/auth/register`, `POST /api/competitions/:id/join` |
| 2. Host opens registration, then starts | `POST /:id/open` (DRAFT → WAITING), `POST /:id/start` (WAITING → RUNNING) |
| 3. Start Test unlocks for everyone | `competition:started` event to every connected client (plus 3 s polling fallback in the frontend) |
| 4. Each student starts when ready | `POST /:id/start-test` creates that student's own exam session (idempotent) |
| 5. Easy / Medium / Hard MCQs | Questions are frozen into snapshots at start; students never receive the correct option |
| 6. Answers can't be changed | One row per (competition, student, question): the primary key makes a second answer impossible |
| 7. Individual timer | Each session has its own `expires_at` = Start Test time + the competition's duration |
| 8. Finish or time out | `POST /:id/complete`, or the Durable Object alarm marks the session EXPIRED at its deadline, even if the tab is closed |
| 9. Automatic results | Scored at submission; a student's results unlock as soon as **their own** test is over |

There is no shared competition clock and no host-paced questions: `pause`, `resume`, `publish`, `release-all`
and `skip` from the old engine return a clear 409. **End competition** stops anyone still answering.

## Architecture

```
Browser ──/api──► Vercel rewrite ──► Worker (Hono) ──HTTP──► Neon Postgres
                                       │
                                       └──► CompetitionRoom Durable Object (one per competition)
                                              • SSE streams to students and hosts
                                              • alarm at the next exam-session deadline
                                              • debounced leaderboard pushes to hosts
```

- `src/routes/` — HTTP routes (same paths as before)
- `src/services/` — game logic: `competitions.ts` (lifecycle), `sessions.ts` (Start Test, answers, timers),
  `results.ts` (leaderboard, analytics, exports), `participants.ts`, `questions.ts`, `imports.ts`
- `src/realtime/CompetitionRoom.ts` — the Durable Object
- `migrations/0001_init.sql` — the database schema (source of truth)
- Passwords: Argon2id via WebAssembly (`hash-wasm`), same parameters and format as before, so **existing password hashes keep working**
- Sessions: the same HS256 cookie the old backend issued; with the same `SESSION_SECRET`, people stay signed in across the switch

## Requirements

- **Cloudflare Workers Paid plan** ($5/month). A sign-in hashes the password with Argon2id, which takes about
  75 ms of CPU; the free plan allows 10 ms per request. Durable Objects are included.
- A **Neon** project (the free plan is fine to start).
- Node.js 20.11+ for the scripts.

## Setup

```bash
npm install
npx wrangler login
```

1. **Database.** Create a Neon project and copy its connection string. Then:
   ```bash
   DATABASE_URL='postgresql://...' npm run db:migrate
   ```
   (Or paste `migrations/0001_init.sql` into Neon's SQL editor.)
2. **Secrets.**
   ```bash
   npx wrangler secret put DATABASE_URL
   npx wrangler secret put SESSION_SECRET   # reuse the old backend's value to keep everyone signed in
   ```
3. **Settings.** In `wrangler.toml`, set `FRONTEND_URL` to the frontend's address (e.g. your Vercel site).
4. **Existing data (optional).** Copy everything from MongoDB Atlas, keeping IDs and passwords:
   ```bash
   MONGODB_URI='mongodb+srv://...' DATABASE_URL='postgresql://...' npm run import-mongo
   ```
   Safe to re-run. Old "timed out" placeholder attempts are dropped (unanswered now means no answer row).
5. **A host account** (if you did not import one):
   ```bash
   DATABASE_URL='postgresql://...' HOST_EMAIL=admin@college.edu HOST_PASSWORD='...' npm run create-host
   ```
6. **Deploy.**
   ```bash
   npm run deploy
   ```
   Then put the Worker's address in the frontend's `vercel.json` rewrite.

If your account doesn't offer rate limiting bindings, delete the `[[ratelimits]]` block in `wrangler.toml`;
student accounts still lock for 15 minutes after 5 wrong passwords.

## Local development

```bash
cp .dev.vars.example .dev.vars   # point DATABASE_URL at a Neon development branch
npm run dev                      # http://localhost:8787
```

Run the frontend's `npm run dev` alongside; Vite proxies `/api` to port 8787.

## Scripts

- `npm run dev` — run the Worker locally with wrangler
- `npm run deploy` — deploy to Cloudflare
- `npm run typecheck` — TypeScript check
- `npm test` — end-to-end tests of every game rule, run against PGlite (Postgres in WebAssembly) with the real schema
- `npm run db:migrate` — apply `migrations/*.sql`
- `npm run create-host` — create a host account
- `npm run import-mongo` — copy data from the old MongoDB database
