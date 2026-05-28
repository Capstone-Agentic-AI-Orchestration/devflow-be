import { forwardRef, Module } from '@nestjs/common';
import { GithubModule } from '../github/github.module';
import { MemoryModule } from '../memory/memory.module';
import { SupervisorModule } from '../supervisor/supervisor.module';
import { GatewayModule } from '../gateway/gateway.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrchestrationService } from './orchestration.service';
import { RequirementsParserNode } from './nodes/requirements-parser.node';
import { ContractNegotiatorNode } from './nodes/contract-negotiator.node';
import { FrontendAgentNode } from './nodes/frontend-agent.node';
import { BackendAgentNode } from './nodes/backend-agent.node';
import { DatabaseAgentNode } from './nodes/database-agent.node';
import { ArchitectureAgentNode } from './nodes/architecture-agent.node';
import { ValidatorNode } from './nodes/validator.node';
import { GithubCommitNode } from './nodes/github-commit.node';
import { AgentProviderRegistry } from './providers/agent-provider.registry';
import { ArtifactContractValidator } from './providers/artifact-contract.validator';
import { LlmAgentProvider } from './providers/llm-agent.provider';
import { MockAgentProvider } from './providers/mock-agent.provider';

@Module({
  imports: [
    // PrismaModule is global — no import needed
    GithubModule,
    MemoryModule,
    // SupervisorModule exports EventLogService, which all agent nodes inject.
    forwardRef(() => SupervisorModule),
    // Phase 2E — import GatewayModule so DevFlowGateway can be injected
    // into OrchestrationService via @Optional().
    GatewayModule,
    NotificationsModule,
  ],
  providers: [
    OrchestrationService,
    RequirementsParserNode,
    ContractNegotiatorNode,
    FrontendAgentNode,
    BackendAgentNode,
    DatabaseAgentNode,
    ArchitectureAgentNode,
    ValidatorNode,
    GithubCommitNode,
    AgentProviderRegistry,
    ArtifactContractValidator,
    LlmAgentProvider,
    MockAgentProvider,
  ],
  exports: [OrchestrationService],
})
export class OrchestrationModule {}
