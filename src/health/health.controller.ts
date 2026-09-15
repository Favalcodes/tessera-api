import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { sql } from 'kysely';
import { Public } from '../auth/decorators/public.decorator';
import { DatabaseService } from '../database/database.service';
import { LedgerService } from '../ledger/ledger.service';
import { Money } from '../common/money';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly database: DatabaseService,
    private readonly ledger: LedgerService,
  ) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Liveness' })
  live() {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }

  @Public()
  @Get('db')
  @ApiOperation({ summary: 'Readiness — database reachable' })
  async db() {
    try {
      await sql`select 1`.execute(this.database.db);
      return { status: 'ok', database: 'reachable' };
    } catch {
      throw new ServiceUnavailableException({ status: 'error', database: 'unreachable' });
    }
  }

  /**
   * The ledger invariant as a health check.
   *
   * Exposed as an endpoint, not just a test, so it can be scraped continuously
   * and asserted at the end of a load test without a separate harness. If this
   * ever reports anything but zero drift, the system's core claim is false and
   * it should be treated as an outage.
   */
  @Public()
  @Get('ledger')
  @ApiOperation({ summary: 'Readiness — ledger integrity invariants hold' })
  async ledgerIntegrity() {
    const [globalSum, drift, circulation] = await Promise.all([
      this.ledger.getGlobalSum(),
      this.ledger.findBalanceDrift(),
      this.ledger.getCreditsInCirculation(),
    ]);

    const healthy = globalSum === 0 && drift.length === 0;

    const body = {
      status: healthy ? 'ok' : 'error',
      globalPostingSum: globalSum,
      driftingAccounts: drift.length,
      drift,
      creditsInCirculation: Money.format(circulation),
    };

    if (!healthy) throw new ServiceUnavailableException(body);
    return body;
  }
}
