import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';
import { GeneratedArtifact, ProjectContract } from '../orchestration/graph/devflow.state';

// ─── Types ────────────────────────────────────────────────────────────────────

export type AgentMemoryType = 'SKILL' | 'PATTERN' | 'MISTAKE';

export interface MemoryRecord {
  id: string;
  agentType: string;
  memoryType: AgentMemoryType;
  content: string;
  metadata: Record<string, unknown>;
  projectId: string | null;
  createdAt: Date;
  /** Cosine similarity score — only present on search results */
  similarity?: number;
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
}

export interface WritePatternInput {
  contract: ProjectContract;
  projectId: string;
  stackKey: string;
}

export interface WriteMistakeInput {
  agentType: string;
  /** The artifact or contract content that was rejected */
  rejectedContent: string;
  rejectionNotes: string;
  projectId: string;
  gateType: 'GATE_1' | 'GATE_2';
  stackKey: string;
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * MemoryService — reads and writes agent memories backed by pgvector.
 *
 * Write policy (Option A — decided 2026-04-26):
 *   - SKILL + PATTERN entries are written ONLY on Gate 2 approval (DELIVERED path)
 *   - MISTAKE entries are written on Gate 1 OR Gate 2 rejection
 *
 * Read policy:
 *   - Each agent node calls readRelevant() before execute()
 *   - Top-3 memories by cosine similarity are injected into the system prompt
 */
@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);

  /** Similarity threshold for the skip-generation path (Phase 2D) */
  static readonly SKIP_THRESHOLD = 0.92;

  /** Number of memories to inject per agent invocation */
  static readonly TOP_K = 3;

  constructor(
    private readonly prisma: PrismaService,
    private readonly embedding: EmbeddingService,
  ) {}

  // ─── Read ──────────────────────────────────────────────────────────────────

  /**
   * Retrieve the top-K most similar memories for a given agent and query.
   * Called by each agent node before its LLM call to inject context.
   *
   * @param agentType  - Agent partition (e.g. 'backend', 'frontend')
   * @param query      - Free-text query derived from the current task context
   * @param topK       - Number of results to return (default: 3)
   */
  async readRelevant(
    agentType: string,
    query: string,
    topK: number = MemoryService.TOP_K,
  ): Promise<MemoryRecord[]> {
    try {
      const queryVector = await this.embedding.embed(query);
      const vectorSql = EmbeddingService.toSql(queryVector);

      // pgvector cosine distance operator: <=> (lower = more similar)
      // We convert to similarity: 1 - distance
      const rows = await this.prisma.$queryRaw<
        Array<{
          id: string;
          agentType: string;
          memoryType: string;
          content: string;
          metadata: unknown;
          projectId: string | null;
          createdAt: Date;
          similarity: number;
        }>
      >`
        SELECT
          id,
          "agentType",
          "memoryType",
          content,
          metadata,
          "projectId",
          "createdAt",
          1 - (embedding <=> ${vectorSql}::vector) AS similarity
        FROM agent_memories
        WHERE "agentType" = ${agentType}
        ORDER BY embedding <=> ${vectorSql}::vector
        LIMIT ${topK}
      `;

      return rows.map((r) => ({
        id: r.id,
        agentType: r.agentType,
        memoryType: r.memoryType as AgentMemoryType,
        content: r.content,
        metadata: (r.metadata as Record<string, unknown>) ?? {},
        projectId: r.projectId,
        createdAt: r.createdAt,
        similarity: r.similarity,
      }));
    } catch (error) {
      // Memory read failures must NEVER block agent execution
      this.logger.warn(
        `MemoryService.readRelevant failed for ${agentType}: ${
          error instanceof Error ? error.message : String(error)
        } — continuing without memory context`,
      );
      return [];
    }
  }

  /**
   * Format retrieved memories as a system prompt injection block.
   * Returns an empty string if no memories exist.
   */
  formatAsContext(memories: MemoryRecord[]): string {
    if (memories.length === 0) return '';

    const lines = memories.map((m, i) => {
      const label = m.memoryType === 'MISTAKE' ? 'AVOID' : 'REFERENCE';
      return `[${label} ${i + 1}] (${m.agentType} / ${m.memoryType}, score=${(m.similarity ?? 0).toFixed(3)})\n${m.content.slice(0, 600)}`;
    });

    return [
      '--- AGENT MEMORY CONTEXT (injected — do not reproduce verbatim) ---',
      ...lines,
      '--- END MEMORY CONTEXT ---',
    ].join('\n\n');
  }

  // ─── Write: SKILL (Gate 2 approval only) ──────────────────────────────────

  /**
   * Record a successful agent skill: system prompt + output that passed gate review.
   * Called in bulk for all artifacts when Gate 2 is APPROVED.
   */
  async writeSkills(artifacts: GeneratedArtifact[], inputs: Omit<WriteSkillInput, 'agentType' | 'artifactContent' | 'filePath'>[]): Promise<void> {
    // Pair each artifact with its metadata
    const pairs = artifacts.map((artifact, i) => ({
      artifact,
      meta: inputs[i] ?? inputs[0],
    }));

    await Promise.allSettled(
      pairs.map(({ artifact, meta }) =>
        this.writeSkill({
          agentType: artifact.agentType,
          systemPrompt: '', // populated by caller if available
          artifactContent: artifact.content,
          filePath: artifact.filePath,
          projectId: meta.projectId,
          stackKey: meta.stackKey,
          projectType: meta.projectType,
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
      content,
      metadata: {
        filePath: input.filePath,
        stackKey: input.stackKey,
        projectType: input.projectType,
      },
      projectId: input.projectId,
    });
  }

  // ─── Write: PATTERN (Gate 2 approval only) ────────────────────────────────

  /**
   * Record the full contract + fileManifest that resulted in a DELIVERED project.
   * One pattern record per DELIVERED run.
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
      content,
      metadata: {
        stackKey: input.stackKey,
        projectType: input.contract.requirements.projectType,
        complexity: input.contract.requirements.complexity,
        fileCount: input.contract.fileManifest.length,
      },
      projectId: input.projectId,
    });
  }

  // ─── Write: MISTAKE (Gate 1 or Gate 2 rejection) ──────────────────────────

  /**
   * Record a rejected artifact or contract.
   * Called immediately when a gate REJECTS — does not wait for DELIVERED.
   */
  async writeMistake(input: WriteMistakeInput): Promise<void> {
    const content = [
      `GATE: ${input.gateType}`,
      `AGENT: ${input.agentType}`,
      `STACK: ${input.stackKey}`,
      `REJECTION REASON: ${input.rejectionNotes}`,
      '',
      `REJECTED CONTENT:`,
      input.rejectedContent.slice(0, 2000),
    ].join('\n');

    await this.writeMemory({
      agentType: input.agentType,
      memoryType: 'MISTAKE',
      content,
      metadata: {
        gateType: input.gateType,
        stackKey: input.stackKey,
        rejectionNotes: input.rejectionNotes,
      },
      projectId: input.projectId,
    });
  }

  // ─── Similarity check for skip-generation (Phase 2D) ──────────────────────

  /**
   * Check if an existing SKILL memory exceeds the skip threshold for a given file query.
   * Returns the matching memory if found, null otherwise.
   * Used by Phase 2D to bypass LLM calls when similarity > 0.92.
   */
  async findSkipCandidate(
    agentType: string,
    fileQuery: string,
    stackKey: string,
  ): Promise<MemoryRecord | null> {
    const results = await this.readRelevant(agentType, fileQuery, 1);
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

  // ─── Internal ──────────────────────────────────────────────────────────────

  private async writeMemory(input: {
    agentType: string;
    memoryType: AgentMemoryType;
    content: string;
    metadata: Record<string, unknown>;
    projectId: string | null;
  }): Promise<void> {
    try {
      const vector = await this.embedding.embed(input.content);
      const vectorSql = EmbeddingService.toSql(vector);

      await this.prisma.$executeRaw`
        INSERT INTO agent_memories (id, "agentType", "memoryType", content, embedding, metadata, "projectId", "createdAt")
        VALUES (
          gen_random_uuid()::text,
          ${input.agentType},
          ${input.memoryType}::"AgentMemoryType",
          ${input.content},
          ${vectorSql}::vector,
          ${JSON.stringify(input.metadata)}::jsonb,
          ${input.projectId},
          NOW()
        )
      `;

      this.logger.log(
        `Memory written: type=${input.memoryType} agent=${input.agentType} project=${input.projectId ?? 'global'}`,
      );
    } catch (error) {
      // Write failures must not crash the main flow
      this.logger.error(
        `MemoryService.writeMemory failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
