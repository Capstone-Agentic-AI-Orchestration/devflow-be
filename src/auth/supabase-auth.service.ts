import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import { ClientInviteStatus, ProfileStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from './auth.types';

@Injectable()
export class SupabaseAuthService {
  private readonly issuer: string;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const supabaseUrl = this.configService.get<string>('supabase.url');
    if (!supabaseUrl) {
      throw new Error('SUPABASE_URL is required for API authentication');
    }

    const normalizedUrl = supabaseUrl.replace(/\/$/, '');
    this.issuer = `${normalizedUrl}/auth/v1`;
    this.jwks = createRemoteJWKSet(
      new URL(`${this.issuer}/.well-known/jwks.json`),
    );
  }

  async verifyAccessToken(token: string): Promise<AuthUser> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: 'authenticated',
      });

      return this.syncProfile(payload);
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }

  private async syncProfile(payload: JWTPayload): Promise<AuthUser> {
    const userId = payload.sub;
    if (!userId) {
      throw new UnauthorizedException('Access token is missing subject');
    }

    const email = this.getEmail(payload);
    const fullName = this.getFullName(payload);
    const profile = await this.prisma.profile.upsert({
      where: { id: userId },
      update: {
        email,
        ...(fullName ? { fullName } : {}),
      },
      create: {
        id: userId,
        email,
        fullName,
        role: UserRole.CLIENT,
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        status: true,
      },
    });

    if (profile.status === ProfileStatus.SUSPENDED) {
      throw new UnauthorizedException('This account has been suspended');
    }

    await this.acceptPendingClientInvites(profile);

    return profile;
  }

  private getEmail(payload: JWTPayload): string | null {
    return typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
  }

  private getFullName(payload: JWTPayload): string | null {
    const metadata = payload.user_metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return null;
    }

    const fullName = (metadata as Record<string, unknown>).full_name;
    return typeof fullName === 'string' && fullName.trim()
      ? fullName.trim()
      : null;
  }

  private async acceptPendingClientInvites(profile: AuthUser): Promise<void> {
    if (profile.role !== UserRole.CLIENT || !profile.email) return;

    const pendingInvites = await this.prisma.clientInvite.findMany({
      where: {
        email: profile.email,
        status: ClientInviteStatus.PENDING,
      },
      select: { id: true, projectId: true },
    });

    if (pendingInvites.length === 0) return;

    await this.prisma.$transaction(
      pendingInvites.flatMap((invite) => [
        this.prisma.projectMember.upsert({
          where: {
            projectId_userId: {
              projectId: invite.projectId,
              userId: profile.id,
            },
          },
          update: { role: UserRole.CLIENT },
          create: {
            projectId: invite.projectId,
            userId: profile.id,
            role: UserRole.CLIENT,
          },
        }),
        this.prisma.clientInvite.update({
          where: { id: invite.id },
          data: {
            status: ClientInviteStatus.ACCEPTED,
            acceptedById: profile.id,
            acceptedAt: new Date(),
          },
        }),
      ]),
    );
  }
}
