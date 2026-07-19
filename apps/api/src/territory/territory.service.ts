import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { TUNING } from '@runverse/core';
import { DbService } from '../db/db.service';
import { REDIS } from '../redis/redis.module';
import { Problem } from '../common/problem';

const h3ToBigint = (h: string) => { 
  if (!/^[0-9a-f]{15}$/i.test(h)) throw new Problem(HttpStatus.BAD_REQUEST, 'H3_INVALID', `Bad H3 index: ${h}`);
  return BigInt('0x' + h);
};
const bigintToH3 = (b: string | bigint) => BigInt(b).toString(16);

@Injectable()
export class TerritoryService {
  constructor(private db: DbService, @Inject(REDIS) private redis: Redis) {}

  private async season(): Promise<number> {
    const s = await this.db.one<{ id: number }>(`SELECT id FROM seasons WHERE status='active' ORDER BY id DESC LIMIT 1`);
    return s?.id ?? 1;
  }

  /** ETag = joined per-cell version counters (bumped by the broadcaster on change). */
  async viewportEtag(cellsR5: string[]): Promise<string> {
    const season = await this.season();
    const vers = await this.redis.mget(cellsR5.map((c) => `viewport:${season}:${c}:ver`));
    return `W/"${season}:${cellsR5.map((c, i) => `${c}.${vers[i] ?? 0}`).join('|')}"`;
  }

  async viewport(cellsR5: string[]) {
    const season = await this.season();
    const rows = await this.db.query<any>(
      `SELECT h.h3_r9::text AS h3_num, h.strength, h.capture_count,
              extract(epoch from h.last_refreshed_at) AS refreshed_s,
              u.id AS owner_id, u.handle, u.color
       FROM hex_states h JOIN users u ON u.id = h.owner_user_id
       WHERE h.season_id=$1 AND h.h3_r5 = ANY($2::bigint[]) AND u.status='active'`,
      [season, cellsR5.map(h3ToBigint)]);
    const now = Date.now() / 1000;
    return rows.map((r) => ({
      h3: bigintToH3(r.h3_num),
      owner: { id: r.owner_id, handle: r.handle, color: r.color },
      strength_eff: Math.max(0, Math.round(r.strength - ((now - Number(r.refreshed_s)) / 86400) * TUNING.DECAY_PER_DAY)),
      contested: r.capture_count >= 3,
    })).filter((h) => h.strength_eff > 0);
  }

  async summary(userId: string) {
    const season = await this.season();
    const row = await this.db.one<any>(
      `SELECT count(*)::int AS hex_count,
              count(*) FILTER (WHERE strength - (extract(epoch from (now()-last_refreshed_at))/86400.0)*$3 < 25)::int AS at_risk
       FROM hex_states WHERE season_id=$1 AND owner_user_id=$2`,
      [season, userId, TUNING.DECAY_PER_DAY]);
    const hexCount = row?.hex_count ?? 0;
    return {
      hex_count: hexCount,
      decay_at_risk: row?.at_risk ?? 0,
      rank_title: rankTitle(hexCount),
    };
  }

  async hexDetail(h3: string) {
    const season = await this.season();
    const h9 = h3ToBigint(h3);
    const state = await this.db.one<any>(
      `SELECT u.handle, u.color, h.strength, h.captured_at, h.capture_count,
              extract(epoch from h.last_refreshed_at) AS refreshed_s
       FROM hex_states h JOIN users u ON u.id=h.owner_user_id
       WHERE h.season_id=$1 AND h.h3_r9=$2`, [season, h9]);
    const history = await this.db.query<any>(
      `SELECT kind, occurred_at,
              (SELECT handle FROM users WHERE id=e.new_owner_user_id) AS by
       FROM capture_events e WHERE season_id=$1 AND h3_r9=$2
       ORDER BY occurred_at DESC LIMIT 10`, [season, h9]);
    return { h3, state, history };
  }
}

/** Phase 1 rank ladder — hex-count tiers only; plurality titles (Governor+) need P2 rollups. */
function rankTitle(hexes: number): string | null {
  if (hexes >= 150) return 'area_captain';
  if (hexes >= 10) return 'street_owner';
  return null;
}
