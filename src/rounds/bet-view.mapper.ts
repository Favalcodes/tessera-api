import type { BetView, GameKind } from '@tessera/contracts';
import { Money } from '../common/value-objects/money';
import type { BetStatusDb } from '../database/database.types';

export interface BetRow {
  id: string;
  round_id: string;
  stake_minor: number;
  status: BetStatusDb;
  settled_multiplier_bp: number | null;
  payout_minor: number | null;
  created_at: Date;
  selection_type: string | null;
  selection_value: string | null;
  odds_bp: number | null;
}

/**
 * Shared by the services, the engine and the gateway, so a bet is described
 * identically whether it reaches a client over HTTP or over a socket.
 */
export function toBetView(row: BetRow, game: GameKind = 'CRASH'): BetView {
  const payout = row.payout_minor === null ? null : Money.fromMinor(row.payout_minor);

  return {
    id: row.id,
    roundId: row.round_id,
    game,
    selection: row.selection_type
      ? {
          type: row.selection_type,
          ...(row.selection_value === null ? {} : { value: Number(row.selection_value) }),
        }
      : null,
    oddsBp: row.odds_bp,
    stakeMinor: row.stake_minor,
    stake: Money.format(Money.fromMinor(row.stake_minor)),
    status: row.status,
    settledMultiplierBp: row.settled_multiplier_bp,
    payoutMinor: payout,
    payout: payout === null ? null : Money.format(payout),
    createdAt: row.created_at.toISOString(),
  };
}
