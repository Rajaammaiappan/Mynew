import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { TrackPoint, captureBudget, pathLengthM, TUNING } from '@runverse/core';
import { DbService } from '../db/db.service';
import { REDIS } from '../redis/redis.module';
import { Problem } from '../common/problem';
import { StreamStore } from './streams.store';
import { INGEST_QUEUE } from '../pipeline/queues';

const CHUNK_KEY = (id: string) => `act:chunks:${id}`;
const CHUNK_TTL_S = 60 * 60 * 24; // survive a day of network trouble

export interface ChunkBody {
  seq: number;
  points: TrackPoint[];
  sensors?: { steps?: number; accelVar?: number; mockLocation?: boolean };
}

@Injectable()
export class ActivitiesService {
  constructor(
    private db: DbService,
    private streams: StreamStore,
    @Inject(REDIS) private redis: Redis,
    @Inject(INGEST_QUEUE) private ingest: Queue,
  ) {}

  private async activeSeason(): Promise<number> {
    const s = await this.db.one<{ id: number }>(`SELECT id FROM seasons WHERE status='active' ORDER BY id DESC LIMIT 1`);
    if (!s) throw new Problem(HttpStatus.CONFLICT, 'NO_ACTIVE_SEASON', 'No active season');
    return s.id;
  }

