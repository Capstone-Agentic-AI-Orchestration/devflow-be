import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { DevFlowStateType, GeneratedArtifact } from '../graph/devflow.state';
import { MemoryService } from '../../memory/memory.service';
import { EventLogService } from '../../supervisor/event-log.service';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Static system prompt — wrapped in cache_control: ephemeral so Anthropic
 * caches it across sequential calls within the same session.
 * Cost: 0.1× input token price on cache hits.
 */
const SYSTEM_PROMPT = `You are a senior NestJS backend engineer generating production-quality TypeScript code.
Generate complete, working NestJS files with proper decorators, dependency injection, and type safety.
Respond ONLY with a JSON array — no prose, no markdown fences.

Each element: { "filePath": string, "content": string, "language": string }`;

// ─── Node ─────────────────────────────────────────────────────────────────────

@Injectable()
export class BackendAgentNode {
  private readonly logger = new Logger(BackendAgentNode.name);
  private readonly anthropic = new Anthropic();

  constructor(
    private readonly memory: MemoryService,
    private readonly eventLog: EventLogService,
  ) {}

  async execute(
    state: DevFlowStateType,
  ): Promise<Partial<DevFlowStateType>> {
    this.logger.log(`[${state.projectId}] Backend agent generating files`);

    if (!state.contract) {
      return { error: 'BackendAgentNode: contract is null' };
    }

    // Log STARTED — allSettled inside, so failure here does not block the node.
    await this.eventLog.logStarted(state.projectId, 'backend_agent');

    try {
      // ── 1. Read relevant memories before LLM call ──────────────────────────
      // companyName is included so domain-specific backend patterns (e.g.
      // "fintech NestJS CQRS") surface alongside the stack and feature context.
      const memoryQuery = [
        state.contract.requirements.projectType,
        state.stackKey,
        state.contract.requirements.features.join(' '),
        state.companyName,
      ]
        .filter(Boolean)
        .join(' ');

      const memories = await this.memory.readRelevant('backend', memoryQuery);
      const memoryContext = this.memory.formatAsContext(memories);

      // ── 2. Skip-generation check ───────────────────────────────────────────
      // Must run AFTER readRelevant so memory context is still available if the
      // skip threshold is not met. Returns immediately — no LLM tokens consumed.
      const skipCandidate = await this.memory.findSkipCandidate(
        'backend',
        memoryQuery,
        state.stackKey,
      );

      if (skipCandidate) {
        this.logger.log(
          `[${state.projectId}] Skip-generation: reusing backend memory artifact (similarity=${skipCandidate.similarity?.toFixed(3)})`,
        );
        const artifact: GeneratedArtifact = {
          agentType: 'backend',
          filePath:
            (skipCandidate.metadata as Record<string, unknown>)['filePath'] as string ??
            'src/generated/artifact.ts',
          content: skipCandidate.content,
          language: 'typescript',
        };
        return { artifacts: [artifact] };
      }

      // ── 3. Build file list ─────────────────────────────────────────────────
      const backendFiles = state.contract.fileManifest.filter((f) =>
        /\.(module|controller|service|dto|guard|pipe|interceptor)\.ts$|README-backend\.md$/i.test(f),
      );

      const coreFiles = [
        'src/app.module.ts',
        'src/main.ts',
        'src/modules/core/core.module.ts',
        'src/modules/core/core.controller.ts',
        'src/modules/core/core.service.ts',
        'src/modules/core/dto/create-item.dto.ts',
        'README-backend.md',
      ];
      const allBackendFiles = [
        ...new Set([...backendFiles, ...coreFiles]),
      ].slice(0, 8);

      if (process.env.MOCK_MODE === 'true') {
        const artifacts: GeneratedArtifact[] = [
          {
            agentType: 'backend',
            filePath: 'src/main.ts',
            content: `export function bootstrap() {\n  console.log("Mock Backend Running!");\n}`,
            language: 'typescript'
          }
        ];
        await this.eventLog.logCompleted(state.projectId, 'backend_agent', { inputTokens: 0, outputTokens: 0, model: 'mock' });
        return { artifacts };
      }

      // ── 4. Call LLM with prompt caching ───────────────────────────────────
      const response = await this.anthropic.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 8192,
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            // Anthropic prompt caching — mandatory per hard constraints
            cache_control: { type: 'ephemeral' },
          },
          ...(memoryContext
            ? [{ type: 'text' as const, text: memoryContext }]
            : []),
        ],
        messages: [
          {
            role: 'user',
            content: `Generate NestJS backend files for this project:

Project: ${state.contract.projectName}
Description: ${state.contract.description}
Tech Stack: ${JSON.stringify(state.contract.requirements.techStack, null, 2)}
Features: ${state.contract.requirements.features.join(', ')}
Acceptance Criteria: ${state.contract.acceptanceCriteria.join('; ')}

Files to generate:
${allBackendFiles.map((f) => `- ${f}`).join('\n')}

Generate complete NestJS code with:
- Proper @Module, @Controller, @Injectable decorators
- Full CRUD operations where applicable
- Zod-validated DTOs
- Swagger/OpenAPI decorators where appropriate
- For README-backend.md: include API documentation, setup guide, and architecture notes`,
          },
        ],
      });

      // ── 5. Parse response ──────────────────────────────────────────────────
      const rawContent = response.content[0];
      if (rawContent.type !== 'text') {
        throw new Error('Unexpected response type from Anthropic API');
      }

      const jsonText = rawContent.text
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .trim();

      const parsed = JSON.parse(jsonText) as Array<{
        filePath: string;
        content: string;
        language: string;
      }>;

      const artifacts: GeneratedArtifact[] = parsed.map((item) => ({
        agentType: 'backend' as const,
        filePath: item.filePath,
        content: item.content,
        language: item.language ?? 'typescript',
      }));

      this.logger.log(
        `[${state.projectId}] Backend agent generated ${artifacts.length} files (${memories.length} memories injected)`,
      );

      // Log COMPLETED with cost metadata — budget is updated atomically inside.
      const usage = response.usage;
      await this.eventLog.logCompleted(state.projectId, 'backend_agent', {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        model: 'claude-haiku-4-5',
      });

      return { artifacts };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${state.projectId}] Backend agent failed: ${message}`);
      return { error: `BackendAgentNode failed: ${message}` };
    }
  }
}
