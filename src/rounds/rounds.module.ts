import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LedgerModule } from '../ledger/ledger.module';
import { RoundEventBusService } from './events/round-event-bus.service';
import { CommitRevealFairnessProvider } from './fairness/commit-reveal-fairness.provider';
import { FAIRNESS_PROVIDER } from './fairness/fairness.provider';
import { LeaderElectionService } from './leader-election.service';
import { RoundEngineService } from './round-engine.service';
import { RoundsController } from './rounds.controller';
import { RoundsGateway } from './rounds.gateway';
import { RoundsService } from './rounds.service';

@Module({
  imports: [LedgerModule, AuthModule],
  controllers: [RoundsController],
  providers: [
    RoundsService,
    RoundEngineService,
    RoundEventBusService,
    RoundsGateway,
    LeaderElectionService,
    // Phase 4 swaps this binding for the hash-chain provider. Nothing else moves.
    { provide: FAIRNESS_PROVIDER, useClass: CommitRevealFairnessProvider },
  ],
  exports: [RoundsService, RoundEngineService, RoundEventBusService],
})
export class RoundsModule {}
