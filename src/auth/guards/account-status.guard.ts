import { CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthenticatedRequest } from '../../common/types/authenticated-request';
import { UsersService } from '../../users/users.service';

/**
 * The KYC / AML extension seam (PRD 5.6).
 *
 * Today this only rejects non-active accounts, because with no real money there
 * is nothing to verify. It exists so that the place where a real identity check
 * would gate the bet path is already decided, wired and covered by tests, rather
 * than being a later refactor across every betting endpoint.
 *
 * In a real-money deployment this is where you would require `status === 'active'`
 * only after completed verification, consult a sanctions screen, and enforce
 * deposit limits. The bet path itself would not change.
 */
@Injectable()
export class AccountStatusGuard implements CanActivate {
  constructor(private readonly users: UsersService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!user) return false;

    const account = await this.users.findById(user.sub);
    if (!account) throw new ForbiddenException('Account not found');

    if (account.status !== 'active') {
      throw new ForbiddenException(
        account.status === 'pending_verification'
          ? 'Account verification is required before placing a bet'
          : 'This account is suspended',
      );
    }

    return true;
  }
}
