import { Injectable } from '@nestjs/common';
import {
  GeneratedWorkOrderOutput,
  WorkOrderAgentContext,
  WorkOrderAgentProvider,
} from './agent-provider.types';

@Injectable()
export class LlmAgentProvider implements WorkOrderAgentProvider {
  readonly mode = 'llm' as const;

  generateWorkOrderOutput(
    _context: WorkOrderAgentContext,
  ): GeneratedWorkOrderOutput {
    throw new Error(
      'LLM work-order provider is not implemented yet. Use AGENT_PROVIDER=mock until the real provider is wired.',
    );
  }
}
