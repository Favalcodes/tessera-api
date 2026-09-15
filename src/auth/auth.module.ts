import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { LedgerModule } from '../ledger/ledger.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AccountStatusGuard } from './guards/account-status.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { TokensService } from './tokens.service';

@Module({
  imports: [JwtModule.register({}), LedgerModule],
  controllers: [AuthController],
  providers: [AuthService, TokensService, JwtAuthGuard, RolesGuard, AccountStatusGuard],
  exports: [AuthService, TokensService, JwtAuthGuard, RolesGuard, AccountStatusGuard],
})
export class AuthModule {}
