/** Canonical tuning table (Architecture §3.3). Single source across client & server. */
export const TUNING = {
  H3_RES: 9,
  SIMPLIFY_EPSILON_M: 8,
  CORRIDOR_SAMPLE_M: 50,
  LOOP_ENDPOINT_M: 60,
  LOOP_MIN_PERIMETER_M: 400,
  CAPTURE_BUDGET_PER_KM: 10, // isoperimetric bound ~0.76·L² hexes means this binds from ~13km loops; protects vs ultra/cycling enclosures
  IMPORT_BUDGET_MULTIPLIER: 0.5,
  STRENGTH_ON_CAPTURE: 100,
  DECAY_PER_DAY: 8,
  MAX_ACCURACY_M: 35,
  TELEPORT_SPEED_MS: 40,
  TELEPORT_JUMP_M: 500,
  MAX_ACCEL_MS2: 8,
  MOVING_THRESHOLD_MS: 0.5,
  MIN_DURATION_S: 120,
  MIN_DISTANCE_M: 300,
  MIN_STEPS_PER_KM: 250,
} as const;

export type ActivityType = 'run' | 'walk' | 'cycle' | 'hike' | 'trail_run' | 'treadmill';

/** Per-type kinematic envelopes (m/s). maxSustained ≈ generous elite pace + margin. */
export const ACTIVITY_ENVELOPES: Record<ActivityType, { maxSustainedMs: number }> = {
  run: { maxSustainedMs: 6.5 },        // ~2:34/km — faster sustained than WR pace flags
  trail_run: { maxSustainedMs: 6.5 },
  walk: { maxSustainedMs: 2.6 },
  hike: { maxSustainedMs: 2.6 },
  cycle: { maxSustainedMs: 18.0 },     // 64.8 km/h sustained
  treadmill: { maxSustainedMs: 6.5 },  // no GPS capture; validated via sensors only (P4)
};
