import { Injectable } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SearchProfilesDto } from './dto/search-profiles.dto';

export interface ProfileSearchResult {
  id: string;
  email: string | null;
  fullName: string | null;
  role: UserRole;
  createdAt: Date;
}

@Injectable()
export class ProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  search(dto: SearchProfilesDto): Promise<ProfileSearchResult[]> {
    const query = dto.q?.trim();
    const limit = dto.limit ?? 20;
    const where: Prisma.ProfileWhereInput = {};

    if (dto.roles?.length) {
      where.role = { in: dto.roles };
    }

    if (query) {
      where.OR = [
        { email: { contains: query, mode: 'insensitive' } },
        { fullName: { contains: query, mode: 'insensitive' } },
      ];
    }

    return this.prisma.profile.findMany({
      where,
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        createdAt: true,
      },
      orderBy: [
        { role: 'asc' },
        { email: 'asc' },
      ],
      take: limit,
    });
  }
}
