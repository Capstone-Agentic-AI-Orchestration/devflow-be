import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { validateEnv } from './config/env.schema';
import configuration from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { ProjectsModule } from './projects/projects.module';
import { OrchestrationModule } from './orchestration/orchestration.module';
import { GithubModule } from './github/github.module';
import { SupervisorModule } from './supervisor/supervisor.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { GatewayModule } from './gateway/gateway.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),
    // ScheduleModule must be initialized at the root so all @Interval and
    // @Cron decorators in child modules (SupervisorModule) are picked up.
    ScheduleModule.forRoot(),
    PrismaModule,
    GithubModule,
    // Phase 2E — WebSocket gateway (must be before OrchestrationModule so
    // GatewayModule is available for injection into OrchestrationService)
    GatewayModule,
    OrchestrationModule,
    SupervisorModule,
    ProjectsModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
  ],
})
export class AppModule {}
