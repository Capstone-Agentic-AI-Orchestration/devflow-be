import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryService } from '../src/memory/memory.service';
import { EmbeddingService } from '../src/memory/embedding.service';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPrisma = {
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
};

const MOCK_VECTOR = Array.from({ length: 1536 }, (_, i) => i / 1536);

const mockEmbeddingService = {
  embed: vi.fn().mockResolvedValue(MOCK_VECTOR),
} as unknown as EmbeddingService;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MemoryService', () => {
  let service: MemoryService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new MemoryService(mockPrisma as never, mockEmbeddingService);
  });

  describe('readRelevant', () => {
    it('returns formatted memory records on success', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        {
          id: 'mem-1',
          agentType: 'backend',
          memoryType: 'SKILL',
          content: 'FILE: src/users/users.service.ts\n...',
          metadata: { stackKey: 'nestjs-next' },
          projectId: 'proj-1',
          createdAt: new Date(),
          similarity: 0.95,
        },
      ]);

      const results = await service.readRelevant('backend', 'NestJS CRUD users');

      expect(results).toHaveLength(1);
      expect(results[0].memoryType).toBe('SKILL');
      expect(results[0].similarity).toBeCloseTo(0.95);
      expect(mockEmbeddingService.embed).toHaveBeenCalledWith('NestJS CRUD users');
    });

    it('returns empty array and does not throw on DB error', async () => {
      mockPrisma.$queryRaw.mockRejectedValueOnce(new Error('DB connection lost'));

      const results = await service.readRelevant('backend', 'some query');

      expect(results).toEqual([]);
    });
  });

  describe('readForAgent', () => {
    it('queries layered memory buckets for one agent and project', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);

      const result = await service.readForAgent({
        agentType: 'backend',
        projectId: 'project-1',
        query: 'NestJS Supabase dashboard',
      });

      expect(result.projectCore).toEqual([]);
      expect(result.projectAgent).toEqual([]);
      expect(result.agentPrivate).toEqual([]);
      expect(result.mistakes).toEqual([]);
      expect(result.globalPatterns).toEqual([]);
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(5);
      expect(mockEmbeddingService.embed).toHaveBeenCalledTimes(1);
    });
  });

  describe('formatAsContext', () => {
    it('returns empty string for empty memories array', () => {
      expect(service.formatAsContext([])).toBe('');
    });

    it('formats SKILL memory as REFERENCE', () => {
      const memories = [
        {
          id: 'mem-1',
          agentType: 'backend',
          agentProfileId: null,
          scope: 'PROJECT_AGENT' as const,
          memoryType: 'SKILL' as const,
          content: 'FILE: src/users.service.ts\nsome content',
          metadata: {},
          projectId: null,
          sourceType: null,
          importance: 0.5,
          lastUsedAt: null,
          usageCount: 0,
          expiresAt: null,
          approvedAt: null,
          approvalSource: null,
          createdAt: new Date(),
          similarity: 0.9,
        },
      ];
      const context = service.formatAsContext(memories);
      expect(context).toContain('[REFERENCE 1]');
      expect(context).toContain('AGENT MEMORY CONTEXT');
    });

    it('formats MISTAKE memory as AVOID', () => {
      const memories = [
        {
          id: 'mem-2',
          agentType: 'backend',
          agentProfileId: null,
          scope: 'PROJECT_AGENT' as const,
          memoryType: 'MISTAKE' as const,
          content: 'Missing auth guards',
          metadata: {},
          projectId: null,
          sourceType: null,
          importance: 0.5,
          lastUsedAt: null,
          usageCount: 0,
          expiresAt: null,
          approvedAt: null,
          approvalSource: null,
          createdAt: new Date(),
          similarity: 0.85,
        },
      ];
      const context = service.formatAsContext(memories);
      expect(context).toContain('[AVOID 1]');
    });

    it('formats layered memory with project core separated from private memory', () => {
      const context = service.formatLayeredContext({
        projectCore: [
          {
            id: 'core-1',
            agentType: 'project_core',
            agentProfileId: null,
            scope: 'PROJECT_CORE',
            memoryType: 'PATTERN',
            content: 'APPROVED ARCHITECTURE CONTRACT',
            metadata: {},
            projectId: 'project-1',
            sourceType: 'gate_1_approved_contract',
            importance: 1,
            lastUsedAt: null,
            usageCount: 0,
            expiresAt: null,
            approvedAt: new Date(),
            approvalSource: 'GATE_1',
            createdAt: new Date(),
            similarity: 0.91,
          },
        ],
        projectAgent: [],
        agentPrivate: [],
        mistakes: [],
        globalPatterns: [],
      });

      expect(context).toContain('PROJECT CORE MEMORY');
      expect(context).toContain('APPROVED ARCHITECTURE CONTRACT');
    });
  });

  describe('writeMistake', () => {
    it('calls writeMemory with MISTAKE type', async () => {
      mockPrisma.$executeRaw.mockResolvedValueOnce(1);

      await service.writeMistake({
        agentType: 'backend',
        rejectedContent: 'bad code',
        rejectionNotes: 'Missing auth guards',
        projectId: 'proj-1',
        gateType: 'GATE_2',
        stackKey: 'nestjs-next',
      });

      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect(mockEmbeddingService.embed).toHaveBeenCalledTimes(1);
    });

    it('does not throw if DB insert fails', async () => {
      mockPrisma.$executeRaw.mockRejectedValueOnce(new Error('insert failed'));

      await expect(
        service.writeMistake({
          agentType: 'frontend',
          rejectedContent: 'content',
          rejectionNotes: 'reason',
          projectId: 'proj-1',
          gateType: 'GATE_1',
          stackKey: 'nextjs',
        }),
      ).resolves.not.toThrow();
    });
  });

  describe('writeProjectCoreMemory', () => {
    it('requires a human approval source before writing project core memory', async () => {
      await expect(
        service.writeProjectCoreMemory({
          projectId: 'project-1',
          content: 'unapproved shared truth',
          sourceType: 'test',
          approvalSource: 'SYSTEM' as never,
        }),
      ).rejects.toThrow('Project core memory requires human approval');

      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('writes project core memory when approved by a gate', async () => {
      mockPrisma.$executeRaw.mockResolvedValueOnce(1);

      await service.writeProjectCoreMemory({
        projectId: 'project-1',
        content: 'approved shared truth',
        sourceType: 'gate_1_approved_contract',
        approvalSource: 'GATE_1',
      });

      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect(mockEmbeddingService.embed).toHaveBeenCalledWith('approved shared truth');
    });
  });

  describe('findSkipCandidate', () => {
    it('returns memory when similarity exceeds threshold and stackKey matches', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        {
          id: 'mem-3',
          agentType: 'backend',
          memoryType: 'SKILL',
          content: 'FILE: src/users.service.ts\n...',
          metadata: { stackKey: 'nestjs-next' },
          projectId: 'proj-1',
          createdAt: new Date(),
          similarity: 0.95,
        },
      ]);

      const candidate = await service.findSkipCandidate(
        'backend',
        'src/users.service.ts nestjs-next',
        'nestjs-next',
      );

      expect(candidate).not.toBeNull();
      expect(candidate?.id).toBe('mem-3');
    });

    it('returns null when similarity is below threshold', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        {
          id: 'mem-4',
          agentType: 'backend',
          memoryType: 'SKILL',
          content: 'some content',
          metadata: { stackKey: 'nestjs-next' },
          projectId: 'proj-1',
          createdAt: new Date(),
          similarity: 0.88, // below 0.92 threshold
        },
      ]);

      const candidate = await service.findSkipCandidate('backend', 'query', 'nestjs-next');
      expect(candidate).toBeNull();
    });
  });
});

describe('EmbeddingService', () => {
  describe('toSql', () => {
    it('serialises a vector to Postgres wire format', () => {
      const vector = [0.1, 0.2, 0.3];
      expect(EmbeddingService.toSql(vector)).toBe('[0.1,0.2,0.3]');
    });
  });
});
