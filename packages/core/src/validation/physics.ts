import { TrackPoint, haversineM } from '../geo/geometry.js';

/**
 * Stage-1 validation. Deterministic, explainable checks — every flag has a
 * code that surfaces in the admin review queue. A trained classifier joins
 * in Phase 7; these envelopes are the floor that ships on day one.
 */

export type ActivityType = 'run' | 'walk' | 'cycle' | 'hike' | 'trail_run' | 'treadmill';

export type ValidationFlag =
  | 'too_few_points'
  | 'non_monotonic_time'
  | 'invalid_coords'
  | 'teleport_jump'          // hard reject
  | 'speed_envelope'         // sustained speed beyond human for the type
  | 'accel_spike'
  | 'altitude_rate'
  | 'no_step_signal'         // moving fast, cadence/accel silent → vehicle carry
  | 'vehicle_profile'        // speed distribution looks motorized
  | 'gps_accuracy_poor'
  | 'duration_bounds';

export type Verdict = 'validated' | 'flagged' | 'rejected';

export interface ValidationResult {
  verdict: Verdict;
  flags: ValidationFlag[];
  metrics: {
    distanceM: number;
    elapsedS: number;
    vMax: number;      // m/s, after accuracy filtering
    vP95: number;
    vMedian: number;
    accelMax: number;  // m/s²
    movingFraction: number;
  };
  /** suggested trust delta for the user (applied by pipeline) */
  trustDelta: number;
  vehicleProb: number; // 0..1 heuristic until P7 model
}

/** Per-type physics envelopes (sustained, not instantaneous). */
const ENVELOPES: Record<ActivityType, { vSustained: number; vHard: number; accelMax: number }> = {
  //             p95 ceiling  absolute   accel
  run:        { vSustained: 6.5, vHard: 9.0,  accelMax: 3.5 }, // 6.5 m/s ≈ 2:34/km pace
  trail_run:  { vSustained: 6.0, vHard: 9.0,  accelMax: 3.5 },
  walk:       { vSustained: 2.5, vHard: 4.5,  accelMax: 2.5 },
  hike:       { vSustained: 2.8, vHard: 5.0,  accelMax: 2.5 },
  cycle:      { vSustained: 16,  vHard: 28,   accelMax: 4.0 }, // 16 m/s ≈ 58 km/h p95 (descents)
  treadmill:  { vSustained: 6.5, vHard: 9.0,  accelMax: 3.5 }, // GPS mostly absent; distance from cadence/HR
};

const TELEPORT_SPEED = 45;      // m/s across any gap ⇒ physically impossible on foot/bike
const ACC_FILTER_M = 40;        // drop points with worse reported accuracy
const MIN_POINTS = 20;
const MAX_ELAPSED_S = 24 * 3600;

export interface SensorSummary {
  /** average steps/min over moving time, from pedometer (null if unavailable) */
  avgCadenceSpm: number | null;
  /** accelerometer variance while moving (null if unavailable) */
  accelVariance: number | null;
}

