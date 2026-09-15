import { ApiProperty } from '@nestjs/swagger';

export class LedgerEntryResponseDto {
  @ApiProperty() id!: number;
  @ApiProperty() transactionId!: string;
  @ApiProperty({ example: 'SIGNUP_GRANT' }) kind!: string;
  @ApiProperty({ example: 100000 }) amountMinor!: number;
  @ApiProperty({ example: '1000.00' }) amount!: string;
  @ApiProperty({ enum: ['debit', 'credit'] }) direction!: 'debit' | 'credit';
  @ApiProperty({ nullable: true }) referenceType!: string | null;
  @ApiProperty({ nullable: true }) referenceId!: string | null;
  @ApiProperty() createdAt!: string;
}

export class LedgerPageResponseDto {
  @ApiProperty({ type: [LedgerEntryResponseDto] })
  entries!: LedgerEntryResponseDto[];

  @ApiProperty({ nullable: true, description: 'Pass as ?cursor= to fetch the next page' })
  nextCursor!: number | null;
}
