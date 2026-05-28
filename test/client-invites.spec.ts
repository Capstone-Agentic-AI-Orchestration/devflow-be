import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientInviteStatus, NotificationType, ProjectTimelineEventType, ProjectTimelineVisibility, UserRole } from '@prisma/client';
import { AuthUser } from '../src/auth/auth.types';
import { ClientInvitesService } from '../src/client-invites/client-invites.service';
import { PrismaService } from '../src/prisma/prisma.service';

const clientUser: AuthUser = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'client@example.com',
  fullName: 'Casey Client',
  role: UserRole.CLIENT,
};

const pmUser: AuthUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'pm@example.com',
  fullName: 'Pat Manager',
  role: UserRole.PM,
};

function makeInvite(overrides = {}) {
  return {
    id: 'invite-1',
    inquiryId: 'inquiry-1',
    projectId: 'project-1',
    email: 'client@example.com',
    contactName: 'Casey Client',
    companyName: 'Acme Co',
    status: ClientInviteStatus.PENDING,
    createdById: pmUser.id,
    acceptedById: null,
    acceptedAt: null,
    createdAt: new Date('2026-05-28T00:00:00.000Z'),
    updatedAt: new Date('2026-05-28T00:00:00.000Z'),
    project: {
      id: 'project-1',
      companyName: 'Acme Co',
      status: 'PENDING',
      createdAt: new Date('2026-05-28T00:00:00.000Z'),
    },
    ...overrides,
  };
}

function makePrismaMock() {
  const tx = {
    clientInvite: {
      findMany: vi.fn().mockResolvedValue([makeInvite()]),
      update: vi.fn().mockResolvedValue(makeInvite({ status: ClientInviteStatus.ACCEPTED })),
    },
    projectMember: {
      upsert: vi.fn().mockResolvedValue({ id: 'member-1' }),
    },
    projectTimelineEvent: {
      create: vi.fn().mockResolvedValue({ id: 'timeline-1' }),
    },
  };

  return {
    tx,
    clientInvite: {
      findMany: vi.fn().mockResolvedValue([
        makeInvite(),
        makeInvite({ id: 'invite-2', status: ClientInviteStatus.ACCEPTED }),
      ]),
    },
    $transaction: vi.fn((callback) => callback(tx)),
  };
}

function makeNotificationsMock() {
  return {
    notify: vi.fn().mockResolvedValue(undefined),
    projectManagers: vi.fn().mockResolvedValue([pmUser.id]),
  };
}

describe('ClientInvitesService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let notifications: ReturnType<typeof makeNotificationsMock>;
  let service: ClientInvitesService;

  beforeEach(() => {
    prisma = makePrismaMock();
    notifications = makeNotificationsMock();
    service = new ClientInvitesService(
      prisma as unknown as PrismaService,
      notifications as any,
    );
  });

  it('returns public invite status counts by normalized email', async () => {
    const result = await service.publicStatus(' CLIENT@example.com ');

    expect(prisma.clientInvite.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ email: 'client@example.com' }),
    }));
    expect(result.pending).toBe(1);
    expect(result.accepted).toBe(1);
  });

  it('lists invites for the authenticated client', async () => {
    await service.listMine(clientUser);

    expect(prisma.clientInvite.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: [
          { email: 'client@example.com' },
          { acceptedById: clientUser.id },
        ],
      }),
    }));
  });

  it('accepts pending invites by creating memberships', async () => {
    const result = await service.acceptMine(clientUser);

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.tx.projectMember.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        projectId_userId: {
          projectId: 'project-1',
          userId: clientUser.id,
        },
      },
      create: expect.objectContaining({
        projectId: 'project-1',
        userId: clientUser.id,
        role: UserRole.CLIENT,
      }),
    }));
    expect(prisma.tx.clientInvite.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: ClientInviteStatus.ACCEPTED,
        acceptedById: clientUser.id,
      }),
    }));
    expect(prisma.tx.projectTimelineEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: 'project-1',
        actorId: clientUser.id,
        type: ProjectTimelineEventType.CLIENT_INVITE_ACCEPTED,
        visibility: ProjectTimelineVisibility.CLIENT,
      }),
    });
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({
      recipientIds: [pmUser.id],
      actorId: clientUser.id,
      projectId: 'project-1',
      type: NotificationType.CLIENT_INVITE_ACCEPTED,
    }));
    expect(result.accepted.length).toBe(1);
  });

  it('does not accept invites for non-client roles', async () => {
    const result = await service.acceptPendingForProfile({
      profileId: pmUser.id,
      email: pmUser.email,
      role: pmUser.role,
    });

    expect(result).toEqual([]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
