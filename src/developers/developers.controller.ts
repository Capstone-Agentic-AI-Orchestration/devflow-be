import { Body, Controller, Get, Param, Patch, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/auth.types';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { UpdateDeveloperCapacityDto } from './dto/developer.dto';
import { DevelopersService } from './developers.service';

@Controller('developers')
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class DevelopersController {
  constructor(private readonly developersService: DevelopersService) {}

  @Get()
  @Roles(UserRole.PM, UserRole.ADMIN)
  list() {
    return this.developersService.list();
  }

  @Get(':id')
  @Roles(UserRole.PM, UserRole.ADMIN, UserRole.DEV)
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.developersService.get(id, user);
  }

  @Patch('me/capacity')
  @Roles(UserRole.DEV)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
  updateMe(@Body() dto: UpdateDeveloperCapacityDto, @CurrentUser() user: AuthUser) {
    return this.developersService.updateMe(user, dto);
  }
}
