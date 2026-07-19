/**
 * Strength decay & ownership resolution — shared so the client can preview
 * steal outcomes; the SQL in the capture worker is the authoritative twin.
 */
import { TUNING } from './constants';

/** Effective strength after lazy decay. Clamped to [0, 100]. */
export function effectiveStrength(
  strength: number,
  lastRefreshedAtMs: number,
  nowMs: number,
  decayPerDay = TUNING.DECAY_PER_DAY,
): number {
  const days = Math.max(0, (nowMs - lastRefreshedAtMs) / 86_400_000);
  return Math.max(0, Math.min(100, strength - days * decayPerDay));
}

export const ATTACKER_POWER_BASE = 50;

export interface HexOwnershipInput {
  ownerUserId: string | null;
  strength: number;
  lastRefreshedAtMs: number;
}

export type OwnershipOutcome = 'claim' | 'refresh' | 'steal' | 'defended';

/**
 * Resolution rules (Architecture §3.3):
 *  - neutral (no owner or decayed to 0) → claim
 *  - own hex → refresh (strength back to 100)
 *  - rival hex → steal iff attackerPower > effective strength, else defended (no change)
 */
export function resolveOwnership(
  hex: HexOwnershipInput | null,
  attackerUserId: string,
  attackerPower: number,
  nowMs: number,
): OwnershipOutcome {
  if (!hex || hex.ownerUserId === null) return 'claim';
  const eff = effectiveStrength(hex.strength, hex.lastRefreshedAtMs, nowMs);
  if (eff <= 0) return 'claim';
  if (hex.ownerUserId === attackerUserId) return 'refresh';
  return attackerPower > eff ? 'steal' : 'defended';
}
