import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrchestrationService } from '../src/orchestration/orchestration.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { MemoryService } from '../src/memory/memory.service';
import { RequirementsParserNode } from '../src/orchestration/nodes/requirements-parser.node';
import { ContractNegotiatorNode } from '../src/orchestration/nodes/contract-negotiator.node';
import { FrontendAgentNode } from '../src/orchestration/nodes/frontend-agent.node';
import { BackendAgentNode } from '../src/orchestration/nodes/backend-agent.node';
import { DatabaseAgentNode } from '../src/orchestration/nodes/database-agent.node';
import { ArchitectureAgentNode } from '../src/orchestration/nodes/architecture-agent.node';
import { ValidatorNode } from '../src/orchestration/nodes/validator.node';
import { GithubCommitNode } from '../src/orchestration/nodes/github-commit.node';
import { MockAgentProvider } from '../src/orchestration/providers/mock-agent.provider';
import { NotificationsService } from '../src/notifications/notifications.service';
import type { RequirementsDocument, ProjectContract, GeneratedArtifact } from '../src/orchestration/graph/devflow.state';
import { ArtifactReviewStatus, ProjectTaskStatus, WorkOrderAgentType, WorkOrderPriority, WorkOrderStatus } from '@prisma/client';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_REQUIREMENTS: RequirementsDocument = {
  projectType: 'e-commerce',
  features: ['product listing', 'cart', 'checkout'],
  techStack: {
    frontend: 'Next.js 15',
    backend: 'NestJS 10',
    database: 'PostgreSQL with Prisma',
    styling: 'Tailwind CSS',
  },
  complexity: 'medium',
  estimatedFiles: 12,
};

const MOCK_CONTRACT: ProjectContract = {
  projectId: 'test-project-id',
  projectName: 'Test Shop',
  description: 'A test e-commerce project',
  requirements: MOCK_REQUIREMENTS,
  fileManifest: [
    'src/app/page.tsx',
    'src/app/layout.tsx',
    'src/components/Header.tsx',
    'README-frontend.md',
    'src/products/products.module.ts',
    'src/products/products.controller.ts',
    'src/products/products.service.ts',
    'src/products/dto/create-product.dto.ts',
    'README-backend.md',
    'prisma/schema.prisma',
    'prisma/seed.ts',
    'README-database.md',
    'ARCHITECTURE.md',
    'API.md',
    'DEPLOYMENT.md',
  ],
  acceptanceCriteria: ['All files generated', 'No TypeScript errors'],
  lockedAt: new Date().toISOString(),
};

const makeArtifact = (agentType: GeneratedArtifact['agentType'], filePath: string): GeneratedArtifact => ({
  agentType,
  filePath,
  content: `// ${filePath}`,
  language: 'typescript',
});

// ─── Mock factories ───────────────────────────────────────────────────────────

function makePrismaMock() {
  return {
    project: {
      findUnique: vi.fn().mockResolvedValue({ id: 'test-project-id', status: 'PENDING', runId: null }),
      update: vi.fn().mockResolvedValue({}),
    },
    gateEvent: {
      create: vi.fn().mockResolvedValue({}),
    },
    artifact: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn(),
    },
    workOrder: {
      findFirst: vi.fn(),
      count: vi.fn().mockResolvedValue(1),
      update: vi.fn().mockResolvedValue({}),
    },
    orchestrationRun: {
      create: vi.fn().mockResolvedValue({ id: 'orchestration-run-1' }),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    workOrderExecution: {
      create: vi.fn().mockResolvedValue({ id: 'execution-1' }),
      update: vi.fn().mockResolvedValue({ id: 'execution-1' }),
    },
    runBudget: {
      create: vi.fn().mockResolvedValue({}),
    },
    eventLog: {
      create: vi.fn().mockResolvedValue({}),
    },
    projectTimelineEvent: {
      create: vi.fn().mockResolvedValue({}),
    },
    projectTask: {
      update: vi.fn().mockResolvedValue({}),
    },
    projectTaskActivity: {
      create: vi.fn().mockResolvedValue({}),
    },
  };
}

function makeNodeMock<T>(returnValue: T) {
  return { execute: vi.fn().mockResolvedValue(returnValue) };
}

function makeMemoryMock() {
  return {
    writeMistake: vi.fn().mockResolvedValue(undefined),
    writeSkill: vi.fn().mockResolvedValue(undefined),
    writePattern: vi.fn().mockResolvedValue(undefined),
  };
}

