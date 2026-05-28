import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ClientInvitesController } from './client-invites.controller';
import { ClientInvitesService } from './client-invites.service';

@Module({
  imports: [PrismaModule, AuthModule, NotificationsModule],
  controllers: [ClientInvitesController],
  providers: [ClientInvitesService],
  exports: [ClientInvitesService],
})
export class ClientInvitesModule {}
