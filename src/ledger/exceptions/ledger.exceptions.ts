/** A posting set that does not sum to zero. Should never escape LedgerService. */
export class UnbalancedTransactionError extends Error {
  constructor(sum: number) {
    super(`Refusing to post: the postings sum to ${sum}, not 0`);
    this.name = 'UnbalancedTransactionError';
  }
}

/** The account cannot cover the requested debit. Expected; surfaced to callers. */
export class InsufficientFundsError extends Error {
  constructor(
    readonly available: number,
    readonly requested: number,
  ) {
    super(`Insufficient funds: balance ${available}, requested ${requested}`);
    this.name = 'InsufficientFundsError';
  }
}

export class AccountNotFoundError extends Error {
  constructor(identifier: string) {
    super(`No such ledger account: ${identifier}`);
    this.name = 'AccountNotFoundError';
  }
}
