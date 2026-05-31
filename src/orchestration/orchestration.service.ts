import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
import { Annotation, END, START, StateGraph, type CompiledStateGraph } from '@langchain/langgraph';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { RunnableConfig } from '@langchain/core/runnables';
import { createCheckpointer } from './graph/checkpointer';
import { buildDevFlowGraph } from './graph/devflow.graph';
import { DevFlowStateType } from './graph/devflow.state';
import { PrismaService } from '../prisma/prisma.service';
import { RequirementsParserNode } from './nodes/requirements-parser.node';
import { ContractNegotiatorNode } from './nodes/contract-negotiator.node';
import { FrontendAgentNode } from './nodes/frontend-agent.node';
import { BackendAgentNode } from './nodes/backend-agent.node';
import { DatabaseAgentNode } from './nodes/database-agent.node';
import { ArchitectureAgentNode } from './nodes/architecture-agent.node';
import { ValidatorNode } from './nodes/validator.node';
import { GithubCommitNode } from './nodes/github-commit.node';
import { MemoryService } from '../memory/memory.service';
import { DevFlowGateway } from '../gateway/devflow.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import {
  GithubDeliveryStatus,
  GithubDeliveryVerification,
  GithubService,
} from '../github/github.service';
import { AgentProviderRegistry } from './providers/agent-provider.registry';
import { ArtifactContractValidator } from './providers/artifact-contract.validator';
import {
  GraphLlmProvider,
  GraphLlmProviderVerification,
} from './providers/graph-llm.provider';
import { AgentProviderMode, AgentProviderStatus } from './providers/agent-provider.types';
import {
  agentArtifactContractFor,
  ORCHESTRATION_CONTRACT_VERSION,
} from './providers/agent-contracts';
import {
  ArtifactValidationStatus,
  NotificationType,
  OrchestrationRunStatus,
  OrchestrationRunTrigger,
  Prisma,
  ProjectStatus,
  ProjectTaskActivityType,
  ProjectTaskStatus,
  ProjectTimelineEventType,
  ProjectTimelineVisibility,
  WorkOrderAgentType,
  WorkOrderExecutionStatus,
  WorkOrderStatus,
} from '@prisma/client';

// ─── Thread Config Helper ─────────────────────────────────────────────────────

function threadConfig(
  projectId: string,
  runId: string,
): RunnableConfig & { configurable: { thread_id: string } } {
  return {
    configurable: {
      thread_id: `devflow:project-${projectId}:run-${runId}`,
    },
  };
}

// ─── Status Shape ─────────────────────────────────────────────────────────────

export interface OrchestrationStatus {
  status: string;
  currentNode: string;
  retryCount: number;
  error: string | null;
}

export interface WorkOrderExecutionResult {
  executionRunId: string;
  artifactId: string;
}

interface WorkOrderExecutionOptions {
  emitLifecycleEvents?: boolean;
  parentRunId?: string;
  trigger?: OrchestrationRunTrigger;
  allowFailedRetry?: boolean;
}

interface SupervisorRecoveryOptions {
  reason: string;
  retryAttempt: number;
  maxRetries: number;
}

export interface SupervisorRecoveryResult {
  runId: string;
  readyWorkOrders: number;
  completedWorkOrders: number;
  failedWorkOrders: number;
  status: OrchestrationRunStatus;
  error: string | null;
}

export type OrchestrationProviderStatus = AgentProviderStatus & {
  githubDelivery: GithubDeliveryStatus;
};

const MOCK_NODE = {
  LOAD_READY_WORK_ORDERS: 'load_ready_work_orders',
  EXECUTE_READY_WORK_ORDERS: 'execute_ready_work_orders',
  FINALIZE: 'finalize_mock_orchestration',
} as const;
const SUPERVISOR_RECOVERY_NODE = 'supervisor_recovery';

const MockWorkOrderState = Annotation.Root({
  projectId: Annotation<string>(),
  runId: Annotation<string>(),
  trigger: Annotation<OrchestrationRunTrigger>({
    default: () => OrchestrationRunTrigger.START,
    reducer: (_, next) => next,
  }),
  actorId: Annotation<string | null>({
    default: () => null,
    reducer: (_, next) => next,
  }),
  readyWorkOrderIds: Annotation<string[]>({
    default: () => [],
    reducer: (_, next) => next,
  }),
  completedArtifactIds: Annotation<string[]>({
    default: () => [],
    reducer: (existing, next) => [...existing, ...next],
  }),
  failedWorkOrderIds: Annotation<string[]>({
    default: () => [],
    reducer: (existing, next) => [...existing, ...next],
  }),
  error: Annotation<string | null>({
    default: () => null,
    reducer: (_, next) => next,
  }),
});

type MockWorkOrderStateType = typeof MockWorkOrderState.State;

