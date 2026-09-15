import {
  CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import type { AuthenticatedRequest } from '../../common/types/authenticated-request';
import { TokensService } from '../tokens.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokensService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    try {
      request.user = this.tokens.verifyAccessToken(header.slice('Bearer '.length));
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }
}
