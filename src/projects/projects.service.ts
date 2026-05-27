import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrchestrationService, OrchestrationStatus } from '../orchestration/orchestration.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { Prisma, Project, GateEvent, Artifact } from '@prisma/client';

type ProjectWithRelations = Project & {
  gates: GateEvent[];
  _count: { artifacts: number };
};

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestration: OrchestrationService,
  ) {}

  async create(dto: CreateProjectDto): Promise<Project> {
    const project = await this.prisma.project.create({
      data: {
        companyName: dto.companyName,
        brief: dto.brief,
        stackKey: dto.stackKey,
      },
    });

    this.logger.log(`Created project ${project.id} for ${project.companyName}`);

    // Fire-and-forget: start graph run asynchronously
    this.orchestration
      .startRun(project.id, project.brief, project.stackKey, project.companyName)
      .catch((err: unknown) => {
        this.logger.error(
          `Failed to start orchestration run for project ${project.id}`,
          err instanceof Error ? err.stack : String(err),
        );
      });

    return project;
  }

  async findAll(): Promise<Pick<Project, 'id' | 'companyName' | 'status' | 'createdAt'>[]> {
    return this.prisma.project.findMany({
      select: {
        id: true,
        companyName: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string): Promise<ProjectWithRelations> {
    const project = await this.prisma.project.findUnique({
      where: { id },
      include: {
        gates: {
          orderBy: { decidedAt: 'desc' },
        },
        _count: {
          select: { artifacts: true },
        },
      },
    });

    if (!project) {
      throw new NotFoundException(`Project ${id} not found`);
    }

    return project as ProjectWithRelations;
  }

  async findArtifacts(id: string): Promise<Artifact[]> {
    await this.assertExists(id);
    return this.prisma.artifact.findMany({
      where: { projectId: id },
      orderBy: { createdAt: 'asc' },
    });
  }

  async approveGate1(
    id: string,
    approved: boolean,
    notes?: string,
  ): Promise<{ accepted: boolean }> {
    await this.assertExists(id);
    await this.orchestration.resumeGate1(id, approved, notes);
    return { accepted: true };
  }

  async approveGate2(
    id: string,
    approved: boolean,
    notes?: string,
  ): Promise<{ accepted: boolean }> {
    await this.assertExists(id);
    await this.orchestration.resumeGate2(id, approved, notes);
    return { accepted: true };
  }

  async getStatus(id: string): Promise<OrchestrationStatus & Pick<Project, 'companyName' | 'brief' | 'stackKey' | 'createdAt'>> {
    const project = await this.prisma.project.findUnique({
      where: { id },
      select: { id: true, companyName: true, brief: true, stackKey: true, createdAt: true },
    });
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    const orchestrationStatus = await this.orchestration.getStatus(id);
    return { ...orchestrationStatus, ...project };
  }

  private async assertExists(id: string): Promise<void> {
    const exists = await this.prisma.project.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) {
      throw new NotFoundException(`Project ${id} not found`);
    }
  }
}
