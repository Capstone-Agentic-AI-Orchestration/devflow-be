import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { Request, Response } from 'express';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Phase 2E — WebSocket adapter (Socket.IO)
  // Must be registered before app.listen() so the /devflow namespace is mounted.
  app.useWebSocketAdapter(new IoAdapter(app));

  app.enableCors({
    origin: process.env.CORS_ORIGIN ?? '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // LangSmith auto-instrumentation (Phase 2E — no explicit SDK init needed).
  // The @langchain/core tracer picks up LANGCHAIN_TRACING_V2 + LANGCHAIN_API_KEY
  // from the environment at import time when both vars are set.

  // Simple health probe — used by Dockerfile HEALTHCHECK and load balancers
  app.use('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  const port = parseInt(process.env.PORT ?? '4000', 10);
  await app.listen(port, '0.0.0.0');
  logger.log(`DevFlow backend running on port ${port}`);
}

bootstrap().catch((err: unknown) => {
  const logger = new Logger('Bootstrap');
  logger.error(
    'Failed to start application',
    err instanceof Error ? err.stack : String(err),
  );
  process.exit(1);
});
