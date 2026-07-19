/**
 * Stage-1 validation: deterministic physics & sensor checks.
 * Produces flags; the pipeline maps flags → verdict (validated/flagged/rejected).
 * Deliberately conservative: false-flag → human review, never silent rejection.
 */
import { TrackPoint, haversineM } from './geo';
import { ACTIVITY_ENVELOPES, TUNING, ActivityType } from './constants';

export type ValidationFlag =
  | 'empty_track'
  | 'non_monotonic_time'
  | 'coordinates_out_of_bounds'
  | 'teleport_jump'
  | 'sustained_overspeed'
  | 'impossible_acceleration'
  | 'no_step_signal'
  | 'low_accuracy_track'
  | 'duration_too_short'
  | 'vehicle_speed_profile';

export interface SensorSummary {
  /** total pedometer steps reported by the device for the activity window */
  steps?: number;
  /** mean accelerometer magnitude variance over the window (m/s^2) */
  accelVar?: number;
  /** OS-level mock location flag observed at any point */
  mockLocation?: boolean;
}

export interface ValidationReport {
  flags: ValidationFlag[];
  verdict: 'validated' | 'flagged' | 'rejected';
  metrics: {
    p95SpeedMs: number;
    maxGapSpeedMs: number;
    movingTimeS: number;
    distanceM: number;
  };
  /** points surviving the accuracy filter — capture runs on these */
  cleanPoints: TrackPoint[];
}

const HARD_REJECT: ReadonlySet<ValidationFlag> = new Set([
  'empty_track',
  'non_monotonic_time',
  'coordinates_out_of_bounds',
  'duration_too_short',
]);

export function validateTrack(
  points: TrackPoint[],
  type: ActivityType,
  sensors: SensorSummary = {},
): ValidationReport {
  const flags: ValidationFlag[] = [];
  const env = ACTIVITY_ENVELOPES[type];

  const reject = (fs: ValidationFlag[]): ValidationReport => ({
    flags: fs,
    verdict: 'rejected',
    metrics: { p95SpeedMs: 0, maxGapSpeedMs: 0, movingTimeS: 0, distanceM: 0 },
    cleanPoints: [],
  });

  if (points.length < 5) return reject(['empty_track']);

  // Accuracy filter first: drop points the device itself distrusts.
  const clean = points.filter(
    (p) => p.acc === undefined || p.acc <= TUNING.MAX_ACCURACY_M,
  );
  if (clean.length < 5) return reject(['empty_track']);
  if (clean.length / points.length < 0.5) flags.push('low_accuracy_track');

  // Structural checks
  for (let i = 1; i < clean.length; i++) {
    if (clean[i].t <= clean[i - 1].t) return reject(['non_monotonic_time']);
  }
  for (const p of clean) {
    if (Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180 || (p.lat === 0 && p.lng === 0)) {
      return reject(['coordinates_out_of_bounds']);
    }
  }

  // Kinematics
  const speeds: number[] = [];
  let maxGapSpeed = 0;
  let distanceM = 0;
  let movingTimeS = 0;
  let overspeedS = 0;
  let prevV = 0;
  let accelFlagged = false;

  for (let i = 1; i < clean.length; i++) {
    const d = haversineM(clean[i - 1], clean[i]);
    const dt = (clean[i].t - clean[i - 1].t) / 1000;
    const v = d / dt;
    distanceM += d;
    if (v > TUNING.MOVING_THRESHOLD_MS) movingTimeS += dt;
    speeds.push(v);
    if (v > maxGapSpeed) maxGapSpeed = v;

    // Teleport: absurd instantaneous displacement
    if (v > TUNING.TELEPORT_SPEED_MS || (d > TUNING.TELEPORT_JUMP_M && dt < 5)) {
      flags.push('teleport_jump');
    }
    // Sustained overspeed for the claimed activity type
    if (v > env.maxSustainedMs) overspeedS += dt;
    // Impossible acceleration (once is enough to flag)
    if (!accelFlagged && dt > 0 && Math.abs(v - prevV) / dt > TUNING.MAX_ACCEL_MS2) {
      flags.push('impossible_acceleration');
      accelFlagged = true;
    }
    prevV = v;
  }

  const durationS = (clean[clean.length - 1].t - clean[0].t) / 1000;
  if (durationS < TUNING.MIN_DURATION_S || distanceM < TUNING.MIN_DISTANCE_M) {
    return reject(['duration_too_short']);
  }

  if (overspeedS > durationS * 0.1) flags.push('sustained_overspeed');

  const sorted = [...speeds].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;

  // Vehicle heuristic (full classifier lands in Phase 7): fast + smooth + no steps.
  if (
    (type === 'run' || type === 'walk') &&
    p95 > env.maxSustainedMs * 1.15 &&
    (sensors.steps ?? Infinity) < (distanceM / 1000) * 100 // < ~100 steps/km is not on foot
  ) {
    flags.push('vehicle_speed_profile');
  }

  // Sensor cross-check: on-foot speed with a dead pedometer = phone in a vehicle.
  if (
    (type === 'run' || type === 'walk') &&
    sensors.steps !== undefined &&
    sensors.steps < (distanceM / 1000) * TUNING.MIN_STEPS_PER_KM &&
    distanceM > 800
  ) {
    flags.push('no_step_signal');
  }

  const dedupFlags = [...new Set(flags)];
  const verdict: ValidationReport['verdict'] = dedupFlags.some((f) => HARD_REJECT.has(f))
    ? 'rejected'
    : dedupFlags.some((f) =>
        ['teleport_jump', 'sustained_overspeed', 'vehicle_speed_profile', 'no_step_signal'].includes(f),
      )
    ? 'flagged'
    : 'validated';

  return {
    flags: dedupFlags,
    verdict,
    metrics: { p95SpeedMs: p95, maxGapSpeedMs: maxGapSpeed, movingTimeS, distanceM },
    cleanPoints: clean,
  };
}
