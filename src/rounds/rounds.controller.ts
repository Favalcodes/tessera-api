import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { BetView, RoundView } from '@tessera/contracts';
import { AccountStatusGuard } from '../auth/guards/account-status.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import type { AccessTokenPayload } from '../common/types/authenticated-request';
import { CashOutDto } from './dto/cash-out.dto';
import { PlaceBetDto } from './dto/place-bet.dto';
import { BetResponseDto, RoundResponseDto } from './dto/round-response.dto';
import { FairnessService } from './fairness.service';
import { RoundsService } from './rounds.service';

@ApiTags('rounds')
@Controller('rounds')
export class RoundsController {
  constructor(
    private readonly rounds: RoundsService,
    private readonly fairness: FairnessService,
  ) {}

  @Public()
  @Get('fairness/chains')
  @ApiOperation({ summary: 'Every published chain commitment, oldest first' })
  chains() {
    return this.fairness.listChains();
  }

  @Public()
  @Get('current')
  @ApiOperation({ summary: 'The round currently accepting bets or in flight' })
  @ApiOkResponse({ type: RoundResponseDto })
  current(): Promise<RoundView> {
    return this.rounds.getCurrentRound();
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'A single round, including its reveal once it has crashed' })
  @ApiOkResponse({ type: RoundResponseDto })
  byId(@Param('id', ParseUUIDPipe) id: string): Promise<RoundView> {
    return this.rounds.getRound(id);
  }

  @Public()
  @Get(':id/fairness')
  @ApiOperation({ summary: 'Everything needed to verify this round independently' })
  fairnessProof(@Param('id', ParseUUIDPipe) id: string) {
    return this.fairness.getProof(id);
  }

  @Get(':id/bets')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Your bets on this round' })
  bets(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BetView[]> {
    return this.rounds.getUserBetsForRound(user.sub, id);
  }

  /**
   * AccountStatusGuard sits here rather than on the controller as a whole: it is
   * the KYC seam (PRD 5.6), and the paths it needs to gate are the ones that
   * move money, not the read paths.
   */
  @Post(':id/bets')
  @UseGuards(AccountStatusGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Place a bet on an open round' })
  @ApiOkResponse({ type: BetResponseDto })
  placeBet(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PlaceBetDto,
  ): Promise<BetView> {
    return this.rounds.placeBet({
      userId: user.sub,
      roundId: id,
      stakeMinor: dto.stakeMinor,
      idempotencyKey: dto.idempotencyKey,
      ...(dto.selection ? { selection: dto.selection } : {}),
    });
  }

  /**
   * Addresses a specific bet, not a round: a player may hold more than one bet
   * on the same round, so "cash out of this round" would be ambiguous.
   */
  @Post('bets/:betId/cashout')
  @UseGuards(AccountStatusGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cash out a bet at the current multiplier' })
  @ApiOkResponse({ type: BetResponseDto })
  cashOut(
    @CurrentUser() user: AccessTokenPayload,
    @Param('betId', ParseUUIDPipe) betId: string,
    @Body() _dto: CashOutDto,
  ): Promise<BetView> {
    return this.rounds.cashOut({ userId: user.sub, betId });
  }
}
