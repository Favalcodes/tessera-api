import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { DomainExceptionFilter } from './common/filters/domain-exception.filter';
import { corsOrigins, type Env } from './config/env';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));

  const config = app.get(ConfigService<Env, true>);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  app.useGlobalFilters(new DomainExceptionFilter());

  app.enableCors({
    origin: corsOrigins(config.get('CORS_ORIGINS', { infer: true })),
    credentials: true,
  });

  // Behind a proxy the throttler must rate-limit the real client, not the proxy.
  app.set('trust proxy', 1);

  if (config.get('NODE_ENV', { infer: true }) !== 'production') {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Tessera API')
        .setDescription('Real-time ledger and settlement engine. Simulated credits only.')
        .setVersion('0.1.0')
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup('docs', app, doc);
  }

  const port = config.get('PORT', { infer: true });
  await app.listen(port);

  app.get(Logger).log(`Tessera API listening on http://localhost:${port}`);
}

void bootstrap();
