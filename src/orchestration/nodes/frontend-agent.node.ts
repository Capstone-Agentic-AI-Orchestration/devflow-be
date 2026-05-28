import { Injectable, Logger } from '@nestjs/common';
import { DevFlowStateType, GeneratedArtifact } from '../graph/devflow.state';
import { MemoryService } from '../../memory/memory.service';
import { EventLogService } from '../../supervisor/event-log.service';
import { GraphLlmProvider } from '../providers/graph-llm.provider';

// ─── Constants ────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior frontend engineer generating production-quality React/Next.js code.
Generate complete, working TypeScript files. Each file must be standalone and well-commented.
Respond ONLY with a JSON array — no prose, no markdown fences.

Each element: { "filePath": string, "content": string, "language": string }`;

// ─── Node ─────────────────────────────────────────────────────────────────────

@Injectable()
export class FrontendAgentNode {
  private readonly logger = new Logger(FrontendAgentNode.name);

  constructor(
    private readonly memory: MemoryService,
    private readonly eventLog: EventLogService,
    private readonly graphLlm: GraphLlmProvider,
  ) {}

  async execute(
    state: DevFlowStateType,
  ): Promise<Partial<DevFlowStateType>> {
    this.logger.log(`[${state.projectId}] Frontend agent generating files`);

    if (!state.contract) {
      return { error: 'FrontendAgentNode: contract is null' };
    }

    // Log STARTED — allSettled inside, so failure here does not block the node.
    await this.eventLog.logStarted(state.projectId, 'frontend_agent');

    try {
      // ── 1. Read relevant memories ──────────────────────────────────────────
      // companyName is included so industry-specific frontend patterns surface
      // alongside stack + feature context.
      const memoryQuery = [
        state.contract.requirements.projectType,
        state.stackKey,
        state.contract.requirements.techStack.frontend,
        state.contract.requirements.features.join(' '),
        state.companyName,
      ]
        .filter(Boolean)
        .join(' ');

      const memories = await this.memory.readRelevant('frontend', memoryQuery);
      const memoryContext = this.memory.formatAsContext(memories);

      // ── 2. Skip-generation check ───────────────────────────────────────────
      // Must run AFTER readRelevant so memory context is still available if the
      // skip threshold is not met. Returns immediately — no LLM tokens consumed.
      const skipCandidate = await this.memory.findSkipCandidate(
        'frontend',
        memoryQuery,
        state.stackKey,
      );

      if (skipCandidate) {
        this.logger.log(
          `[${state.projectId}] Skip-generation: reusing frontend memory artifact (similarity=${skipCandidate.similarity?.toFixed(3)})`,
        );
        const rememberedFilePath = skipCandidate.metadata['filePath'];
        const artifact: GeneratedArtifact = {
          agentType: 'frontend',
          filePath:
            typeof rememberedFilePath === 'string'
              ? rememberedFilePath
              : 'src/app/page.tsx',
          content: skipCandidate.content,
          language: 'typescript',
        };
        return { artifacts: [artifact] };
      }

      // ── 3. Build file list ─────────────────────────────────────────────────
      const frontendFiles = state.contract.fileManifest.filter((f) =>
        /\.(tsx|jsx|css|scss|module\.css)$|README-frontend\.md$/i.test(f),
      );

      const coreFiles = [
        'src/app/page.tsx',
        'src/app/layout.tsx',
        'src/components/ui/Button.tsx',
        'src/components/ui/Card.tsx',
        'src/styles/globals.css',
        'README-frontend.md',
      ];
      const allFrontendFiles = [
        ...new Set([...frontendFiles, ...coreFiles]),
      ].slice(0, 8);

      if (process.env.MOCK_MODE === 'true') {
        const artifacts: GeneratedArtifact[] = [
          {
            agentType: 'frontend',
            filePath: 'src/app/page.tsx',
            content: `export default function Page() { return <div>Mock Frontend for ${state.companyName}</div>; }`,
            language: 'tsx'
          }
        ];
        await this.eventLog.logCompleted(state.projectId, 'frontend_agent', { inputTokens: 0, outputTokens: 0, model: 'mock' });
        return { artifacts };
      }

      // ── 4. LLM call ───────────────────────────────────────────────────────
      const result = await this.graphLlm.generateJson<Array<{
        filePath: string;
        content: string;
        language?: string;
      }>>({
        agentName: 'frontend_agent',
        systemPrompt: memoryContext
          ? `${SYSTEM_PROMPT}\n\nRelevant memory:\n${memoryContext}`
          : SYSTEM_PROMPT,
        userPrompt: `Generate frontend files for this project:

Project: ${state.contract.projectName}
Description: ${state.contract.description}
Tech Stack: ${JSON.stringify(state.contract.requirements.techStack, null, 2)}
Features: ${state.contract.requirements.features.join(', ')}
Acceptance Criteria: ${state.contract.acceptanceCriteria.join('; ')}

Files to generate:
${allFrontendFiles.map((f) => `- ${f}`).join('\n')}

Generate complete, production-quality code for each file. For README-frontend.md, include setup instructions, architecture overview, and component documentation.`,
        expectedShape: 'array',
        maxTokens: 8192,
      });

      const artifacts: GeneratedArtifact[] = result.value.map((item) => ({
        agentType: 'frontend' as const,
        filePath: item.filePath,
        content: item.content,
        language: item.language ?? this.inferLanguage(item.filePath),
      }));

      this.logger.log(
        `[${state.projectId}] Frontend agent generated ${artifacts.length} files (${memories.length} memories injected)`,
      );

      // Log COMPLETED with cost metadata — budget is updated atomically inside.
      await this.eventLog.logCompleted(state.projectId, 'frontend_agent', {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        model: result.model,
      });

      return { artifacts };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${state.projectId}] Frontend agent failed: ${message}`);
      return { error: `FrontendAgentNode failed: ${message}` };
    }
  }

  private inferLanguage(filePath: string): string {
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx')) return 'typescript';
    if (filePath.endsWith('.ts') || filePath.endsWith('.js')) return 'typescript';
    if (filePath.endsWith('.css') || filePath.endsWith('.scss')) return 'css';
    if (filePath.endsWith('.md')) return 'markdown';
    return 'text';
  }
}
