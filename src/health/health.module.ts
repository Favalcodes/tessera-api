import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { LedgerModule } from '../ledger/ledger.module';
import { HealthController } from './health.controller';
import { DatabaseHealthIndicator } from './indicators/database.health-indicator';
import { LedgerHealthIndicator } from './indicators/ledger.health-indicator';

@Module({
  imports: [TerminusModule, LedgerModule],
  controllers: [HealthController],
  providers: [DatabaseHealthIndicator, LedgerHealthIndicator],
})
export class HealthModule {}
