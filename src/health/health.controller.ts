import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService, type HealthCheckResult } from '@nestjs/terminus';
import { Public } from '../common/decorators/public.decorator';
import { DatabaseHealthIndicator } from './indicators/database.health-indicator';
import { LedgerHealthIndicator } from './indicators/ledger.health-indicator';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly databaseIndicator: DatabaseHealthIndicator,
    private readonly ledgerIndicator: LedgerHealthIndicator,
  ) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Liveness — the process is up' })
  live() {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }

  @Public()
  @Get('ready')
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness — the database is reachable' })
  ready(): Promise<HealthCheckResult> {
    return this.health.check([() => this.databaseIndicator.isHealthy('database')]);
  }

  @Public()
  @Get('ledger')
  @HealthCheck()
  @ApiOperation({ summary: 'Integrity — the ledger balances and no cached balance has drifted' })
  ledger(): Promise<HealthCheckResult> {
    return this.health.check([() => this.ledgerIndicator.isHealthy('ledger')]);
  }
}
