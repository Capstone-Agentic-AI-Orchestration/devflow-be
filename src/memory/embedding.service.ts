import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * OpenAI text-embedding-3-small produces 1536-dim vectors.
 * Cost: $0.02 / 1M tokens — cheapest option that matches our pgvector schema.
 */
const EMBEDDING_MODEL = 'text-embedding-3-small' as const;
const EMBEDDING_DIMENSIONS = 1536 as const;

/** Truncate to this byte length before embedding to stay under the 8191-token limit. */
const MAX_EMBED_CHARS = 24_000;

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly openai = new OpenAI();

  /**
   * Embed a single text string.
   * Returns a 1536-dim float array ready for pgvector insertion.
   */
  async embed(text: string): Promise<number[]> {
    const truncated = text.slice(0, MAX_EMBED_CHARS);

    const response = await this.openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: truncated,
      dimensions: EMBEDDING_DIMENSIONS,
    });

    const vector = response.data[0]?.embedding;
    if (!vector || vector.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `EmbeddingService: unexpected vector length ${vector?.length ?? 0}`,
      );
    }

    return vector;
  }

  /**
   * Embed multiple texts in a single API call (batch up to 2048 inputs).
   * Returns vectors in the same order as the input array.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const truncated = texts.map((t) => t.slice(0, MAX_EMBED_CHARS));

    this.logger.debug(`Embedding batch of ${texts.length} texts`);

    const response = await this.openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: truncated,
      dimensions: EMBEDDING_DIMENSIONS,
    });

    return response.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }

  /**
   * Serialise a float array to the Postgres wire format understood by pgvector:
   * '[0.1,0.2,...,0.n]'
   *
   * Use this when building raw SQL queries.
   * Prisma + pgvector accepts this string format directly in $queryRaw.
   */
  static toSql(vector: number[]): string {
    return `[${vector.join(',')}]`;
  }
}
