import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'player@example.com' })
  @IsEmail({}, { message: 'a valid email address is required' })
  @MaxLength(254)
  email!: string;

  @ApiProperty({ example: 'Ada' })
  @IsString()
  @MinLength(2)
  @MaxLength(40)
  displayName!: string;

  @ApiProperty({ example: 'correct-horse-battery-staple', minLength: 12 })
  @IsString()
  @MinLength(12, { message: 'password must be at least 12 characters' })
  @MaxLength(128)
  // Length carries far more entropy than composition rules, so the only pattern
  // check is a ban on whitespace-only padding used to pad out the minimum.
  @Matches(/\S{12,}/, { message: 'password must contain at least 12 non-whitespace characters' })
  password!: string;
}
