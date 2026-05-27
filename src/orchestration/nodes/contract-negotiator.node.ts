import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaService } from '../../prisma/prisma.service';
import { DevFlowStateType, ProjectContract } from '../graph/devflow.state';
import { MemoryService } from '../../memory/memory.service';
import { EventLogService } from '../../supervisor/event-log.service';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * ContractNegotiator uses claude-sonnet-4-6 (Phase 2D model tiering decision).
 * Rationale: contract quality determines ALL downstream artifact quality.
 * A well-formed fileManifest and acceptance criteria prevent validator failures
 * and reduce retries — the Sonnet cost at this single upstream node pays for
 * itself by avoiding 2–3 haiku retries on code generation nodes.
 */
const CONTRACT_MODEL = 'claude-sonnet-4-6';

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
  private readonly anthropic = new Anthropic();

  constructor(
    private readonly prisma: PrismaService,
    private readonly memory: MemoryService,
    private readonly eventLog: EventLogService,
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

      // ── 2. LLM call with prompt caching ───────────────────────────────────
      const response = await this.anthropic.messages.create({
        model: CONTRACT_MODEL,
        max_tokens: 4096,
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
          ...(memoryContext
            ? [{ type: 'text' as const, text: memoryContext }]
            : []),
        ],
        messages: [
          {
            role: 'user',
            content: `Create a complete project contract for the following:

Company: ${state.companyName}
Project ID: ${state.projectId}

Original Brief:
${state.brief}

Parsed Requirements:
${requirementsSummary}

Produce a fileManifest that lists every file that will be generated (frontend, backend, database files, and architecture docs).
Include 8–20 files depending on complexity. Use realistic relative paths (e.g. "src/app/page.tsx", "src/modules/users/users.service.ts").
Produce 5–10 acceptance criteria as clear, testable statements.`,
          },
        ],
      });

      // ── 3. Parse ───────────────────────────────────────────────────────────
      const rawContent = response.content[0];
      if (rawContent.type !== 'text') {
        throw new Error('Unexpected response type from Anthropic API');
      }

      const jsonText = rawContent.text
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .trim();

      const parsed = JSON.parse(jsonText) as Record<string, unknown>;

      const contract: ProjectContract = {
        projectId: state.projectId,
        projectName: typeof parsed['projectName'] === 'string' ? parsed['projectName'] : `${state.companyName} Project`,
        description: typeof parsed['description'] === 'string' ? parsed['description'] : state.brief,
        requirements: state.requirements,
        fileManifest: Array.isArray(parsed['fileManifest'])
          ? (parsed['fileManifest'] as string[])
          : [],
        acceptanceCriteria: Array.isArray(parsed['acceptanceCriteria'])
          ? (parsed['acceptanceCriteria'] as string[])
          : [],
        lockedAt: new Date().toISOString(),
      };

      this.logger.log(
        `[${state.projectId}] Contract negotiated: ${contract.fileManifest.length} files in manifest (${memories.length} patterns referenced)`,
      );

      // Log COMPLETED with cost metadata — budget is updated atomically inside.
      const usage = response.usage;
      // Log COMPLETED — model field drives cost attribution in RunSupervisorService.
      await this.eventLog.logCompleted(state.projectId, 'contract_negotiator', {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        model: CONTRACT_MODEL, // claude-sonnet-4-6 per Phase 2D tiering
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
}
