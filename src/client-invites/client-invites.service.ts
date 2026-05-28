import { Injectable } from '@nestjs/common';
import { ClientInvite, ClientInviteStatus, NotificationType, Prisma, ProjectTimelineEventType, ProjectTimelineVisibility, UserRole } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

type InviteView = ClientInvite & {
  project: {
    id: string;
    companyName: string;
    status: string;
    createdAt: Date;
  };
};

const inviteInclude = {
  project: {
    select: {
      id: true,
      companyName: true,
      status: true,
      createdAt: true,
    },
  },
} satisfies Prisma.ClientInviteInclude;

@Injectable()
export class ClientInvitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async publicStatus(email: string): Promise<{
    email: string;
    pending: number;
    accepted: number;
    latestCompanyName: string | null;
  }> {
    const normalizedEmail = email.trim().toLowerCase();
    const invites = await this.prisma.clientInvite.findMany({
      where: { email: normalizedEmail, status: { in: [ClientInviteStatus.PENDING, ClientInviteStatus.ACCEPTED] } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return {
      email: normalizedEmail,
      pending: invites.filter((invite) => invite.status === ClientInviteStatus.PENDING).length,
      accepted: invites.filter((invite) => invite.status === ClientInviteStatus.ACCEPTED).length,
      latestCompanyName: invites[0]?.companyName ?? null,
    };
  }

  listMine(user: AuthUser): Promise<InviteView[]> {
    return this.prisma.clientInvite.findMany({
      where: {
        OR: [
          { email: user.email?.toLowerCase() ?? '' },
          { acceptedById: user.id },
        ],
        status: { in: [ClientInviteStatus.PENDING, ClientInviteStatus.ACCEPTED] },
      },
      include: inviteInclude,
      orderBy: { createdAt: 'desc' },
    });
  }

  async acceptMine(user: AuthUser): Promise<{ accepted: InviteView[] }> {
    if (!user.email) {
      return { accepted: [] };
    }

    const accepted = await this.acceptPendingForProfile({
      profileId: user.id,
      email: user.email,
      role: user.role,
    });

    return { accepted };
  }

  async acceptPendingForProfile(input: {
    profileId: string;
    email: string | null;
    role: UserRole;
  }): Promise<InviteView[]> {
    if (!input.email || input.role !== UserRole.CLIENT) {
      return [];
    }

    const normalizedEmail = input.email.trim().toLowerCase();

    const accepted = await this.prisma.$transaction(async (tx) => {
      const pending = await tx.clientInvite.findMany({
        where: {
          email: normalizedEmail,
          status: ClientInviteStatus.PENDING,
        },
        include: inviteInclude,
        orderBy: { createdAt: 'asc' },
      });

      for (const invite of pending) {
        await tx.projectMember.upsert({
          where: {
            projectId_userId: {
              projectId: invite.projectId,
              userId: input.profileId,
            },
          },
          update: { role: UserRole.CLIENT },
          create: {
            projectId: invite.projectId,
            userId: input.profileId,
            role: UserRole.CLIENT,
          },
        });

        await tx.clientInvite.update({
          where: { id: invite.id },
          data: {
            status: ClientInviteStatus.ACCEPTED,
            acceptedById: input.profileId,
            acceptedAt: new Date(),
          },
        });

        await tx.projectTimelineEvent.create({
          data: {
            projectId: invite.projectId,
            actorId: input.profileId,
            type: ProjectTimelineEventType.CLIENT_INVITE_ACCEPTED,
            visibility: ProjectTimelineVisibility.CLIENT,
            title: 'Client invite accepted',
            body: invite.companyName,
            metadata: { inviteId: invite.id, email: normalizedEmail },
          },
        });
      }

      if (pending.length === 0) {
        return [];
      }

      return tx.clientInvite.findMany({
        where: { id: { in: pending.map((invite) => invite.id) } },
        include: inviteInclude,
        orderBy: { createdAt: 'desc' },
      });
    });

    for (const invite of accepted) {
      await this.notifications.notify({
        recipientIds: await this.notifications.projectManagers(invite.projectId),
        actorId: input.profileId,
        projectId: invite.projectId,
        type: NotificationType.CLIENT_INVITE_ACCEPTED,
        title: 'Client accepted invite',
        body: invite.companyName,
        metadata: { inviteId: invite.id, email: normalizedEmail },
      });
    }

    return accepted;
  }
}
