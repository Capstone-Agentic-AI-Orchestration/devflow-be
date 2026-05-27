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

  describe('formatAsContext', () => {
    it('returns empty string for empty memories array', () => {
      expect(service.formatAsContext([])).toBe('');
    });

    it('formats SKILL memory as REFERENCE', () => {
      const memories = [
        {
          id: 'mem-1',
          agentType: 'backend',
          memoryType: 'SKILL' as const,
          content: 'FILE: src/users.service.ts\nsome content',
          metadata: {},
          projectId: null,
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
          memoryType: 'MISTAKE' as const,
          content: 'Missing auth guards',
          metadata: {},
          projectId: null,
          createdAt: new Date(),
          similarity: 0.85,
        },
      ];
      const context = service.formatAsContext(memories);
      expect(context).toContain('[AVOID 1]');
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
