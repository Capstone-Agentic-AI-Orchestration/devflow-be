-- Phase 2A: Memory Foundation
-- Enables pgvector extension and creates AgentMemory table.
-- Also creates Phase 2B EventLog and RunBudget tables so schema is coherent.
-- Run: npx prisma migrate dev --name phase2a_memory

-- Step 1: enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Step 2: AgentMemory types
CREATE TYPE "AgentMemoryType" AS ENUM ('SKILL', 'PATTERN', 'MISTAKE');

-- Step 3: AgentMemory table
CREATE TABLE "agent_memories" (
    "id"         TEXT NOT NULL,
    "agentType"  TEXT NOT NULL,
    "memoryType" "AgentMemoryType" NOT NULL,
    "content"    TEXT NOT NULL,
    "embedding"  vector(1536) NOT NULL,
    "metadata"   JSONB NOT NULL DEFAULT '{}',
    "projectId"  TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_memories_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "agent_memories_agentType_memoryType_idx"
    ON "agent_memories"("agentType", "memoryType");

CREATE INDEX "agent_memories_projectId_idx"
    ON "agent_memories"("projectId");

-- IVFFlat index for fast ANN search (lists = sqrt(expected rows) ≈ 10 for dev)
-- Rebuild with HNSW in production when row count > 10k
CREATE INDEX "agent_memories_embedding_ivfflat_idx"
    ON "agent_memories"
    USING ivfflat ("embedding" vector_cosine_ops)
    WITH (lists = 10);

-- Step 4: EventLog table (Phase 2B — included here so migration is atomic)
CREATE TABLE "event_logs" (
    "id"          TEXT NOT NULL,
    "projectId"   TEXT NOT NULL,
    "nodeName"    TEXT NOT NULL,
    "eventType"   TEXT NOT NULL,
    "costMeta"    JSONB NOT NULL DEFAULT '{}',
    "runTokens"   INTEGER NOT NULL DEFAULT 0,
    "occurredAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "event_logs_projectId_occurredAt_idx"
    ON "event_logs"("projectId", "occurredAt");

ALTER TABLE "event_logs"
    ADD CONSTRAINT "event_logs_projectId_fkey"
    FOREIGN KEY ("projectId")
    REFERENCES "Project"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Step 5: RunBudget table (Phase 2B)
CREATE TABLE "run_budgets" (
    "id"             TEXT NOT NULL,
    "projectId"      TEXT NOT NULL,
    "tokenBudget"    INTEGER NOT NULL DEFAULT 200000,
    "tokensConsumed" INTEGER NOT NULL DEFAULT 0,
    "retryCount"     INTEGER NOT NULL DEFAULT 0,
    "maxRetries"     INTEGER NOT NULL DEFAULT 2,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "run_budgets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "run_budgets_projectId_key"
    ON "run_budgets"("projectId");

ALTER TABLE "run_budgets"
    ADD CONSTRAINT "run_budgets_projectId_fkey"
    FOREIGN KEY ("projectId")
    REFERENCES "Project"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
