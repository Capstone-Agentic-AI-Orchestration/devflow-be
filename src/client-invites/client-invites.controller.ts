import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { ClientInvitesService } from './client-invites.service';

@Controller('client-invites')
export class ClientInvitesController {
  constructor(private readonly clientInvitesService: ClientInvitesService) {}

  @Get('status')
  status(@Query('email') email = '') {
    return this.clientInvitesService.publicStatus(email);
  }

  @Get('me')
  @Roles(UserRole.CLIENT)
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  listMine(@CurrentUser() user: AuthUser) {
    return this.clientInvitesService.listMine(user);
  }

  @Post('accept')
  @Roles(UserRole.CLIENT)
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  acceptMine(@CurrentUser() user: AuthUser) {
    return this.clientInvitesService.acceptMine(user);
  }
}
