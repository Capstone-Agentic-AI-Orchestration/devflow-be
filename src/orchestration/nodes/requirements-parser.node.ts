import { Injectable, Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';
import { MemoryService } from '../../memory/memory.service';
import {
  DevFlowStateType,
  RequirementsDocument,
} from '../graph/devflow.state';

// ─── Zod Schema for Structured Output ────────────────────────────────────────

const TechStackSchema = z.object({
  frontend: z.string().describe('Frontend framework or library (e.g. Next.js, React, Vue)'),
  backend: z.string().describe('Backend framework (e.g. NestJS, Express, FastAPI)'),
  database: z.string().describe('Database technology (e.g. PostgreSQL, MongoDB, SQLite)'),
  styling: z.string().describe('Styling approach (e.g. Tailwind CSS, styled-components, CSS Modules)'),
});

const RequirementsSchema = z.object({
  projectType: z
    .string()
    .describe('Category of project, e.g. "SaaS web app", "REST API", "e-commerce platform"'),
  features: z
    .array(z.string())
    .min(1)
    .describe('List of distinct features/capabilities the project must have'),
  techStack: TechStackSchema,
  complexity: z
    .enum(['simple', 'medium', 'complex'])
    .describe('Overall complexity assessment'),
  estimatedFiles: z
    .number()
    .int()
    .positive()
    .describe('Estimated number of source files to generate'),
});

// ─── Node ─────────────────────────────────────────────────────────────────────

@Injectable()
export class RequirementsParserNode {
  private readonly logger = new Logger(RequirementsParserNode.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly memory: MemoryService,
  ) {}

  async execute(
    state: DevFlowStateType,
  ): Promise<Partial<DevFlowStateType>> {
    this.logger.log(`[${state.projectId}] Parsing requirements`);

    try {
      await this.prisma.project.update({
        where: { id: state.projectId },
        data: { status: 'PARSING_REQUIREMENTS' },
      });

      const model = new ChatOpenAI({
        model: 'gpt-4o-mini',
        temperature: 0.2,
      });

      const structuredModel = model.withStructuredOutput(RequirementsSchema);

      const prompt = `You are a software architect analyzing a project brief to extract structured requirements.

Project Brief:
${state.brief}

Preferred Stack Key: ${state.stackKey}

Analyze this brief and produce a structured requirements document. Base the tech stack on the stack key hint, but infer reasonable defaults if not specified.`;

      // Mock Mode bypass
      if (process.env.MOCK_MODE === 'true') {
        const requirements: RequirementsDocument = {
          projectType: 'SaaS Dashboard',
          features: ['User Auth', 'Payments', 'Dashboard'],
          techStack: {
            frontend: 'Next.js',
            backend: 'NestJS',
            database: 'PostgreSQL',
            styling: 'Tailwind'
          },
          complexity: 'simple',
          estimatedFiles: 5,
        };
        return { requirements, complexity: 'simple' };
      }

      const result = await structuredModel.invoke(prompt);

      const requirements: RequirementsDocument = {
        projectType: result.projectType,
        features: result.features,
        techStack: result.techStack,
        complexity: result.complexity,
        estimatedFiles: result.estimatedFiles,
      };

      this.logger.log(
        `[${state.projectId}] Requirements parsed: ${requirements.complexity} complexity, ${requirements.estimatedFiles} estimated files`,
      );

      // ── Derive top-level complexity for Phase 2D parallel fan-out ────────────
      // The graph router reads state.complexity to decide whether to dispatch
      // frontend/backend/database/architecture agents in parallel (Send() API)
      // or keep them sequential. Thresholds:
      //   complex  — > 5 features OR > 10 estimated files
      //   medium   — > 3 features OR > 5 estimated files
      //   simple   — otherwise
      let complexity: 'simple' | 'medium' | 'complex';
      if (requirements.features.length > 5 || requirements.estimatedFiles > 10) {
        complexity = 'complex';
      } else if (requirements.features.length > 3 || requirements.estimatedFiles > 5) {
        complexity = 'medium';
      } else {
        complexity = 'simple';
      }

      // ── Write successful parse as a SKILL for the 'requirements' agent ────────
      // This builds the memory store's understanding of how briefs map to parsed
      // requirements for a given stack + project type. Future runs can reference
      // these entries to self-correct their own parsing output.
      await this.memory.writeSkill({
        agentType: 'requirements',
        systemPrompt: prompt,
        artifactContent: JSON.stringify(requirements, null, 2),
        filePath: `requirements/${state.projectId}.json`,
        projectId: state.projectId,
        stackKey: state.stackKey,
        projectType: requirements.projectType,
      });

      return { requirements, complexity };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${state.projectId}] Requirements parsing failed: ${message}`);

      await this.prisma.project
        .update({
          where: { id: state.projectId },
          data: { status: 'FAILED' },
        })
        .catch(() => undefined);

      return { error: `RequirementsParserNode failed: ${message}` };
    }
  }
}
