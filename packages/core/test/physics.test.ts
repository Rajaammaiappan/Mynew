import assert from 'node:assert';
import { validateTrack } from '../src/physics';
import { effectiveStrength, resolveOwnership } from '../src/decay';
import { toTrack, straightPath, withTeleport, assertLog } from './helpers';

const STEPS_OK = (km: number) => ({ steps: Math.round(km * 1400), accelVar: 1.2 });
const NOW = 1_750_000_000_000;

// 1. Normal 5k run at ~5:12/km validates clean
{
  const r = validateTrack(toTrack(straightPath(5), { speedMs: 3.2, jitterM: 3 }), 'run', STEPS_OK(5));
  assert.strictEqual(r.verdict, 'validated');
  assert.deepStrictEqual(r.flags, []);
  assert.ok(Math.abs(r.metrics.distanceM - 5000) < 250);
  assertLog('normal 5k validates', `p95 ${r.metrics.p95SpeedMs.toFixed(2)} m/s`);
}

// 2. Teleport jump flagged
{
  const r = validateTrack(withTeleport(toTrack(straightPath(3), { speedMs: 3 }), 80), 'run', STEPS_OK(3));
  assert.ok(r.flags.includes('teleport_jump'), r.flags.join(','));
  assert.strictEqual(r.verdict, 'flagged');
  assertLog('teleport flagged');
}

// 3. Car posing as run: sustained 15 m/s + no steps
{
  const r = validateTrack(toTrack(straightPath(8), { speedMs: 15 }), 'run', { steps: 40, accelVar: 0.02 });
  assert.ok(r.flags.includes('sustained_overspeed'));
  assert.ok(r.flags.includes('no_step_signal') || r.flags.includes('vehicle_speed_profile'));
  assert.strictEqual(r.verdict, 'flagged');
  assertLog('vehicle flagged', r.flags.join(','));
}

// 4. Same speeds are fine for cycling
{
  const r = validateTrack(toTrack(straightPath(8), { speedMs: 9 }), 'cycle', {});
  assert.strictEqual(r.verdict, 'validated');
  assertLog('cycle at 32km/h validates');
}

// 5. Non-monotonic time → hard reject
{
  const t = toTrack(straightPath(2), { speedMs: 3 });
  t[50] = { ...t[50], t: t[49].t - 1000 };
  const r = validateTrack(t, 'run', STEPS_OK(2));
  assert.strictEqual(r.verdict, 'rejected');
  assertLog('non-monotonic rejected');
}

// 6. Too short → reject
{
  const r = validateTrack(toTrack(straightPath(0.2), { speedMs: 3 }), 'run', {});
  assert.strictEqual(r.verdict, 'rejected');
  assertLog('sub-300m rejected');
}

// 7. Silent pedometer on a "run" → flagged
{
  const r = validateTrack(toTrack(straightPath(4), { speedMs: 3 }), 'run', { steps: 100, accelVar: 0.02 });
  assert.ok(r.flags.includes('no_step_signal'));
  assert.strictEqual(r.verdict, 'flagged');
  assertLog('dead pedometer flagged');
}

// --- decay & ownership ---
{
  assert.strictEqual(effectiveStrength(100, NOW - 5 * 86_400_000, NOW), 60); // 100 - 5*8
  assert.strictEqual(effectiveStrength(100, NOW - 20 * 86_400_000, NOW), 0);
  assert.strictEqual(effectiveStrength(100, NOW + 1000, NOW), 100); // clock skew clamp
  assertLog('effectiveStrength math');

  assert.strictEqual(resolveOwnership(null, 'u1', 50, NOW), 'claim');
  const fresh = { ownerUserId: 'u2', strength: 100, lastRefreshedAtMs: NOW };
  assert.strictEqual(resolveOwnership(fresh, 'u1', 50, NOW), 'defended');
  assert.strictEqual(resolveOwnership(fresh, 'u2', 50, NOW), 'refresh');
  const stale = { ownerUserId: 'u2', strength: 100, lastRefreshedAtMs: NOW - 7 * 86_400_000 }; // eff 44
  assert.strictEqual(resolveOwnership(stale, 'u1', 50, NOW), 'steal');
  const dead = { ownerUserId: 'u2', strength: 100, lastRefreshedAtMs: NOW - 13 * 86_400_000 }; // eff 0
  assert.strictEqual(resolveOwnership(dead, 'u1', 50, NOW), 'claim');
  assertLog('ownership resolution: claim/refresh/steal/defended');
}

console.log('\nphysics+decay: all tests passed');