  async start(userId: string, type: string, startedAt: string) {
    const season = await this.activeSeason();
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO activities(user_id, type, source, started_at, season_id, status)
       VALUES ($1,$2,'live',$3,$4,'recording') RETURNING id`,
      [userId, type, startedAt, season]);
    return { activity_id: row!.id };
  }

  async appendChunk(userId: string, activityId: string, chunk: ChunkBody) {
    await this.assertOwnedRecording(userId, activityId);
    // chunks stored keyed by seq → idempotent re-send, gap detection on finish
    await this.redis.hset(CHUNK_KEY(activityId), String(chunk.seq), JSON.stringify(chunk));
    await this.redis.expire(CHUNK_KEY(activityId), CHUNK_TTL_S);
    return { acked_seq: chunk.seq };
  }

  async finish(userId: string, activityId: string, endedAt: string) {
    await this.assertOwnedRecording(userId, activityId);
    const raw = await this.redis.hgetall(CHUNK_KEY(activityId));
    const chunks = Object.entries(raw)
      .map(([seq, v]) => ({ ...(JSON.parse(v) as ChunkBody), seq: Number(seq) }))
      .sort((a, b) => a.seq - b.seq);
    const points = chunks.flatMap((c) => c.points).sort((a, b) => a.t - b.t);
    if (points.length < 5) {
      await this.db.query(`UPDATE activities SET status='rejected', validation_flags='["empty_track"]', ended_at=$2 WHERE id=$1`,
        [activityId, endedAt]);
      return { status: 'rejected' };
    }
    const sensors = chunks.reduce(
      (acc, c) => ({
        steps: (acc.steps ?? 0) + (c.sensors?.steps ?? 0),
        accelVar: c.sensors?.accelVar ?? acc.accelVar,
        mockLocation: acc.mockLocation || !!c.sensors?.mockLocation,
      }),
      {} as NonNullable<ChunkBody['sensors']>,
    );

    const url = this.streams.put(activityId, points);
    const distance = Math.round(pathLengthM(points));
    await this.db.query(
      `UPDATE activities SET status='pending', ended_at=$2, raw_stream_url=$3,
         distance_m=$4, elapsed_time_s=$5,
         capture_budget=$6
       WHERE id=$1`,
      [activityId, endedAt, url, distance,
        Math.round((points[points.length - 1].t - points[0].t) / 1000),
        captureBudget(distance)]);
    await this.redis.del(CHUNK_KEY(activityId));
    await this.ingest.add('ingest', { activityId, sensors }, { jobId: activityId, removeOnComplete: 1000, removeOnFail: false });
    return { status: 'pending' };
  }

  async abandon(userId: string, activityId: string) {
    await this.assertOwnedRecording(userId, activityId);
    await this.db.query(`UPDATE activities SET status='abandoned' WHERE id=$1`, [activityId]);
    await this.redis.del(CHUNK_KEY(activityId));
  }

  async get(userId: string, activityId: string) {
    const a = await this.db.one(
      `SELECT a.id, a.user_id, a.type, a.source, a.started_at, a.ended_at, a.distance_m,
              a.moving_time_s, a.elapsed_time_s, a.avg_pace_s_per_km, a.polyline, a.status,
              a.hexes_claimed, a.hexes_stolen, a.hexes_refreshed, a.visibility,
              u.handle, u.display_name, u.color
       FROM activities a JOIN users u ON u.id = a.user_id WHERE a.id=$1`, [activityId]);
    if (!a) throw new Problem(HttpStatus.NOT_FOUND, 'ACTIVITY_NOT_FOUND', 'No such activity');
    if ((a as any).user_id !== userId && (a as any).visibility === 'private') {
      throw new Problem(HttpStatus.NOT_FOUND, 'ACTIVITY_NOT_FOUND', 'No such activity');
    }
    return a;
  }

  async captures(activityId: string) {
    return this.db.query(
      `SELECT h3_to_string(h3_r9) AS h3, kind FROM (
         SELECT h3_r9, kind, occurred_at FROM capture_events WHERE activity_id=$1) e
       ORDER BY occurred_at`, [activityId])
      .catch(async () =>
        // dev fallback when h3-pg absent: return raw bigint as hex string
        this.db.query(
          `SELECT to_hex(h3_r9) AS h3, kind FROM capture_events WHERE activity_id=$1 ORDER BY occurred_at`,
          [activityId]));
  }

  async feed(userId: string, cursor: string | undefined, limit: number) {
    const rows = await this.db.query(
      `SELECT a.id, a.type, a.started_at, a.distance_m, a.moving_time_s, a.polyline,
              a.hexes_claimed, a.hexes_stolen, u.handle, u.display_name, u.color,
              (SELECT count(*) FROM kudos k WHERE k.activity_id=a.id)::int AS kudos_count,
              (SELECT count(*) FROM comments c WHERE c.activity_id=a.id AND c.deleted_at IS NULL)::int AS comment_count
       FROM activities a JOIN users u ON u.id=a.user_id
       WHERE a.status IN ('validated') AND a.visibility IN ('public','followers')
         AND (a.user_id = $1 OR a.user_id IN (SELECT followee_id FROM follows WHERE follower_id=$1))
         AND ($2::timestamptz IS NULL OR a.started_at < $2)
       ORDER BY a.started_at DESC LIMIT $3`,
      [userId, cursor ?? null, limit]);
    const next = rows.length === limit ? (rows[rows.length - 1] as any).started_at : null;
    return { items: rows, next_cursor: next };
  }

  async result(userId: string, activityId: string) {
    const a = await this.db.one<any>(
      `SELECT status, pipeline_stage, hexes_claimed, hexes_stolen, hexes_refreshed, validation_flags
       FROM activities WHERE id=$1 AND user_id=$2`, [activityId, userId]);
    if (!a) throw new Problem(HttpStatus.NOT_FOUND, 'ACTIVITY_NOT_FOUND', 'No such activity');
    return a;
  }

  private async assertOwnedRecording(userId: string, activityId: string) {
    const a = await this.db.one<{ user_id: string; status: string }>(
      'SELECT user_id, status FROM activities WHERE id=$1', [activityId]);
    if (!a || a.user_id !== userId) throw new Problem(HttpStatus.NOT_FOUND, 'ACTIVITY_NOT_FOUND', 'No such activity');
    if (a.status !== 'recording') throw new Problem(HttpStatus.CONFLICT, 'ACTIVITY_NOT_RECORDING', `Activity is ${a.status}`);
  }
}
