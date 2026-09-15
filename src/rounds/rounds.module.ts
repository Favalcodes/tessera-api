import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LedgerModule } from '../ledger/ledger.module';
import { CommitRevealFairnessProvider } from './fairness/commit-reveal-fairness.provider';
import { FAIRNESS_PROVIDER } from './fairness/fairness.provider';
import { LeaderElectionService } from './leader-election.service';
import { RoundEngineService } from './round-engine.service';
import { RoundsController } from './rounds.controller';
import { RoundsService } from './rounds.service';

@Module({
  imports: [LedgerModule, AuthModule],
  controllers: [RoundsController],
  providers: [
    RoundsService,
    RoundEngineService,
    LeaderElectionService,
    // Phase 4 swaps this binding for the hash-chain provider. Nothing else moves.
    { provide: FAIRNESS_PROVIDER, useClass: CommitRevealFairnessProvider },
  ],
  exports: [RoundsService, RoundEngineService],
})
export class RoundsModule {}
