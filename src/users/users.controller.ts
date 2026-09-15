import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AccessTokenPayload } from '../common/types/authenticated-request';
import { Money } from '../common/value-objects/money';
import { BalanceResponseDto } from './dto/balance-response.dto';
import { LedgerPageResponseDto } from './dto/ledger-entry-response.dto';
import { LedgerQueryDto } from './dto/ledger-query.dto';
import { UsersService } from './users.service';

@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'The authenticated account' })
  async me(@CurrentUser() user: AccessTokenPayload) {
    return this.users.requireById(user.sub);
  }

  @Get('balance')
  @ApiOperation({ summary: 'Current wallet balance, derived from the ledger' })
  @ApiOkResponse({ type: BalanceResponseDto })
  async balance(@CurrentUser() user: AccessTokenPayload): Promise<BalanceResponseDto> {
    const balance = await this.users.getBalance(user.sub);
    return { balanceMinor: balance, balance: Money.format(balance) };
  }

  @Get('ledger')
  @ApiOperation({ summary: 'Immutable posting history for this account, newest first' })
  @ApiOkResponse({ type: LedgerPageResponseDto })
  async ledger(
    @CurrentUser() user: AccessTokenPayload,
    @Query() query: LedgerQueryDto,
  ): Promise<LedgerPageResponseDto> {
    return this.users.getLedgerHistory(user.sub, query);
  }
}
