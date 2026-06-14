import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/auth.types';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import {
  CreateAdminDomainDto,
  HandoffOverrideDto,
  LinkAdminRepositoryDto,
  UpdateAdminDomainDto,
  UpdateAdminUserRoleDto,
  UpdateAdminUserStatusDto,
  UpdatePlatformSettingDto,
} from './dto/admin.dto';
import { AdminService } from './admin.service';

@Controller('admin')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('users')
  users(@Query('q') q?: string, @Query('role') role?: UserRole) {
    return this.adminService.listUsers({ q, role });
  }

  @Patch('users/:id/role')
  updateUserRole(
    @Param('id') id: string,
    @Body() dto: UpdateAdminUserRoleDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.adminService.updateUserRole(id, dto.role, user);
  }

  @Patch('users/:id/status')
  updateUserStatus(
    @Param('id') id: string,
    @Body() dto: UpdateAdminUserStatusDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.adminService.updateUserStatus(id, dto.status, user);
  }

  @Get('domains')
  domains() {
    return this.adminService.listDomains();
  }

  @Post('domains')
  createDomain(@Body() dto: CreateAdminDomainDto, @CurrentUser() user: AuthUser) {
    return this.adminService.createDomain(dto, user);
  }

  @Patch('domains/:id')
  updateDomain(
    @Param('id') id: string,
    @Body() dto: UpdateAdminDomainDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.adminService.updateDomain(id, dto, user);
  }

  @Post('domains/:id/verify')
  verifyDomain(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.adminService.verifyDomain(id, user);
  }

  @Delete('domains/:id')
  deleteDomain(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.adminService.deleteDomain(id, user);
  }

  @Get('repositories')
  repositories() {
    return this.adminService.listRepositories();
  }

  @Patch('projects/:id/repository')
  linkRepository(
    @Param('id') id: string,
    @Body() dto: LinkAdminRepositoryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.adminService.linkRepository(id, dto.repoUrl, user);
  }

  @Get('handoffs')
  handoffs() {
    return this.adminService.listHandoffs();
  }

  @Post('projects/:id/handoff/override')
  overrideHandoff(
    @Param('id') id: string,
    @Body() dto: HandoffOverrideDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.adminService.overrideHandoff(id, dto, user);
  }

  @Get('usage')
  usage() {
    return this.adminService.usage();
  }

  @Get('health')
  health() {
    return this.adminService.health();
  }

  @Get('audit-logs')
  auditLogs(@Query('limit') limit?: string) {
    return this.adminService.auditLogs(limit ? Number(limit) : undefined);
  }

  @Get('settings')
  settings() {
    return this.adminService.settings();
  }

  @Patch('settings/:key')
  updateSetting(
    @Param('key') key: string,
    @Body() dto: UpdatePlatformSettingDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.adminService.updateSetting(key, dto.value, user);
  }
}
