import { Injectable } from '@nestjs/common';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';
import { Money } from '../../common/value-objects/money';
import { LedgerService } from '../../ledger/ledger.service';

/**
 * The ledger invariant, exposed as a health check.
 *
 * A health endpoint rather than only a test, so it can be scraped continuously
 * and asserted at the end of a load test without a separate harness. If this
 * ever reports down, the system's central claim is false and it should be
 * treated as an outage, not a warning.
 */
@Injectable()
export class LedgerHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly ledger: LedgerService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);

    const [globalPostingSum, drift, circulation] = await Promise.all([
      this.ledger.getGlobalSum(),
      this.ledger.findBalanceDrift(),
      this.ledger.getCreditsInCirculation(),
    ]);

    const details = {
      globalPostingSum,
      driftingAccounts: drift.length,
      creditsInCirculation: Money.format(circulation),
    };

    if (globalPostingSum !== 0 || drift.length > 0) {
      return indicator.down({ ...details, drift });
    }

    return indicator.up(details);
  }
}
