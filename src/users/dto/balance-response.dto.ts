import { ApiProperty } from '@nestjs/swagger';

export class BalanceResponseDto {
  @ApiProperty({ example: 100000, description: 'Balance in minor units (100 = 1.00 credit)' })
  balanceMinor!: number;

  @ApiProperty({ example: '1000.00' })
  balance!: string;
}