type MockWorkOrderGraphBuilder = {
  addNode(
    name: string,
    action: (
      state: MockWorkOrderStateType,
    ) => Partial<MockWorkOrderStateType> | Promise<Partial<MockWorkOrderStateType>>,
  ): MockWorkOrderGraphBuilder;
  addEdge(start: string, end: string): MockWorkOrderGraphBuilder;
  compile(input: {
    checkpointer: PostgresSaver;
  }): CompiledStateGraph<
    MockWorkOrderStateType,
    Partial<MockWorkOrderStateType>,
    string
  >;
};

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class OrchestrationService implements OnModuleInit {
  private readonly logger = new Logger(OrchestrationService.name);

  private graph!: CompiledStateGraph<
    DevFlowStateType,
    Partial<DevFlowStateType>,
    string
  >;
  private mockWorkOrderGraph!: CompiledStateGraph<
    MockWorkOrderStateType,
    Partial<MockWorkOrderStateType>,
    string
  >;
  private checkpointer!: PostgresSaver;
  constructor(
    private readonly prisma: PrismaService,
    private readonly requirementsParser: RequirementsParserNode,
    private readonly contractNegotiator: ContractNegotiatorNode,
    private readonly frontendAgent: FrontendAgentNode,
    private readonly backendAgent: BackendAgentNode,
    private readonly databaseAgent: DatabaseAgentNode,
    private readonly architectureAgent: ArchitectureAgentNode,
    private readonly validator: ValidatorNode,
    private readonly githubCommit: GithubCommitNode,
    private readonly memory: MemoryService,
    private readonly artifactContractValidator: ArtifactContractValidator,
    private readonly agentProviderRegistry: AgentProviderRegistry,
    private readonly notifications: NotificationsService,
    private readonly github: GithubService,
    @Optional() @Inject(GraphLlmProvider)
    private readonly graphLlmProvider: GraphLlmProvider | null,
    // Optional: WebSocket gateway may not be present in all environments
    @Optional() private readonly gateway: DevFlowGateway | null,
  ) {}

  getProviderStatus(): OrchestrationProviderStatus {
    return {
      ...this.agentProviderRegistry.getStatus(),
      githubDelivery: this.github.getDeliveryStatus(),
    };
  }

  verifyGithubDeliveryAccess(): Promise<GithubDeliveryVerification> {
    return this.github.verifyDeliveryAccess();
  }

  verifyLlmProviderAccess(): Promise<GraphLlmProviderVerification> {
    if (!this.graphLlmProvider) {
      throw new Error('Graph LLM provider is not available in this runtime.');
    }

    return this.graphLlmProvider.verifyConnection();
  }

  async onModuleInit(): Promise<void> {
    this.logger.log('Initializing orchestration graph...');
    this.checkpointer = await createCheckpointer();
    this.graph = buildDevFlowGraph(
      this.requirementsParser,
      this.contractNegotiator,
      this.frontendAgent,
      this.backendAgent,
      this.databaseAgent,
      this.architectureAgent,
      this.validator,
      this.githubCommit,
      this.prisma,
      this.checkpointer,
    );
    this.mockWorkOrderGraph = this.buildMockWorkOrderGraph();
    this.logger.log('Orchestration graph initialized and compiled');
  }

  /**
   * Starts a new graph run for a project.
   * Called by ProjectsService on POST /projects.
   * Returns the generated runId.
   */
  async startRun(
    projectId: string,
    brief: string,
    stackKey: string,
    companyName: string,
    actorId?: string,
    trigger: OrchestrationRunTrigger = OrchestrationRunTrigger.START,
  ): Promise<string> {
    const runId = createId();
    this.agentProviderRegistry.getActiveProviderOrThrow();
    if (this.agentProviderMode() === 'llm') {
      const githubDelivery = this.github.getDeliveryStatus();
      if (!githubDelivery.available) {
        throw new Error(
          githubDelivery.reason ??
            'GitHub delivery is not configured for LLM orchestration.',
        );
      }
    }

    this.logger.log(
      `Starting run ${runId} for project ${projectId} (${companyName})`,
    );

    await this.prisma.project.update({
      where: { id: projectId },
      data: { runId },
    });

    const readyWorkOrders = await this.prisma.workOrder.count({
      where: {
        projectId,
        status: WorkOrderStatus.READY,
        instructions: { not: null },
      },
    });

    await this.prisma.orchestrationRun.create({
      data: {
        projectId,
        runId,
        providerMode: this.agentProviderMode(),
        trigger,
        status: OrchestrationRunStatus.RUNNING,
        currentNode: this.agentProviderMode() === 'mock'
          ? MOCK_NODE.LOAD_READY_WORK_ORDERS
          : 'parse_requirements',
        actorId: actorId ?? null,
        readyWorkOrders,
      },
    });

    // Initialise run budget (Phase 2B)
    await this.prisma.runBudget.create({
      data: { projectId },
    }).catch(() => undefined);

    const config = threadConfig(projectId, runId);

    if (this.agentProviderMode() === 'mock') {
      const initialInput: Partial<MockWorkOrderStateType> = {
        projectId,
        runId,
        trigger,
        actorId: actorId ?? null,
      };

      this.mockWorkOrderGraph.invoke(initialInput, config).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Mock orchestration run ${runId} for project ${projectId} failed: ${message}`,
        );
        void this.markRunFailed(runId, MOCK_NODE.FINALIZE, message);
      });

      this.gateway?.emitStatusUpdate(
        projectId,
        ProjectStatus.GENERATING_CODE,
        MOCK_NODE.LOAD_READY_WORK_ORDERS,
      );

      return runId;
    }

    const initialInput: Partial<DevFlowStateType> = {
      projectId,
      runId,
      brief,
      stackKey,
      companyName,
    };

    this.graph.invoke(initialInput, config).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Graph run ${runId} for project ${projectId} encountered an error: ${message}`,
      );
      void this.markRunFailed(runId, 'graph', message);
    });

    // Notify subscribers that the graph has started and is parsing requirements
    this.gateway?.emitStatusUpdate(
      projectId,
      'PARSING_REQUIREMENTS',
      'parse_requirements',
    );

    return runId;
  }

  /**
   * Called when the user approves or rejects Gate 1 (architecture review).
   *
   * Phase 2A memory write policy:
   *   REJECTED → write MISTAKE memory immediately
   *   APPROVED → no memory write yet (SKILL/PATTERN written only on Gate 2 approval)
   */
  async resumeGate1(
    projectId: string,
    approved: boolean,
    notes?: string,
  ): Promise<void> {
    this.logger.log(
      `Resuming gate 1 for project ${projectId}: approved=${approved}`,
    );

    const runId = await this.getRunId(projectId);
    const config = threadConfig(projectId, runId);

    if (!approved) {
      await Promise.all([
        this.prisma.gateEvent.create({
          data: { projectId, gateType: 'ARCHITECTURE_REVIEW', decision: 'REJECTED', notes: notes ?? null },
        }),
        this.prisma.project.update({
          where: { id: projectId },
          data: { status: 'FAILED' },
        }),
      ]);

      // Write mistake memory: contract that was rejected at Gate 1
      const checkpoint = await this.checkpointer.get(config).catch(() => null);
      const state = checkpoint?.channel_values as Partial<DevFlowStateType> | undefined;
      if (state?.contract) {
        await this.memory.writeMistake({
          agentType: 'contract',
          rejectedContent: JSON.stringify(state.contract, null, 2),
          rejectionNotes: notes ?? 'No reason provided',
          projectId,
          gateType: 'GATE_1',
          stackKey: state.stackKey ?? 'unknown',
        });
      }

      this.logger.log(`Gate 1 rejected for project ${projectId} — mistake recorded`);
      // Notify subscribers: gate rejection leads to FAILED state
      this.gateway?.emitStatusUpdate(projectId, 'FAILED', 'gate_rejected', 'Gate 1 rejected');
      return;
    }

    await this.prisma.gateEvent.create({
      data: {
        projectId,
        gateType: 'ARCHITECTURE_REVIEW',
        decision: 'APPROVED',
        notes: notes ?? null,
      },
    });

    await this.graph.updateState(config, {
      gate1Approved: true,
      gate1Notes: notes ?? '',
    });

    // Notify subscribers that code generation has begun after Gate 1 approval
    this.gateway?.emitStatusUpdate(projectId, 'GENERATING_CODE', 'gate_1_check');

    this.graph.invoke(null, config).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Graph resume after gate 1 for project ${projectId} failed: ${message}`,
      );
    });
  }

  /**
   * Called when the user approves or rejects Gate 2 (code review).
   *
   * Phase 2A memory write policy:
   *   REJECTED → write MISTAKE memories for each artifact that failed
   *   APPROVED → write SKILL memories for all artifacts + PATTERN for the contract
   */
  async resumeGate2(
    projectId: string,
    approved: boolean,
    notes?: string,
  ): Promise<void> {
    this.logger.log(
      `Resuming gate 2 for project ${projectId}: approved=${approved}`,
    );

    const runId = await this.getRunId(projectId);
    const config = threadConfig(projectId, runId);

    const checkpoint = await this.checkpointer.get(config).catch(() => null);
    const state = checkpoint?.channel_values as Partial<DevFlowStateType> | undefined;

    if (!approved) {
      await Promise.all([
        this.prisma.gateEvent.create({
          data: { projectId, gateType: 'CODE_REVIEW', decision: 'REJECTED', notes: notes ?? null },
        }),
        this.prisma.project.update({
          where: { id: projectId },
          data: { status: 'FAILED' },
        }),
      ]);

      // Write MISTAKE memory for each artifact that was rejected
      if (state?.artifacts?.length) {
        await Promise.allSettled(
          state.artifacts.map((artifact) =>
            this.memory.writeMistake({
              agentType: artifact.agentType,
              rejectedContent: `FILE: ${artifact.filePath}\n\n${artifact.content}`,
              rejectionNotes: notes ?? 'No reason provided',
              projectId,
              gateType: 'GATE_2',
              stackKey: state.stackKey ?? 'unknown',
            }),
          ),
        );
        this.logger.log(
          `Gate 2 rejected: ${state.artifacts.length} mistake memories written for project ${projectId}`,
        );
      }

      // Notify subscribers: gate rejection leads to FAILED state
      this.gateway?.emitStatusUpdate(projectId, 'FAILED', 'gate_rejected', 'Gate 2 rejected');
      return;
    }

    // Gate 2 APPROVED — write SKILL + PATTERN memories
    await this.prisma.gateEvent.create({
      data: {
        projectId,
        gateType: 'CODE_REVIEW',
        decision: 'APPROVED',
        notes: notes ?? null,
      },
    });

    if (state?.artifacts?.length && state?.contract) {
      const projectType = state.contract.requirements.projectType;
      const stackKey = state.stackKey ?? 'unknown';

      // SKILL: one memory per artifact
      await Promise.allSettled(
        state.artifacts.map((artifact) =>
          this.memory.writeSkill({
            agentType: artifact.agentType,
            systemPrompt: '',
            artifactContent: artifact.content,
            filePath: artifact.filePath,
            projectId,
            stackKey,
            projectType,
          }),
        ),
      );

      // PATTERN: one memory for the successful contract
      await this.memory.writePattern({
        contract: state.contract,
        projectId,
        stackKey,
      });

      this.logger.log(
        `Gate 2 approved: ${state.artifacts.length} skill memories + 1 pattern written for project ${projectId}`,
      );
    }

    await this.graph.updateState(config, {
      gate2Approved: true,
      gate2Notes: notes ?? '',
    });

    // Notify subscribers that commit phase has begun after Gate 2 approval
    this.gateway?.emitStatusUpdate(projectId, 'COMMITTING', 'gate_2_check');

    this.graph.invoke(null, config).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Graph resume after gate 2 for project ${projectId} failed: ${message}`,
      );
    });
  }

  /**
   * Returns a combined status from the latest checkpoint + DB project row.
   */
  async getStatus(projectId: string): Promise<OrchestrationStatus> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { status: true, runId: true },
    });

    if (!project?.runId) {
      return {
        status: project?.status ?? 'UNKNOWN',
        currentNode: 'none',
        retryCount: 0,
        error: null,
      };
    }

    const config = threadConfig(projectId, project.runId);

    try {
      const checkpoint = await this.checkpointer.get(config);
      const channelValues = checkpoint?.channel_values as
        | Partial<DevFlowStateType>
        | undefined;

      const rawError = channelValues?.error ?? null;
      const publicError =
        rawError?.startsWith('RETRY:') ? null : rawError;

      return {
        status: project.status,
        currentNode: this.getCurrentNode(checkpoint),
        retryCount: channelValues?.retryCount ?? 0,
        error: publicError,
      };
    } catch {
      return {
        status: project.status,
        currentNode: 'unknown',
        retryCount: 0,
        error: null,
      };
    }
  }

  async executeWorkOrder(
    projectId: string,
    workOrderId: string,
    actorId?: string,
    options: WorkOrderExecutionOptions = {},
  ): Promise<WorkOrderExecutionResult> {
    const executionRunId = createId();
    const startedAt = new Date();
    const workOrder = await this.prisma.workOrder.findFirst({
      where: { id: workOrderId, projectId },
      include: {
        project: {
          select: {
            id: true,
            companyName: true,
            brief: true,
            stackKey: true,
          },
        },
        task: {
          select: {
            id: true,
            title: true,
            description: true,
            assignedToId: true,
            status: true,
          },
        },
        artifact: {
          select: {
            id: true,
            filePath: true,
            displayName: true,
            content: true,
          },
        },
      },
    });

    if (!workOrder) {
      throw new Error(`Work order ${workOrderId} not found`);
    }

    this.assertWorkOrderExecutable(workOrder, options);

    const provider = this.agentProviderRegistry.getActiveProviderOrThrow();
    const attempt = workOrder.executionAttempt + 1;
    const nodeName = this.workOrderNodeName(workOrder.agentType);
    const contractMetadata = this.workOrderContractMetadata(workOrder.agentType);
    const orchestrationRun = await this.findOrCreateWorkOrderRun(projectId, {
      runId: options.parentRunId ?? executionRunId,
      executionRunId,
      trigger: options.trigger ?? OrchestrationRunTrigger.WORK_ORDER_DISPATCH,
      actorId,
      currentNode: nodeName,
    });

    await this.prisma.workOrder.update({
      where: { id: workOrderId },
      data: {
        status: WorkOrderStatus.DISPATCHED,
        dispatchedAt: workOrder.dispatchedAt ?? startedAt,
        executionRunId,
        executionAttempt: attempt,
        executionStartedAt: startedAt,
        executionCompletedAt: null,
        executionError: null,
        lastEventAt: startedAt,
      },
    });

    await this.prisma.workOrderExecution.create({
      data: {
        projectId,
        orchestrationRunId: orchestrationRun.id,
        workOrderId,
        executionRunId,
        attempt,
        agentType: workOrder.agentType,
        status: WorkOrderExecutionStatus.RUNNING,
        startedAt,
        metadata: {
          trigger: options.trigger ?? OrchestrationRunTrigger.WORK_ORDER_DISPATCH,
          sourceArtifactId: workOrder.artifactId,
          providerMode: this.agentProviderMode(),
          requestedProviderMode: this.requestedAgentProviderMode(),
          contract: contractMetadata,
        },
      },
    });

    await this.updateRunProgress(orchestrationRun.id, {
      currentNode: nodeName,
      status: OrchestrationRunStatus.RUNNING,
    });

    if (options.emitLifecycleEvents) {
      await Promise.all([
        this.recordWorkOrderTimelineEvent(projectId, actorId, {
          type: ProjectTimelineEventType.WORK_ORDER_DISPATCHED,
          taskId: workOrder.taskId,
          artifactId: workOrder.artifactId,
          title: 'Work order dispatched',
          body: workOrder.title,
          metadata: {
            workOrderId,
            executionRunId,
            attempt,
            agentType: workOrder.agentType,
          },
        }),
        this.notifyWorkOrderLifecycle(projectId, actorId, workOrder, {
          type: NotificationType.WORK_ORDER_DISPATCHED,
          title: 'Work order dispatched',
          status: WorkOrderStatus.DISPATCHED,
          executionRunId,
        }),
      ]);
    }

    await this.prisma.eventLog.create({
      data: {
        projectId,
        nodeName,
        eventType: 'STARTED',
        costMeta: {
          workOrderId,
          executionRunId,
          attempt,
          agentType: workOrder.agentType,
          providerMode: this.agentProviderMode(),
          requestedProviderMode: this.requestedAgentProviderMode(),
          contract: contractMetadata,
        },
        runTokens: 0,
        occurredAt: startedAt,
      },
    });

    this.gateway?.emitStatusUpdate(projectId, 'GENERATING_CODE', nodeName);

    try {
      const completedAt = new Date();
      const agentContext = {
        project: workOrder.project,
        workOrder: {
          id: workOrder.id,
          title: workOrder.title,
          instructions: workOrder.instructions,
          agentType: workOrder.agentType,
          priority: workOrder.priority,
        },
        task: workOrder.task,
        sourceArtifact: workOrder.artifact,
        executionRunId,
      };
      const output = await provider.generateWorkOrderOutput(agentContext);
      const validation = this.artifactContractValidator.validate(output, agentContext);

      if (!validation.valid) {
        throw new Error(`Artifact contract validation failed: ${validation.errors.join('; ')}`);
      }

      const artifact = await this.prisma.artifact.create({
        data: {
          projectId,
          agentType: workOrder.agentType.toLowerCase(),
          filePath: output.filePath,
          displayName: output.displayName,
          content: output.content,
          clientVisible: false,
          validationStatus: ArtifactValidationStatus.PASSED,
          validationSummary: validation.summary,
          validationErrors: validation.errors,
        },
      });

      await this.prisma.workOrder.update({
        where: { id: workOrderId },
        data: {
          status: WorkOrderStatus.COMPLETED,
          artifactId: artifact.id,
          completedAt,
          failedAt: null,
          executionCompletedAt: completedAt,
          executionError: null,
          lastEventAt: completedAt,
        },
      });

      if (workOrder.taskId) {
        await this.prisma.projectTask.update({
          where: { id: workOrder.taskId },
          data: { status: ProjectTaskStatus.IN_REVIEW, artifactId: artifact.id },
        });

        await this.prisma.projectTaskActivity.create({
          data: {
            projectId,
            taskId: workOrder.taskId,
            actorId,
            type: ProjectTaskActivityType.ARTIFACT_CHANGED,
            message: 'Work order execution produced an artifact',
            metadata: {
              workOrderId,
              executionRunId,
              artifactId: artifact.id,
            },
          },
        });
      }

      await this.prisma.eventLog.create({
        data: {
          projectId,
          nodeName,
          eventType: 'COMPLETED',
          costMeta: {
            workOrderId,
            executionRunId,
            attempt,
            artifactId: artifact.id,
            agentType: workOrder.agentType,
            providerMode: this.agentProviderMode(),
            requestedProviderMode: this.requestedAgentProviderMode(),
            contract: contractMetadata,
            output: {
              filePath: output.filePath,
              language: output.language,
              metadata: output.metadata ?? {},
            },
            validation: {
              summary: validation.summary,
              errors: validation.errors,
            },
          },
          runTokens: 0,
          occurredAt: completedAt,
        },
      });

      await Promise.all([
        this.prisma.workOrderExecution.update({
          where: { executionRunId },
          data: {
            status: WorkOrderExecutionStatus.SUCCEEDED,
            artifactId: artifact.id,
            completedAt,
            metadata: {
              trigger: options.trigger ?? OrchestrationRunTrigger.WORK_ORDER_DISPATCH,
              sourceArtifactId: workOrder.artifactId,
              providerMode: this.agentProviderMode(),
              requestedProviderMode: this.requestedAgentProviderMode(),
              contract: contractMetadata,
              output: {
                filePath: output.filePath,
                language: output.language,
                metadata: output.metadata ?? {},
              },
              validation: {
                summary: validation.summary,
                errors: validation.errors,
              },
            },
          },
        }),
        this.incrementRunCompletion(orchestrationRun.id, {
          artifactId: artifact.id,
          currentNode: nodeName,
          completeRun: !options.parentRunId,
        }),
      ]);

      if (options.emitLifecycleEvents) {
        await Promise.all([
          this.recordWorkOrderTimelineEvent(projectId, actorId, {
            type: ProjectTimelineEventType.WORK_ORDER_STATUS_CHANGED,
            taskId: workOrder.taskId,
            artifactId: artifact.id,
            title: 'Work order execution completed',
            body: workOrder.title,
            metadata: {
              workOrderId,
              from: WorkOrderStatus.DISPATCHED,
              to: WorkOrderStatus.COMPLETED,
              executionRunId,
              artifactId: artifact.id,
            },
          }),
          this.notifyWorkOrderLifecycle(projectId, actorId, workOrder, {
            type: NotificationType.WORK_ORDER_STATUS_CHANGED,
            title: 'Work order completed',
            status: WorkOrderStatus.COMPLETED,
            executionRunId,
            artifactId: artifact.id,
          }),
        ]);
      }

      this.gateway?.emitStatusUpdate(projectId, 'AWAITING_GATE_2', nodeName);
      return { executionRunId, artifactId: artifact.id };
    } catch (error) {
      const failedAt = new Date();
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.workOrder.update({
        where: { id: workOrderId },
        data: {
          status: WorkOrderStatus.FAILED,
          failedAt,
          executionError: message,
          lastEventAt: failedAt,
        },
      });
      await this.prisma.eventLog.create({
        data: {
          projectId,
          nodeName,
          eventType: 'FAILED',
          costMeta: {
            workOrderId,
            executionRunId,
            attempt,
            agentType: workOrder.agentType,
            providerMode: this.agentProviderMode(),
            requestedProviderMode: this.requestedAgentProviderMode(),
            contract: contractMetadata,
            error: message,
          },
          runTokens: 0,
          occurredAt: failedAt,
        },
      });
      await Promise.all([
        this.prisma.workOrderExecution.update({
          where: { executionRunId },
          data: {
            status: WorkOrderExecutionStatus.FAILED,
            error: message,
            completedAt: failedAt,
            metadata: {
              trigger: options.trigger ?? OrchestrationRunTrigger.WORK_ORDER_DISPATCH,
              sourceArtifactId: workOrder.artifactId,
              providerMode: this.agentProviderMode(),
              requestedProviderMode: this.requestedAgentProviderMode(),
              contract: contractMetadata,
              error: message,
            },
          },
        }),
        this.incrementRunFailure(orchestrationRun.id, {
          error: message,
          currentNode: nodeName,
          completeRun: !options.parentRunId,
        }),
      ]);
      this.gateway?.emitStatusUpdate(projectId, 'FAILED', nodeName, message);
      throw error;
    }
  }

  async recoverStaleProject(
    projectId: string,
    options: SupervisorRecoveryOptions,
  ): Promise<SupervisorRecoveryResult> {
    const runId = createId();
    const startedAt = new Date();
    const trigger = OrchestrationRunTrigger.RERUN_READY_WORK_ORDERS;
    const readyWorkOrders = await this.prisma.workOrder.findMany({
      where: {
        projectId,
        status: WorkOrderStatus.READY,
        instructions: { not: null },
      },
      select: { id: true, instructions: true },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
    const readyWorkOrderIds = readyWorkOrders
      .filter((workOrder) => workOrder.instructions?.trim())
      .map((workOrder) => workOrder.id);

    await this.prisma.orchestrationRun.create({
      data: {
        projectId,
        runId,
        providerMode: this.agentProviderMode(),
        trigger,
        status: OrchestrationRunStatus.RUNNING,
        currentNode: SUPERVISOR_RECOVERY_NODE,
        actorId: null,
        readyWorkOrders: readyWorkOrderIds.length,
      },
    });

    await Promise.all([
      this.prisma.project.update({
        where: { id: projectId },
        data: { runId, status: ProjectStatus.GENERATING_CODE },
      }),
      this.prisma.eventLog.create({
        data: {
          projectId,
          nodeName: SUPERVISOR_RECOVERY_NODE,
          eventType: 'STARTED',
          costMeta: {
            runId,
            trigger,
            reason: options.reason,
            retryAttempt: options.retryAttempt,
            maxRetries: options.maxRetries,
            providerMode: this.agentProviderMode(),
            requestedProviderMode: this.requestedAgentProviderMode(),
            readyWorkOrderIds,
          },
          runTokens: 0,
          occurredAt: startedAt,
        },
      }),
      this.prisma.projectTimelineEvent.create({
        data: {
          projectId,
          actorId: null,
          type: ProjectTimelineEventType.PROJECT_UPDATED,
          visibility: ProjectTimelineVisibility.TEAM,
          title: 'Supervisor recovery started',
          body: `${readyWorkOrderIds.length} ready work order${readyWorkOrderIds.length === 1 ? '' : 's'} queued for automatic recovery.`,
          metadata: {
            runId,
            reason: options.reason,
            retryAttempt: options.retryAttempt,
            maxRetries: options.maxRetries,
            readyWorkOrderIds,
          },
        },
      }),
    ]);

    this.gateway?.emitStatusUpdate(
      projectId,
      ProjectStatus.GENERATING_CODE,
      SUPERVISOR_RECOVERY_NODE,
    );

    const completedArtifactIds: string[] = [];
    const failedWorkOrderIds: string[] = [];
    let error: string | null = null;

    if (readyWorkOrderIds.length === 0) {
      error = 'Supervisor recovery found no READY work orders with instructions.';
    }

    for (const workOrderId of readyWorkOrderIds) {
      try {
        const result = await this.executeWorkOrder(
          projectId,
          workOrderId,
          undefined,
          {
            emitLifecycleEvents: true,
            parentRunId: runId,
            trigger,
          },
        );
        completedArtifactIds.push(result.artifactId);
      } catch (err) {
        failedWorkOrderIds.push(workOrderId);
        error = err instanceof Error ? err.message : String(err);
      }
    }

    const failed = Boolean(error) || failedWorkOrderIds.length > 0;
    const completedAt = new Date();
    const status = failed
      ? OrchestrationRunStatus.FAILED
      : OrchestrationRunStatus.SUCCEEDED;
    const projectStatus = failed
      ? ProjectStatus.FAILED
      : ProjectStatus.AWAITING_GATE_2;
    const body = failed
      ? error
      : `${completedArtifactIds.length} recovered artifact${completedArtifactIds.length === 1 ? '' : 's'} ready for PM output review.`;

    await Promise.all([
      this.prisma.project.update({
        where: { id: projectId },
        data: { status: projectStatus },
      }),
      this.prisma.eventLog.create({
        data: {
          projectId,
          nodeName: SUPERVISOR_RECOVERY_NODE,
          eventType: failed ? 'FAILED' : 'COMPLETED',
          costMeta: {
            runId,
            trigger,
            reason: options.reason,
            retryAttempt: options.retryAttempt,
            maxRetries: options.maxRetries,
            providerMode: this.agentProviderMode(),
            requestedProviderMode: this.requestedAgentProviderMode(),
            readyWorkOrderIds,
            completedArtifactIds,
            failedWorkOrderIds,
            error,
          },
          runTokens: 0,
          occurredAt: completedAt,
        },
      }),
      this.prisma.projectTimelineEvent.create({
        data: {
          projectId,
          actorId: null,
          type: ProjectTimelineEventType.PROJECT_UPDATED,
          visibility: ProjectTimelineVisibility.TEAM,
          title: failed
            ? 'Supervisor recovery failed'
            : 'Supervisor recovery completed',
          body,
          metadata: {
            runId,
            reason: options.reason,
            retryAttempt: options.retryAttempt,
            maxRetries: options.maxRetries,
            readyWorkOrderIds,
            completedArtifactIds,
            failedWorkOrderIds,
            error,
          },
        },
      }),
      this.prisma.orchestrationRun.updateMany({
        where: { projectId, runId },
        data: {
          status,
          currentNode: SUPERVISOR_RECOVERY_NODE,
          error,
          completedWorkOrders: completedArtifactIds.length,
          failedWorkOrders: failedWorkOrderIds.length,
          completedArtifacts: completedArtifactIds.length,
          completedAt,
        },
      }),
    ]);

    await this.notifications.notify({
      recipientIds: await this.notifications.projectManagers(projectId),
      actorId: null,
      projectId,
      type: NotificationType.WORK_ORDER_STATUS_CHANGED,
      title: failed
        ? 'Supervisor recovery failed'
        : 'Supervisor recovery completed',
      body,
      metadata: {
        runId,
        reason: options.reason,
        retryAttempt: options.retryAttempt,
        maxRetries: options.maxRetries,
        completedArtifacts: completedArtifactIds.length,
        failedWorkOrders: failedWorkOrderIds.length,
      },
    });

    this.gateway?.emitStatusUpdate(
      projectId,
      projectStatus,
      SUPERVISOR_RECOVERY_NODE,
      error ?? undefined,
    );

    return {
      runId,
      readyWorkOrders: readyWorkOrderIds.length,
      completedWorkOrders: completedArtifactIds.length,
      failedWorkOrders: failedWorkOrderIds.length,
      status,
      error,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private buildMockWorkOrderGraph(): CompiledStateGraph<
    MockWorkOrderStateType,
    Partial<MockWorkOrderStateType>,
    string
  > {
    const graph = new StateGraph(
      MockWorkOrderState,
    ) as unknown as MockWorkOrderGraphBuilder;

    graph.addNode(MOCK_NODE.LOAD_READY_WORK_ORDERS, async (state) => {
      const readyWorkOrders = await this.prisma.workOrder.findMany({
        where: {
          projectId: state.projectId,
          status: WorkOrderStatus.READY,
        },
        select: { id: true, instructions: true },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      });

      const readyWorkOrderIds = readyWorkOrders
        .filter((workOrder) => workOrder.instructions?.trim())
        .map((workOrder) => workOrder.id);

      if (readyWorkOrderIds.length === 0) {
        return {
          error: 'No READY work orders with instructions are available for orchestration.',
        };
      }

      const startedAt = new Date();
      await Promise.all([
        this.prisma.project.update({
          where: { id: state.projectId },
          data: { status: ProjectStatus.GENERATING_CODE },
        }),
        this.prisma.eventLog.create({
          data: {
            projectId: state.projectId,
            nodeName: MOCK_NODE.LOAD_READY_WORK_ORDERS,
            eventType: 'STARTED',
            costMeta: {
              provider: this.agentProviderMode(),
              runId: state.runId,
              workOrderCount: readyWorkOrderIds.length,
            },
            runTokens: 0,
            occurredAt: startedAt,
          },
        }),
        this.prisma.projectTimelineEvent.create({
          data: {
            projectId: state.projectId,
            actorId: state.actorId,
            type: ProjectTimelineEventType.PROJECT_UPDATED,
            visibility: ProjectTimelineVisibility.TEAM,
            title: 'Orchestration started',
            body: `${readyWorkOrderIds.length} ready work order${readyWorkOrderIds.length === 1 ? '' : 's'} queued for mock agent execution.`,
            metadata: {
              provider: this.agentProviderMode(),
              runId: state.runId,
              readyWorkOrderIds,
            },
          },
        }),
      ]);

      return { readyWorkOrderIds };
    });

    graph.addNode(MOCK_NODE.EXECUTE_READY_WORK_ORDERS, async (state) => {
      if (state.error) return {};

      const completedArtifactIds: string[] = [];
      const failedWorkOrderIds: string[] = [];

      for (const workOrderId of state.readyWorkOrderIds) {
        try {
          const result = await this.executeWorkOrder(
            state.projectId,
            workOrderId,
            state.actorId ?? undefined,
            {
              emitLifecycleEvents: true,
              parentRunId: state.runId,
              trigger: state.trigger,
            },
          );
          completedArtifactIds.push(result.artifactId);
        } catch {
          failedWorkOrderIds.push(workOrderId);
        }
      }

      return {
        completedArtifactIds,
        failedWorkOrderIds,
        error:
          failedWorkOrderIds.length > 0
            ? `${failedWorkOrderIds.length} work order execution${failedWorkOrderIds.length === 1 ? '' : 's'} failed.`
            : null,
      };
    });

    graph.addNode(MOCK_NODE.FINALIZE, async (state) => {
      const failed = state.error || state.failedWorkOrderIds.length > 0;
      const completedAt = new Date();
      const status = failed
        ? ProjectStatus.FAILED
        : ProjectStatus.AWAITING_GATE_2;
      const title = failed
        ? 'Orchestration failed'
        : 'Orchestration outputs ready';
      const body = failed
        ? state.error
        : `${state.completedArtifactIds.length} artifact${state.completedArtifactIds.length === 1 ? '' : 's'} ready for PM output review.`;

      await Promise.all([
        this.prisma.project.update({
          where: { id: state.projectId },
          data: { status },
        }),
        this.prisma.eventLog.create({
          data: {
            projectId: state.projectId,
            nodeName: MOCK_NODE.FINALIZE,
            eventType: failed ? 'FAILED' : 'COMPLETED',
            costMeta: {
              provider: this.agentProviderMode(),
              runId: state.runId,
              completedArtifactIds: state.completedArtifactIds,
              failedWorkOrderIds: state.failedWorkOrderIds,
              error: state.error,
            },
            runTokens: 0,
            occurredAt: completedAt,
          },
        }),
        this.prisma.projectTimelineEvent.create({
          data: {
            projectId: state.projectId,
            actorId: state.actorId,
            type: ProjectTimelineEventType.PROJECT_UPDATED,
            visibility: ProjectTimelineVisibility.TEAM,
            title,
            body,
            metadata: {
              provider: this.agentProviderMode(),
              runId: state.runId,
              completedArtifactIds: state.completedArtifactIds,
              failedWorkOrderIds: state.failedWorkOrderIds,
            },
          },
        }),
        this.prisma.orchestrationRun.updateMany({
          where: { projectId: state.projectId, runId: state.runId },
          data: {
            status: failed ? OrchestrationRunStatus.FAILED : OrchestrationRunStatus.SUCCEEDED,
            currentNode: MOCK_NODE.FINALIZE,
            error: failed ? state.error : null,
            completedWorkOrders: state.completedArtifactIds.length,
            failedWorkOrders: state.failedWorkOrderIds.length,
            completedArtifacts: state.completedArtifactIds.length,
            completedAt,
          },
        }),
      ]);

      if (!failed) {
        await this.notifications.notify({
          recipientIds: await this.notifications.projectManagers(state.projectId),
          actorId: state.actorId,
          projectId: state.projectId,
          type: NotificationType.WORK_ORDER_STATUS_CHANGED,
          title: 'Orchestration outputs ready',
          body,
          metadata: {
            provider: this.agentProviderMode(),
            runId: state.runId,
            artifactCount: state.completedArtifactIds.length,
          },
        });
      }

      this.gateway?.emitStatusUpdate(
        state.projectId,
        status,
        MOCK_NODE.FINALIZE,
        state.error ?? undefined,
      );

      return {};
    });

    graph.addEdge(START, MOCK_NODE.LOAD_READY_WORK_ORDERS);
    graph.addEdge(MOCK_NODE.LOAD_READY_WORK_ORDERS, MOCK_NODE.EXECUTE_READY_WORK_ORDERS);
    graph.addEdge(MOCK_NODE.EXECUTE_READY_WORK_ORDERS, MOCK_NODE.FINALIZE);
    graph.addEdge(MOCK_NODE.FINALIZE, END);

    return graph.compile({ checkpointer: this.checkpointer });
  }

  private assertWorkOrderExecutable(
    workOrder: {
      id: string;
      status: WorkOrderStatus;
      instructions: string | null;
      executionRunId: string | null;
      executionStartedAt: Date | null;
    },
    options: WorkOrderExecutionOptions,
  ): void {
    const isReady = workOrder.status === WorkOrderStatus.READY;
    const isFreshManualDispatch =
      workOrder.status === WorkOrderStatus.DISPATCHED &&
      !workOrder.executionRunId &&
      !workOrder.executionStartedAt;
    const isAllowedFailedRetry =
      options.allowFailedRetry === true &&
      workOrder.status === WorkOrderStatus.FAILED;

    if (!isReady && !isFreshManualDispatch && !isAllowedFailedRetry) {
      throw new Error(
        `Work order ${workOrder.id} must be READY before agent execution`,
      );
    }

    if (!workOrder.instructions?.trim()) {
      throw new Error(
        `Work order ${workOrder.id} needs instructions before agent execution`,
      );
    }
  }

  private workOrderContractMetadata(
    agentType: WorkOrderAgentType,
  ): Prisma.InputJsonObject {
    const contract = agentArtifactContractFor(agentType);
    return {
      version: ORCHESTRATION_CONTRACT_VERSION,
      agentType,
      agentSlug: contract.slug,
      nodeName: contract.nodeName,
      requiredExtensions: contract.requiredExtensions,
      requiredSignals: contract.requiredSignals,
      handoffChecklist: contract.handoffChecklist,
    };
  }

  private agentProviderMode(): AgentProviderMode {
    return this.agentProviderRegistry.activeMode();
  }

  private requestedAgentProviderMode(): AgentProviderMode {
    return this.agentProviderRegistry.requestedMode();
  }

  private async getRunId(projectId: string): Promise<string> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { runId: true },
    });
    if (!project?.runId) {
      throw new Error(
        `Project ${projectId} has no runId — cannot resume graph`,
      );
    }
    return project.runId;
  }

  private async findOrCreateWorkOrderRun(
    projectId: string,
    input: {
      runId: string;
      executionRunId: string;
      trigger: OrchestrationRunTrigger;
      actorId?: string;
      currentNode: string;
    },
  ): Promise<{ id: string }> {
    const existing = await this.prisma.orchestrationRun.findUnique({
      where: { runId: input.runId },
      select: { id: true },
    });

    if (existing) {
      await this.prisma.orchestrationRun.update({
        where: { id: existing.id },
        data: {
          currentNode: input.currentNode,
          status: OrchestrationRunStatus.RUNNING,
        },
      });
      return existing;
    }

    return this.prisma.orchestrationRun.create({
      data: {
        projectId,
        runId: input.runId,
        providerMode: this.agentProviderMode(),
        trigger: input.trigger,
        status: OrchestrationRunStatus.RUNNING,
        currentNode: input.currentNode,
        actorId: input.actorId ?? null,
        readyWorkOrders: 1,
      },
      select: { id: true },
    });
  }

  private async updateRunProgress(
    id: string,
    data: Prisma.OrchestrationRunUpdateInput,
  ): Promise<void> {
    await this.prisma.orchestrationRun.update({
      where: { id },
      data,
    });
  }

  private async incrementRunCompletion(
    id: string,
    input: { artifactId: string; currentNode: string; completeRun: boolean },
  ): Promise<void> {
    await this.prisma.orchestrationRun.update({
      where: { id },
      data: {
        currentNode: input.currentNode,
        completedWorkOrders: { increment: 1 },
        completedArtifacts: { increment: 1 },
        status: input.completeRun ? OrchestrationRunStatus.SUCCEEDED : undefined,
        completedAt: input.completeRun ? new Date() : undefined,
      },
    });
  }

  private async incrementRunFailure(
    id: string,
    input: { error: string; currentNode: string; completeRun: boolean },
  ): Promise<void> {
    await this.prisma.orchestrationRun.update({
      where: { id },
      data: {
        currentNode: input.currentNode,
        failedWorkOrders: { increment: 1 },
        error: input.error,
        status: input.completeRun ? OrchestrationRunStatus.FAILED : undefined,
        completedAt: input.completeRun ? new Date() : undefined,
      },
    });
  }

  private async markRunFailed(
    runId: string,
    currentNode: string,
    error: string,
  ): Promise<void> {
    await this.prisma.orchestrationRun.updateMany({
      where: { runId },
      data: {
        status: OrchestrationRunStatus.FAILED,
        currentNode,
        error,
        completedAt: new Date(),
      },
    });
  }

  private getCurrentNode(checkpoint: unknown): string {
    if (!checkpoint || typeof checkpoint !== 'object') return 'none';
    const cp = checkpoint as Record<string, unknown>;
    const metadata = cp['metadata'] as Record<string, unknown> | undefined;
    if (metadata?.['source'] === 'loop') {
      const writes = metadata?.['writes'] as Record<string, unknown> | null;
      if (writes && Object.keys(writes).length > 0) {
        return Object.keys(writes)[0] ?? 'none';
      }
    }
    const next = cp['next'] as string[] | undefined;
    return next?.[0] ?? 'none';
  }

  private workOrderNodeName(agentType: WorkOrderAgentType): string {
    return `work_order_${agentType.toLowerCase()}`;
  }

  private async recordWorkOrderTimelineEvent(
    projectId: string,
    actorId: string | undefined,
    input: {
      type: ProjectTimelineEventType;
      title: string;
      body?: string | null;
      taskId?: string | null;
      artifactId?: string | null;
      metadata?: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    await this.prisma.projectTimelineEvent.create({
      data: {
        projectId,
        actorId: actorId ?? null,
        taskId: input.taskId ?? null,
        artifactId: input.artifactId ?? null,
        type: input.type,
        visibility: ProjectTimelineVisibility.TEAM,
        title: input.title,
        body: input.body ?? null,
        metadata: input.metadata ?? {},
      },
    });
  }

  private async notifyWorkOrderLifecycle(
    projectId: string,
    actorId: string | undefined,
    workOrder: {
      id: string;
      title: string;
      agentType: WorkOrderAgentType;
      taskId: string | null;
      task: { assignedToId: string | null } | null;
    },
    input: {
      type: NotificationType;
      title: string;
      status: WorkOrderStatus;
      executionRunId: string;
      artifactId?: string;
    },
  ): Promise<void> {
    await this.notifications.notify({
      recipientIds: [
        ...(await this.notifications.projectManagers(projectId)),
        ...(workOrder.task?.assignedToId ? [workOrder.task.assignedToId] : []),
      ],
      actorId: actorId ?? null,
      projectId,
      taskId: workOrder.taskId,
      artifactId: input.artifactId ?? null,
      type: input.type,
      title: input.title,
      body: workOrder.title,
      metadata: {
        workOrderId: workOrder.id,
        status: input.status,
        agentType: workOrder.agentType,
        executionRunId: input.executionRunId,
      },
    });
  }
}
