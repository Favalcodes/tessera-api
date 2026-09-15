import type { ExecutionContext } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * The rate limiter, with an operational off switch.
 *
 * Phase 2 load-tests the bet-placement race by firing hundreds of concurrent
 * requests at a single account. Against the production limiter that measures the
 * limiter, not the concurrency control — so the limiter has to be disablable for
 * those runs, and the same switch keeps it out of the way of the test suite.
 *
 * The check reads the environment per request rather than at construction, so it
 * can be flipped without rebuilding the DI graph. `validateEnv` refuses a
 * disabled limiter when NODE_ENV is production, so this cannot be turned off
 * anywhere it matters.
 */
@Injectable()
export class ConfigurableThrottlerGuard extends ThrottlerGuard {
  override async canActivate(context: ExecutionContext): Promise<boolean> {
    if (process.env.THROTTLE_ENABLED === 'false') return true;
    return super.canActivate(context);
  }
}
