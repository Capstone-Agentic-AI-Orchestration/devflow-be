import { Injectable, Logger } from '@nestjs/common';
import { DevFlowStateType, GeneratedArtifact } from '../graph/devflow.state';
import { MemoryService } from '../../memory/memory.service';
import { EventLogService } from '../../supervisor/event-log.service';
import { GraphLlmProvider } from '../providers/graph-llm.provider';

// ─── Constants ────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior database engineer generating production-quality Prisma schemas and SQL migrations.
Generate complete, well-structured database files with proper relationships, indexes, and constraints.
Respond ONLY with a JSON array — no prose, no markdown fences.

Each element: { "filePath": string, "content": string, "language": string }`;

// ─── Node ─────────────────────────────────────────────────────────────────────

@Injectable()
export class DatabaseAgentNode {
  private readonly logger = new Logger(DatabaseAgentNode.name);

  constructor(
    private readonly memory: MemoryService,
    private readonly eventLog: EventLogService,
    private readonly graphLlm: GraphLlmProvider,
  ) {}

  async execute(
    state: DevFlowStateType,
  ): Promise<Partial<DevFlowStateType>> {
    this.logger.log(`[${state.projectId}] Database agent generating files`);

    if (!state.contract) {
      return { error: 'DatabaseAgentNode: contract is null' };
    }

    // Log STARTED — allSettled inside, so failure here does not block the node.
    await this.eventLog.logStarted(state.projectId, 'database_agent');

    try {
      // ── 1. Read relevant memories ──────────────────────────────────────────
      // companyName is included so industry-specific schema patterns (e.g.
      // "healthcare PostgreSQL multi-tenant") surface alongside the stack context.
      const memoryQuery = [
        state.contract.requirements.projectType,
        state.contract.requirements.techStack.database,
        state.contract.requirements.features.join(' '),
        state.companyName,
      ]
        .filter(Boolean)
        .join(' ');

      const memoryBundle = await this.memory.buildContextForAgent({
        agentType: 'database',
        projectId: state.projectId,
        query: memoryQuery,
      });
      const memoryContext = memoryBundle.context;

      // ── 2. Build file list ───────────────────────────────────────────────
      const dbFiles = state.contract.fileManifest.filter((f) =>
        /\.(prisma|sql|seed\.(ts|js))$|README-database\.md$/i.test(f),
      );

      const coreFiles = [
        'prisma/schema.prisma',
        'prisma/migrations/0001_initial.sql',
        'prisma/seed.ts',
        'README-database.md',
      ];
      const allDbFiles = [...new Set([...coreFiles, ...dbFiles])].slice(0, 5);

      // ── 2. Skip-generation check ───────────────────────────────────────────
      // Must run AFTER readRelevant so memory context is still available if the
      // skip threshold is not met. Returns immediately — no LLM tokens consumed.
      const skipCandidate = await this.memory.findSkipCandidate(
        'database',
        memoryQuery,
        state.stackKey,
        state.projectId,
      );

      if (skipCandidate) {
        this.logger.log(
          `[${state.projectId}] Skip-generation: reusing database memory artifact (similarity=${skipCandidate.similarity?.toFixed(3)})`,
        );
        const rememberedFilePath = skipCandidate.metadata['filePath'];
        const artifact: GeneratedArtifact = {
          agentType: 'database',
          filePath:
            typeof rememberedFilePath === 'string'
              ? rememberedFilePath
              : 'prisma/schema.prisma',
          content: skipCandidate.content,
          language: 'prisma',
        };
        return { artifacts: this.completeArtifacts(allDbFiles, [artifact], state) };
      }

      if (process.env.MOCK_MODE === 'true') {
        const artifacts = this.completeArtifacts(
          allDbFiles,
          [
          {
            agentType: 'database',
            filePath: 'prisma/schema.prisma',
            content: `model User {\n  id Int @id @default(autoincrement())\n}`,
            language: 'prisma'
          }
          ],
          state,
        );
        await this.eventLog.logCompleted(state.projectId, 'database_agent', { inputTokens: 0, outputTokens: 0, model: 'mock' });
        return { artifacts };
      }

      // ── 4. LLM call ───────────────────────────────────────────────────────
      const result = await this.graphLlm.generateJson<Array<{
        filePath: string;
        content: string;
        language?: string;
      }>>({
        agentName: 'database_agent',
        systemPrompt: memoryContext
          ? `${SYSTEM_PROMPT}\n\nRelevant memory:\n${memoryContext}`
          : SYSTEM_PROMPT,
        userPrompt: `Generate database files for this project:

