import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

/**
 * Creates and sets up a PostgresSaver checkpointer.
 * Called once on module init — the result is cached in OrchestrationService.
 */
export async function createCheckpointer(): Promise<PostgresSaver> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is not set');
  }

  const checkpointer = PostgresSaver.fromConnString(connectionString);
  await checkpointer.setup();
  return checkpointer;
}
