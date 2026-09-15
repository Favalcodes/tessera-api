import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { RequestWithUser } from '../guards/jwt-auth.guard';
import type { AccessTokenPayload } from '../tokens.service';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AccessTokenPayload => {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    if (!request.user) {
      throw new Error('CurrentUser used on a route with no authentication guard');
    }
    return request.user;
  },
);
