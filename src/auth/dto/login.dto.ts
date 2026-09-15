import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'player@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(128)
  password!: string;
}
