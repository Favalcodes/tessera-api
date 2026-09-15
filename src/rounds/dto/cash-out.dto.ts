import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

/**
 * Note what is absent: a multiplier.
 *
 * The server derives it from its own clock and the round's start time (ADR-006).
 * A client-supplied multiplier would be a request to be paid an arbitrary amount.
 */
export class CashOutDto {
  @ApiProperty({ description: 'Client-generated key making a retry safe.' })
  @IsString()
  @Length(8, 128)
  idempotencyKey!: string;
}
