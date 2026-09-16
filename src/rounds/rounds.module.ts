import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LedgerModule } from '../ledger/ledger.module';
import { RoundEventBusService } from './events/round-event-bus.service';
import { HashChainFairnessProvider } from './fairness/hash-chain-fairness.provider';
import { FAIRNESS_PROVIDER } from './fairness/fairness.provider';
import { LeaderElectionService } from './leader-election.service';
import { RoundEngineService } from './round-engine.service';
import { RoundsController } from './rounds.controller';
import { FairnessService } from './fairness.service';
import { RoundsGateway } from './rounds.gateway';
import { RoundsService } from './rounds.service';

@Module({
  imports: [LedgerModule, AuthModule],
  controllers: [RoundsController],
  providers: [
    RoundsService,
    FairnessService,
    RoundEngineService,
    RoundEventBusService,
    RoundsGateway,
    LeaderElectionService,
    // Phase 4 swapped this binding from commit/reveal to the committed chain.
    // Nothing else in the engine or the betting path changed, which is what the
    // interface was for.
    HashChainFairnessProvider,
    { provide: FAIRNESS_PROVIDER, useExisting: HashChainFairnessProvider },
  ],
  exports: [RoundsService, FairnessService, RoundEngineService, RoundEventBusService],
})
export class RoundsModule {}
