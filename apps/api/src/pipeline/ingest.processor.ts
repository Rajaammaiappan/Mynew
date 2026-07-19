/**
 * Ingest worker — pipeline stages 1 (validate), 2 (capture), 4-lite (fanout).
 * Stage 3 (resources) lands in Phase 2; the stage hook is already in place.
 *
 * Idempotent by activity_id: pipeline_stage on the activity row gates each stage,
 * so a crashed/redelivered job resumes without double-awarding.
 */
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { latLngToCell, cellToParent } from 'h3-js';
import {
  computeCapture, validateTrack, resolveOwnership, effectiveStrength,
  ATTACKER_POWER_BASE, TUNING, TrackPoint, ActivityType, SensorSummary,
} from '@runverse/core';
import { DbService } from '../db/db.service';
import { REDIS } from '../redis/redis.module';
import { StreamStore } from '../activities/streams.store';
import { INGEST_QUEUE, ingestConnection } from './queues';
import { Broadcaster } from '../realtime/broadcaster.service';
import { CONFIG } from '../config';

const h3ToBigint = (h: string) => BigInt('0x' + h);

interface IngestJob { activityId: string; sensors?: SensorSummary }

@Injectable()
export class IngestProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ingest');
  private worker?: Worker;

  constructor(
    private db: DbService,
    private streams: StreamStore,
    private broadcaster: Broadcaster,
    @Inject(REDIS) private redis: Redis,
    @Inject(INGEST_QUEUE) private queue: Queue,
  ) {}

  onModuleInit() {
    this.worker = new Worker<IngestJob>(
      this.queue.name,
      async (job) => this.process(job.data),
      { connection: ingestConnection(), concurrency: 8 },
    );
    this.worker.on('failed', (job, err) => this.log.error(`job ${job?.id} failed: ${err.message}`));
  }

  async onModuleDestroy() { await this.worker?.close(); }

  async process({ activityId, sensors }: IngestJob): Promise<void> {
    const act = await this.db.one<{
      id: string; user_id: string; type: ActivityType; source: string; status: string;
      pipeline_stage: string; season_id: number; started_at: string; capture_budget: number;
    }>(`SELECT id, user_id, type, source, status, pipeline_stage, season_id, started_at, capture_budget
        FROM activities WHERE id=$1`, [activityId]);
    if (!act || act.status === 'rejected' || act.status === 'abandoned') return;

    const points = this.streams.get(activityId);
    if (!points) { this.log.warn(`no stream for ${activityId}`); return; }

    // ── Stage 1: validate ────────────────────────────────────────────────────
    let cleanPoints: TrackPoint[] = points;
    if (act.pipeline_stage === 'none') {
      const report = validateTrack(points, act.type, sensors ?? {});
      if (sensors?.mockLocation) report.flags.push('teleport_jump'); // mock loc escalates
      const user = await this.db.one<{ trust_score: number; status: string }>(
        'SELECT trust_score, status FROM users WHERE id=$1', [act.user_id]);

      const summarySql = `distance_m=$2::int, moving_time_s=$3::int,
        avg_pace_s_per_km = CASE WHEN $2::int > 0 THEN (($3::int)::float / (($2::int)::float/1000))::int ELSE NULL END,
        validation_flags=$4::jsonb, pipeline_stage='validated'`;

      if (report.verdict === 'rejected') {
        await this.db.query(`UPDATE activities SET status='rejected', ${summarySql} WHERE id=$1`,
          [activityId, Math.round(report.metrics.distanceM), Math.round(report.metrics.movingTimeS),
           JSON.stringify(report.flags)]);
        await this.bumpTrust(act.user_id, -3, 'activity_rejected', activityId);
        return;
      }
      // Flagged (or low-trust user): territory withheld, human review queued.
      // Reversibility comes from capture_events, so approve-later replays cleanly.
      if (report.verdict === 'flagged' || (user?.trust_score ?? 100) < 40) {
        await this.db.query(`UPDATE activities SET status='flagged', ${summarySql} WHERE id=$1`,
          [activityId, Math.round(report.metrics.distanceM), Math.round(report.metrics.movingTimeS),
           JSON.stringify(report.flags)]);
        await this.db.query(
          `INSERT INTO fraud_reviews(activity_id, user_id, flags) VALUES ($1,$2,$3::jsonb)`,
          [activityId, act.user_id, JSON.stringify(report.flags)]);
        await this.bumpTrust(act.user_id, -5, 'activity_flagged', activityId);
        return;
      }
      await this.db.query(`UPDATE activities SET status='validated', ${summarySql} WHERE id=$1`,
        [activityId, Math.round(report.metrics.distanceM), Math.round(report.metrics.movingTimeS),
         JSON.stringify(report.flags)]);
      await this.bumpTrust(act.user_id, +1, 'activity_validated', activityId);
      cleanPoints = report.cleanPoints;
      act.pipeline_stage = 'validated';
    }

    // ── Stage 2: capture ─────────────────────────────────────────────────────
    if (act.pipeline_stage === 'validated') {
      const isImport = act.source.startsWith('import');
      const shadowBanned = (await this.db.one<{ status: string }>(
        'SELECT status FROM users WHERE id=$1', [act.user_id]))?.status === 'shadow_banned';

      const result = computeCapture(cleanPoints, isImport ? TUNING.IMPORT_BUDGET_MULTIPLIER : 1);
      const changed: Array<{ h3: string; kind: string }> = [];
      let claimed = 0, stolen = 0, refreshed = 0;

      if (!shadowBanned) {
        // Chunked transactions: bounded lock scope, resumable via capture_events dedup below.
        const CHUNK = 200;
        for (let i = 0; i < result.cells.length; i += CHUNK) {
          const slice = result.cells.slice(i, i + CHUNK);
          await this.db.tx(async (c) => {
            for (const cell of slice) {
              const h9 = h3ToBigint(cell.h3);
              const existing = await c.query(
                `SELECT owner_user_id, strength,
                        extract(epoch from last_refreshed_at)*1000 AS refreshed_ms
                 FROM hex_states WHERE season_id=$1 AND h3_r9=$2 FOR UPDATE`,
                [act.season_id, h9]);
              const row = existing.rows[0];
              const outcome = resolveOwnership(
                row ? { ownerUserId: row.owner_user_id, strength: row.strength, lastRefreshedAtMs: Number(row.refreshed_ms) } : null,
                act.user_id, ATTACKER_POWER_BASE, Date.now());
              if (outcome === 'defended') continue;

              // dedup guard for resumed jobs: skip if this activity already logged this hex
              const dup = await c.query(
                'SELECT 1 FROM capture_events WHERE activity_id=$1 AND h3_r9=$2 LIMIT 1', [activityId, h9]);
              if (dup.rowCount) continue;

              const kind = outcome === 'claim' ? 'claim' : outcome === 'refresh' ? 'refresh' : 'steal';
              await c.query(
                `INSERT INTO hex_states(season_id, h3_r9, owner_user_id, strength, captured_at,
                                        last_refreshed_at, h3_r7, h3_r5)
                 VALUES ($1,$2,$3,$4,now(),now(),$5,$6)
                 ON CONFLICT (season_id, h3_r9) DO UPDATE SET
                   owner_user_id=EXCLUDED.owner_user_id, strength=EXCLUDED.strength,
                   last_refreshed_at=now(),
                   captured_at = CASE WHEN hex_states.owner_user_id IS DISTINCT FROM EXCLUDED.owner_user_id
                                      THEN now() ELSE hex_states.captured_at END,
                   capture_count = hex_states.capture_count + CASE WHEN $7 = 'refresh' THEN 0 ELSE 1 END`,
                [act.season_id, h9, act.user_id, TUNING.STRENGTH_ON_CAPTURE,
                 h3ToBigint(cellToParent(cell.h3, 7)), h3ToBigint(cellToParent(cell.h3, 5)), kind]);
              await c.query(
                `INSERT INTO capture_events(season_id, h3_r9, activity_id, kind,
                                            prev_owner_user_id, new_owner_user_id)
                 VALUES ($1,$2,$3,$4,$5,$6)`,
                [act.season_id, h9, activityId, kind, row?.owner_user_id ?? null, act.user_id]);
              if (kind === 'claim') claimed++; else if (kind === 'steal') stolen++; else refreshed++;
              changed.push({ h3: cell.h3, kind });
            }
          });
        }
      }

      await this.db.query(
        `UPDATE activities SET pipeline_stage='captured', hexes_claimed=$2, hexes_stolen=$3,
           hexes_refreshed=$4, polyline=$5 WHERE id=$1`,
        [activityId, claimed, stolen, refreshed, encodePolylineLite(cleanPoints)]);
      act.pipeline_stage = 'captured';

      // ── Stage 4-lite: fanout ──────────────────────────────────────────────
      if (changed.length) {
        const user = await this.db.one<{ handle: string; color: string }>(
          'SELECT handle, color FROM users WHERE id=$1', [act.user_id]);
        await this.broadcaster.publishTerritoryDeltas(act.season_id, act.user_id, user!, changed);
      }
      await this.broadcaster.publishActivityResult(act.user_id, {
        activity_id: activityId, hexes_claimed: claimed, hexes_stolen: stolen, hexes_refreshed: refreshed,
      });
      await this.db.query(`UPDATE activities SET pipeline_stage='fanned_out' WHERE id=$1`, [activityId]);
      this.log.log(`ingested ${activityId}: +${claimed} claim, +${stolen} steal, ${refreshed} refresh`);
    }
  }

  private async bumpTrust(userId: string, delta: number, reason: string, refId: string) {
    await this.db.query(
      `UPDATE users SET trust_score = LEAST(100, GREATEST(0, trust_score + $2)) WHERE id=$1`,
      [userId, delta]);
    await this.db.query(
      `INSERT INTO trust_events(user_id, delta, reason, ref_id) VALUES ($1,$2,$3,$4)`,
      [userId, delta, reason, refId]);
  }
}

/** Compact lat,lng;... polyline for the feed (Google-encoded polyline lands with the mobile client). */
function encodePolylineLite(points: TrackPoint[]): string {
  const step = Math.max(1, Math.floor(points.length / 200));
  return points.filter((_, i) => i % step === 0)
    .map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join(';');
}
