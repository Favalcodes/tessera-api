import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [LedgerModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
