import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { UsersController } from './users.controller';

@Module({
  imports: [LedgerModule],
  controllers: [UsersController],
})
export class UsersModule {}
