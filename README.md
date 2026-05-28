# DevFlow Backend

`devflow-be` is the NestJS API for the migrated DevFlow product. It serves the PM, DEV, CLIENT, and ADMIN workspaces used by `devlow-frontend`.

The current production-ready surface is the project delivery lifecycle around intake, client invites, kickoff, tasks, work orders, artifacts, collaboration, timeline, notifications, and delivery review. The full orchestrator remains the final major integration target.

## Prerequisites

| Tool | Version |
| --- | --- |
| Node.js | 22.x |
| npm | 10.x |
| PostgreSQL | Supabase Postgres or local PostgreSQL |
| Supabase | Auth + Postgres project |

## Setup

```powershell
npm install
Copy-Item .env.example .env
npm run prisma:generate
npm run prisma:migrate
npm run build
npm run start
```

The API listens on `http://localhost:4000` by default. Health check:

```powershell
Invoke-RestMethod http://localhost:4000/health
```

For hot reload during development:

```powershell
npm run start:dev
```

## Environment

Required:

```env
DATABASE_URL="postgresql://..."
SUPABASE_URL="https://your-project-ref.supabase.co"
ANTHROPIC_API_KEY="sk-ant-..."
OPENAI_API_KEY="sk-..."
GITHUB_APP_ID="123456"
GITHUB_PRIVATE_KEY="<base64-encoded PEM key>"
GITHUB_INSTALLATION_ID="12345678"
```

Common optional values:

```env
PORT=4000
NODE_ENV="development"
CORS_ORIGIN="http://localhost:3000"
SUPABASE_SERVICE_ROLE_KEY=""
SUPABASE_ANON_KEY=""
LANGCHAIN_API_KEY=""
LANGCHAIN_TRACING_V2="false"
LANGCHAIN_PROJECT="devflow"
```

`SUPABASE_SERVICE_ROLE_KEY` is server-side only. Never expose it to `devlow-frontend`.

## Scripts

```powershell
npm test              # Vitest unit/regression tests
npm run build         # Compile NestJS to dist/
npm run start         # Run compiled output
npm run start:dev     # Development server
npm run prisma:migrate
npm run prisma:generate
npm run prisma:studio
npm run auth:set-role
npm run seed:demo
npm run seed:demo:check
npm run seed:demo:smoke
```

## Persona Demo Data

The repeatable demo seed creates PM, DEV, and CLIENT records against real Supabase Auth/Profile data.

Default demo users:

| Persona | Email | Role |
| --- | --- | --- |
| PM | `devflow.pm@example.com` | `PM` |
| Developer | `devflow.dev@example.com` | `DEV` |
| Client | `devflow.client@example.com` | `CLIENT` |

If `SUPABASE_SERVICE_ROLE_KEY` is set, missing default auth users are created through Supabase Auth Admin. If only `SUPABASE_ANON_KEY` is set and public signup is enabled, missing users are created through public signup. Otherwise the seed reuses existing profiles for each role.

```powershell
npm run seed:demo
npm run seed:demo:check
```

With the API running and `SUPABASE_ANON_KEY` available:

```powershell
npm run seed:demo:smoke
```

The smoke signs in as each persona and validates positive access plus forbidden cross-role access.

Optional seed overrides:

```env
DEMO_PROJECT_ID="demo-persona-project"
DEMO_PM_EMAIL="devflow.pm@example.com"
DEMO_DEV_EMAIL="devflow.dev@example.com"
DEMO_CLIENT_EMAIL="devflow.client@example.com"
DEMO_AUTH_PASSWORD="DevFlowDemo123!"
```

## Current API Surface

All protected endpoints expect `Authorization: Bearer <Supabase access token>`.

Public:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Health probe |
| `POST` | `/inquiries` | Public project inquiry |
| `GET` | `/client-invites/status?email=...` | Public invite status lookup |

Authenticated:

| Area | Representative endpoints |
| --- | --- |
| Auth | `GET /auth/me` |
| Projects | `GET /projects`, `POST /projects`, `GET/PATCH /projects/:id` |
| Members | `POST /projects/:id/members`, `DELETE /projects/:id/members/:userId` |
| Kickoff | `GET/PATCH /projects/:id/kickoff`, `POST /projects/:id/kickoff/tasks`, `POST /projects/:id/kickoff/work-orders` |
| Tasks | `GET/POST /projects/:id/tasks`, `PATCH /projects/:id/tasks/:taskId`, comments/activity endpoints |
| Work orders | `GET/POST /projects/:id/work-orders`, `PATCH /projects/:id/work-orders/:workOrderId`, `POST /projects/:id/work-orders/:workOrderId/dispatch` |
| Artifacts | `GET /projects/:id/artifacts`, artifact detail, share, review, output review, publish, revision endpoints |
| Collaboration | conversations, messages, read state, documents, document review under `/projects/:projectId/...` |
| Delivery | `GET /projects/:id/delivery-review`, accept/revision/resolve endpoints |
| Timeline/events | `GET /projects/:id/timeline`, `GET /projects/:id/events` |
| Notifications | `GET /notifications`, read endpoints |
| Profiles | `GET /profiles` for PM/ADMIN profile search |
| Client invites | `GET /client-invites/me`, `POST /client-invites/accept` for CLIENT users |
| Orchestration bridge | `POST /projects/:id/orchestration/start`, status/gate endpoints, work-order dispatch |

See `docs/architecture/production-readiness.md` for the role matrix, lifecycle rules, data-integrity rules, and verification baseline.

## Frontend Pairing

Run the frontend separately from `../devlow-frontend`:

```powershell
cd ..\devlow-frontend
Copy-Item .env.example .env.local
npm install
npm run dev
```

Use matching Supabase project values in both apps. The frontend only receives public values (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_API_URL`).

## Verification Baseline

```powershell
npm test
npm run build
npm run seed:demo
npm run seed:demo:check
npm run seed:demo:smoke

cd ..\devlow-frontend
npm run typecheck
npm run build
```
