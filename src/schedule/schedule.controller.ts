import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/auth.types';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CreateScheduleEventDto, UpdateScheduleEventDto } from './dto/schedule.dto';
import { ScheduleService } from './schedule.service';

@Controller('schedule/events')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles(UserRole.CLIENT, UserRole.PM, UserRole.DEV, UserRole.ADMIN)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
export class ScheduleController {
  constructor(private readonly scheduleService: ScheduleService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.scheduleService.list(user);
  }

  @Post()
  create(@Body() dto: CreateScheduleEventDto, @CurrentUser() user: AuthUser) {
    return this.scheduleService.create(user, dto);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateScheduleEventDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.scheduleService.update(id, user, dto);
  }

  @Delete(':id')
  delete(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.scheduleService.delete(id, user);
  }
}
