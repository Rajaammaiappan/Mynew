/**
 * Territory strength & decay rules (canonical constants — ADR tuning table).
 * Effective strength is always computed lazily from last_refreshed_at.
 */
export const STRENGTH_ON_CAPTURE = 100;
export const DECAY_PER_DAY = 8;
export const ATTACKER_POWER_BASE = 55; // + building/streak perks (Phase 2)

export function effectiveStrength(
  strength: number,
  lastRefreshedAt: Date,
  now: Date = new Date(),
  decayPerDay: number = DECAY_PER_DAY,
): number {
  const days = Math.max(0, (now.getTime() - lastRefreshedAt.getTime()) / 86_400_000);
  return Math.max(0, strength - decayPerDay * days);
}

export type OwnershipAction = 'claim' | 'refresh' | 'steal' | 'blocked';

/** Pure ownership-resolution rule; SQL in the pipeline mirrors this exactly. */
export function resolveOwnership(params: {
  currentOwnerId: string | null;
  effStrength: number;
  attackerId: string;
  attackerPower: number;
}): OwnershipAction {
  const { currentOwnerId, effStrength, attackerId, attackerPower } = params;
  if (currentOwnerId == null || effStrength <= 0) return 'claim';
  if (currentOwnerId === attackerId) return 'refresh';
  return attackerPower > effStrength ? 'steal' : 'blocked';
}
