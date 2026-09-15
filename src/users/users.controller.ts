import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AccessTokenPayload } from '../auth/tokens.service';
import { Money } from '../common/money';
import { LedgerService } from '../ledger/ledger.service';

@ApiTags('me')
@Controller('me')
export class UsersController {
  constructor(private readonly ledger: LedgerService) {}

  @Get('balance')
  @ApiOperation({ summary: 'Current wallet balance, derived from the ledger' })
  async balance(@CurrentUser() user: AccessTokenPayload) {
    const balance = await this.ledger.getUserBalance(user.sub);
    return { balanceMinor: balance, balance: Money.format(balance) };
  }

  @Get('ledger')
  @ApiOperation({ summary: 'Immutable posting history for this account, newest first' })
  async ledgerHistory(
    @CurrentUser() user: AccessTokenPayload,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('cursor') cursor?: string,
    @Query('referenceType') referenceType?: string,
  ) {
    const accountId = await this.ledger.getWalletAccountId(user.sub);
    const page = await this.ledger.getHistory(accountId, {
      limit,
      cursor: cursor ? Number(cursor) : undefined,
      referenceType,
    });

    return {
      entries: page.entries.map((e) => ({
        id: e.id,
        transactionId: e.transactionId,
        kind: e.transactionKind,
        amountMinor: e.amount,
        amount: Money.format(e.amount),
        direction: e.amount < 0 ? 'debit' : 'credit',
        referenceType: e.referenceType,
        referenceId: e.referenceId,
        createdAt: e.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }
}
