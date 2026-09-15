import type { BetView } from '@tessera/contracts';
import { Money } from '../common/value-objects/money';
import type { BetStatusDb } from '../database/database.types';

export interface BetRow {
  id: string;
  round_id: string;
  stake_minor: number;
  status: BetStatusDb;
  cashout_multiplier_bp: number | null;
  payout_minor: number | null;
  created_at: Date;
}

/**
 * Shared by the service and the engine, so a bet is described identically
 * whether it reaches a client over HTTP or over a socket.
 */
export function toBetView(row: BetRow): BetView {
  const payout = row.payout_minor === null ? null : Money.fromMinor(row.payout_minor);

  return {
    id: row.id,
    roundId: row.round_id,
    stakeMinor: row.stake_minor,
    stake: Money.format(Money.fromMinor(row.stake_minor)),
    status: row.status,
    cashoutMultiplierBp: row.cashout_multiplier_bp,
    payoutMinor: payout,
    payout: payout === null ? null : Money.format(payout),
    createdAt: row.created_at.toISOString(),
  };
}
