import { ApiProperty } from '@nestjs/swagger';

export class RoundResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['OPEN', 'LOCKED', 'FLYING', 'CRASHED', 'SETTLED'] }) status!: string;

  @ApiProperty({ description: 'sha256 of the seed, published before betting opens' })
  seedHash!: string;

  @ApiProperty({ nullable: true, description: 'Revealed only once the round has crashed' })
  seedRevealed!: string | null;

  @ApiProperty({ nullable: true, description: 'Withheld until the round has crashed' })
  crashPointBp!: number | null;

  @ApiProperty() opensAt!: string;
  @ApiProperty() locksAt!: string;
  @ApiProperty({ nullable: true }) startedAt!: string | null;
  @ApiProperty({ nullable: true }) crashedAt!: string | null;

  @ApiProperty({ description: 'Server clock, so a client can correct for skew' })
  serverTime!: string;
}

export class BetResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() roundId!: string;
  @ApiProperty() stakeMinor!: number;
  @ApiProperty() stake!: string;
  @ApiProperty({ enum: ['ACTIVE', 'CASHED_OUT', 'LOST', 'VOIDED'] }) status!: string;
  @ApiProperty({ nullable: true }) cashoutMultiplierBp!: number | null;
  @ApiProperty({ nullable: true }) payoutMinor!: number | null;
  @ApiProperty({ nullable: true }) payout!: string | null;
  @ApiProperty() createdAt!: string;
}
