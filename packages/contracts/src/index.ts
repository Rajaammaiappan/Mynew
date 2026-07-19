/**
 * @runverse/contracts — zod schemas are the single source of truth for the
 * API surface. OpenAPI generation hangs off these in CI (zod-to-openapi).
 */
import { z } from 'zod';

// ---------- shared ----------
export const ActivityType = z.enum(['run', 'walk', 'cycle', 'hike', 'trail_run', 'treadmill']);
export const Visibility = z.enum(['public', 'followers', 'private']);

export const TrackPointDto = z.object({
  t: z.number().int().positive(),          // epoch ms
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  alt: z.number().min(-500).max(9000).optional(),
  acc: z.number().min(0).max(500).optional(),
  hr: z.number().int().min(20).max(250).optional(),
  cad: z.number().int().min(0).max(300).optional(),
});

// ---------- auth ----------
export const OtpRequestDto = z.object({
  phone_e164: z.string().regex(/^\+[1-9]\d{6,14}$/),
});
export const DeviceDto = z.object({
  platform: z.enum(['ios', 'android']),
  model: z.string().max(64).optional(),
  os_version: z.string().max(32).optional(),
  push_token: z.string().max(4096).optional(),
});
export const OtpVerifyDto = z.object({
  phone_e164: z.string().regex(/^\+[1-9]\d{6,14}$/),
  code: z.string().length(6),
  device: DeviceDto,
  handle: z.string().regex(/^[a-z0-9_]{3,20}$/).optional(),   // required for new users
  display_name: z.string().min(1).max(50).optional(),
});
export const RefreshDto = z.object({ refresh: z.string() });

// ---------- activities ----------
export const LiveStartDto = z.object({
  type: ActivityType,
  started_at: z.string().datetime(),
});
export const ChunkDto = z.object({
  seq: z.number().int().min(0),
  points: z.array(TrackPointDto).min(1).max(600),
  sensors: z.object({
    avg_cadence_spm: z.number().nullable().optional(),
    accel_variance: z.number().nullable().optional(),
    steps: z.number().int().optional(),
  }).optional(),
});
export const LiveFinishDto = z.object({
  ended_at: z.string().datetime(),
  client_summary: z.object({
    distance_m: z.number().int().min(0),
    moving_time_s: z.number().int().min(0),
  }).optional(),
});

// ---------- territory ----------
export const ViewportQuery = z.object({
  cells: z.string().transform((s) => s.split(',').slice(0, 12)),  // res-5 H3 strings
  res: z.coerce.number().int().refine((r) => r === 7 || r === 9).default(9),
});

export type TOtpVerify = z.infer<typeof OtpVerifyDto>;
export type TChunk = z.infer<typeof ChunkDto>;
export type TLiveStart = z.infer<typeof LiveStartDto>;
