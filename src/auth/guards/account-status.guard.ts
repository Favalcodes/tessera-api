import { CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import type { RequestWithUser } from './jwt-auth.guard';

/**
 * The KYC / AML extension seam (PRD 5.6).
 *
 * Today this only rejects suspended accounts, because with no real money there
 * is nothing to verify. It exists so that the place where a real identity check
 * would gate the bet path is already decided, already wired, and already covered
 * by tests — rather than being a refactor that touches every betting endpoint.
 *
 * In a real-money deployment this is where you would require
 * `status === 'active'` only after a completed verification, consult a sanctions
 * screen, and enforce deposit limits. The bet path itself would not change.
 */
@Injectable()
export class AccountStatusGuard implements CanActivate {
  constructor(private readonly database: DatabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { user } = context.switchToHttp().getRequest<RequestWithUser>();
    if (!user) return false;

    const row = await this.database.db
      .selectFrom('users')
      .select(['status'])
      .where('id', '=', user.sub)
      .executeTakeFirst();

    if (!row) throw new ForbiddenException('Account not found');

    if (row.status !== 'active') {
      throw new ForbiddenException(
        row.status === 'pending_verification'
          ? 'Account verification is required before placing a bet'
          : 'This account is suspended',
      );
    }

    return true;
  }
}
