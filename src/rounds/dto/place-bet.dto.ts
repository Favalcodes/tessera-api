import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, Length, Min } from 'class-validator';

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
}
