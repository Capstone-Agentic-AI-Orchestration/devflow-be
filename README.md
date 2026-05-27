# DevFlow Backend

DevFlow is an AI-powered development workflow orchestration backend. It automates the full software delivery lifecycle — from receiving a feature request to opening a production-ready pull request — by coordinating a multi-agent LangGraph pipeline that plans, generates, reviews, and gates code changes. The backend exposes a REST API consumed by the DevFlow frontend and integrates with GitHub via a GitHub App to manage branches, commits, and pull request status.

---

## Prerequisites

| Tool | Version |
|------|---------|
| Node.js | 22.x |
| npm | 10.x (bundled with Node 22) |
| Docker + Docker Compose | Docker 24+ / Compose v2 |
| PostgreSQL | 16 (provided via Docker) |

---

## Quick Start (Docker Compose)

The fastest way to run the full stack locally:

```bash
# 1. Copy environment template
cp .env.example .env
# Fill in API keys — see Environment Variables section below

# 2. Start API + database
docker-compose up --build

# API is available at http://localhost:4000
# Database is available at localhost:5432
```

To run in the background:

```bash
docker-compose up --build -d
docker-compose logs -f api
```

To stop and clean up:

```bash
docker-compose down -v   # -v also removes the postgres_data volume
```

---

## Manual Setup

```bash
# 1. Clone the repository
git clone <repo-url>
cd devflow-backend

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Open .env and fill in all required values

# 4. Run Prisma migrations (creates/updates the database schema)
npm run prisma:migrate

# 5. Start the development server with hot-reload
npm run start:dev
```

Other useful commands:

```bash
npm run build          # Compile TypeScript to dist/
npm run start          # Run compiled output (production mode)
npm run test           # Run Vitest test suite once
npm run test:watch     # Run Vitest in watch mode
npm run prisma:studio  # Open Prisma Studio (visual DB browser)
npm run lint           # Lint src/ and test/
npm run lint:fix       # Lint and auto-fix
```

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/health` | Health check — returns `{ status: "ok" }` |
| `POST` | `/api/v1/jobs` | Create a new orchestration job from a feature request |
| `GET` | `/api/v1/jobs/:jobId` | Get current status and metadata for a job |
| `GET` | `/api/v1/jobs/:jobId/stream` | SSE stream of real-time agent log events for a job |
| `POST` | `/api/v1/jobs/:jobId/gates/:gateName/approve` | Approve a named gate checkpoint to resume the pipeline |
| `POST` | `/api/v1/jobs/:jobId/gates/:gateName/reject` | Reject a named gate checkpoint and halt the pipeline |
| `GET` | `/api/v1/jobs/:jobId/artifact` | Retrieve the final artifact (PR URL, diff summary) for a completed job |

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Claude models |
| `OPENAI_API_KEY` | Yes | OpenAI API key (used by LangGraph tooling) |
| `GITHUB_APP_ID` | Yes | GitHub App numeric ID |
| `GITHUB_APP_PRIVATE_KEY_BASE64` | Yes | Base64-encoded PEM private key for the GitHub App |
| `GITHUB_APP_INSTALLATION_ID` | Yes | Installation ID for the target GitHub org |
| `GITHUB_ORG` | Yes | GitHub org where generated repos are created |
| `PORT` | No | HTTP port (default: `4000`) |
| `NODE_ENV` | No | `development` or `production` |
| `LANGCHAIN_API_KEY` | No | LangSmith API key (Phase 2 tracing, not required in Phase 1) |
| `LANGCHAIN_TRACING_V2` | No | Set to `"true"` to enable LangSmith tracing |

### Encoding the GitHub App private key

GitHub App private keys are downloaded as `.pem` files. Encode it for use as an environment variable:

```bash
# macOS / Linux
base64 -w 0 your-app.private-key.pem

# Windows (PowerShell)
[Convert]::ToBase64String([IO.File]::ReadAllBytes("your-app.private-key.pem"))
```

Paste the output as the value of `GITHUB_APP_PRIVATE_KEY_BASE64`. The application decodes it at runtime in `configuration.ts`.

---

## Gate Approval Flow

The DevFlow pipeline pauses at named checkpoints (gates) before performing irreversible actions — such as pushing a branch or opening a pull request. Gates allow a human operator to inspect the agent's output before the pipeline proceeds.

**How it works:**

1. Create a job via `POST /api/v1/jobs`. The pipeline starts running asynchronously.
2. Poll `GET /api/v1/jobs/:jobId` until `status` is `"awaiting_gate"` and `currentGate` contains a gate name (e.g., `"pre-push"`).
3. Review the pending output. You can stream agent logs via `GET /api/v1/jobs/:jobId/stream` to see what the agent produced.
4. Send your decision:
   - `POST /api/v1/jobs/:jobId/gates/:gateName/approve` — pipeline resumes from the checkpoint.
   - `POST /api/v1/jobs/:jobId/gates/:gateName/reject` — pipeline is halted; `status` becomes `"rejected"`.
5. Repeat for each gate until `status` reaches `"completed"` or `"failed"`.
6. Retrieve the final artifact (PR URL) via `GET /api/v1/jobs/:jobId/artifact`.

Gate names are defined in the LangGraph workflow and will be documented per-pipeline in the `src/agents/` module.
