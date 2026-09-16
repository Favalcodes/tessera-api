/** No round is currently accepting bets or in flight. */
export class NoActiveRoundError extends Error {
  constructor() {
    super('No round is currently active');
    this.name = 'NoActiveRoundError';
  }
}

export class RoundNotFoundError extends Error {
  constructor(roundId: string) {
    super(`No such round: ${roundId}`);
    this.name = 'RoundNotFoundError';
  }
}

/** Betting has closed on this round. */
export class RoundNotOpenError extends Error {
  constructor(readonly status: string) {
    super(`Betting is closed: the round is ${status}`);
    this.name = 'RoundNotOpenError';
  }
}

/** Cash-out attempted on a round that is not running. */
export class RoundNotRunningError extends Error {
  constructor(readonly status: string) {
    super(`Cannot cash out: the round is ${status}`);
    this.name = 'RoundNotRunningError';
  }
}

/** A selection was supplied for crash, or omitted for roulette. */
export class InvalidSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSelectionError';
  }
}

/** Cash-out attempted on a roulette bet, which has no such action. */
export class GameDoesNotSupportCashOutError extends Error {
  constructor(readonly game: string) {
    super(`${game} bets are settled when the round resolves; there is nothing to cash out`);
    this.name = 'GameDoesNotSupportCashOutError';
  }
}

/**
 * The cash-out arrived at or after the crash point.
 *
 * Expected and correct, not an edge case to be smoothed over: a request that
 * physically reached the server after the round crashed has lost, and paying it
 * would mean paying for a multiplier that never existed.
 */
export class CashOutTooLateError extends Error {
  constructor(readonly crashPointBp: number) {
    super('Too late — the round had already crashed');
    this.name = 'CashOutTooLateError';
  }
}

export class NoBetOnRoundError extends Error {
  constructor() {
    super('You have no active bet on this round');
    this.name = 'NoBetOnRoundError';
  }
}

export class BetAlreadySettledError extends Error {
  constructor(readonly status: string) {
    super(`This bet is already ${status.toLowerCase().replace('_', ' ')}`);
    this.name = 'BetAlreadySettledError';
  }
}

/** A bet already exists for this user on this round. */
export class DuplicateBetError extends Error {
  constructor() {
    super('You already have a bet on this round');
    this.name = 'DuplicateBetError';
  }
}

export class StakeOutOfRangeError extends Error {
  constructor(readonly minMinor: number, readonly maxMinor: number) {
    super(`Stake must be between ${minMinor} and ${maxMinor} minor units`);
    this.name = 'StakeOutOfRangeError';
  }
}