Project: ${state.contract.projectName}
Description: ${state.contract.description}
Database: ${state.contract.requirements.techStack.database}
Features: ${state.contract.requirements.features.join(', ')}
Acceptance Criteria: ${state.contract.acceptanceCriteria.join('; ')}

Files to generate:
${allDbFiles.map((f) => `- ${f}`).join('\n')}

Requirements:
- prisma/schema.prisma: Full Prisma schema with all models, relations, and indexes
- migrations SQL: Clean DDL with CREATE TABLE, indexes, and foreign keys
- prisma/seed.ts: Realistic seed data using @prisma/client
- README-database.md: ERD description, migration guide, seeding instructions`,
        expectedShape: 'array',
        maxTokens: 6144,
      });

      const artifacts = this.completeArtifacts(
        allDbFiles,
        result.value.map((item) => ({
          agentType: 'database' as const,
          filePath: item.filePath,
          content: item.content,
          language: item.language ?? this.inferLanguage(item.filePath),
        })),
        state,
      );

      this.logger.log(
        `[${state.projectId}] Database agent generated ${artifacts.length} files (${memoryBundle.total} layered memories injected)`,
      );

      // Log COMPLETED with cost metadata — budget is updated atomically inside.
      await this.eventLog.logCompleted(state.projectId, 'database_agent', {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        model: result.model,
      });

      return { artifacts };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${state.projectId}] Database agent failed: ${message}`);
      return { error: `DatabaseAgentNode failed: ${message}` };
    }
  }

  private inferLanguage(filePath: string): string {
    if (filePath.endsWith('.prisma')) return 'prisma';
    if (filePath.endsWith('.sql')) return 'sql';
    if (filePath.endsWith('.ts') || filePath.endsWith('.js')) return 'typescript';
    if (filePath.endsWith('.md')) return 'markdown';
    return 'text';
  }

  private completeArtifacts(
    requestedFiles: string[],
    generated: GeneratedArtifact[],
    state: DevFlowStateType,
  ): GeneratedArtifact[] {
    const byPath = new Map(generated.map((artifact) => [artifact.filePath, artifact]));

    return requestedFiles.map((filePath) => {
      const artifact = byPath.get(filePath);
      if (artifact?.content?.trim()) return artifact;

      return {
        agentType: 'database' as const,
        filePath,
        content: this.fallbackContent(filePath, state),
        language: this.inferLanguage(filePath),
      };
    });
  }

  private fallbackContent(filePath: string, state: DevFlowStateType): string {
    const projectName = state.contract?.projectName ?? state.companyName;

    if (filePath.endsWith('schema.prisma')) {
      return `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id        String   @id @default(cuid())
  email     String   @unique
  name      String?
  tasks     Task[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model Task {
  id          String   @id @default(cuid())
  title       String
  description String?
  completed   Boolean  @default(false)
  ownerId     String?
  owner       User?    @relation(fields: [ownerId], references: [id])
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([ownerId])
}
`;
    }

    if (filePath.endsWith('.sql')) {
      return `CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  owner_id TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX tasks_owner_id_idx ON tasks(owner_id);
`;
    }

    if (/seed\.(ts|js)$/i.test(filePath)) {
      return `import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.upsert({
    where: { email: 'demo@example.com' },
    update: {},
    create: { email: 'demo@example.com', name: 'Demo User' },
  });

  await prisma.task.create({
    data: {
      title: 'Review ${projectName}',
      description: 'Initial generated seed task',
      ownerId: user.id,
    },
  });
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  });
`;
    }

    return `# Database

This database layer was generated for ${projectName}.

## Models

- User stores application users.
- Task stores assignable work items.

## Operations

Run Prisma migrations, generate the client, and execute the seed script before starting the application.
`;
  }
}
