import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';
import { GeneratedArtifact, ProjectContract } from '../orchestration/graph/devflow.state';

// Types

export type AgentMemoryType = 'SKILL' | 'PATTERN' | 'MISTAKE';
export type AgentMemoryScope = 'AGENT_PRIVATE' | 'PROJECT_CORE' | 'PROJECT_AGENT' | 'GLOBAL_PATTERN';
export type ProjectCoreApprovalSource = 'GATE_1' | 'GATE_2' | 'HUMAN_REVIEW';

type MemoryApprovalSource = ProjectCoreApprovalSource | 'VALIDATOR' | 'SYSTEM' | 'GATE_2_LEGACY';

export interface MemoryRecord {
  id: string;
  agentType: string;
  agentProfileId: string | null;
  scope: AgentMemoryScope;
  memoryType: AgentMemoryType;
  content: string;
  metadata: Record<string, unknown>;
  projectId: string | null;
  sourceType: string | null;
  importance: number;
  lastUsedAt: Date | null;
  usageCount: number;
  expiresAt: Date | null;
  approvedAt: Date | null;
  approvalSource: string | null;
  createdAt: Date;
  similarity?: number;
}

interface MemoryRow {
  id: string;
  agentType: string;
  agentProfileId?: string | null;
  scope?: string | null;
  memoryType: string;
  content: string;
  metadata: unknown;
  projectId: string | null;
  sourceType?: string | null;
  importance?: number | null;
  lastUsedAt?: Date | null;
  usageCount?: number | null;
  expiresAt?: Date | null;
  approvedAt?: Date | null;
  approvalSource?: string | null;
  createdAt: Date;
  similarity: number;
}

export interface LayeredAgentMemories {
  projectCore: MemoryRecord[];
  projectAgent: MemoryRecord[];
  agentPrivate: MemoryRecord[];
  mistakes: MemoryRecord[];
  globalPatterns: MemoryRecord[];
}

export interface AgentMemoryContext {
  layers: LayeredAgentMemories;
  context: string;
  total: number;
}

export interface ReadForAgentInput {
  agentType: string;
  projectId: string;
  query: string;
  topK?: number;
}

export interface WriteSkillInput {
  agentType: string;
  /** The static system prompt used by the agent */
  systemPrompt: string;
  /** The generated artifact content */
  artifactContent: string;
  filePath: string;
  projectId: string;
  stackKey: string;
  projectType: string;
  scope?: AgentMemoryScope;
  sourceType?: string;
  importance?: number;
  approvalSource?: MemoryApprovalSource;
}

export interface WritePatternInput {
  contract: ProjectContract;
  projectId: string;
  stackKey: string;
  scope?: AgentMemoryScope;
  sourceType?: string;
  approvalSource?: MemoryApprovalSource;
}

export interface WriteMistakeInput {
  agentType: string;
  /** The artifact or contract content that was rejected */
  rejectedContent: string;
  rejectionNotes: string;
  projectId: string;
  gateType: 'GATE_1' | 'GATE_2';
  stackKey: string;
  scope?: AgentMemoryScope;
  sourceType?: string;
  approvalSource?: MemoryApprovalSource;
}

export interface WriteProjectCoreMemoryInput {
  projectId: string;
  content: string;
  metadata?: Record<string, unknown>;
  sourceType: string;
  approvalSource: ProjectCoreApprovalSource;
  agentType?: string;
  memoryType?: AgentMemoryType;
  importance?: number;
}

