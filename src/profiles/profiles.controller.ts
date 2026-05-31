import { Controller, Get, Query, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { SearchProfilesDto } from './dto/search-profiles.dto';
import { ProfilesService } from './profiles.service';

@Controller('profiles')
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class ProfilesController {
  constructor(private readonly profilesService: ProfilesService) {}

  @Get()
  @Roles(UserRole.PM, UserRole.ADMIN)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
  search(@Query() query: SearchProfilesDto) {
    return this.profilesService.search(query);
  }
}
