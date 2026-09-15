import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { LedgerModule } from '../ledger/ledger.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AccountStatusGuard } from './guards/account-status.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { TokensService } from './tokens.service';

@Module({
  imports: [JwtModule.register({}), LedgerModule, UsersModule],
  controllers: [AuthController],
  providers: [AuthService, TokensService, JwtAuthGuard, RolesGuard, AccountStatusGuard],
  // UsersModule is re-exported because AccountStatusGuard depends on UsersService
  // and guards are instantiated in the injector of whichever module applies them.
  // Without this, every module using the guard would have to import UsersModule
  // itself and know why.
  exports: [AuthService, TokensService, JwtAuthGuard, RolesGuard, AccountStatusGuard, UsersModule],
})
export class AuthModule {}