@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);

  /** Similarity threshold for the skip-generation path. */
  static readonly SKIP_THRESHOLD = 0.92;

  /** Number of memories to inject per agent invocation. */
  static readonly TOP_K = 3;

  constructor(
    private readonly prisma: PrismaService,
    private readonly embedding: EmbeddingService,
  ) {}

  // Reads

  /**
   * Legacy reader retained for older callers/tests. Prefer readForAgent() for
   * project-core + agent-private layering.
   */
  async readRelevant(
    agentType: string,
    query: string,
    topK: number = MemoryService.TOP_K,
  ): Promise<MemoryRecord[]> {
    try {
      return await this.queryMemories(
        query,
        Prisma.sql`
          "agentType" = ${agentType}
          AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
        `,
        topK,
      );
    } catch (error) {
      this.logger.warn(
        `MemoryService.readRelevant failed for ${agentType}: ${this.errorMessage(error)} - continuing without memory context`,
      );
      return [];
    }
  }

  /**
   * Read layered memory for one agent invocation:
   * - approved PROJECT_CORE memory for the project, shared by all agents
   * - PROJECT_AGENT memory for this project + agent
   * - AGENT_PRIVATE global memory for this agent
   * - MISTAKE memories to avoid repeat failures
   * - approved GLOBAL_PATTERN memories
   */
  async readForAgent(input: ReadForAgentInput): Promise<LayeredAgentMemories> {
    const topK = input.topK ?? MemoryService.TOP_K;

    try {
      const vectorSql = await this.vectorSqlFor(input.query);
      const [
        projectCore,
        projectAgent,
        agentPrivate,
        mistakes,
        globalPatterns,
      ] = await Promise.all([
        this.queryMemoriesWithVector(
          vectorSql,
          Prisma.sql`
            "scope" = 'PROJECT_CORE'::"AgentMemoryScope"
            AND "projectId" = ${input.projectId}
            AND "approvedAt" IS NOT NULL
            AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
          `,
          topK,
        ),
        this.queryMemoriesWithVector(
          vectorSql,
          Prisma.sql`
            "scope" = 'PROJECT_AGENT'::"AgentMemoryScope"
            AND "agentType" = ${input.agentType}
            AND "projectId" = ${input.projectId}
            AND "memoryType" <> 'MISTAKE'::"AgentMemoryType"
            AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
          `,
          topK,
        ),
        this.queryMemoriesWithVector(
          vectorSql,
          Prisma.sql`
            "scope" = 'AGENT_PRIVATE'::"AgentMemoryScope"
            AND "agentType" = ${input.agentType}
            AND "projectId" IS NULL
            AND "memoryType" <> 'MISTAKE'::"AgentMemoryType"
            AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
          `,
          topK,
        ),
        this.queryMemoriesWithVector(
          vectorSql,
          Prisma.sql`
            "agentType" = ${input.agentType}
            AND "memoryType" = 'MISTAKE'::"AgentMemoryType"
            AND (
              ("scope" = 'PROJECT_AGENT'::"AgentMemoryScope" AND "projectId" = ${input.projectId})
              OR ("scope" = 'AGENT_PRIVATE'::"AgentMemoryScope" AND "projectId" IS NULL)
            )
            AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
          `,
          topK,
        ),
        this.queryMemoriesWithVector(
          vectorSql,
          Prisma.sql`
            "scope" = 'GLOBAL_PATTERN'::"AgentMemoryScope"
            AND "approvedAt" IS NOT NULL
            AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
          `,
          topK,
        ),
      ]);

      return {
        projectCore,
        projectAgent,
        agentPrivate,
        mistakes,
        globalPatterns,
      };
    } catch (error) {
      this.logger.warn(
        `MemoryService.readForAgent failed for ${input.agentType}/${input.projectId}: ${this.errorMessage(error)} - continuing without memory context`,
      );
      return this.emptyLayers();
    }
  }

  async buildContextForAgent(input: ReadForAgentInput): Promise<AgentMemoryContext> {
    const layers = await this.readForAgent(input);
    const context = this.formatLayeredContext(layers);
    const total =
      layers.projectCore.length +
      layers.projectAgent.length +
      layers.agentPrivate.length +
      layers.mistakes.length +
      layers.globalPatterns.length;
    return { layers, context, total };
  }

  /**
   * Format retrieved memories as a flat system prompt injection block.
   * Retained for compatibility with older callers.
   */
  formatAsContext(memories: MemoryRecord[]): string {
    if (memories.length === 0) return '';

    const lines = memories.map((m, i) => this.formatMemoryLine(m, i));

    return [
      '--- AGENT MEMORY CONTEXT (injected - do not reproduce verbatim) ---',
      ...lines,
      '--- END MEMORY CONTEXT ---',
    ].join('\n\n');
  }

  formatLayeredContext(layers: LayeredAgentMemories): string {
    const sections = [
      this.formatSection('PROJECT CORE MEMORY (approved shared project truth)', layers.projectCore),
      this.formatSection('PROJECT-SPECIFIC AGENT MEMORY', layers.projectAgent),
      this.formatSection('AGENT PRIVATE MEMORY', layers.agentPrivate),
      this.formatSection('KNOWN MISTAKES TO AVOID', layers.mistakes),
      this.formatSection('GLOBAL APPROVED PATTERNS', layers.globalPatterns),
    ].filter(Boolean);

    if (sections.length === 0) return '';

    return [
      '--- LAYERED AGENT MEMORY CONTEXT (injected - do not reproduce verbatim) ---',
      ...sections,
      '--- END LAYERED AGENT MEMORY CONTEXT ---',
    ].join('\n\n');
  }

  // Writes

  /**
   * Record a successful agent skill. Default scope is PROJECT_AGENT so raw
   * project artifacts do not leak into another project's prompts.
   */
  async writeSkills(artifacts: GeneratedArtifact[], inputs: Omit<WriteSkillInput, 'agentType' | 'artifactContent' | 'filePath'>[]): Promise<void> {
    const pairs = artifacts.map((artifact, i) => ({
      artifact,
      meta: inputs[i] ?? inputs[0],
    }));

    await Promise.allSettled(
      pairs.map(({ artifact, meta }) =>
        this.writeSkill({
          agentType: artifact.agentType,
          systemPrompt: '',
          artifactContent: artifact.content,
          filePath: artifact.filePath,
          projectId: meta.projectId,
          stackKey: meta.stackKey,
          projectType: meta.projectType,
          scope: meta.scope,
          sourceType: meta.sourceType,
          importance: meta.importance,
          approvalSource: meta.approvalSource,
        }),
      ),
    );
  }

  async writeSkill(input: WriteSkillInput): Promise<void> {
    const content = [
      `FILE: ${input.filePath}`,
      `STACK: ${input.stackKey}`,
      `TYPE: ${input.projectType}`,
      '',
      input.artifactContent,
    ].join('\n');

    await this.writeMemory({
      agentType: input.agentType,
      memoryType: 'SKILL',
      scope: input.scope ?? 'PROJECT_AGENT',
      content,
      metadata: {
        filePath: input.filePath,
        stackKey: input.stackKey,
        projectType: input.projectType,
      },
      projectId: input.projectId,
      sourceType: input.sourceType ?? 'agent_skill',
      importance: input.importance ?? 0.6,
      approvalSource: input.approvalSource ?? null,
      approvedAt: this.approvedAt(input.approvalSource),
    });
  }

  /**
   * Record a reusable successful contract pattern. Gate 2 callers should pass
   * approvalSource='GATE_2' so the pattern is clearly human approved.
   */
  async writePattern(input: WritePatternInput): Promise<void> {
    const content = [
      `PROJECT TYPE: ${input.contract.requirements.projectType}`,
      `STACK KEY: ${input.stackKey}`,
      `COMPLEXITY: ${input.contract.requirements.complexity}`,
      `FILES: ${input.contract.fileManifest.join(', ')}`,
      `CRITERIA: ${input.contract.acceptanceCriteria.join('; ')}`,
    ].join('\n');

    await this.writeMemory({
      agentType: 'contract',
      memoryType: 'PATTERN',
      scope: input.scope ?? 'GLOBAL_PATTERN',
      content,
      metadata: {
        stackKey: input.stackKey,
        projectType: input.contract.requirements.projectType,
        complexity: input.contract.requirements.complexity,
        fileCount: input.contract.fileManifest.length,
      },
      projectId: input.projectId,
      sourceType: input.sourceType ?? 'contract_pattern',
      importance: 0.8,
      approvalSource: input.approvalSource ?? null,
      approvedAt: this.approvedAt(input.approvalSource),
    });
  }

  /**
   * Record a rejected artifact or contract. Gate rejections pass approvalSource
   * GATE_1/GATE_2; validator failures remain private advisory memories.
   */
  async writeMistake(input: WriteMistakeInput): Promise<void> {
    const content = [
      `GATE: ${input.gateType}`,
      `AGENT: ${input.agentType}`,
      `STACK: ${input.stackKey}`,
      `REJECTION REASON: ${input.rejectionNotes}`,
      '',
      'REJECTED CONTENT:',
      input.rejectedContent.slice(0, 2000),
    ].join('\n');

    await this.writeMemory({
      agentType: input.agentType,
      memoryType: 'MISTAKE',
      scope: input.scope ?? 'PROJECT_AGENT',
      content,
      metadata: {
        gateType: input.gateType,
        stackKey: input.stackKey,
        rejectionNotes: input.rejectionNotes,
      },
      projectId: input.projectId,
      sourceType: input.sourceType ?? 'rejected_output',
      importance: 0.9,
      approvalSource: input.approvalSource ?? null,
      approvedAt: this.approvedAt(input.approvalSource),
    });
  }

  /**
   * Project core memory is shared by all agents. This is intentionally gated:
   * only human-approved sources can promote content into shared project truth.
   */
  async writeProjectCoreMemory(input: WriteProjectCoreMemoryInput): Promise<void> {
    this.assertProjectCoreApproval(input.approvalSource);

    await this.writeMemory({
      agentType: input.agentType ?? 'project_core',
      memoryType: input.memoryType ?? 'PATTERN',
      scope: 'PROJECT_CORE',
      content: input.content,
      metadata: input.metadata ?? {},
      projectId: input.projectId,
      sourceType: input.sourceType,
      importance: input.importance ?? 1,
      approvalSource: input.approvalSource,
      approvedAt: new Date(),
    });
  }

  // Skip-generation

  async findSkipCandidate(
    agentType: string,
    fileQuery: string,
    stackKey: string,
    projectId?: string,
  ): Promise<MemoryRecord | null> {
    const results = projectId
      ? await this.queryMemories(
          fileQuery,
          Prisma.sql`
            "agentType" = ${agentType}
            AND "memoryType" = 'SKILL'::"AgentMemoryType"
            AND (
              ("scope" = 'PROJECT_AGENT'::"AgentMemoryScope" AND "projectId" = ${projectId})
              OR ("scope" = 'AGENT_PRIVATE'::"AgentMemoryScope" AND "projectId" IS NULL)
            )
            AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
          `,
          1,
        )
      : await this.readRelevant(agentType, fileQuery, 1);
    const top = results[0];

    if (
      top &&
      top.memoryType === 'SKILL' &&
      (top.similarity ?? 0) >= MemoryService.SKIP_THRESHOLD &&
      top.metadata['stackKey'] === stackKey
    ) {
      this.logger.log(
        `Skip-generation candidate found for ${agentType}/${fileQuery} (similarity=${top.similarity?.toFixed(3)})`,
      );
      return top;
    }

    return null;
  }

  // Internal

  private async queryMemories(query: string, where: Prisma.Sql, topK: number): Promise<MemoryRecord[]> {
    return this.queryMemoriesWithVector(await this.vectorSqlFor(query), where, topK);
  }

  private async queryMemoriesWithVector(vectorSql: string, where: Prisma.Sql, topK: number): Promise<MemoryRecord[]> {
    const rows = await this.prisma.$queryRaw<MemoryRow[]>(Prisma.sql`
      SELECT
        id,
        "agentType",
        "agentProfileId",
        scope,
        "memoryType",
        content,
        metadata,
        "projectId",
        "sourceType",
        importance,
        "lastUsedAt",
        "usageCount",
        "expiresAt",
        "approvedAt",
        "approvalSource",
        "createdAt",
        1 - (embedding <=> ${vectorSql}::vector) AS similarity
      FROM agent_memories
      WHERE ${where}
      ORDER BY embedding <=> ${vectorSql}::vector
      LIMIT ${topK}
    `);

    return rows.map((row) => this.mapRow(row));
  }

  private async vectorSqlFor(query: string): Promise<string> {
    const queryVector = await this.embedding.embed(query);
    return EmbeddingService.toSql(queryVector);
  }

  private async writeMemory(input: {
    agentType: string;
    agentProfileId?: string | null;
    scope: AgentMemoryScope;
    memoryType: AgentMemoryType;
    content: string;
    metadata: Record<string, unknown>;
    projectId: string | null;
    sourceType?: string | null;
    importance?: number;
    expiresAt?: Date | null;
    approvedAt?: Date | null;
    approvalSource?: string | null;
  }): Promise<void> {
    try {
      const vector = await this.embedding.embed(input.content);
      const vectorSql = EmbeddingService.toSql(vector);

      await this.prisma.$executeRaw`
        INSERT INTO agent_memories (
          id,
          "agentType",
          "agentProfileId",
          scope,
          "memoryType",
          content,
          embedding,
          metadata,
          "projectId",
          "sourceType",
          importance,
          "expiresAt",
          "approvedAt",
          "approvalSource",
          "createdAt"
        )
        VALUES (
          gen_random_uuid()::text,
          ${input.agentType},
          ${input.agentProfileId ?? null},
          ${input.scope}::"AgentMemoryScope",
          ${input.memoryType}::"AgentMemoryType",
          ${input.content},
          ${vectorSql}::vector,
          ${JSON.stringify(input.metadata)}::jsonb,
          ${input.projectId},
          ${input.sourceType ?? null},
          ${input.importance ?? 0.5},
          ${input.expiresAt ?? null},
          ${input.approvedAt ?? null},
          ${input.approvalSource ?? null},
          NOW()
        )
      `;

      this.logger.log(
        `Memory written: scope=${input.scope} type=${input.memoryType} agent=${input.agentType} project=${input.projectId ?? 'global'}`,
      );
    } catch (error) {
      this.logger.error(
        `MemoryService.writeMemory failed: ${this.errorMessage(error)}`,
      );
    }
  }

  private formatSection(title: string, memories: MemoryRecord[]): string {
    if (memories.length === 0) return '';
    return [
      `### ${title}`,
      ...memories.map((memory, index) => this.formatMemoryLine(memory, index)),
    ].join('\n\n');
  }

  private formatMemoryLine(memory: MemoryRecord, index: number): string {
    const label = memory.memoryType === 'MISTAKE' ? 'AVOID' : 'REFERENCE';
    return [
      `[${label} ${index + 1}] (${memory.agentType} / ${memory.scope} / ${memory.memoryType}, score=${(memory.similarity ?? 0).toFixed(3)})`,
      memory.content.slice(0, 800),
    ].join('\n');
  }

  private mapRow(row: MemoryRow): MemoryRecord {
    return {
      id: row.id,
      agentType: row.agentType,
      agentProfileId: row.agentProfileId ?? null,
      scope: this.scopeFrom(row.scope),
      memoryType: row.memoryType as AgentMemoryType,
      content: row.content,
      metadata: (row.metadata as Record<string, unknown>) ?? {},
      projectId: row.projectId,
      sourceType: row.sourceType ?? null,
      importance: row.importance ?? 0.5,
      lastUsedAt: row.lastUsedAt ?? null,
      usageCount: row.usageCount ?? 0,
      expiresAt: row.expiresAt ?? null,
      approvedAt: row.approvedAt ?? null,
      approvalSource: row.approvalSource ?? null,
      createdAt: row.createdAt,
      similarity: row.similarity,
    };
  }

  private scopeFrom(scope: string | null | undefined): AgentMemoryScope {
    if (
      scope === 'PROJECT_CORE' ||
      scope === 'PROJECT_AGENT' ||
      scope === 'AGENT_PRIVATE' ||
      scope === 'GLOBAL_PATTERN'
    ) {
      return scope;
    }

    return 'AGENT_PRIVATE';
  }

  private approvedAt(source: MemoryApprovalSource | null | undefined): Date | null {
    return source ? new Date() : null;
  }

  private assertProjectCoreApproval(source: ProjectCoreApprovalSource): void {
    if (source !== 'GATE_1' && source !== 'GATE_2' && source !== 'HUMAN_REVIEW') {
      throw new Error('Project core memory requires human approval through Gate 1, Gate 2, or HUMAN_REVIEW.');
    }
  }

  private emptyLayers(): LayeredAgentMemories {
    return {
      projectCore: [],
      projectAgent: [],
      agentPrivate: [],
      mistakes: [],
      globalPatterns: [],
    };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
