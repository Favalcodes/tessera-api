import type { Request } from 'express';

/** Claims carried by an access token, attached to the request by JwtAuthGuard. */
export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: string;
}

/**
 * Lives in `common` rather than `auth` so that guards, decorators and feature
 * controllers can all share it without `common` having to depend on `auth`.
 */
export interface AuthenticatedRequest extends Request {
  user?: AccessTokenPayload;
}
