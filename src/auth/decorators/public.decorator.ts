import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Exempt a route from the globally-applied JwtAuthGuard. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