function makeNotificationsMock() {
  return {
    notify: vi.fn().mockResolvedValue(undefined),
    projectManagers: vi.fn().mockResolvedValue(['pm-2']),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OrchestrationService', () => {
  let service: OrchestrationService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let requirementsParser: { execute: ReturnType<typeof vi.fn> };
  let contractNegotiator: { execute: ReturnType<typeof vi.fn> };
  let frontendAgent: { execute: ReturnType<typeof vi.fn> };
  let backendAgent: { execute: ReturnType<typeof vi.fn> };
  let databaseAgent: { execute: ReturnType<typeof vi.fn> };
  let architectureAgent: { execute: ReturnType<typeof vi.fn> };
  let validator: { execute: ReturnType<typeof vi.fn> };
  let githubCommit: { execute: ReturnType<typeof vi.fn> };
  let memory: ReturnType<typeof makeMemoryMock>;
  let mockAgentProvider: MockAgentProvider;
  let notifications: ReturnType<typeof makeNotificationsMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
    memory = makeMemoryMock();
    mockAgentProvider = new MockAgentProvider();
    notifications = makeNotificationsMock();

    requirementsParser = makeNodeMock({ requirements: MOCK_REQUIREMENTS });
    contractNegotiator = makeNodeMock({ contract: MOCK_CONTRACT });
    frontendAgent = makeNodeMock({
      artifacts: [
        makeArtifact('frontend', 'src/app/page.tsx'),
        makeArtifact('frontend', 'src/app/layout.tsx'),
        makeArtifact('frontend', 'src/components/Header.tsx'),
        makeArtifact('frontend', 'README-frontend.md'),
      ],
    });
    backendAgent = makeNodeMock({
      artifacts: [
        makeArtifact('backend', 'src/products/products.module.ts'),
        makeArtifact('backend', 'src/products/products.controller.ts'),
        makeArtifact('backend', 'src/products/products.service.ts'),
        makeArtifact('backend', 'src/products/dto/create-product.dto.ts'),
        makeArtifact('backend', 'README-backend.md'),
      ],
    });
    databaseAgent = makeNodeMock({
      artifacts: [
        makeArtifact('database', 'prisma/schema.prisma'),
        makeArtifact('database', 'prisma/seed.ts'),
        makeArtifact('database', 'README-database.md'),
      ],
    });
    architectureAgent = makeNodeMock({
      artifacts: [
        makeArtifact('architecture', 'ARCHITECTURE.md'),
        makeArtifact('architecture', 'API.md'),
        makeArtifact('architecture', 'DEPLOYMENT.md'),
      ],
    });
    validator = makeNodeMock({});
    githubCommit = makeNodeMock({ repoUrl: 'https://github.com/test/test-shop' });

    service = new OrchestrationService(
      prisma as unknown as PrismaService,
      requirementsParser as unknown as RequirementsParserNode,
      contractNegotiator as unknown as ContractNegotiatorNode,
      frontendAgent as unknown as FrontendAgentNode,
      backendAgent as unknown as BackendAgentNode,
      databaseAgent as unknown as DatabaseAgentNode,
      architectureAgent as unknown as ArchitectureAgentNode,
      validator as unknown as ValidatorNode,
      githubCommit as unknown as GithubCommitNode,
      memory as unknown as MemoryService,
      mockAgentProvider,
      notifications as unknown as NotificationsService,
      null,
    );

    // Mock checkpointer so onModuleInit doesn't need a real DB
    vi.spyOn(service as unknown as { onModuleInit: () => Promise<void> }, 'onModuleInit').mockResolvedValue(undefined);
  });

  it('startRun updates project runId and returns a non-empty runId', async () => {
    // Stub graph invoke so it doesn't actually run
    (service as unknown as { mockWorkOrderGraph: { invoke: ReturnType<typeof vi.fn> } }).mockWorkOrderGraph = {
      invoke: vi.fn().mockResolvedValue({}),
    };

    const runId = await service.startRun('test-project-id', 'Build a shop', 'nextjs-nestjs', 'TestCo');
    expect(runId).toBeTruthy();
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: 'test-project-id' },
      data: { runId },
    });
    expect(prisma.orchestrationRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: 'test-project-id',
        runId,
        status: 'RUNNING',
      }),
    });
  });

  it('resumeGate1 with approved=false records REJECTED and does not resume graph', async () => {
    prisma.project.findUnique.mockResolvedValue({ runId: 'run-001' });
    (service as unknown as { graph: { updateState: ReturnType<typeof vi.fn>; invoke: ReturnType<typeof vi.fn> } }).graph = {
      updateState: vi.fn(),
      invoke: vi.fn(),
    };
    (service as unknown as { checkpointer: { get: ReturnType<typeof vi.fn> } }).checkpointer = {
      get: vi.fn().mockResolvedValue(null),
    };

    await service.resumeGate1('test-project-id', false, 'needs more work');

    expect(prisma.gateEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ decision: 'REJECTED' }) }),
    );
    const graphMock = (service as unknown as { graph: { invoke: ReturnType<typeof vi.fn> } }).graph;
    expect(graphMock.invoke).not.toHaveBeenCalled();
  });

  it('resumeGate1 with approved=true records APPROVED and resumes graph', async () => {
    prisma.project.findUnique.mockResolvedValue({ runId: 'run-001' });
    const updateState = vi.fn().mockResolvedValue({});
    const invoke = vi.fn().mockResolvedValue({});
    (service as unknown as { graph: unknown }).graph = { updateState, invoke };
    (service as unknown as { checkpointer: { get: ReturnType<typeof vi.fn> } }).checkpointer = {
      get: vi.fn().mockResolvedValue(null),
    };

    await service.resumeGate1('test-project-id', true);

    expect(prisma.gateEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ decision: 'APPROVED' }) }),
    );
    expect(updateState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ gate1Approved: true }),
    );
    expect(invoke).toHaveBeenCalledWith(null, expect.anything());
  });

  it('resumeGate2 with approved=true records APPROVED and resumes graph', async () => {
    prisma.project.findUnique.mockResolvedValue({ runId: 'run-002' });
    const updateState = vi.fn().mockResolvedValue({});
    const invoke = vi.fn().mockResolvedValue({});
    (service as unknown as { graph: unknown }).graph = { updateState, invoke };
    (service as unknown as { checkpointer: { get: ReturnType<typeof vi.fn> } }).checkpointer = {
      get: vi.fn().mockResolvedValue(null),
    };

    await service.resumeGate2('test-project-id', true, 'looks good');

    expect(updateState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ gate2Approved: true, gate2Notes: 'looks good' }),
    );
    expect(invoke).toHaveBeenCalledWith(null, expect.anything());
  });

  it('getStatus returns UNKNOWN when project has no runId', async () => {
    prisma.project.findUnique.mockResolvedValue({ status: 'PENDING', runId: null });
    (service as unknown as { checkpointer: unknown }).checkpointer = {};

    const status = await service.getStatus('test-project-id');
    expect(status.status).toBe('PENDING');
    expect(status.currentNode).toBe('none');
    expect(status.retryCount).toBe(0);
    expect(status.error).toBeNull();
  });

  it('getStatus masks RETRY: prefix errors from public response', async () => {
    prisma.project.findUnique.mockResolvedValue({ status: 'GENERATING_CODE', runId: 'run-003' });
    (service as unknown as { checkpointer: { get: ReturnType<typeof vi.fn> } }).checkpointer = {
      get: vi.fn().mockResolvedValue({
        channel_values: { error: 'RETRY:frontend', retryCount: 1 },
        metadata: { source: 'loop', writes: { validate_outputs: {} } },
      }),
    };

    const status = await service.getStatus('test-project-id');
    expect(status.error).toBeNull();
    expect(status.retryCount).toBe(1);
  });

  it('executeWorkOrder records execution logs, creates an artifact, and links it back to work order and task', async () => {
    prisma.workOrder.findFirst.mockResolvedValue({
      id: 'work-order-1',
      projectId: 'test-project-id',
      taskId: 'task-1',
      artifactId: null,
      title: 'Build frontend shell',
      instructions: 'Create the first dashboard shell.',
      agentType: WorkOrderAgentType.FRONTEND,
      priority: WorkOrderPriority.HIGH,
      status: WorkOrderStatus.READY,
      executionAttempt: 0,
      dispatchedAt: null,
      project: {
        id: 'test-project-id',
        companyName: 'TestCo',
        brief: 'Build a shop',
        stackKey: 'nextjs-nestjs',
      },
      task: {
        id: 'task-1',
        title: 'Frontend dashboard',
        description: 'Client dashboard task.',
        assignedToId: 'dev-1',
        status: ProjectTaskStatus.TODO,
      },
      artifact: null,
    });
    prisma.artifact.create.mockResolvedValue({
      id: 'artifact-generated-1',
      projectId: 'test-project-id',
      agentType: 'frontend',
      filePath: 'work-orders/work-order-1/frontend-output.md',
      displayName: 'Build frontend shell output',
      reviewStatus: ArtifactReviewStatus.PENDING,
    });

    const result = await service.executeWorkOrder('test-project-id', 'work-order-1', 'pm-1');

    expect(result).toEqual({
      executionRunId: expect.any(String),
      artifactId: 'artifact-generated-1',
    });
    expect(prisma.eventLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: 'test-project-id',
        nodeName: 'work_order_frontend',
        eventType: 'STARTED',
        costMeta: expect.objectContaining({ workOrderId: 'work-order-1' }),
      }),
    });
    expect(prisma.workOrderExecution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: 'test-project-id',
        orchestrationRunId: 'orchestration-run-1',
        workOrderId: 'work-order-1',
        executionRunId: expect.any(String),
        attempt: 1,
        agentType: WorkOrderAgentType.FRONTEND,
        status: 'RUNNING',
      }),
    });
    expect(prisma.artifact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: 'test-project-id',
        agentType: 'frontend',
        filePath: 'work-orders/work-order-1/frontend-output.tsx',
        clientVisible: false,
      }),
    });
    expect(prisma.workOrder.update).toHaveBeenCalledWith({
      where: { id: 'work-order-1' },
      data: expect.objectContaining({
        status: WorkOrderStatus.COMPLETED,
        artifactId: 'artifact-generated-1',
        executionCompletedAt: expect.any(Date),
      }),
    });
    expect(prisma.projectTask.update).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: {
        status: ProjectTaskStatus.IN_REVIEW,
        artifactId: 'artifact-generated-1',
      },
    });
    expect(prisma.eventLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: 'test-project-id',
        nodeName: 'work_order_frontend',
        eventType: 'COMPLETED',
        costMeta: expect.objectContaining({
          workOrderId: 'work-order-1',
          artifactId: 'artifact-generated-1',
        }),
      }),
    });
  });
});
