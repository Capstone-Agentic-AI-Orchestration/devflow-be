import {
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
import type { CompiledStateGraph } from '@langchain/langgraph';
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
import { ProjectTaskActivityType, ProjectTaskStatus, WorkOrderAgentType, WorkOrderStatus } from '@prisma/client';

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

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class OrchestrationService implements OnModuleInit {
  private readonly logger = new Logger(OrchestrationService.name);

  private graph!: CompiledStateGraph<
    DevFlowStateType,
    Partial<DevFlowStateType>,
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
    // Optional: WebSocket gateway may not be present in all environments
    @Optional() private readonly gateway: DevFlowGateway | null,
  ) {}

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
  ): Promise<string> {
    const runId = createId();

    this.logger.log(
      `Starting run ${runId} for project ${projectId} (${companyName})`,
    );

    await this.prisma.project.update({
      where: { id: projectId },
      data: { runId },
    });

    // Initialise run budget (Phase 2B)
    await this.prisma.runBudget.create({
      data: { projectId },
    });

    const config = threadConfig(projectId, runId);

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
  ): Promise<WorkOrderExecutionResult> {
    const executionRunId = createId();
    const startedAt = new Date();
    const workOrder = await this.prisma.workOrder.findFirst({
      where: { id: workOrderId, projectId },
      include: {
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

    const attempt = workOrder.executionAttempt + 1;
    const nodeName = this.workOrderNodeName(workOrder.agentType);

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
        },
        runTokens: 0,
        occurredAt: startedAt,
      },
    });

    this.gateway?.emitStatusUpdate(projectId, 'GENERATING_CODE', nodeName);

    try {
      const completedAt = new Date();
      const artifact = await this.prisma.artifact.create({
        data: {
          projectId,
          agentType: workOrder.agentType.toLowerCase(),
          filePath: this.workOrderArtifactPath(workOrder.agentType, workOrder.id),
          displayName: `${workOrder.title} output`,
          content: this.renderWorkOrderArtifactContent(workOrder, executionRunId),
          clientVisible: false,
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
          },
          runTokens: 0,
          occurredAt: completedAt,
        },
      });

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
            error: message,
          },
          runTokens: 0,
          occurredAt: failedAt,
        },
      });
      this.gateway?.emitStatusUpdate(projectId, 'FAILED', nodeName, message);
      throw error;
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

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

  private workOrderArtifactPath(agentType: WorkOrderAgentType, workOrderId: string): string {
    const extension = agentType === WorkOrderAgentType.DATABASE ? 'sql' : 'md';
    return `work-orders/${workOrderId}/${agentType.toLowerCase()}-output.${extension}`;
  }

  private renderWorkOrderArtifactContent(
    workOrder: {
      id: string;
      title: string;
      instructions: string | null;
      agentType: WorkOrderAgentType;
      priority: string;
      task: { title: string; description: string | null } | null;
      artifact: { filePath: string; displayName: string | null; content: string } | null;
    },
    executionRunId: string,
  ): string {
    const lines = [
      `# ${workOrder.title}`,
      '',
      `Execution run: ${executionRunId}`,
      `Work order: ${workOrder.id}`,
      `Agent: ${workOrder.agentType}`,
      `Priority: ${workOrder.priority}`,
      '',
      '## Instructions',
      workOrder.instructions || 'No explicit instructions were provided.',
    ];

    if (workOrder.task) {
      lines.push('', '## Linked task', workOrder.task.title);
      if (workOrder.task.description) lines.push('', workOrder.task.description);
    }

    if (workOrder.artifact) {
      lines.push(
        '',
        '## Source artifact',
        workOrder.artifact.displayName || workOrder.artifact.filePath,
        '',
        '```',
        workOrder.artifact.content,
        '```',
      );
    }

    lines.push('', '## Execution result', 'Generated by the DevFlow work-order orchestration bridge.');
    return lines.join('\n');
  }
}
