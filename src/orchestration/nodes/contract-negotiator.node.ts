import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DevFlowStateType, ProjectContract } from '../graph/devflow.state';
import { MemoryService } from '../../memory/memory.service';
import { EventLogService } from '../../supervisor/event-log.service';
import { GraphLlmProvider } from '../providers/graph-llm.provider';

// ─── Constants ────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior software architect producing a detailed project contract.
You respond ONLY with a valid JSON object — no markdown fences, no prose outside the JSON.

The JSON must match this exact shape:
{
  "projectId": string,
  "projectName": string,
  "description": string,
  "requirements": <the exact requirements object passed in>,
  "fileManifest": string[],
  "acceptanceCriteria": string[],
  "lockedAt": string
}`;

// ─── Node ─────────────────────────────────────────────────────────────────────

@Injectable()
export class ContractNegotiatorNode {
  private readonly logger = new Logger(ContractNegotiatorNode.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly memory: MemoryService,
    private readonly eventLog: EventLogService,
    private readonly graphLlm: GraphLlmProvider,
  ) {}

  async execute(
    state: DevFlowStateType,
  ): Promise<Partial<DevFlowStateType>> {
    this.logger.log(`[${state.projectId}] Negotiating project contract`);

    if (!state.requirements) {
      return { error: 'ContractNegotiatorNode: requirements is null' };
    }

    // Log STARTED — allSettled inside, so failure here does not block the node.
    await this.eventLog.logStarted(state.projectId, 'contract_negotiator');

    try {
      await this.prisma.project.update({
        where: { id: state.projectId },
        data: { status: 'NEGOTIATING_CONTRACT' },
      });

      // ── 1. Read relevant patterns from memory ──────────────────────────────
      // companyName enriches the query so industry-specific contract patterns
      // (e.g. "fintech NestJS SaaS") surface higher than generic ones.
      const memoryQuery = [
        state.requirements.projectType,
        state.stackKey,
        state.requirements.complexity,
        state.requirements.features.join(' '),
        state.companyName,
      ]
        .filter(Boolean)
        .join(' ');

      const memories = await this.memory.readRelevant('contract', memoryQuery);
      const memoryContext = this.memory.formatAsContext(memories);

      const requirementsSummary = JSON.stringify(state.requirements, null, 2);

      if (process.env.MOCK_MODE === 'true') {
        const contract: ProjectContract = {
          projectId: state.projectId,
          projectName: state.companyName.replace(/[^a-zA-Z]/g, '') + 'App',
          description: 'Mocked contract for basic fullstack application',
          requirements: state.requirements,
          fileManifest: ['src/app/page.tsx', 'src/main.ts', 'schema.prisma'],
          acceptanceCriteria: ['Must compile', 'Must pass mock tests'],
          lockedAt: new Date().toISOString()
        };
        await this.eventLog.logCompleted(state.projectId, 'contract_negotiator', {
          inputTokens: 0,
          outputTokens: 0,
          model: 'mock',
        });
        return { contract };
      }

      // ── 2. LLM call ───────────────────────────────────────────────────────
      const result = await this.graphLlm.generateJson<Record<string, unknown>>({
        agentName: 'contract_negotiator',
        systemPrompt: memoryContext
          ? `${SYSTEM_PROMPT}\n\nRelevant memory:\n${memoryContext}`
          : SYSTEM_PROMPT,
        userPrompt: `Create a complete project contract for the following:

Company: ${state.companyName}
Project ID: ${state.projectId}

Original Brief:
${state.brief}

Parsed Requirements:
${requirementsSummary}

Produce a fileManifest that lists every file that will be generated (frontend, backend, database files, and architecture docs).
Include 8–20 files depending on complexity. Use realistic relative paths (e.g. "src/app/page.tsx", "src/modules/users/users.service.ts").
Produce 5–10 acceptance criteria as clear, testable statements.`,
        expectedShape: 'object',
        maxTokens: 4096,
      });

      const parsed = result.value;

      const rawFileManifest = Array.isArray(parsed['fileManifest'])
        ? (parsed['fileManifest'] as unknown[]).filter((filePath): filePath is string => typeof filePath === 'string')
        : [];

      const contract: ProjectContract = {
        projectId: state.projectId,
        projectName: typeof parsed['projectName'] === 'string' ? parsed['projectName'] : `${state.companyName} Project`,
        description: typeof parsed['description'] === 'string' ? parsed['description'] : state.brief,
        requirements: state.requirements,
        fileManifest: this.normalizeFileManifest(rawFileManifest),
        acceptanceCriteria: Array.isArray(parsed['acceptanceCriteria'])
          ? (parsed['acceptanceCriteria'] as string[])
          : [],
        lockedAt: new Date().toISOString(),
      };

      this.logger.log(
        `[${state.projectId}] Contract negotiated: ${contract.fileManifest.length} files in manifest (${memories.length} patterns referenced)`,
      );

      // Log COMPLETED with cost metadata — budget is updated atomically inside.
      await this.eventLog.logCompleted(state.projectId, 'contract_negotiator', {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        model: result.model,
      });

      return { contract };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${state.projectId}] Contract negotiation failed: ${message}`);

      await this.prisma.project
        .update({
          where: { id: state.projectId },
          data: { status: 'FAILED' },
        })
        .catch(() => undefined);

      return { error: `ContractNegotiatorNode failed: ${message}` };
    }
  }

  private normalizeFileManifest(fileManifest: string[]): string[] {
    const coreFiles = [
      'src/app/page.tsx',
      'src/app/layout.tsx',
      'src/components/ui/Button.tsx',
      'src/components/ui/Card.tsx',
      'src/styles/globals.css',
      'README-frontend.md',
      'src/app.module.ts',
      'src/main.ts',
      'src/modules/core/core.module.ts',
      'src/modules/core/core.controller.ts',
      'src/modules/core/core.service.ts',
      'src/modules/core/dto/create-item.dto.ts',
      'README-backend.md',
      'prisma/schema.prisma',
      'prisma/migrations/0001_initial.sql',
      'prisma/seed.ts',
      'README-database.md',
      'ARCHITECTURE.md',
      'API.md',
      'DEPLOYMENT.md',
    ];
    const supportedFile = (filePath: string) =>
      /\.(tsx|jsx|css|scss|module\.css|module\.ts|controller\.ts|service\.ts|dto\.ts|guard\.ts|pipe\.ts|interceptor\.ts|prisma|sql|md)$/i.test(filePath) ||
      /seed\.(ts|js)$/i.test(filePath);

    return [...new Set([...coreFiles, ...fileManifest.filter(supportedFile)])].slice(0, 24);
  }
}
