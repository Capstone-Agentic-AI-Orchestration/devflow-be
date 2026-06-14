import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AdminDomainStatus,
  Prisma,
  ProfileStatus,
  ProjectDeliveryReviewStatus,
  ProjectStatus,
  UserRole,
  WorkOrderStatus,
} from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAdminDomainDto, HandoffOverrideDto, UpdateAdminDomainDto } from './dto/admin.dto';

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async listUsers(input: { q?: string; role?: UserRole }) {
    const query = input.q?.trim();
    const where: Prisma.ProfileWhereInput = {};
    if (input.role && Object.values(UserRole).includes(input.role)) where.role = input.role;
    if (query) {
      where.OR = [
        { email: { contains: query, mode: 'insensitive' } },
        { fullName: { contains: query, mode: 'insensitive' } },
      ];
    }

    const users = await this.prisma.profile.findMany({
      where,
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        memberships: { select: { projectId: true, role: true } },
        createdProjects: { select: { id: true } },
      },
      orderBy: [{ role: 'asc' }, { email: 'asc' }],
      take: 200,
    });

    return users.map((user) => ({
      ...user,
      projectCount: new Set([
        ...user.memberships.map((member) => member.projectId),
        ...user.createdProjects.map((project) => project.id),
      ]).size,
    }));
  }

  async updateUserRole(id: string, role: UserRole, actor: AuthUser) {
    if (id === actor.id && role !== UserRole.ADMIN) {
      throw new BadRequestException('Admins cannot remove their own ADMIN role');
    }

    const previous = await this.findProfile(id);
    const updated = await this.prisma.profile.update({
      where: { id },
      data: { role },
      select: this.profileSelect(),
    });

    await this.audit(actor, 'admin.user.role_updated', 'profile', id, `Changed ${updated.email ?? id} role to ${role}`, {
      previousRole: previous.role,
      nextRole: role,
    });

    return updated;
  }

  async updateUserStatus(id: string, status: ProfileStatus, actor: AuthUser) {
    if (id === actor.id && status === ProfileStatus.SUSPENDED) {
      throw new BadRequestException('Admins cannot suspend their own account');
    }

    const previous = await this.findProfile(id);
    const updated = await this.prisma.profile.update({
      where: { id },
      data: { status },
      select: this.profileSelect(),
    });

    await this.audit(actor, 'admin.user.status_updated', 'profile', id, `Changed ${updated.email ?? id} status to ${status}`, {
      previousStatus: previous.status,
      nextStatus: status,
    });

    return updated;
  }

  listDomains() {
    return this.prisma.adminDomain.findMany({ orderBy: [{ environment: 'asc' }, { name: 'asc' }] });
  }

  async createDomain(dto: CreateAdminDomainDto, actor: AuthUser) {
    const domain = await this.prisma.adminDomain.create({
      data: {
        name: dto.name.trim().toLowerCase(),
        type: dto.type.trim(),
        owner: dto.owner?.trim() || null,
        target: dto.target?.trim() || null,
        environment: dto.environment?.trim() || 'production',
        createdById: actor.id,
      },
    });
    await this.audit(actor, 'admin.domain.created', 'domain', domain.id, `Created domain ${domain.name}`, domain);
    return domain;
  }

  async updateDomain(id: string, dto: UpdateAdminDomainDto, actor: AuthUser) {
    const existing = await this.findDomain(id);
    const domain = await this.prisma.adminDomain.update({
      where: { id },
      data: {
        type: dto.type?.trim(),
        owner: dto.owner === undefined ? undefined : dto.owner.trim() || null,
        target: dto.target === undefined ? undefined : dto.target.trim() || null,
        environment: dto.environment?.trim(),
        status: dto.status,
        verifiedAt: dto.status === AdminDomainStatus.VERIFIED ? new Date() : undefined,
      },
    });
    await this.audit(actor, 'admin.domain.updated', 'domain', id, `Updated domain ${domain.name}`, {
      previousStatus: existing.status,
      nextStatus: domain.status,
    });
    return domain;
  }

  async verifyDomain(id: string, actor: AuthUser) {
    const existing = await this.findDomain(id);
    const domain = await this.prisma.adminDomain.update({
      where: { id },
      data: { status: AdminDomainStatus.VERIFIED, verifiedAt: new Date() },
    });
    await this.audit(actor, 'admin.domain.verified', 'domain', id, `Verified domain ${existing.name}`, {
      previousStatus: existing.status,
    });
    return domain;
  }

  async deleteDomain(id: string, actor: AuthUser) {
    const existing = await this.findDomain(id);
    await this.prisma.adminDomain.delete({ where: { id } });
    await this.audit(actor, 'admin.domain.deleted', 'domain', id, `Deleted domain ${existing.name}`, existing);
    return { deleted: true };
  }

  async listRepositories() {
    const projects = await this.prisma.project.findMany({
      select: {
        id: true,
        companyName: true,
        status: true,
        repoUrl: true,
        updatedAt: true,
        runId: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    return projects.map((project) => ({
      projectId: project.id,
      companyName: project.companyName,
      status: project.status,
      repoUrl: project.repoUrl,
      runId: project.runId,
      linked: Boolean(project.repoUrl),
      updatedAt: project.updatedAt,
    }));
  }

  async linkRepository(projectId: string, repoUrl: string, actor: AuthUser) {
    const project = await this.prisma.project.update({
      where: { id: projectId },
      data: { repoUrl },
      select: { id: true, companyName: true, repoUrl: true, status: true, updatedAt: true },
    }).catch(() => null);
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    await this.audit(actor, 'admin.repository.linked', 'project', projectId, `Linked GitHub repository for ${project.companyName}`, {
      repoUrl,
    });
    return project;
  }

  async listHandoffs() {
    const projects = await this.prisma.project.findMany({
      select: {
        id: true,
        companyName: true,
        status: true,
        repoUrl: true,
        updatedAt: true,
        deliveryReview: true,
        artifacts: { select: { clientVisible: true, outputReviewStatus: true, reviewStatus: true } },
        workOrders: { select: { status: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return projects.map((project) => ({
      projectId: project.id,
      companyName: project.companyName,
      projectStatus: project.status,
      repoUrl: project.repoUrl,
      deliveryReviewStatus: project.deliveryReview?.status ?? ProjectDeliveryReviewStatus.PENDING,
      clientVisibleArtifacts: project.artifacts.filter((artifact) => artifact.clientVisible).length,
      publishedArtifacts: project.artifacts.filter((artifact) => artifact.outputReviewStatus === 'PUBLISHED').length,
      activeWorkOrders: project.workOrders.filter((workOrder) => {
        const activeStatuses: WorkOrderStatus[] = [
          WorkOrderStatus.READY,
          WorkOrderStatus.DISPATCHED,
          WorkOrderStatus.FAILED,
        ];
        return activeStatuses.includes(workOrder.status);
      }).length,
      updatedAt: project.updatedAt,
    }));
  }

  async overrideHandoff(projectId: string, dto: HandoffOverrideDto, actor: AuthUser) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true, companyName: true, status: true } });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: { status: dto.markReady ? ProjectStatus.AWAITING_GATE_2 : undefined },
      select: { id: true, companyName: true, status: true, updatedAt: true },
    });

    await Promise.all([
      this.prisma.projectTimelineEvent.create({
        data: {
          projectId,
          actorId: actor.id,
          type: 'PROJECT_UPDATED',
          visibility: 'INTERNAL',
          title: 'Admin handoff override',
          body: dto.note,
          metadata: { markReady: Boolean(dto.markReady), previousStatus: project.status },
        },
      }),
      this.audit(actor, 'admin.handoff.override', 'project', projectId, `Admin override for ${project.companyName}`, {
        note: dto.note,
        markReady: Boolean(dto.markReady),
        previousStatus: project.status,
        nextStatus: updated.status,
      }),
    ]);

    return updated;
  }

  async usage() {
    const [budgets, runs, eventCount] = await Promise.all([
      this.prisma.runBudget.findMany({ include: { project: { select: { id: true, companyName: true, status: true } } } }),
      this.prisma.orchestrationRun.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
      this.prisma.eventLog.count(),
    ]);

    const tokensConsumed = budgets.reduce((sum, budget) => sum + budget.tokensConsumed, 0);
    const tokenBudget = budgets.reduce((sum, budget) => sum + budget.tokenBudget, 0);

    return {
      totals: {
        tokensConsumed,
        tokenBudget,
        budgetUtilization: tokenBudget ? tokensConsumed / tokenBudget : 0,
        runCount: runs.length,
        eventCount,
      },
      projects: budgets.map((budget) => ({
        projectId: budget.projectId,
        companyName: budget.project.companyName,
        status: budget.project.status,
        tokensConsumed: budget.tokensConsumed,
        tokenBudget: budget.tokenBudget,
        retryCount: budget.retryCount,
        maxRetries: budget.maxRetries,
      })),
      recentRuns: runs,
    };
  }

  async health() {
    const [projectCount, profileCount, runningRuns, failedRuns, domains] = await Promise.all([
      this.prisma.project.count(),
      this.prisma.profile.count(),
      this.prisma.orchestrationRun.count({ where: { status: 'RUNNING' } }),
      this.prisma.orchestrationRun.count({ where: { status: 'FAILED' } }),
      this.prisma.adminDomain.groupBy({ by: ['status'], _count: true }).catch(() => []),
    ]);

    return {
      ok: true,
      checkedAt: new Date(),
      services: {
        database: 'available',
        projects: projectCount,
        profiles: profileCount,
        runningRuns,
        failedRuns,
      },
      domains,
    };
  }

  auditLogs(limit = 100) {
    return this.prisma.adminAuditLog.findMany({
      include: { actor: { select: { id: true, email: true, fullName: true, role: true } } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 250),
    });
  }

  settings() {
    return this.prisma.platformSetting.findMany({ orderBy: { key: 'asc' } });
  }

  async updateSetting(key: string, value: Record<string, unknown>, actor: AuthUser) {
    const jsonValue = value as Prisma.InputJsonValue;
    const setting = await this.prisma.platformSetting.upsert({
      where: { key },
      update: { value: jsonValue, updatedById: actor.id },
      create: { key, value: jsonValue, updatedById: actor.id },
    });
    await this.audit(actor, 'admin.setting.updated', 'setting', key, `Updated platform setting ${key}`, { value: jsonValue } as Prisma.InputJsonValue);
    return setting;
  }

  private async findProfile(id: string) {
    const profile = await this.prisma.profile.findUnique({ where: { id }, select: this.profileSelect() });
    if (!profile) throw new NotFoundException(`Profile ${id} not found`);
    return profile;
  }

  private async findDomain(id: string) {
    const domain = await this.prisma.adminDomain.findUnique({ where: { id } });
    if (!domain) throw new NotFoundException(`Domain ${id} not found`);
    return domain;
  }

  private profileSelect() {
    return {
      id: true,
      email: true,
      fullName: true,
      role: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    } satisfies Prisma.ProfileSelect;
  }

  private async audit(
    actor: AuthUser,
    action: string,
    targetType: string,
    targetId: string | null,
    summary: string,
    metadata: Prisma.InputJsonValue = {},
  ) {
    await this.prisma.adminAuditLog.create({
      data: {
        actorId: actor.id,
        action,
        targetType,
        targetId,
        summary,
        metadata,
      },
    });
  }
}
