import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ClientInquiry,
  ClientInvite,
  ClientInviteStatus,
  CollaborationDocumentKind,
  CollaborationDocumentStatus,
  CollaborationVisibility,
  ConversationCategory,
  InquiryStatus,
  NotificationType,
  Prisma,
  ProjectStatus,
  ProjectTimelineEventType,
  ProjectTimelineVisibility,
  UserRole,
} from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateInquiryDto } from './dto/create-inquiry.dto';
import { ReviewInquiryDto } from './dto/review-inquiry.dto';

type InquiryWithReviewer = ClientInquiry & {
  reviewedBy: {
    id: string;
    email: string | null;
    fullName: string | null;
    role: UserRole;
  } | null;
  clientInvite: Pick<ClientInvite, 'id' | 'status' | 'projectId' | 'email' | 'acceptedAt'> | null;
};

const reviewerInclude = {
  reviewedBy: {
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
    },
  },
  clientInvite: {
    select: {
      id: true,
      status: true,
      projectId: true,
      email: true,
      acceptedAt: true,
    },
  },
} satisfies Prisma.ClientInquiryInclude;

@Injectable()
export class InquiriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(dto: CreateInquiryDto): Promise<InquiryWithReviewer> {
    const inquiry = await this.prisma.clientInquiry.create({
      data: {
        companyName: dto.companyName.trim(),
        contactName: dto.contactName.trim(),
        email: dto.email.trim().toLowerCase(),
        phone: dto.phone?.trim() || null,
        role: dto.role?.trim() || null,
        brief: dto.brief.trim(),
        stackKey: dto.stackKey?.trim() || 'nextjs-nestjs-supabase',
        budgetRange: dto.budgetRange?.trim() || null,
        timeline: dto.timeline?.trim() || null,
      },
      include: reviewerInclude,
    });

    await this.notifications.notify({
      recipientIds: await this.notifications.projectManagers(),
      type: NotificationType.INQUIRY_SUBMITTED,
      title: 'New client inquiry',
      body: `${inquiry.companyName} submitted a project brief.`,
      metadata: { inquiryId: inquiry.id, email: inquiry.email },
    });

    return inquiry;
  }

  findAll(status?: InquiryStatus): Promise<InquiryWithReviewer[]> {
    return this.prisma.clientInquiry.findMany({
      where: status ? { status } : undefined,
      include: reviewerInclude,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string): Promise<InquiryWithReviewer> {
    const inquiry = await this.prisma.clientInquiry.findUnique({
      where: { id },
      include: reviewerInclude,
    });

    if (!inquiry) {
      throw new NotFoundException(`Inquiry ${id} not found`);
    }

    return inquiry;
  }

  async approve(
    id: string,
    user: AuthUser,
    dto: ReviewInquiryDto,
  ): Promise<InquiryWithReviewer> {
    const inquiry = await this.findOne(id);
    if (inquiry.status !== InquiryStatus.NEW) {
      throw new BadRequestException(`Inquiry ${id} has already been reviewed`);
    }

    const note = dto.reviewNote?.trim() || null;
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: {
          companyName: inquiry.companyName,
          brief: inquiry.brief,
          stackKey: inquiry.stackKey,
          status: ProjectStatus.PENDING,
          createdById: user.id,
        },
      });

      const clientProfile = await tx.profile.findFirst({
        where: { email: inquiry.email, role: UserRole.CLIENT },
        select: { id: true },
      });

      if (clientProfile) {
        await tx.projectMember.upsert({
          where: {
            projectId_userId: {
              projectId: project.id,
              userId: clientProfile.id,
            },
          },
          update: { role: UserRole.CLIENT },
          create: {
            projectId: project.id,
            userId: clientProfile.id,
            role: UserRole.CLIENT,
          },
        });
      }

      await tx.clientInvite.create({
        data: {
          inquiryId: inquiry.id,
          projectId: project.id,
          email: inquiry.email,
          contactName: inquiry.contactName,
          companyName: inquiry.companyName,
          status: clientProfile ? ClientInviteStatus.ACCEPTED : ClientInviteStatus.PENDING,
          createdById: user.id,
          acceptedById: clientProfile?.id ?? null,
          acceptedAt: clientProfile ? now : null,
        },
      });

      await tx.projectTimelineEvent.create({
        data: {
          projectId: project.id,
          actorId: user.id,
          type: ProjectTimelineEventType.PROJECT_CREATED,
          visibility: ProjectTimelineVisibility.TEAM,
          title: 'Project created from inquiry',
          body: inquiry.companyName,
          metadata: { inquiryId: inquiry.id, stackKey: inquiry.stackKey },
        },
      });

      const conversation = await tx.projectConversation.create({
        data: {
          projectId: project.id,
          title: 'Client onboarding',
          category: ConversationCategory.SUPPORT,
          visibility: CollaborationVisibility.CLIENT,
          createdById: user.id,
          lastMessageAt: now,
        },
      });

      await tx.projectMessage.create({
        data: {
          projectId: project.id,
          conversationId: conversation.id,
          authorId: user.id,
          body: [
            `Initial inquiry from ${inquiry.contactName} (${inquiry.email}).`,
            '',
            inquiry.brief,
          ].join('\n'),
          createdAt: now,
        },
      });

      await tx.collaborationDocument.create({
        data: {
          projectId: project.id,
          title: 'Initial requirements brief',
          description: inquiry.brief,
          kind: CollaborationDocumentKind.REQUIREMENT,
          status: CollaborationDocumentStatus.APPROVAL_REQUESTED,
          clientVisible: true,
          uploadedById: user.id,
        },
      });

      const approvedInquiry = await tx.clientInquiry.update({
        where: { id },
        data: {
          status: InquiryStatus.APPROVED,
          reviewNote: note,
          reviewedAt: now,
          reviewedById: user.id,
          approvedProjectId: project.id,
        },
        include: reviewerInclude,
      });

      return { inquiry: approvedInquiry, projectId: project.id, clientProfileId: clientProfile?.id ?? null };
    });

    await this.notifications.notify({
      recipientIds: [
        ...(await this.notifications.projectManagers(result.projectId)),
        ...(result.clientProfileId ? [result.clientProfileId] : []),
      ],
      actorId: user.id,
      projectId: result.projectId,
      type: NotificationType.INQUIRY_APPROVED,
      title: 'Inquiry approved',
      body: result.inquiry.companyName,
      metadata: { inquiryId: result.inquiry.id, approvedProjectId: result.projectId },
    });

    return result.inquiry;
  }

  async reject(
    id: string,
    user: AuthUser,
    dto: ReviewInquiryDto,
  ): Promise<InquiryWithReviewer> {
    const inquiry = await this.findOne(id);
    if (inquiry.status !== InquiryStatus.NEW) {
      throw new BadRequestException(`Inquiry ${id} has already been reviewed`);
    }

    const rejected = await this.prisma.clientInquiry.update({
      where: { id },
      data: {
        status: InquiryStatus.REJECTED,
        reviewNote: dto.reviewNote?.trim() || null,
        reviewedAt: new Date(),
        reviewedById: user.id,
      },
      include: reviewerInclude,
    });

    await this.notifications.notify({
      recipientIds: await this.notifications.projectManagers(),
      actorId: user.id,
      type: NotificationType.INQUIRY_REJECTED,
      title: 'Inquiry rejected',
      body: rejected.companyName,
      metadata: { inquiryId: rejected.id },
    });

    return rejected;
  }
}
