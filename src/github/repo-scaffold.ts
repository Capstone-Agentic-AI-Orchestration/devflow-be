import { GitHubArtifact } from './github.types';

// ─── CI Workflow Templates ─────────────────────────────────────────────────────

const CI_FULLSTACK = `name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build-frontend:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ./frontend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
          cache-dependency-path: frontend/package-lock.json
      - name: Install dependencies
        run: npm ci
      - name: Build
        run: npm run build --if-present
      - name: Test
        run: npm test --if-present

  build-backend:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ./backend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
          cache-dependency-path: backend/package-lock.json
      - name: Install dependencies
        run: npm ci
      - name: Build
        run: npm run build --if-present
      - name: Test
        run: npm test --if-present
`;

const CI_FULLSTACK_POSTGRES = `name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build-frontend:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ./frontend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
          cache-dependency-path: frontend/package-lock.json
      - name: Install dependencies
        run: npm ci
      - name: Build
        run: npm run build --if-present
      - name: Test
        run: npm test --if-present

  build-backend:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ./backend
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_DB: devflow_test
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
          cache-dependency-path: backend/package-lock.json
      - name: Install dependencies
        run: npm ci
      - name: Build
        run: npm run build --if-present
      - name: Test
        run: npm test --if-present
`;

const CI_NEXTJS_ONLY = `name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
      - name: Install dependencies
        run: npm ci
      - name: Build
        run: npm run build
      - name: Test
        run: npm test --if-present
`;

// ─── Dockerfile & Compose Templates ───────────────────────────────────────────

const DOCKERFILE = `# Stage 1: Build
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: Production image
FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
EXPOSE 3000
CMD ["node", "dist/main"]
`;

const DOCKER_COMPOSE = `version: '3.9'

services:
  backend:
    build: ./backend
    ports:
      - '3000:3000'
    environment:
      DATABASE_URL: postgresql://postgres:postgres@db:5432/devflow
      JWT_SECRET: \${JWT_SECRET}
      PORT: 3000
    depends_on:
      db:
        condition: service_healthy

  db:
    image: postgres:15
    ports:
      - '5432:5432'
    environment:
      POSTGRES_DB: devflow
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U postgres']
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:
`;

// ─── .env.example Templates ────────────────────────────────────────────────────

const ENV_EXAMPLE_SUPABASE = `# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Database
DATABASE_URL=

# Auth
JWT_SECRET=
`;

const ENV_EXAMPLE_POSTGRES = `# Database
DATABASE_URL=postgresql://postgres:postgres@db:5432/devflow

# Auth
JWT_SECRET=

# Server
PORT=3000
`;

const ENV_EXAMPLE_NEXTJS_ONLY = `# API
NEXT_PUBLIC_API_URL=
`;

// ─── README Template ───────────────────────────────────────────────────────────

function buildReadme(projectName: string): string {
  return `# ${projectName}

Scaffolded by [DevFlow](https://devflow.app).

## Getting Started

1. Clone this repository
2. Copy \`.env.example\` to \`.env\` and fill in the required values
3. Install dependencies and start the development server

## Project Structure

Refer to the generated source files for the full project layout.
`;
}

// ─── Scaffold Registry ─────────────────────────────────────────────────────────

type ScaffoldFactory = (projectName: string) => GitHubArtifact[];

const SCAFFOLD_REGISTRY: Record<string, ScaffoldFactory> = {
  'nextjs-nestjs-supabase': (projectName) => [
    {
      filePath: '.github/workflows/ci.yml',
      content: CI_FULLSTACK,
    },
    {
      filePath: '.env.example',
      content: ENV_EXAMPLE_SUPABASE,
    },
    {
      filePath: 'README.md',
      content: buildReadme(projectName),
    },
  ],

  'nextjs-nestjs-postgres': (projectName) => [
    {
      filePath: '.github/workflows/ci.yml',
      content: CI_FULLSTACK_POSTGRES,
    },
    {
      filePath: 'Dockerfile',
      content: DOCKERFILE,
    },
    {
      filePath: 'docker-compose.yml',
      content: DOCKER_COMPOSE,
    },
    {
      filePath: '.env.example',
      content: ENV_EXAMPLE_POSTGRES,
    },
    {
      filePath: 'README.md',
      content: buildReadme(projectName),
    },
  ],

  'nextjs-only': (projectName) => [
    {
      filePath: '.github/workflows/ci.yml',
      content: CI_NEXTJS_ONLY,
    },
    {
      filePath: '.env.example',
      content: ENV_EXAMPLE_NEXTJS_ONLY,
    },
    {
      filePath: 'README.md',
      content: buildReadme(projectName),
    },
  ],
};

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the list of GitHubArtifact files to scaffold for the given stack.
 * Falls back to `nextjs-nestjs-supabase` for unrecognised stack keys.
 */
export function scaffoldFilesForStack(
  stackKey: string,
  projectName: string,
): GitHubArtifact[] {
  const factory =
    SCAFFOLD_REGISTRY[stackKey] ?? SCAFFOLD_REGISTRY['nextjs-nestjs-supabase'];
  return factory(projectName);
}
