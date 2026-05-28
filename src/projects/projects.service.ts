import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrchestrationService, OrchestrationStatus } from '../orchestration/orchestration.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { ArtifactOutputReviewStatus, ArtifactReviewStatus, ClientInviteStatus, CollaborationDocumentStatus, NotificationType, ProjectDeliveryReview, ProjectDeliveryReviewStatus, ProjectStatus, ProjectTimelineEvent, ProjectTimelineEventType, ProjectTimelineVisibility, ProjectTaskActivity, ProjectTaskActivityType, ProjectTaskStatus, Project, GateEvent, Artifact, EventLog, Prisma, ProjectKickoff, ProjectKickoffStatus, ProjectTask, UserRole, WorkOrder, WorkOrderAgentType, WorkOrderPriority, WorkOrderStatus } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { UpdateProjectDto } from './dto/update-project.dto';
import { AddProjectMemberDto } from './dto/project-member.dto';
import { ShareArtifactDto } from './dto/share-artifact.dto';
import { ReviewArtifactDto } from './dto/review-artifact.dto';
import { HandleRevisionDto } from './dto/handle-revision.dto';
import { ProjectDeliveryReviewNoteDto } from './dto/project-delivery-review.dto';
import { PublishArtifactOutputDto, ReviewArtifactOutputDto } from './dto/output-review.dto';
import { CreateProjectTaskDto, UpdateProjectTaskDto } from './dto/project-task.dto';
import { AddTaskCommentDto } from './dto/task-comment.dto';
import { CreateWorkOrderDto, UpdateWorkOrderDto } from './dto/work-order.dto';
import { UpdateProjectKickoffDto } from './dto/project-kickoff.dto';
import { NotificationsService } from '../notifications/notifications.service';

type ProjectWithRelations = Project & {
  gates: GateEvent[];
  createdBy: { id: string; email: string | null; fullName: string | null; role: UserRole } | null;
  members: {
    id: string;
    projectId: string;
    userId: string;
    role: UserRole;
    createdAt: Date;
    user: { id: string; email: string | null; fullName: string | null; role: UserRole };
  }[];
  runBudget: {
    id: string;
    tokenBudget: number;
    tokensConsumed: number;
    retryCount: number;
    maxRetries: number;
    createdAt: Date;
    updatedAt: Date;
  } | null;
  kickoff: ProjectKickoff | null;
  deliveryReview: ProjectDeliveryReview | null;
  clientInvites: {
    id: string;
    email: string;
    contactName: string;
    companyName: string;
    status: ClientInviteStatus;
    acceptedById: string | null;
    acceptedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }[];
  lifecycle: ProjectLifecycleSummary;
  _count: { artifacts: number; eventLogs: number };
};

type ProjectLifecycleStage =
  | 'APPROVED'
  | 'CLIENT_ONBOARDING'
  | 'KICKOFF'
  | 'READY_FOR_ORCHESTRATION'
  | 'IN_ORCHESTRATION'
  | 'CLIENT_REVIEW'
  | 'REVISION'
  | 'DELIVERED'
  | 'FAILED';

type ProjectLifecycleSummary = {
  stage: ProjectLifecycleStage;
  label: string;
  nextAction: string;
  tone: 'gray' | 'blue' | 'purple' | 'yellow' | 'green' | 'red';
  progress: number;
  signals: {
    clientAccepted: boolean;
    kickoffReady: boolean;
    orchestrationStarted: boolean;
    clientReviewOpen: boolean;
    revisionOpen: boolean;
    deliveryAccepted: boolean;
    deliveryRevisionOpen: boolean;
    totalTasks: number;
    openTasks: number;
    totalWorkOrders: number;
    activeWorkOrders: number;
    clientVisibleArtifacts: number;
  };
};

type ProjectListItem = Pick<Project, 'id' | 'companyName' | 'status' | 'createdAt' | 'updatedAt'> & {
  lifecycle: ProjectLifecycleSummary;
};

type ProjectLifecycleSource = Pick<Project, 'status' | 'runId'> & {
  kickoff?: Pick<ProjectKickoff, 'status'> | null;
  clientInvites?: { status: ClientInviteStatus }[];
  artifacts?: {
    clientVisible: boolean;
    reviewStatus: ArtifactReviewStatus;
    revisionHandledAt: Date | null;
  }[];
  tasks?: { status: ProjectTaskStatus }[];
  workOrders?: { status: WorkOrderStatus }[];
  deliveryReview?: Pick<ProjectDeliveryReview, 'status'> | null;
};

type ArtifactListItem =
  | Artifact
  | Pick<
      Artifact,
      | 'id'
      | 'projectId'
      | 'agentType'
      | 'filePath'
      | 'clientVisible'
      | 'displayName'
      | 'sharedAt'
      | 'reviewStatus'
      | 'reviewNote'
      | 'reviewedAt'
      | 'reviewedById'
      | 'outputReviewStatus'
      | 'outputReviewNote'
      | 'outputReviewedAt'
      | 'outputReviewedById'
      | 'publishedAt'
      | 'publishedById'
      | 'revisionHandledAt'
      | 'revisionHandledById'
      | 'revisionResolutionNote'
      | 'createdAt'
    >;

type ProjectTaskWithRelations = ProjectTask & {
  assignedTo: { id: string; email: string | null; fullName: string | null; role: UserRole } | null;
  createdBy: { id: string; email: string | null; fullName: string | null; role: UserRole } | null;
  artifact: {
    id: string;
    filePath: string;
    displayName: string | null;
    reviewStatus: ArtifactReviewStatus;
    reviewNote: string | null;
    reviewedAt: Date | null;
    revisionHandledAt: Date | null;
  } | null;
};

type ProjectTaskActivityWithActor = ProjectTaskActivity & {
  actor: { id: string; email: string | null; fullName: string | null; role: UserRole } | null;
};

type ProjectTimelineEventWithActor = ProjectTimelineEvent & {
  actor: { id: string; email: string | null; fullName: string | null; role: UserRole } | null;
};

type WorkOrderWithRelations = WorkOrder & {
  task: { id: string; title: string; assignedToId: string | null; status: ProjectTaskStatus } | null;
  artifact: { id: string; filePath: string; displayName: string | null; reviewStatus: ArtifactReviewStatus; outputReviewStatus: ArtifactOutputReviewStatus } | null;
  createdBy: { id: string; email: string | null; fullName: string | null; role: UserRole } | null;
};

const taskInclude = {
  assignedTo: {
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
    },
  },
  createdBy: {
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
    },
  },
  artifact: {
    select: {
      id: true,
      filePath: true,
      displayName: true,
      reviewStatus: true,
      reviewNote: true,
      reviewedAt: true,
      revisionHandledAt: true,
    },
  },
} satisfies Prisma.ProjectTaskInclude;

const taskActivityInclude = {
  actor: {
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
    },
  },
} satisfies Prisma.ProjectTaskActivityInclude;

const timelineInclude = {
  actor: {
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
    },
  },
} satisfies Prisma.ProjectTimelineEventInclude;

const workOrderInclude = {
  task: {
    select: {
      id: true,
      title: true,
      assignedToId: true,
      status: true,
    },
  },
  artifact: {
    select: {
      id: true,
      filePath: true,
      displayName: true,
      reviewStatus: true,
      outputReviewStatus: true,
    },
  },
  createdBy: {
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
    },
  },
} satisfies Prisma.WorkOrderInclude;

const kickoffChecklistFields = [
  'scopeConfirmed',
  'milestonesConfirmed',
  'documentsConfirmed',
  'techStackConfirmed',
  'rolesConfirmed',
  'clientAccessConfirmed',
  'initialTasksCreated',
  'initialWorkOrdersCreated',
] as const;

type KickoffChecklistField = (typeof kickoffChecklistFields)[number];

const kickoffTextFields = [
  'scopeSummary',
  'milestones',
  'requiredDocuments',
  'techStackNotes',
  'deliveryRoles',
  'readinessNotes',
] as const;

type KickoffTextField = (typeof kickoffTextFields)[number];

type ProjectKickoffInput = Partial<
  Pick<
    ProjectKickoff,
    KickoffTextField | KickoffChecklistField
  >
