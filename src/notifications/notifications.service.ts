import { Injectable, NotFoundException } from '@nestjs/common';
import { Notification, NotificationType, Prisma, ProjectTimelineEventType, ProjectTimelineVisibility, UserRole } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';

export type NotificationWithActor = Notification & {
  actor: { id: string; email: string | null; fullName: string | null; role: UserRole } | null;
};

const notificationInclude = {
  actor: {
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
    },
  },
} satisfies Prisma.NotificationInclude;

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  list(user: AuthUser): Promise<NotificationWithActor[]> {
    return this.prisma.notification.findMany({
      where: { recipientId: user.id },
      include: notificationInclude,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async markRead(id: string, user: AuthUser): Promise<NotificationWithActor> {
    const result = await this.prisma.notification.updateMany({
      where: { id, recipientId: user.id },
      data: { readAt: new Date() },
    });

    if (result.count === 0) {
      throw new NotFoundException(`Notification ${id} not found`);
    }

    return this.prisma.notification.findUniqueOrThrow({
      where: { id },
      include: notificationInclude,
    });
  }

  async markAllRead(user: AuthUser): Promise<{ updated: number }> {
    const result = await this.prisma.notification.updateMany({
      where: { recipientId: user.id, readAt: null },
      data: { readAt: new Date() },
    });

    return { updated: result.count };
  }

  async notify(input: {
    recipientIds: string[];
    actorId?: string | null;
    projectId?: string | null;
    taskId?: string | null;
    artifactId?: string | null;
    type: NotificationType;
    title: string;
    body?: string | null;
    metadata?: Prisma.InputJsonValue;
  }): Promise<void> {
    const recipientIds = [...new Set(input.recipientIds)].filter(
      (id) => id && id !== input.actorId,
    );

    if (recipientIds.length === 0) return;

    await this.prisma.notification.createMany({
      data: recipientIds.map((recipientId) => ({
        recipientId,
        actorId: input.actorId ?? null,
        projectId: input.projectId ?? null,
        taskId: input.taskId ?? null,
        artifactId: input.artifactId ?? null,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        metadata: input.metadata ?? {},
      })),
      skipDuplicates: false,
    });

    if (input.projectId) {
      await this.prisma.projectTimelineEvent.create({
        data: {
          projectId: input.projectId,
          actorId: input.actorId ?? null,
          taskId: input.taskId ?? null,
          artifactId: input.artifactId ?? null,
          type: ProjectTimelineEventType.NOTIFICATION_SENT,
          visibility: ProjectTimelineVisibility.INTERNAL,
          title: 'Notification sent',
          body: input.title,
          metadata: {
            notificationType: input.type,
            recipientCount: recipientIds.length,
          },
        },
      });
    }
  }

  async projectManagers(projectId?: string): Promise<string[]> {
    if (projectId) {
      const [project, adminProfiles] = await Promise.all([
        this.prisma.project.findUnique({
          where: { id: projectId },
          select: {
            createdById: true,
            members: {
              where: { role: { in: [UserRole.PM, UserRole.ADMIN] } },
              select: { userId: true },
            },
          },
        }),
        this.prisma.profile.findMany({
          where: { role: UserRole.ADMIN },
          select: { id: true },
        }),
      ]);

      return [
        ...new Set([
          project?.createdById,
          ...(project?.members.map((member) => member.userId) ?? []),
          ...adminProfiles.map((profile) => profile.id),
        ].filter(Boolean) as string[]),
      ];
    }

    const profiles = await this.prisma.profile.findMany({
      where: { role: { in: [UserRole.PM, UserRole.ADMIN] } },
      select: { id: true },
    });

    return profiles.map((profile) => profile.id);
  }

  async projectClients(projectId: string): Promise<string[]> {
    const members = await this.prisma.projectMember.findMany({
      where: { projectId, role: UserRole.CLIENT },
      select: { userId: true },
    });

    return members.map((member) => member.userId);
  }
}
