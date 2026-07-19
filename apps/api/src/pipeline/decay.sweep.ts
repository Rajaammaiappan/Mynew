/**
 * Nightly decay sweep (03:30 IST): neutralize hexes whose effective strength hit 0,
 * emitting decay_loss events. Effective strength on reads stays lazy — this job only
 * finalizes deaths so leaderboards/rollups don't count ghost territory.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TUNING } from '@runverse/core';
import { DbService } from '../db/db.service';

@Injectable()
export class DecaySweep {
  private readonly log = new Logger('decay');
  constructor(private db: DbService) {}

  @Cron('30 3 * * *', { timeZone: 'Asia/Kolkata' })
  async sweep() {
    const rows = await this.db.query<{ n: string }>(
      `WITH dead AS (
         DELETE FROM hex_states
         WHERE strength - (extract(epoch from (now() - last_refreshed_at)) / 86400.0) * $1 <= 0
         RETURNING season_id, h3_r9, owner_user_id
       ), logged AS (
         INSERT INTO capture_events(season_id, h3_r9, kind, prev_owner_user_id)
         SELECT season_id, h3_r9, 'decay_loss', owner_user_id FROM dead
         RETURNING 1
       ) SELECT count(*)::text AS n FROM logged`,
      [TUNING.DECAY_PER_DAY]);
    this.log.log(`decay sweep: ${rows[0]?.n ?? 0} hexes returned to neutral`);
  }
}
