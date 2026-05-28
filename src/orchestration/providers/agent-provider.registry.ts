import { Injectable } from '@nestjs/common';
import {
  AgentProviderMode,
  AgentProviderStatus,
  WorkOrderAgentProvider,
} from './agent-provider.types';
import { LlmAgentProvider } from './llm-agent.provider';
import { MockAgentProvider } from './mock-agent.provider';

@Injectable()
export class AgentProviderRegistry {
  constructor(
    private readonly mockAgentProvider: MockAgentProvider,
    private readonly llmAgentProvider: LlmAgentProvider,
  ) {}

  getStatus(): AgentProviderStatus {
    const requestedMode = this.requestedMode();
    const llmMissingRequirements = this.llmMissingRequirements();
    const llmReason = llmMissingRequirements.length > 0
      ? `LLM provider requires ${llmMissingRequirements.join(' or ')}.`
      : 'LLM provider adapter is not implemented yet.';
    const providers = [
      {
        mode: this.mockAgentProvider.mode,
        displayName: 'Mock Agent Provider',
        active: requestedMode === this.mockAgentProvider.mode,
        available: true,
        implemented: true,
        missingRequirements: [],
        reason: null,
      },
      {
        mode: this.llmAgentProvider.mode,
        displayName: 'LLM Agent Provider',
        active: requestedMode === this.llmAgentProvider.mode,
        available: false,
        implemented: false,
        missingRequirements: llmMissingRequirements,
        reason: llmReason,
      },
    ];
    const activeProvider = providers.find((provider) => provider.active) ?? providers[0];

    return {
      requestedMode,
      activeMode: activeProvider.mode,
      available: activeProvider.available,
      fallbackMode: activeProvider.available ? null : this.mockAgentProvider.mode,
      missingRequirements: activeProvider.missingRequirements,
      reason: activeProvider.reason,
      providers,
    };
  }

  getActiveProviderOrThrow(): WorkOrderAgentProvider {
    const status = this.getStatus();
    if (!status.available) {
      throw new Error(
        `Agent provider ${status.activeMode} is unavailable: ${status.reason}`,
      );
    }

    return status.activeMode === this.llmAgentProvider.mode
      ? this.llmAgentProvider
      : this.mockAgentProvider;
  }

  requestedMode(): AgentProviderMode {
    return process.env.AGENT_PROVIDER === 'llm' ? 'llm' : 'mock';
  }

  activeMode(): AgentProviderMode {
    return this.getStatus().activeMode;
  }

  private llmMissingRequirements(): string[] {
    return process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY
      ? []
      : ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
  }
}
