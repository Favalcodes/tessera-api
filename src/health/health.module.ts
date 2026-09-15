import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { HealthController } from './health.controller';

@Module({
  imports: [LedgerModule],
  controllers: [HealthController],
})
export class HealthModule {}
