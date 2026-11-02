# MathHack — Backend API & Realtime Engine

Production-ready backend API for the MathHack real-time mathematical MCQ competition platform. Built with **Node.js**, **Express**, **Hono**, **MongoDB (Mongoose)**, and **Server-Sent Events (SSE)**.

---

## Features

- **Hono & Express Hybrid Engine:** Standard REST APIs for operations, native SSE (`streamSSE`) for low-overhead real-time notifications.
- **Individual Exam Sessions & Independent Timers:** Host starts the competition globally, but each participant receives an authoritative individual session and countdown timer starting the moment they click "Start Test".
- **Realtime Server-Sent Events (SSE):** Heartbeat ping (15s), automatic client lifecycle management, and optional Redis pub/sub support (`mh:events:*`).
- **Idempotency & Concurrency-Safe:** Compound unique indexes (`{ competitionId: 1, studentId: 1 }`) and atomic operations prevent duplicate sessions and double submissions.
- **Security Defense-in-Depth:** Origin-locked CORS, session-bound CSRF validation tokens, Argon2 password hashing, and question payload sanitization (correct options stripped from participants).
- **Admin & Host Management:** Host registration, participant dashboard, bulk deletion, Excel/CSV exports, and host password resets.

---

## Requirements

- **Node.js**: >= 20.11.0
- **MongoDB**: >= 6.0 (Atlas cluster or local instance)
- **Redis** *(optional)*: For multi-instance scaling

---

## Getting Started

### 1. Installation

```bash
npm install
```

### 2. Environment Configuration

Copy the example environment file and fill in your values:

```bash
cp .env.example .env
```

Validate your configuration before starting:

```bash
npm run validate-env
```

To test connectivity to your MongoDB database:

```bash
npm run validate-env -- --check-db
```

### 3. Creating an Initial Host Account

```bash
npm run create-host
```

### 4. Running the Development Server

```bash
npm run dev
```

The API will be available at `http://localhost:4000`.

---

## Available Scripts

- `npm run dev`: Start the development server with live reload (`tsx watch`).
- `npm run build`: Compile TypeScript for production to `dist/`.
- `npm start`: Launch the compiled production server.
- `npm run typecheck`: Run TypeScript compiler check without emitting files.
- `npm run lint`: Lint code with ESLint.
- `npm test`: Run complete Vitest test suite.
- `npm run create-host`: Interactive/environment-based host account creator.
- `npm run reset-host-pass`: Reset a host password via CLI.
- `npm run users`: List and inspect registered users.
- `npm run seed:dev`: Seed development database with sample questions and competitions.

---

## Architecture Overview

- `src/realtime/honoApp.ts`: Standardized Hono routes for realtime competition lifecycles, SSE stream (`/events`), session creation (`/start-test`), submissions, and status.
- `src/realtime/sseHub.ts`: Server-Sent Events hub managing in-memory room subscriptions and Redis distribution.
- `src/services/examSessionService.ts`: Authoritative session creation, independent countdown timers, and answer recording.
- `src/controllers/`: Express controllers for competition management, questions, participants, and reports.
- `src/models/`: Mongoose schemas for Competitions, ExamSessions, Participants, Questions, Attempts, and Hosts/Students.