>;

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestration: OrchestrationService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(dto: CreateProjectDto, user: AuthUser): Promise<Project> {
    const project = await this.prisma.project.create({
      data: {
        companyName: dto.companyName,
        brief: dto.brief,
        stackKey: dto.stackKey,
        createdById: user.id,
      },
    });

    this.logger.log(`Created project ${project.id} for ${project.companyName}`);
    await this.recordTimelineEvent(project.id, user, {
      type: ProjectTimelineEventType.PROJECT_CREATED,
      visibility: ProjectTimelineVisibility.TEAM,
      title: 'Project created',
      body: project.companyName,
      metadata: { status: project.status, stackKey: project.stackKey },
    });
    return project;
  }

  async startOrchestration(
    id: string,
    user: AuthUser,
  ): Promise<{ accepted: boolean; runId: string }> {
    const project = await this.prisma.project.findFirst({
      where: this.projectAccessWhere(user, id),
      select: {
        id: true,
        companyName: true,
        brief: true,
        stackKey: true,
        runId: true,
        kickoff: {
          select: {
            status: true,
          },
        },
      },
    });

    if (!project) {
      throw new NotFoundException(`Project ${id} not found`);
    }

    if (project.runId) {
      return { accepted: true, runId: project.runId };
    }

    if (project.kickoff?.status !== ProjectKickoffStatus.READY && project.kickoff?.status !== ProjectKickoffStatus.LOCKED) {
      throw new BadRequestException('Project kickoff must be complete before orchestration can start');
    }

    const runId = await this.orchestration.startRun(
      project.id,
      project.brief,
      project.stackKey,
      project.companyName,
    );

    return { accepted: true, runId };
  }

  async findAll(user: AuthUser): Promise<ProjectListItem[]> {
    const projects = await this.prisma.project.findMany({
      where: this.projectAccessWhere(user),
      select: {
        id: true,
        companyName: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        runId: true,
        kickoff: {
          select: {
            status: true,
          },
        },
        deliveryReview: {
          select: {
            status: true,
          },
        },
        clientInvites: {
          select: {
            status: true,
          },
        },
        artifacts: {
          select: {
            clientVisible: true,
            reviewStatus: true,
            revisionHandledAt: true,
          },
        },
        tasks: {
          select: {
            status: true,
          },
        },
        workOrders: {
          select: {
            status: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return projects.map((project) => ({
      id: project.id,
      companyName: project.companyName,
      status: project.status,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      lifecycle: this.deriveProjectLifecycle(project),
    }));
  }

  async findOne(id: string, user: AuthUser): Promise<ProjectWithRelations> {
    const project = await this.prisma.project.findFirst({
      where: this.projectAccessWhere(user, id),
      include: {
        createdBy: {
          select: {
            id: true,
            email: true,
            fullName: true,
            role: true,
          },
        },
        members: {
          orderBy: { createdAt: 'asc' },
          include: {
            user: {
              select: {
                id: true,
                email: true,
                fullName: true,
                role: true,
              },
            },
          },
        },
        gates: {
          orderBy: { decidedAt: 'desc' },
        },
        runBudget: {
          select: {
            id: true,
            tokenBudget: true,
            tokensConsumed: true,
            retryCount: true,
            maxRetries: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        kickoff: true,
        deliveryReview: true,
        artifacts: {
          select: {
            clientVisible: true,
            reviewStatus: true,
            revisionHandledAt: true,
          },
        },
        tasks: {
          select: {
            status: true,
          },
        },
        workOrders: {
          select: {
            status: true,
          },
        },
        clientInvites: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            email: true,
            contactName: true,
            companyName: true,
            status: true,
            acceptedById: true,
            acceptedAt: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        _count: {
          select: { artifacts: true, eventLogs: true },
        },
      },
    });

    if (!project) {
      throw new NotFoundException(`Project ${id} not found`);
    }

    const {
      artifacts: _lifecycleArtifacts,
      tasks: _lifecycleTasks,
      workOrders: _lifecycleWorkOrders,
      ...projectDetail
    } = project;

    return {
      ...projectDetail,
      lifecycle: this.deriveProjectLifecycle(project),
    };
  }

  async update(
    id: string,
    user: AuthUser,
    dto: UpdateProjectDto,
  ): Promise<ProjectWithRelations> {
    await this.assertAccessible(id, user);

    await this.prisma.project.update({
      where: { id },
      data: {
        companyName: dto.companyName,
        brief: dto.brief,
        stackKey: dto.stackKey,
        status: dto.status,
        repoUrl: dto.repoUrl,
      },
    });

    await this.recordTimelineEvent(id, user, {
      type: ProjectTimelineEventType.PROJECT_UPDATED,
      visibility: ProjectTimelineVisibility.TEAM,
      title: 'Project updated',
      body: dto.companyName || dto.status || dto.repoUrl || null,
      metadata: {
        companyName: dto.companyName,
        stackKey: dto.stackKey,
        status: dto.status,
        repoUrl: dto.repoUrl,
      },
    });

    return this.findOne(id, user);
  }

  async findKickoff(id: string, user: AuthUser): Promise<ProjectKickoff> {
    await this.assertAccessible(id, user);

    return this.prisma.projectKickoff.upsert({
      where: { projectId: id },
      update: {},
      create: {
        projectId: id,
        updatedById: user.id,
      },
    });
  }

  async updateKickoff(
    id: string,
    user: AuthUser,
    dto: UpdateProjectKickoffDto,
  ): Promise<ProjectKickoff> {
    await this.assertAccessible(id, user);
    return this.updateKickoffRecord(id, user, dto);
  }

  async createKickoffTasks(
    id: string,
    user: AuthUser,
  ): Promise<{ tasks: ProjectTaskWithRelations[]; kickoff: ProjectKickoff }> {
    await this.assertAccessible(id, user);

    const project = await this.prisma.project.findFirst({
      where: this.projectAccessWhere(user, id),
      select: { id: true, companyName: true, brief: true, stackKey: true },
    });

    if (!project) {
      throw new NotFoundException(`Project ${id} not found`);
    }

    const starterTasks = [
      {
        title: 'Finalize scope and acceptance criteria',
        description: `Confirm delivery boundaries, success criteria, and exclusions for ${project.companyName}.`,
      },
      {
        title: 'Prepare milestone plan',
        description: 'Break the kickoff brief into delivery checkpoints, review moments, and owner expectations.',
      },
      {
        title: 'Collect client documents and access',
        description: 'Confirm required files, credentials, brand assets, and environment access before implementation starts.',
      },
    ];
    const existing = await this.prisma.projectTask.findMany({
      where: {
        projectId: id,
        title: { in: starterTasks.map((task) => task.title) },
      },
      include: taskInclude,
    });
    const existingTitles = new Set(existing.map((task) => task.title));
    const created: ProjectTaskWithRelations[] = [];

    for (const task of starterTasks) {
      if (existingTitles.has(task.title)) continue;
      created.push(await this.createTask(id, user, task));
    }

    const kickoff = await this.updateKickoffRecord(id, user, {
      initialTasksCreated: true,
    });

    return { tasks: [...existing, ...created], kickoff };
  }

  async createKickoffWorkOrders(
    id: string,
    user: AuthUser,
  ): Promise<{ workOrders: WorkOrderWithRelations[]; kickoff: ProjectKickoff }> {
    await this.assertAccessible(id, user);

    const project = await this.prisma.project.findFirst({
      where: this.projectAccessWhere(user, id),
      select: { id: true, companyName: true, brief: true, stackKey: true },
    });

    if (!project) {
      throw new NotFoundException(`Project ${id} not found`);
    }

    const starterWorkOrders = [
      {
        title: 'Architecture kickoff brief',
        instructions: `Review the client brief, stack key (${project.stackKey}), and kickoff checklist before generating architecture decisions.`,
        agentType: WorkOrderAgentType.ARCHITECTURE,
        priority: WorkOrderPriority.HIGH,
      },
      {
        title: 'Implementation discovery handoff',
        instructions: 'Identify frontend, backend, database, and integration questions that must be answered before orchestration starts.',
        agentType: WorkOrderAgentType.BACKEND,
        priority: WorkOrderPriority.NORMAL,
      },
    ];
    const existing = await this.prisma.workOrder.findMany({
      where: {
        projectId: id,
        title: { in: starterWorkOrders.map((workOrder) => workOrder.title) },
      },
      include: workOrderInclude,
    });
    const existingTitles = new Set(existing.map((workOrder) => workOrder.title));
    const created: WorkOrderWithRelations[] = [];

    for (const workOrder of starterWorkOrders) {
      if (existingTitles.has(workOrder.title)) continue;
      const createdWorkOrder = await this.prisma.workOrder.create({
        data: {
          projectId: id,
          title: workOrder.title,
          instructions: workOrder.instructions,
          agentType: workOrder.agentType,
          priority: workOrder.priority,
          status: WorkOrderStatus.READY,
          createdById: user.id,
        },
        include: workOrderInclude,
      });

      await this.recordTimelineEvent(id, user, {
        type: ProjectTimelineEventType.WORK_ORDER_CREATED,
        visibility: ProjectTimelineVisibility.TEAM,
        title: 'Work order created',
        body: createdWorkOrder.title,
        metadata: {
          workOrderId: createdWorkOrder.id,
          agentType: createdWorkOrder.agentType,
          priority: createdWorkOrder.priority,
          source: 'kickoff',
        },
      });

      created.push(createdWorkOrder);
    }

    const kickoff = await this.updateKickoffRecord(id, user, {
      initialWorkOrdersCreated: true,
    });

    return { workOrders: [...existing, ...created], kickoff };
  }

  async addMember(
    projectId: string,
    user: AuthUser,
    dto: AddProjectMemberDto,
  ): Promise<ProjectWithRelations> {
    await this.assertAccessible(projectId, user);
    this.assertManagerRole(user);

    if (!dto.userId && !dto.email) {
      throw new BadRequestException('Either userId or email is required');
    }

    const profile = await this.prisma.profile.findFirst({
      where: dto.userId ? { id: dto.userId } : { email: dto.email },
      select: { id: true, role: true },
    });

    if (!profile) {
      throw new NotFoundException('Profile not found');
    }

    this.assertRoleCompatible(profile.role, dto.role);

    await this.prisma.projectMember.upsert({
      where: {
        projectId_userId: {
          projectId,
          userId: profile.id,
        },
      },
      update: { role: dto.role },
      create: {
        projectId,
        userId: profile.id,
        role: dto.role,
      },
    });

    await this.recordTimelineEvent(projectId, user, {
      type: ProjectTimelineEventType.MEMBER_ADDED,
      visibility: ProjectTimelineVisibility.TEAM,
      title: 'Project member added',
      body: `${dto.role} member added`,
      metadata: { userId: profile.id, role: dto.role },
    });

    return this.findOne(projectId, user);
  }

  async removeMember(
    projectId: string,
    userId: string,
    user: AuthUser,
  ): Promise<ProjectWithRelations> {
    await this.assertAccessible(projectId, user);
    this.assertManagerRole(user);
    await this.assertCanRemoveMember(projectId, userId);

    await this.prisma.projectMember
      .delete({
        where: {
          projectId_userId: {
            projectId,
            userId,
          },
        },
      })
      .catch((error: unknown) => {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2025'
        ) {
          throw new NotFoundException('Project member not found');
        }
        throw error;
      });

    await this.recordTimelineEvent(projectId, user, {
      type: ProjectTimelineEventType.MEMBER_REMOVED,
      visibility: ProjectTimelineVisibility.TEAM,
      title: 'Project member removed',
      metadata: { userId },
    });

    return this.findOne(projectId, user);
  }

  async findArtifacts(id: string, user: AuthUser): Promise<ArtifactListItem[]> {
    await this.assertAccessible(id, user);

    if (user.role === UserRole.CLIENT) {
      return this.prisma.artifact.findMany({
        where: { projectId: id, clientVisible: true },
        select: {
          id: true,
          projectId: true,
          agentType: true,
          filePath: true,
          clientVisible: true,
          displayName: true,
          sharedAt: true,
          reviewStatus: true,
          reviewNote: true,
          reviewedAt: true,
          reviewedById: true,
          outputReviewStatus: true,
          outputReviewNote: true,
          outputReviewedAt: true,
          outputReviewedById: true,
          publishedAt: true,
          publishedById: true,
          revisionHandledAt: true,
          revisionHandledById: true,
          revisionResolutionNote: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      });
    }

    return this.prisma.artifact.findMany({
      where: { projectId: id },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findArtifact(
    id: string,
    artifactId: string,
    user: AuthUser,
  ): Promise<Artifact> {
    await this.assertAccessible(id, user);
    const artifact = await this.prisma.artifact.findFirst({
      where: {
        id: artifactId,
        projectId: id,
      },
    });

    if (!artifact) {
      throw new NotFoundException(`Artifact ${artifactId} not found`);
    }

    return artifact;
  }

  async updateArtifactSharing(
    id: string,
    artifactId: string,
    user: AuthUser,
    dto: ShareArtifactDto,
  ): Promise<Artifact> {
    await this.assertAccessible(id, user);

    const artifact = await this.prisma.artifact.findFirst({
      where: {
        id: artifactId,
        projectId: id,
      },
      select: { id: true },
    });

    if (!artifact) {
      throw new NotFoundException(`Artifact ${artifactId} not found`);
    }

    const updated = await this.prisma.artifact.update({
      where: { id: artifactId },
      data: {
        clientVisible: dto.clientVisible,
        displayName: dto.displayName,
        sharedAt: dto.clientVisible ? new Date() : null,
        reviewStatus: dto.clientVisible ? undefined : ArtifactReviewStatus.PENDING,
        reviewNote: dto.clientVisible ? undefined : null,
        reviewedAt: dto.clientVisible ? undefined : null,
        reviewedById: dto.clientVisible ? undefined : null,
        revisionHandledAt: dto.clientVisible ? undefined : null,
        revisionHandledById: dto.clientVisible ? undefined : null,
        revisionResolutionNote: dto.clientVisible ? undefined : null,
      },
    });

    await this.recordTimelineEvent(id, user, {
      type: dto.clientVisible
        ? ProjectTimelineEventType.ARTIFACT_SHARED
        : ProjectTimelineEventType.ARTIFACT_UNSHARED,
      visibility: dto.clientVisible
        ? ProjectTimelineVisibility.CLIENT
        : ProjectTimelineVisibility.INTERNAL,
      artifactId,
      title: dto.clientVisible ? 'Artifact shared with client' : 'Artifact unshared',
      body: updated.displayName || updated.filePath,
      metadata: { clientVisible: updated.clientVisible },
    });

    return updated;
  }

  async reviewArtifactOutput(
    id: string,
    artifactId: string,
    user: AuthUser,
    dto: ReviewArtifactOutputDto,
  ): Promise<Artifact> {
    await this.assertAccessible(id, user);

    if (
      dto.status === ArtifactOutputReviewStatus.PENDING ||
      dto.status === ArtifactOutputReviewStatus.PUBLISHED
    ) {
      throw new BadRequestException('status must be APPROVED or REWORK_REQUESTED');
    }

    const artifact = await this.prisma.artifact.findFirst({
      where: { id: artifactId, projectId: id },
      include: {
        workOrders: {
          include: {
            task: {
              select: {
                id: true,
                title: true,
                assignedToId: true,
              },
            },
          },
          orderBy: { updatedAt: 'desc' },
          take: 1,
        },
      },
    });

    if (!artifact) {
      throw new NotFoundException(`Artifact ${artifactId} not found`);
    }

    const note = dto.note?.trim() || null;
    const rework = dto.status === ArtifactOutputReviewStatus.REWORK_REQUESTED;

    if (rework) {
      const sourceWorkOrder = artifact.workOrders?.[0];
      const assignedToId = dto.assignedToId || sourceWorkOrder?.task?.assignedToId;

      if (!assignedToId) {
        throw new BadRequestException('A developer assignee is required for rework');
      }

      await this.assertTaskLinks(id, assignedToId, artifact.id);
    }

    const updated = await this.prisma.artifact.update({
      where: { id: artifactId },
      data: {
        outputReviewStatus: dto.status,
        outputReviewNote: note,
        outputReviewedAt: new Date(),
        outputReviewedById: user.id,
      },
    });

    await this.recordTimelineEvent(id, user, {
      type: rework
        ? ProjectTimelineEventType.ARTIFACT_REWORK_REQUESTED
        : ProjectTimelineEventType.ARTIFACT_OUTPUT_REVIEWED,
      visibility: ProjectTimelineVisibility.TEAM,
      artifactId,
      title: rework ? 'Artifact rework requested' : 'Artifact output approved',
      body: note ?? updated.displayName ?? updated.filePath,
      metadata: { outputReviewStatus: updated.outputReviewStatus },
    });

    if (rework) {
      await this.createArtifactRework(id, artifact, user, note, dto.assignedToId);
    }

    return updated;
  }

  async publishArtifactOutput(
    id: string,
    artifactId: string,
    user: AuthUser,
    dto: PublishArtifactOutputDto,
  ): Promise<Artifact> {
    await this.assertAccessible(id, user);

    const artifact = await this.prisma.artifact.findFirst({
      where: { id: artifactId, projectId: id },
      select: { id: true, filePath: true, displayName: true, outputReviewStatus: true },
    });

    if (!artifact) {
      throw new NotFoundException(`Artifact ${artifactId} not found`);
    }

    if (artifact.outputReviewStatus === ArtifactOutputReviewStatus.REWORK_REQUESTED) {
      throw new BadRequestException('Resolve rework before publishing this artifact');
    }

    const updated = await this.prisma.artifact.update({
      where: { id: artifactId },
      data: {
        clientVisible: true,
        displayName: dto.displayName?.trim() || artifact.displayName || artifact.filePath,
        sharedAt: new Date(),
        reviewStatus: ArtifactReviewStatus.PENDING,
        reviewNote: null,
        reviewedAt: null,
        reviewedById: null,
        revisionHandledAt: null,
        revisionHandledById: null,
        revisionResolutionNote: null,
        outputReviewStatus: ArtifactOutputReviewStatus.PUBLISHED,
        outputReviewedAt: new Date(),
        outputReviewedById: user.id,
        publishedAt: new Date(),
        publishedById: user.id,
      },
    });

    await this.notifications.notify({
      recipientIds: await this.notifications.projectClients(id),
      actorId: user.id,
      projectId: id,
      artifactId,
      type: NotificationType.ARTIFACT_PUBLISHED,
      title: 'New deliverable published',
      body: updated.displayName || updated.filePath,
      metadata: { outputReviewStatus: updated.outputReviewStatus },
    });

    await this.recordTimelineEvent(id, user, {
      type: ProjectTimelineEventType.ARTIFACT_PUBLISHED,
      visibility: ProjectTimelineVisibility.CLIENT,
      artifactId,
      title: 'Deliverable published',
      body: updated.displayName || updated.filePath,
      metadata: { outputReviewStatus: updated.outputReviewStatus },
    });

    return updated;
  }

  async reviewArtifact(
    id: string,
    artifactId: string,
    user: AuthUser,
    dto: ReviewArtifactDto,
  ): Promise<ArtifactListItem> {
    await this.assertAccessible(id, user);

    if (dto.reviewStatus === ArtifactReviewStatus.PENDING) {
      throw new BadRequestException('reviewStatus must be APPROVED or REVISION_REQUESTED');
    }

    const artifact = await this.prisma.artifact.findFirst({
      where: {
        id: artifactId,
        projectId: id,
        clientVisible: true,
      },
      select: { id: true },
    });

    if (!artifact) {
      throw new NotFoundException(`Shared artifact ${artifactId} not found`);
    }

    const updated = await this.prisma.artifact.update({
      where: { id: artifactId },
      data: {
        reviewStatus: dto.reviewStatus,
        reviewNote: dto.reviewNote?.trim() || null,
        reviewedAt: new Date(),
        reviewedById: user.id,
        revisionHandledAt: null,
        revisionHandledById: null,
        revisionResolutionNote: null,
      },
      select: {
        id: true,
        projectId: true,
        agentType: true,
        filePath: true,
        clientVisible: true,
        displayName: true,
        sharedAt: true,
        reviewStatus: true,
        reviewNote: true,
        reviewedAt: true,
        reviewedById: true,
        outputReviewStatus: true,
        outputReviewNote: true,
        outputReviewedAt: true,
        outputReviewedById: true,
        publishedAt: true,
        publishedById: true,
        revisionHandledAt: true,
        revisionHandledById: true,
        revisionResolutionNote: true,
        createdAt: true,
      },
    });

    await this.notifications.notify({
      recipientIds: await this.notifications.projectManagers(id),
      actorId: user.id,
      projectId: id,
      artifactId,
      type: NotificationType.ARTIFACT_REVIEWED,
      title: dto.reviewStatus === ArtifactReviewStatus.APPROVED
        ? 'Client approved a deliverable'
        : 'Client requested revisions',
      body: updated.reviewNote,
      metadata: { reviewStatus: dto.reviewStatus },
    });

    await this.recordTimelineEvent(id, user, {
      type: ProjectTimelineEventType.ARTIFACT_REVIEWED,
      visibility: ProjectTimelineVisibility.CLIENT,
      artifactId,
      title: dto.reviewStatus === ArtifactReviewStatus.APPROVED
        ? 'Client approved deliverable'
        : 'Client requested revisions',
      body: updated.reviewNote,
      metadata: { reviewStatus: dto.reviewStatus },
    });

    return updated;
  }

  async handleRevision(
    id: string,
    artifactId: string,
    user: AuthUser,
    dto: HandleRevisionDto,
  ): Promise<Artifact> {
    await this.assertAccessible(id, user);

    const artifact = await this.prisma.artifact.findFirst({
      where: {
        id: artifactId,
        projectId: id,
        reviewStatus: ArtifactReviewStatus.REVISION_REQUESTED,
      },
      select: { id: true },
    });

    if (!artifact) {
      throw new NotFoundException(`Revision request ${artifactId} not found`);
    }

    const updated = await this.prisma.artifact.update({
      where: { id: artifactId },
      data: {
        revisionHandledAt: new Date(),
        revisionHandledById: user.id,
        revisionResolutionNote: dto.resolutionNote?.trim() || null,
      },
    });

    await this.notifications.notify({
      recipientIds: await this.notifications.projectClients(id),
      actorId: user.id,
      projectId: id,
      artifactId,
      type: NotificationType.REVISION_HANDLED,
      title: 'Your revision request was acknowledged',
      body: updated.revisionResolutionNote,
      metadata: { reviewStatus: updated.reviewStatus },
    });

    await this.recordTimelineEvent(id, user, {
      type: ProjectTimelineEventType.REVISION_HANDLED,
      visibility: ProjectTimelineVisibility.CLIENT,
      artifactId,
      title: 'Revision request acknowledged',
      body: updated.revisionResolutionNote,
      metadata: { reviewStatus: updated.reviewStatus },
    });

    return updated;
  }

  async findDeliveryReview(
    id: string,
    user: AuthUser,
  ): Promise<ProjectDeliveryReview | null> {
    await this.assertAccessible(id, user);

    return this.prisma.projectDeliveryReview.findUnique({
      where: { projectId: id },
    });
  }

  async acceptDelivery(
    id: string,
    user: AuthUser,
    dto: ProjectDeliveryReviewNoteDto,
  ): Promise<ProjectDeliveryReview> {
    await this.assertAccessible(id, user);
    await this.assertAcceptedClientInvite(id, user.id);
    await this.assertDeliveryReviewsCleared(id);

    const note = dto.note?.trim() || null;
    const review = await this.prisma.projectDeliveryReview.upsert({
      where: { projectId: id },
      update: {
        status: ProjectDeliveryReviewStatus.ACCEPTED,
        acceptanceNote: note,
        acceptedById: user.id,
        acceptedAt: new Date(),
      },
      create: {
        projectId: id,
        status: ProjectDeliveryReviewStatus.ACCEPTED,
        acceptanceNote: note,
        acceptedById: user.id,
        acceptedAt: new Date(),
      },
    });

    await this.prisma.project.update({
      where: { id },
      data: { status: ProjectStatus.DELIVERED },
    });

    await this.notifications.notify({
      recipientIds: await this.notifications.projectManagers(id),
      actorId: user.id,
      projectId: id,
      type: NotificationType.DELIVERY_ACCEPTED,
      title: 'Client accepted final delivery',
      body: review.acceptanceNote,
      metadata: { deliveryReviewStatus: review.status },
    });

    await this.recordTimelineEvent(id, user, {
      type: ProjectTimelineEventType.DELIVERY_ACCEPTED,
      visibility: ProjectTimelineVisibility.CLIENT,
      title: 'Final delivery accepted',
      body: review.acceptanceNote,
      metadata: { deliveryReviewStatus: review.status },
    });

    return review;
  }

  async requestDeliveryRevision(
    id: string,
    user: AuthUser,
    dto: ProjectDeliveryReviewNoteDto,
  ): Promise<ProjectDeliveryReview> {
    await this.assertAccessible(id, user);

    const note = dto.note?.trim() || null;
    if (!note) {
      throw new BadRequestException('A revision note is required');
    }

    const review = await this.prisma.projectDeliveryReview.upsert({
      where: { projectId: id },
      update: {
        status: ProjectDeliveryReviewStatus.REVISION_REQUESTED,
        revisionNote: note,
        revisionRequestedById: user.id,
        revisionRequestedAt: new Date(),
        revisionResolvedById: null,
        revisionResolvedAt: null,
        resolutionNote: null,
      },
      create: {
        projectId: id,
        status: ProjectDeliveryReviewStatus.REVISION_REQUESTED,
        revisionNote: note,
        revisionRequestedById: user.id,
        revisionRequestedAt: new Date(),
      },
    });

    await this.notifications.notify({
      recipientIds: await this.notifications.projectManagers(id),
      actorId: user.id,
      projectId: id,
      type: NotificationType.DELIVERY_REVISION_REQUESTED,
      title: 'Client requested delivery revisions',
      body: review.revisionNote,
      metadata: { deliveryReviewStatus: review.status },
    });

    await this.recordTimelineEvent(id, user, {
      type: ProjectTimelineEventType.DELIVERY_REVISION_REQUESTED,
      visibility: ProjectTimelineVisibility.CLIENT,
      title: 'Delivery revision requested',
      body: review.revisionNote,
      metadata: { deliveryReviewStatus: review.status },
    });

    return review;
  }

  async resolveDeliveryRevision(
    id: string,
    user: AuthUser,
    dto: ProjectDeliveryReviewNoteDto,
  ): Promise<ProjectDeliveryReview> {
    await this.assertAccessible(id, user);

    const existing = await this.prisma.projectDeliveryReview.findUnique({
      where: { projectId: id },
    });
    if (!existing) {
      throw new NotFoundException(`Delivery review for project ${id} not found`);
    }
    if (existing.status !== ProjectDeliveryReviewStatus.REVISION_REQUESTED) {
      throw new BadRequestException('Delivery review does not have an active revision request');
    }

    const review = await this.prisma.projectDeliveryReview.update({
      where: { projectId: id },
      data: {
        status: ProjectDeliveryReviewStatus.REVISION_RESOLVED,
        revisionResolvedById: user.id,
        revisionResolvedAt: new Date(),
        resolutionNote: dto.note?.trim() || null,
      },
    });

    await this.notifications.notify({
      recipientIds: await this.notifications.projectClients(id),
      actorId: user.id,
      projectId: id,
      type: NotificationType.DELIVERY_REVISION_RESOLVED,
      title: 'Delivery revision was resolved',
      body: review.resolutionNote,
      metadata: { deliveryReviewStatus: review.status },
    });

    await this.recordTimelineEvent(id, user, {
      type: ProjectTimelineEventType.DELIVERY_REVISION_RESOLVED,
      visibility: ProjectTimelineVisibility.CLIENT,
      title: 'Delivery revision resolved',
      body: review.resolutionNote,
      metadata: { deliveryReviewStatus: review.status },
    });

    return review;
  }

  async findTasks(id: string, user: AuthUser): Promise<ProjectTaskWithRelations[]> {
    await this.assertAccessible(id, user);

    const where: Prisma.ProjectTaskWhereInput = { projectId: id };
    if (user.role === UserRole.DEV) {
      where.assignedToId = user.id;
    }

    return this.prisma.projectTask.findMany({
      where,
      include: taskInclude,
      orderBy: { updatedAt: 'desc' },
    });
  }

  async createTask(
    id: string,
    user: AuthUser,
    dto: CreateProjectTaskDto,
  ): Promise<ProjectTaskWithRelations> {
    await this.assertAccessible(id, user);
    await this.assertTaskLinks(id, dto.assignedToId, dto.artifactId);

    const task = await this.prisma.projectTask.create({
      data: {
        projectId: id,
        title: dto.title.trim(),
        description: dto.description?.trim() || null,
        status: dto.status ?? ProjectTaskStatus.TODO,
        assignedToId: dto.assignedToId || null,
        artifactId: dto.artifactId || null,
        createdById: user.id,
      },
      include: taskInclude,
    });

    await this.recordTaskActivity({
      projectId: id,
      taskId: task.id,
      actorId: user.id,
      type: ProjectTaskActivityType.TASK_CREATED,
      message: `Task created: ${task.title}`,
      metadata: {
        status: task.status,
        assignedToId: task.assignedToId,
        artifactId: task.artifactId,
      },
    });

    if (task.assignedToId) {
      await this.recordTaskActivity({
        projectId: id,
        taskId: task.id,
        actorId: user.id,
        type: ProjectTaskActivityType.ASSIGNEE_CHANGED,
        message: 'Task assigned',
        metadata: { to: task.assignedToId },
      });

      await this.notifications.notify({
        recipientIds: [task.assignedToId],
        actorId: user.id,
        projectId: id,
        taskId: task.id,
        artifactId: task.artifactId,
        type: NotificationType.TASK_ASSIGNED,
        title: 'New task assigned',
        body: task.title,
        metadata: { status: task.status },
      });
    }

    if (task.artifactId) {
      await this.recordTaskActivity({
        projectId: id,
        taskId: task.id,
        actorId: user.id,
        type: ProjectTaskActivityType.ARTIFACT_CHANGED,
        message: 'Artifact linked',
        metadata: { to: task.artifactId },
      });
    }

    await this.recordTimelineEvent(id, user, {
      type: ProjectTimelineEventType.TASK_CREATED,
      visibility: ProjectTimelineVisibility.TEAM,
      taskId: task.id,
      artifactId: task.artifactId,
      title: 'Task created',
      body: task.title,
      metadata: {
        status: task.status,
        assignedToId: task.assignedToId,
      },
    });

    if (task.assignedToId) {
      await this.recordTimelineEvent(id, user, {
        type: ProjectTimelineEventType.TASK_ASSIGNED,
        visibility: ProjectTimelineVisibility.TEAM,
        taskId: task.id,
        artifactId: task.artifactId,
        title: 'Task assigned',
        body: task.title,
        metadata: { assignedToId: task.assignedToId },
      });
    }

    return task;
  }

  async updateTask(
    id: string,
    taskId: string,
    user: AuthUser,
    dto: UpdateProjectTaskDto,
  ): Promise<ProjectTaskWithRelations> {
    await this.assertAccessible(id, user);

    const task = await this.prisma.projectTask.findFirst({
      where: { id: taskId, projectId: id },
      select: {
        id: true,
        assignedToId: true,
        artifactId: true,
        status: true,
      },
    });

    if (!task) {
      throw new NotFoundException(`Task ${taskId} not found`);
    }

    const canManage = this.canManageProjects(user.role);
    if (!canManage) {
      if (task.assignedToId !== user.id) {
        throw new NotFoundException(`Task ${taskId} not found`);
      }

      const hasManagerOnlyFields =
        dto.title !== undefined ||
        dto.description !== undefined ||
        dto.assignedToId !== undefined ||
        dto.artifactId !== undefined;

      if (hasManagerOnlyFields) {
        throw new BadRequestException('Developers can only update task status');
      }
    }

    if (canManage) {
      await this.assertTaskLinks(id, dto.assignedToId, dto.artifactId);
    }

    const updated = await this.prisma.projectTask.update({
      where: { id: taskId },
      data: {
        title: canManage ? dto.title?.trim() : undefined,
        description: canManage
          ? dto.description === undefined
            ? undefined
            : dto.description.trim() || null
          : undefined,
        status: dto.status,
        assignedToId: canManage
          ? dto.assignedToId === undefined
            ? undefined
            : dto.assignedToId || null
          : undefined,
        artifactId: canManage
          ? dto.artifactId === undefined
            ? undefined
            : dto.artifactId || null
          : undefined,
      },
      include: taskInclude,
    });

    await this.recordTaskUpdateActivity(id, task, updated, user);

    if (task.status !== updated.status) {
      await this.notifications.notify({
        recipientIds: [
          ...(await this.notifications.projectManagers(id)),
          ...(updated.assignedToId ? [updated.assignedToId] : []),
        ],
        actorId: user.id,
        projectId: id,
        taskId: updated.id,
        artifactId: updated.artifactId,
        type: NotificationType.TASK_STATUS_CHANGED,
        title: 'Task status changed',
        body: `${updated.title} is now ${updated.status}`,
        metadata: { from: task.status, to: updated.status },
      });

      await this.recordTimelineEvent(id, user, {
        type: ProjectTimelineEventType.TASK_STATUS_CHANGED,
        visibility: ProjectTimelineVisibility.TEAM,
        taskId: updated.id,
        artifactId: updated.artifactId,
        title: 'Task status changed',
        body: `${updated.title} is now ${updated.status}`,
        metadata: { from: task.status, to: updated.status },
      });
    }

    if (task.assignedToId !== updated.assignedToId && updated.assignedToId) {
      await this.notifications.notify({
        recipientIds: [updated.assignedToId],
        actorId: user.id,
        projectId: id,
        taskId: updated.id,
        artifactId: updated.artifactId,
        type: NotificationType.TASK_ASSIGNED,
        title: 'Task assigned to you',
        body: updated.title,
        metadata: { from: task.assignedToId, to: updated.assignedToId },
      });

      await this.recordTimelineEvent(id, user, {
        type: ProjectTimelineEventType.TASK_ASSIGNED,
        visibility: ProjectTimelineVisibility.TEAM,
        taskId: updated.id,
        artifactId: updated.artifactId,
        title: 'Task reassigned',
        body: updated.title,
        metadata: { from: task.assignedToId, to: updated.assignedToId },
      });
    }

    return updated;
  }

  async findTaskActivity(
    id: string,
    taskId: string,
    user: AuthUser,
  ): Promise<ProjectTaskActivityWithActor[]> {
    await this.assertTaskAccessible(id, taskId, user);

    return this.prisma.projectTaskActivity.findMany({
      where: {
        projectId: id,
        taskId,
      },
      include: taskActivityInclude,
      orderBy: { createdAt: 'asc' },
    });
  }

  async addTaskComment(
    id: string,
    taskId: string,
    user: AuthUser,
    dto: AddTaskCommentDto,
  ): Promise<ProjectTaskActivityWithActor> {
    await this.assertTaskAccessible(id, taskId, user);

    const activity = await this.prisma.projectTaskActivity.create({
      data: {
        projectId: id,
        taskId,
        actorId: user.id,
        type: ProjectTaskActivityType.COMMENT,
        message: dto.message.trim(),
      },
      include: taskActivityInclude,
    });

    const task = await this.prisma.projectTask.findUnique({
      where: { id: taskId },
      select: { id: true, title: true, assignedToId: true, artifactId: true },
    });

    await this.notifications.notify({
      recipientIds: [
        ...(await this.notifications.projectManagers(id)),
        ...(task?.assignedToId ? [task.assignedToId] : []),
      ],
      actorId: user.id,
      projectId: id,
      taskId,
      artifactId: task?.artifactId,
      type: NotificationType.TASK_COMMENTED,
      title: 'New task comment',
      body: dto.message.trim(),
      metadata: { taskTitle: task?.title },
    });

    await this.recordTimelineEvent(id, user, {
      type: ProjectTimelineEventType.TASK_COMMENTED,
      visibility: ProjectTimelineVisibility.TEAM,
      taskId,
      artifactId: task?.artifactId,
      title: 'Task comment added',
      body: dto.message.trim(),
      metadata: { taskTitle: task?.title },
    });

    return activity;
  }

  async findTimeline(
    id: string,
    user: AuthUser,
  ): Promise<ProjectTimelineEventWithActor[]> {
    await this.assertAccessible(id, user);

    return this.prisma.projectTimelineEvent.findMany({
      where: {
        projectId: id,
        visibility: { in: this.timelineVisibilityFor(user.role) },
      },
      include: timelineInclude,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async findWorkOrders(id: string, user: AuthUser): Promise<WorkOrderWithRelations[]> {
    await this.assertAccessible(id, user);

    const where: Prisma.WorkOrderWhereInput = { projectId: id };
    if (user.role === UserRole.DEV) {
      where.task = { assignedToId: user.id };
    }

    return this.prisma.workOrder.findMany({
      where,
      include: workOrderInclude,
      orderBy: { updatedAt: 'desc' },
    });
  }

  async createWorkOrder(
    id: string,
    user: AuthUser,
    dto: CreateWorkOrderDto,
  ): Promise<WorkOrderWithRelations> {
    await this.assertAccessible(id, user);
    this.assertWorkOrderActionable(dto.instructions, WorkOrderStatus.READY);
    await this.assertWorkOrderLinks(id, dto.taskId, dto.artifactId);

    const workOrder = await this.prisma.workOrder.create({
      data: {
        projectId: id,
        title: dto.title.trim(),
        instructions: dto.instructions?.trim() || null,
        agentType: dto.agentType,
        priority: dto.priority,
        taskId: dto.taskId || null,
        artifactId: dto.artifactId || null,
        createdById: user.id,
      },
      include: workOrderInclude,
    });

    await this.recordTimelineEvent(id, user, {
      type: ProjectTimelineEventType.WORK_ORDER_CREATED,
      visibility: ProjectTimelineVisibility.TEAM,
      taskId: workOrder.taskId,
      artifactId: workOrder.artifactId,
      title: 'Work order created',
      body: workOrder.title,
      metadata: {
        workOrderId: workOrder.id,
        agentType: workOrder.agentType,
        priority: workOrder.priority,
      },
    });

    if (workOrder.task?.assignedToId) {
      await this.notifications.notify({
        recipientIds: [workOrder.task.assignedToId],
        actorId: user.id,
        projectId: id,
        taskId: workOrder.taskId,
        artifactId: workOrder.artifactId,
        type: NotificationType.WORK_ORDER_CREATED,
        title: 'Work order created',
        body: workOrder.title,
        metadata: { workOrderId: workOrder.id, agentType: workOrder.agentType },
      });
    }

    return workOrder;
  }

  async updateWorkOrder(
    id: string,
    workOrderId: string,
    user: AuthUser,
    dto: UpdateWorkOrderDto,
  ): Promise<WorkOrderWithRelations> {
    await this.assertAccessible(id, user);

    const current = await this.prisma.workOrder.findFirst({
      where: { id: workOrderId, projectId: id },
      include: workOrderInclude,
    });

    if (!current) {
      throw new NotFoundException(`Work order ${workOrderId} not found`);
    }

    this.assertWorkOrderMutable(current.status, dto);
    this.assertWorkOrderActionable(dto.instructions, dto.status ?? current.status, current.instructions);
    await this.assertWorkOrderLinks(id, dto.taskId, dto.artifactId);

    const updated = await this.prisma.workOrder.update({
      where: { id: workOrderId },
      data: {
        title: dto.title?.trim(),
        instructions: dto.instructions === undefined ? undefined : dto.instructions.trim() || null,
        agentType: dto.agentType,
        priority: dto.priority,
        status: dto.status,
        taskId: dto.taskId === undefined ? undefined : dto.taskId || null,
        artifactId: dto.artifactId === undefined ? undefined : dto.artifactId || null,
        completedAt: dto.status === WorkOrderStatus.COMPLETED ? new Date() : undefined,
        failedAt: dto.status === WorkOrderStatus.FAILED ? new Date() : undefined,
      },
      include: workOrderInclude,
    });

    if (current.status !== updated.status) {
      await this.recordTimelineEvent(id, user, {
        type: ProjectTimelineEventType.WORK_ORDER_STATUS_CHANGED,
        visibility: ProjectTimelineVisibility.TEAM,
        taskId: updated.taskId,
        artifactId: updated.artifactId,
        title: 'Work order status changed',
        body: `${updated.title} is now ${updated.status}`,
        metadata: { workOrderId: updated.id, from: current.status, to: updated.status },
      });

      await this.notifyWorkOrderStakeholders(id, user, updated, NotificationType.WORK_ORDER_STATUS_CHANGED, 'Work order status changed');
    }

    return updated;
  }

  async dispatchWorkOrder(
    id: string,
    workOrderId: string,
    user: AuthUser,
  ): Promise<WorkOrderWithRelations> {
    await this.assertAccessible(id, user);

    const current = await this.prisma.workOrder.findFirst({
      where: { id: workOrderId, projectId: id },
      include: workOrderInclude,
    });

    if (!current) {
      throw new NotFoundException(`Work order ${workOrderId} not found`);
    }

    if (current.status !== WorkOrderStatus.READY) {
      throw new BadRequestException('Only READY work orders can be dispatched');
    }

    if (!current.instructions?.trim()) {
      throw new BadRequestException('Work order instructions are required before dispatch');
    }

    const updated = await this.prisma.workOrder.update({
      where: { id: workOrderId },
      data: {
        status: WorkOrderStatus.DISPATCHED,
        dispatchedAt: new Date(),
      },
      include: workOrderInclude,
    });

    await this.recordTimelineEvent(id, user, {
      type: ProjectTimelineEventType.WORK_ORDER_DISPATCHED,
      visibility: ProjectTimelineVisibility.TEAM,
      taskId: updated.taskId,
      artifactId: updated.artifactId,
      title: 'Work order dispatched',
      body: updated.title,
      metadata: { workOrderId: updated.id, agentType: updated.agentType },
    });

    await this.notifyWorkOrderStakeholders(id, user, updated, NotificationType.WORK_ORDER_DISPATCHED, 'Work order dispatched');

    const execution = await this.orchestration.executeWorkOrder(id, workOrderId, user.id);
    const executed = await this.prisma.workOrder.findFirst({
      where: { id: workOrderId, projectId: id },
      include: workOrderInclude,
    });

    if (!executed) {
      throw new NotFoundException(`Work order ${workOrderId} not found`);
    }

    await this.recordTimelineEvent(id, user, {
      type: ProjectTimelineEventType.WORK_ORDER_STATUS_CHANGED,
      visibility: ProjectTimelineVisibility.TEAM,
      taskId: executed.taskId,
      artifactId: executed.artifactId,
      title: 'Work order execution completed',
      body: executed.title,
      metadata: {
        workOrderId: executed.id,
        from: WorkOrderStatus.DISPATCHED,
        to: executed.status,
        executionRunId: execution.executionRunId,
        artifactId: execution.artifactId,
      },
    });

    await this.notifyWorkOrderStakeholders(id, user, executed, NotificationType.WORK_ORDER_STATUS_CHANGED, 'Work order completed');

    return executed;
  }

  async findEvents(id: string, user: AuthUser): Promise<EventLog[]> {
    await this.assertAccessible(id, user);
    return this.prisma.eventLog.findMany({
      where: { projectId: id },
      orderBy: { occurredAt: 'desc' },
      take: 50,
    });
  }

  async approveGate1(
    id: string,
    user: AuthUser,
    approved: boolean,
    notes?: string,
  ): Promise<{ accepted: boolean }> {
    await this.assertAccessible(id, user);
    await this.orchestration.resumeGate1(id, approved, notes);
    return { accepted: true };
  }

  async approveGate2(
    id: string,
    user: AuthUser,
    approved: boolean,
    notes?: string,
  ): Promise<{ accepted: boolean }> {
    await this.assertAccessible(id, user);
    await this.orchestration.resumeGate2(id, approved, notes);
    return { accepted: true };
  }

  async getStatus(
    id: string,
    user: AuthUser,
  ): Promise<OrchestrationStatus & Pick<Project, 'companyName' | 'brief' | 'stackKey' | 'createdAt'>> {
    const project = await this.prisma.project.findFirst({
      where: this.projectAccessWhere(user, id),
      select: { id: true, companyName: true, brief: true, stackKey: true, createdAt: true },
    });
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    const orchestrationStatus = await this.orchestration.getStatus(id);
    return { ...orchestrationStatus, ...project };
  }

  private async assertDeliveryReviewsCleared(projectId: string): Promise<void> {
    const openArtifactReviews = await this.prisma.artifact.count({
      where: {
        projectId,
        clientVisible: true,
        OR: [
          { reviewStatus: ArtifactReviewStatus.PENDING },
          {
            reviewStatus: ArtifactReviewStatus.REVISION_REQUESTED,
            revisionHandledAt: null,
          },
        ],
      },
    });

    if (openArtifactReviews > 0) {
      throw new BadRequestException('Resolve or approve all shared artifact reviews before accepting delivery');
    }

    const openDocumentReviews = await this.prisma.collaborationDocument.count({
      where: {
        projectId,
        clientVisible: true,
        status: {
          notIn: [
            CollaborationDocumentStatus.APPROVED,
            CollaborationDocumentStatus.ARCHIVED,
          ],
        },
      },
    });

    if (openDocumentReviews > 0) {
      throw new BadRequestException('Resolve all client-visible document reviews before accepting delivery');
    }
  }

  private async assertAcceptedClientInvite(projectId: string, userId: string): Promise<void> {
    const invite = await this.prisma.clientInvite.findFirst({
      where: {
        projectId,
        acceptedById: userId,
        status: ClientInviteStatus.ACCEPTED,
      },
      select: { id: true },
    });

    if (!invite) {
      throw new BadRequestException('Client invite must be accepted before final delivery can be accepted');
    }
  }

  private deriveProjectLifecycle(project: ProjectLifecycleSource): ProjectLifecycleSummary {
    const artifacts = project.artifacts ?? [];
    const tasks = project.tasks ?? [];
    const workOrders = project.workOrders ?? [];
    const clientAccepted = (project.clientInvites ?? []).some(
      (invite) => invite.status === ClientInviteStatus.ACCEPTED,
    );
    const kickoffReady =
      project.kickoff?.status === ProjectKickoffStatus.READY ||
      project.kickoff?.status === ProjectKickoffStatus.LOCKED;
    const orchestrationStarted = Boolean(project.runId);
    const deliveryReviewStatus = project.deliveryReview?.status;
    const deliveryAccepted = deliveryReviewStatus === ProjectDeliveryReviewStatus.ACCEPTED;
    const deliveryRevisionOpen = deliveryReviewStatus === ProjectDeliveryReviewStatus.REVISION_REQUESTED;
    const deliveryReviewOpen = deliveryReviewStatus === ProjectDeliveryReviewStatus.REVISION_RESOLVED;
    const clientVisibleArtifacts = artifacts.filter((artifact) => artifact.clientVisible);
    const artifactRevisionOpen = clientVisibleArtifacts.some(
      (artifact) =>
        artifact.reviewStatus === ArtifactReviewStatus.REVISION_REQUESTED &&
        !artifact.revisionHandledAt,
    );
    const revisionOpen = artifactRevisionOpen || deliveryRevisionOpen;
    const clientReviewOpen =
      deliveryReviewOpen ||
      clientVisibleArtifacts.some((artifact) => artifact.reviewStatus === ArtifactReviewStatus.PENDING);
    const openTasks = tasks.filter((task) => task.status !== ProjectTaskStatus.DONE).length;
    const activeWorkOrderStatuses = new Set<WorkOrderStatus>([
      WorkOrderStatus.READY,
      WorkOrderStatus.DISPATCHED,
      WorkOrderStatus.FAILED,
    ]);
    const activeWorkOrders = workOrders.filter((workOrder) =>
      activeWorkOrderStatuses.has(workOrder.status),
    ).length;

    let stage: ProjectLifecycleStage = 'APPROVED';

    if (project.status === 'FAILED') {
      stage = 'FAILED';
    } else if (revisionOpen) {
      stage = 'REVISION';
    } else if (project.status === 'DELIVERED' || deliveryAccepted) {
      stage = 'DELIVERED';
    } else if (clientReviewOpen) {
      stage = 'CLIENT_REVIEW';
    } else if (orchestrationStarted) {
      stage = 'IN_ORCHESTRATION';
    } else if (kickoffReady) {
      stage = 'READY_FOR_ORCHESTRATION';
    } else if (clientAccepted || project.kickoff) {
      stage = 'KICKOFF';
    } else if ((project.clientInvites ?? []).length > 0 && !clientAccepted) {
      stage = 'CLIENT_ONBOARDING';
    }

    const stageView: Record<
      ProjectLifecycleStage,
      { label: string; nextAction: string; tone: ProjectLifecycleSummary['tone']; progress: number }
    > = {
      APPROVED: {
        label: 'Approved',
        nextAction: 'Create kickoff',
        tone: 'gray',
        progress: 10,
      },
      CLIENT_ONBOARDING: {
        label: 'Client onboarding',
        nextAction: 'Wait for client join',
        tone: 'yellow',
        progress: 20,
      },
      KICKOFF: {
        label: 'Kickoff',
        nextAction: 'Complete kickoff',
        tone: 'blue',
        progress: 35,
      },
      READY_FOR_ORCHESTRATION: {
        label: 'Ready for orchestration',
        nextAction: 'Start orchestration',
        tone: 'green',
        progress: 50,
      },
      IN_ORCHESTRATION: {
        label: 'In orchestration',
        nextAction: 'Monitor delivery',
        tone: 'purple',
        progress: 65,
      },
      CLIENT_REVIEW: {
        label: 'Client review',
        nextAction: 'Follow up review',
        tone: 'yellow',
        progress: 78,
      },
      REVISION: {
        label: 'Revision',
        nextAction: 'Resolve revision',
        tone: 'red',
        progress: 82,
      },
      DELIVERED: {
        label: 'Delivered',
        nextAction: 'Delivery accepted',
        tone: 'green',
        progress: 100,
      },
      FAILED: {
        label: 'Failed',
        nextAction: 'Review failure',
        tone: 'red',
        progress: 0,
      },
    };

    return {
      stage,
      ...stageView[stage],
      signals: {
        clientAccepted,
        kickoffReady,
        orchestrationStarted,
        clientReviewOpen,
        revisionOpen,
        deliveryAccepted,
        deliveryRevisionOpen,
        totalTasks: tasks.length,
        openTasks,
        totalWorkOrders: workOrders.length,
        activeWorkOrders,
        clientVisibleArtifacts: clientVisibleArtifacts.length,
      },
    };
  }

  private async updateKickoffRecord(
    projectId: string,
    user: AuthUser,
    dto: UpdateProjectKickoffDto,
  ): Promise<ProjectKickoff> {
    const existing = await this.prisma.projectKickoff.findUnique({
      where: { projectId },
    });
    const data = this.normalizeKickoffInput(dto);
    const merged = {
      ...Object.fromEntries(kickoffChecklistFields.map((field) => [field, false])),
      ...existing,
      ...data,
    } as Record<KickoffChecklistField, boolean> & {
      status?: ProjectKickoffStatus;
      completedAt?: Date | null;
      completedById?: string | null;
    };
    const allReady = kickoffChecklistFields.every((field) => Boolean(merged[field]));
    const nextStatus =
      existing?.status === ProjectKickoffStatus.LOCKED
        ? ProjectKickoffStatus.LOCKED
        : allReady
          ? ProjectKickoffStatus.READY
          : ProjectKickoffStatus.DRAFT;
    const completionData =
      nextStatus === ProjectKickoffStatus.READY || nextStatus === ProjectKickoffStatus.LOCKED
        ? {
            completedAt: existing?.completedAt ?? new Date(),
            completedById: existing?.completedById ?? user.id,
          }
        : {
            completedAt: null,
            completedById: null,
          };

    return this.prisma.projectKickoff.upsert({
      where: { projectId },
      update: {
        ...data,
        ...completionData,
        status: nextStatus,
        updatedById: user.id,
      },
      create: {
        projectId,
        ...data,
        ...completionData,
        status: nextStatus,
        updatedById: user.id,
      },
    });
  }

  private normalizeKickoffInput(
    dto: UpdateProjectKickoffDto,
  ): ProjectKickoffInput {
    const data: ProjectKickoffInput = {};

    for (const field of kickoffTextFields) {
      const value = dto[field];
      if (typeof value === 'string') {
        data[field] = value.trim() || null;
      }
    }

    for (const field of kickoffChecklistFields) {
      const value = dto[field];
      if (typeof value === 'boolean') {
        data[field] = value;
      }
    }

    return data;
  }

  private async assertAccessible(id: string, user: AuthUser): Promise<void> {
    const exists = await this.prisma.project.findFirst({
      where: this.projectAccessWhere(user, id),
      select: { id: true },
    });
    if (!exists) {
      throw new NotFoundException(`Project ${id} not found`);
    }
  }

  private async assertTaskAccessible(
    projectId: string,
    taskId: string,
    user: AuthUser,
  ): Promise<{ id: string; assignedToId: string | null }> {
    await this.assertAccessible(projectId, user);

    const task = await this.prisma.projectTask.findFirst({
      where: { id: taskId, projectId },
      select: { id: true, assignedToId: true },
    });

    if (!task) {
      throw new NotFoundException(`Task ${taskId} not found`);
    }

    if (user.role === UserRole.DEV && task.assignedToId !== user.id) {
      throw new NotFoundException(`Task ${taskId} not found`);
    }

    return task;
  }

  private async recordTaskUpdateActivity(
    projectId: string,
    previous: {
      id: string;
      assignedToId: string | null;
      artifactId: string | null;
      status: ProjectTaskStatus;
    },
    updated: ProjectTask,
    user: AuthUser,
  ): Promise<void> {
    if (previous.status !== updated.status) {
      await this.recordTaskActivity({
        projectId,
        taskId: previous.id,
        actorId: user.id,
        type: ProjectTaskActivityType.STATUS_CHANGED,
        message: `Status changed to ${updated.status}`,
        metadata: { from: previous.status, to: updated.status },
      });
    }

    if (previous.assignedToId !== updated.assignedToId) {
      await this.recordTaskActivity({
        projectId,
        taskId: previous.id,
        actorId: user.id,
        type: ProjectTaskActivityType.ASSIGNEE_CHANGED,
        message: updated.assignedToId ? 'Task reassigned' : 'Task unassigned',
        metadata: { from: previous.assignedToId, to: updated.assignedToId },
      });
    }

    if (previous.artifactId !== updated.artifactId) {
      await this.recordTaskActivity({
        projectId,
        taskId: previous.id,
        actorId: user.id,
        type: ProjectTaskActivityType.ARTIFACT_CHANGED,
        message: updated.artifactId ? 'Artifact linked' : 'Artifact unlinked',
        metadata: { from: previous.artifactId, to: updated.artifactId },
      });
    }
  }

  private async recordTaskActivity(input: {
    projectId: string;
    taskId: string;
    actorId: string | null;
    type: ProjectTaskActivityType;
    message?: string;
    metadata?: Prisma.InputJsonValue;
  }): Promise<void> {
    await this.prisma.projectTaskActivity.create({
      data: {
        projectId: input.projectId,
        taskId: input.taskId,
        actorId: input.actorId,
        type: input.type,
        message: input.message,
        metadata: input.metadata ?? {},
      },
    });
  }

  private async notifyWorkOrderStakeholders(
    projectId: string,
    user: AuthUser,
    workOrder: WorkOrderWithRelations,
    type: NotificationType,
    title: string,
  ): Promise<void> {
    await this.notifications.notify({
      recipientIds: [
        ...(await this.notifications.projectManagers(projectId)),
        ...(workOrder.task?.assignedToId ? [workOrder.task.assignedToId] : []),
      ],
      actorId: user.id,
      projectId,
      taskId: workOrder.taskId,
      artifactId: workOrder.artifactId,
      type,
      title,
      body: workOrder.title,
      metadata: {
        workOrderId: workOrder.id,
        status: workOrder.status,
        agentType: workOrder.agentType,
      },
    });
  }

  private async recordTimelineEvent(
    projectId: string,
    user: AuthUser,
    input: {
      type: ProjectTimelineEventType;
      visibility: ProjectTimelineVisibility;
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
        actorId: user.id,
        taskId: input.taskId ?? null,
        artifactId: input.artifactId ?? null,
        type: input.type,
        visibility: input.visibility,
        title: input.title,
        body: input.body ?? null,
        metadata: input.metadata ?? {},
      },
    });
  }

  private timelineVisibilityFor(role: UserRole): ProjectTimelineVisibility[] {
    if (this.canManageProjects(role)) {
      return [
        ProjectTimelineVisibility.INTERNAL,
        ProjectTimelineVisibility.TEAM,
        ProjectTimelineVisibility.CLIENT,
      ];
    }

    if (role === UserRole.DEV) {
      return [ProjectTimelineVisibility.TEAM, ProjectTimelineVisibility.CLIENT];
    }

    return [ProjectTimelineVisibility.CLIENT];
  }

  private async assertTaskLinks(
    projectId: string,
    assignedToId?: string,
    artifactId?: string,
  ): Promise<void> {
    if (assignedToId) {
      const member = await this.prisma.projectMember.findFirst({
        where: {
          projectId,
          userId: assignedToId,
          role: UserRole.DEV,
        },
        select: { id: true },
      });

      if (!member) {
        throw new NotFoundException('Assigned developer is not a project member');
      }
    }

    if (artifactId) {
      const artifact = await this.prisma.artifact.findFirst({
        where: {
          id: artifactId,
          projectId,
        },
        select: { id: true },
      });

      if (!artifact) {
        throw new NotFoundException(`Artifact ${artifactId} not found`);
      }
    }
  }

  private assertManagerRole(user: AuthUser): void {
    if (!this.canManageProjects(user.role)) {
      throw new BadRequestException('Only PM or ADMIN users can manage this resource');
    }
  }

  private assertRoleCompatible(profileRole: UserRole, projectRole: UserRole): void {
    if (profileRole !== projectRole) {
      throw new BadRequestException(`Cannot add ${profileRole} profile as ${projectRole}`);
    }
  }

  private async assertCanRemoveMember(projectId: string, userId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        createdById: true,
        members: {
          where: { role: { in: [UserRole.PM, UserRole.ADMIN] } },
          select: { userId: true },
        },
      },
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const managerIds = new Set([
      project.createdById,
      ...project.members.map((member) => member.userId),
    ].filter(Boolean) as string[]);

    if (managerIds.has(userId) && managerIds.size <= 1) {
      throw new BadRequestException('Cannot remove the last project manager');
    }
  }

  private assertWorkOrderActionable(
    instructions?: string | null,
    status?: WorkOrderStatus,
    currentInstructions?: string | null,
  ): void {
    const nextInstructions = instructions === undefined ? currentInstructions : instructions;
    const isActionableStatus =
      status === WorkOrderStatus.READY ||
      status === WorkOrderStatus.DISPATCHED ||
      status === WorkOrderStatus.COMPLETED;

    if (isActionableStatus && !nextInstructions?.trim()) {
      throw new BadRequestException('Work order instructions are required before it can be actioned');
    }
  }

  private assertWorkOrderMutable(
    currentStatus: WorkOrderStatus,
    dto: UpdateWorkOrderDto,
  ): void {
    if (
      (currentStatus === WorkOrderStatus.DISPATCHED ||
        currentStatus === WorkOrderStatus.COMPLETED) &&
      (
        dto.title !== undefined ||
        dto.instructions !== undefined ||
        dto.agentType !== undefined ||
        dto.priority !== undefined ||
        dto.taskId !== undefined ||
        dto.artifactId !== undefined
      )
    ) {
      throw new BadRequestException('Dispatched or completed work orders cannot be re-scoped');
    }
  }

  private async assertWorkOrderLinks(
    projectId: string,
    taskId?: string,
    artifactId?: string,
  ): Promise<void> {
    if (taskId) {
      const task = await this.prisma.projectTask.findFirst({
        where: {
          id: taskId,
          projectId,
        },
        select: { id: true },
      });

      if (!task) {
        throw new NotFoundException(`Task ${taskId} not found`);
      }
    }

    if (artifactId) {
      const artifact = await this.prisma.artifact.findFirst({
        where: {
          id: artifactId,
          projectId,
        },
        select: { id: true },
      });

      if (!artifact) {
        throw new NotFoundException(`Artifact ${artifactId} not found`);
      }
    }
  }

  private async createArtifactRework(
    projectId: string,
    artifact: Artifact & {
      workOrders?: {
        id: string;
        agentType: WorkOrderAgentType;
        taskId: string | null;
        task: { id: string; title: string; assignedToId: string | null } | null;
      }[];
    },
    user: AuthUser,
    note: string | null,
    requestedAssigneeId?: string,
  ): Promise<void> {
    const sourceWorkOrder = artifact.workOrders?.[0];
    const assignedToId = requestedAssigneeId || sourceWorkOrder?.task?.assignedToId;

    if (!assignedToId) {
      throw new BadRequestException('A developer assignee is required for rework');
    }

    await this.assertTaskLinks(projectId, assignedToId, artifact.id);

    const label = artifact.displayName || artifact.filePath;
    const task = await this.prisma.projectTask.create({
      data: {
        projectId,
        artifactId: artifact.id,
        title: `Rework: ${label}`,
        description: note || 'PM requested internal rework before client publishing.',
        status: ProjectTaskStatus.TODO,
        assignedToId,
        createdById: user.id,
      },
      include: taskInclude,
    });

    await this.recordTaskActivity({
      projectId,
      taskId: task.id,
      actorId: user.id,
      type: ProjectTaskActivityType.TASK_CREATED,
      message: 'Task created from PM output rework request',
      metadata: { artifactId: artifact.id, sourceWorkOrderId: sourceWorkOrder?.id },
    });

    const workOrder = await this.prisma.workOrder.create({
      data: {
        projectId,
        taskId: task.id,
        artifactId: artifact.id,
        title: `Rework handoff: ${label}`,
        instructions: note || 'Revise this artifact for PM review.',
        agentType: sourceWorkOrder?.agentType ?? this.agentTypeFromArtifact(artifact.agentType),
        priority: WorkOrderPriority.HIGH,
        status: WorkOrderStatus.READY,
        createdById: user.id,
      },
      include: workOrderInclude,
    });

    await this.notifications.notify({
      recipientIds: [assignedToId],
      actorId: user.id,
      projectId,
      taskId: task.id,
      artifactId: artifact.id,
      type: NotificationType.ARTIFACT_REWORK_REQUESTED,
      title: 'PM requested artifact rework',
      body: note || label,
      metadata: { workOrderId: workOrder.id, artifactId: artifact.id },
    });

    await this.recordTimelineEvent(projectId, user, {
      type: ProjectTimelineEventType.WORK_ORDER_CREATED,
      visibility: ProjectTimelineVisibility.TEAM,
      taskId: task.id,
      artifactId: artifact.id,
      title: 'Rework work order created',
      body: workOrder.title,
      metadata: { workOrderId: workOrder.id, sourceWorkOrderId: sourceWorkOrder?.id },
    });
  }

  private agentTypeFromArtifact(agentType: string): WorkOrderAgentType {
    const normalized = agentType.toUpperCase();
    if (normalized in WorkOrderAgentType) {
      return WorkOrderAgentType[normalized as keyof typeof WorkOrderAgentType];
    }
    return WorkOrderAgentType.FRONTEND;
  }

  private projectAccessWhere(user: AuthUser, id?: string): Prisma.ProjectWhereInput {
    const where: Prisma.ProjectWhereInput = id ? { id } : {};

    if (user.role === UserRole.ADMIN) {
      return where;
    }

    return {
      ...where,
      OR: [
        { createdById: user.id },
        { members: { some: { userId: user.id } } },
      ],
    };
  }

  private canManageProjects(role: UserRole): boolean {
    return role === UserRole.PM || role === UserRole.ADMIN;
  }
}
