import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AccessTokenPayload, AuthenticatedRequest } from '../types/authenticated-request';

/**
 * Injects the authenticated user's token claims.
 *
 * Throws rather than returning undefined: reaching this on a route with no
 * authentication guard is a wiring mistake, and failing loudly at the first
 * request beats handing the handler an undefined user.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AccessTokenPayload => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user) {
      throw new Error('CurrentUser used on a route with no authentication guard');
    }
    return request.user;
  },
);
