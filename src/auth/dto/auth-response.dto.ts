import { ApiProperty } from '@nestjs/swagger';

export class AuthUserDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty() role!: string;
}

export class AuthResponseDto {
  @ApiProperty() accessToken!: string;
  @ApiProperty() refreshToken!: string;
  @ApiProperty({ description: 'Access token lifetime in seconds' }) expiresIn!: number;
  @ApiProperty({ type: AuthUserDto }) user!: AuthUserDto;
}
