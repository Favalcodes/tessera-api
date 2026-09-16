import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

const BET_TYPES = [
  'STRAIGHT',
  'RED',
  'BLACK',
  'ODD',
  'EVEN',
  'LOW',
  'HIGH',
  'DOZEN',
  'COLUMN',
] as const;

export class RouletteSelectionDto {
  @ApiProperty({ enum: BET_TYPES })
  @IsIn(BET_TYPES)
  type!: (typeof BET_TYPES)[number];

  @ApiPropertyOptional({
    description: 'Pocket 0-36 for STRAIGHT; 1-3 for DOZEN and COLUMN. Omitted otherwise.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(36)
  value?: number;
}

export class PlaceBetDto {
  @ApiProperty({ example: 1000, description: 'Stake in minor units (100 = 1.00 credit)' })
  @IsInt()
  @Min(1)
  stakeMinor!: number;

  @ApiProperty({
    example: '0f2a9c5e-7b1d-4f3a-9c2e-1d4b6a8f0c3e',
    description:
      'Client-generated key making a retry safe. Replaying a key returns the original bet rather than creating a second one.',
  })
  @IsString()
  @Length(8, 128)
  idempotencyKey!: string;

  /**
   * Required for roulette and rejected for crash, which has only one thing to
   * bet on. The service enforces that rather than ignoring a stray selection —
   * silently dropping it would let a client believe it had backed something.
   */
  @ApiPropertyOptional({ type: RouletteSelectionDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => RouletteSelectionDto)
  selection?: RouletteSelectionDto;
}