export function validateTrack(
  type: ActivityType,
  points: TrackPoint[],
  sensors: SensorSummary,
): ValidationResult {
  const flags = new Set<ValidationFlag>();
  const env = ENVELOPES[type];

  // --- structural sanity ---
  if (points.length < MIN_POINTS) flags.add('too_few_points');
  for (let i = 1; i < points.length; i++) {
    if (points[i].t <= points[i - 1].t) { flags.add('non_monotonic_time'); break; }
  }
  for (const p of points) {
    if (Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180 || (p.lat === 0 && p.lng === 0)) {
      flags.add('invalid_coords'); break;
    }
  }

  // --- accuracy filter, then per-segment kinematics ---
  const pts = points.filter((p) => p.acc == null || p.acc <= ACC_FILTER_M);
  if (pts.length < points.length * 0.5 && points.length >= MIN_POINTS) {
    flags.add('gps_accuracy_poor');
  }

  // Teleport detection runs on RAW coordinates — smoothing would launder a
  // spoof jump into plausible speeds.
  for (let i = 1; i < pts.length; i++) {
    const dt = (pts[i].t - pts[i - 1].t) / 1000;
    if (dt <= 0) continue;
    const d = haversineM(pts[i - 1], pts[i]);
    if (d / dt > TELEPORT_SPEED && d > 100) flags.add('teleport_jump');
    if (pts[i].alt != null && pts[i - 1].alt != null) {
      const vAlt = Math.abs((pts[i].alt! - pts[i - 1].alt!) / dt);
      if (vAlt > 5 && dt > 2) flags.add('altitude_rate');
    }
  }

  // Position smoothing (3-point moving average) before kinematics. At walking
  // speed the per-second step (~1.5 m) is smaller than GPS jitter (±2-5 m),
  // which systematically inflates raw point-to-point distance and speed.
  const spts = pts.map((p, i) => {
    if (i === 0 || i === pts.length - 1) return p;
    return {
      ...p,
      lat: (pts[i - 1].lat + p.lat + pts[i + 1].lat) / 3,
      lng: (pts[i - 1].lng + p.lng + pts[i + 1].lng) / 3,
    };
  });

  interface Seg { v: number; dt: number; d: number }
  const segs: Seg[] = [];
  let distanceM = 0;
  for (let i = 1; i < spts.length; i++) {
    const dt = (spts[i].t - spts[i - 1].t) / 1000;
    if (dt <= 0) continue;
    const d = haversineM(spts[i - 1], spts[i]);
    distanceM += d;
    segs.push({ v: d / dt, dt, d });
  }

  // Pass 2 — rolling-median smoothing (window 5). GPS jitter of ±3-5 m at
  // 1 Hz fabricates instantaneous speeds a runner never held; envelopes and
  // acceleration apply to smoothed motion, matching production trackers.
  const win = 5, half = 2;
  const smoothV = (i: number): number => {
    const lo = Math.max(0, i - half), hi = Math.min(segs.length - 1, i + half);
    const w = segs.slice(lo, hi + 1).map((s) => s.v).sort((a, b) => a - b);
    return w[Math.floor(w.length / 2)];
  };

  const vs: number[] = new Array(segs.length);
  for (let i = 0; i < segs.length; i++) {
    vs[i] = segs.length >= win ? smoothV(i) : segs[i].v;
  }

  const speeds: number[] = [];
  let accelMax = 0;
  let movingS = 0;
  const ACCEL_BASELINE = 3; // samples (~3s at 1 Hz) — physical accel, not sample noise
  for (let i = 0; i < segs.length; i++) {
    if (vs[i] > env.vHard) flags.add('speed_envelope');
    if (i >= ACCEL_BASELINE) {
      let span = 0;
      for (let k = i - ACCEL_BASELINE + 1; k <= i; k++) span += segs[k].dt;
      if (span > 0) {
        const a = Math.abs(vs[i] - vs[i - ACCEL_BASELINE]) / span;
        if (a > accelMax) accelMax = a;
        if (a > env.accelMax && vs[i] > 3) flags.add('accel_spike');
      }
    }
    if (vs[i] > 0.5) { speeds.push(vs[i]); movingS += segs[i].dt; }
  }

  const sorted = [...speeds].sort((a, b) => a - b);
  const q = (f: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))] : 0);
  const vP95 = q(0.95);
  const vMedian = q(0.5);
  const vMax = sorted.length ? sorted[sorted.length - 1] : 0;

  if (vP95 > env.vSustained) flags.add('speed_envelope');

  const elapsedS = pts.length >= 2 ? (pts[pts.length - 1].t - pts[0].t) / 1000 : 0;
  if (elapsedS > MAX_ELAPSED_S || (elapsedS < 120 && distanceM > 500)) flags.add('duration_bounds');

  // --- sensor cross-check: the phone-on-a-dashboard detector ---
  // Foot activities moving at speed must show a step signal.
  const footType = type === 'run' || type === 'walk' || type === 'hike' || type === 'trail_run';
  if (footType && vMedian > 1.5) {
    const cadenceSilent = sensors.avgCadenceSpm != null && sensors.avgCadenceSpm < 40;
    const accelSilent = sensors.accelVariance != null && sensors.accelVariance < 0.15;
    if (cadenceSilent || (sensors.avgCadenceSpm == null && accelSilent)) {
      flags.add('no_step_signal');
    }
  }

  // --- vehicle heuristic (replaced by trained classifier in P7) ---
  // Motorized signature: high sustained speed + low speed variance at cruise
  // + long zero-cadence stretches. Score ∈ [0,1].
  let vehicleProb = 0;
  if (footType) {
    if (vP95 > env.vSustained) vehicleProb += 0.45;
    if (vP95 > env.vHard) vehicleProb += 0.3;
    if (flags.has('no_step_signal')) vehicleProb += 0.35;
    if (vMedian > env.vSustained * 0.85) vehicleProb += 0.2;
  } else if (type === 'cycle') {
    if (vP95 > env.vSustained) vehicleProb += 0.4;
    if (vP95 > env.vHard) vehicleProb += 0.4;
  }
  vehicleProb = Math.min(1, vehicleProb);
  if (vehicleProb >= 0.6) flags.add('vehicle_profile');

  // --- verdict ---
  const rejectFlags: ValidationFlag[] = ['teleport_jump', 'invalid_coords', 'non_monotonic_time'];
  const flagOnly: ValidationFlag[] = ['gps_accuracy_poor', 'duration_bounds', 'altitude_rate', 'accel_spike'];

  let verdict: Verdict = 'validated';
  if (rejectFlags.some((f) => flags.has(f)) || flags.has('too_few_points')) {
    verdict = 'rejected';
  } else if (flags.has('vehicle_profile') || flags.has('no_step_signal') || flags.has('speed_envelope')) {
    verdict = 'flagged'; // human/model review — never silently award
  } else if ([...flags].some((f) => !flagOnly.includes(f))) {
    verdict = 'flagged';
  }

  const trustDelta = verdict === 'validated' ? +1 : verdict === 'flagged' ? -3 : -10;

  return {
    verdict,
    flags: [...flags],
    metrics: {
      distanceM, elapsedS, vMax, vP95, vMedian, accelMax,
      movingFraction: elapsedS > 0 ? movingS / elapsedS : 0,
    },
    trustDelta,
    vehicleProb,
  };
}
