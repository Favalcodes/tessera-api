import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class LedgerQueryDto {
  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;

  @ApiPropertyOptional({ description: 'Keyset cursor from a previous page' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  cursor?: number;

  @ApiPropertyOptional({ example: 'user' })
  @IsOptional()
  @IsString()
  referenceType?: string;
}
