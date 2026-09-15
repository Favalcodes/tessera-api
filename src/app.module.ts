import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';
import { ConfigurableThrottlerGuard } from './common/guards/configurable-throttler.guard';
import { validateEnv } from './config/env';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { LedgerModule } from './ledger/ledger.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),

    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        transport:
          process.env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
        autoLogging: { ignore: (req) => req.url === '/health' },
        // Correlation id on every line, so a single request can be followed
        // across the ledger, auth and database logs it touches.
        genReqId: (req, res) => {
          const existing = req.headers['x-request-id'];
          const id = typeof existing === 'string' ? existing : crypto.randomUUID();
          res.setHeader('x-request-id', id);
          return id;
        },
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.body.password',
            'req.body.refreshToken',
          ],
          remove: true,
        },
      },
    }),

    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),

    DatabaseModule,
    LedgerModule,
    AuthModule,
    UsersModule,
    HealthModule,
  ],
  providers: [
    // Authentication is on by default; routes opt out with @Public(). Making the
    // safe state the default means a new endpoint cannot be left unprotected by
    // forgetting a decorator.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: ConfigurableThrottlerGuard },
  ],
})
export class AppModule {}
