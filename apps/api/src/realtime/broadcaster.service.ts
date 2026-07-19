/**
 * Publishes world events to Redis; gateways (any instance) route to subscribed sockets.
 * Channel per res-5 cell keeps fanout regional (Architecture §3.4).
 */
import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { cellToParent } from 'h3-js';
import { REDIS } from '../redis/redis.module';

export const CELL_CHANNEL = (r5: string) => `rt:cell:${r5}`;
export const USER_CHANNEL = (userId: string) => `rt:user:${userId}`;

@Injectable()
export class Broadcaster {
  constructor(@Inject(REDIS) private redis: Redis) {}

  async publishTerritoryDeltas(
    season: number,
    userId: string,
    owner: { handle: string; color: string },
    changed: Array<{ h3: string; kind: string }>,
  ) {
    const byCell = new Map<string, Array<{ h3: string; kind: string }>>();
    for (const c of changed) {
      const r5 = cellToParent(c.h3, 5);
      if (!byCell.has(r5)) byCell.set(r5, []);
      byCell.get(r5)!.push(c);
    }
    const pipe = this.redis.pipeline();
    for (const [r5, cells] of byCell) {
      pipe.publish(CELL_CHANNEL(r5), JSON.stringify({
        type: 'territory.delta', cell_r5: r5, season,
        changes: cells.map((c) => ({ h3: c.h3, kind: c.kind, strength: 100,
          owner: { id: userId, handle: owner.handle, color: owner.color } })),
      }));
      pipe.incr(`viewport:${season}:${r5}:ver`); // ETag invalidation
    }
    await pipe.exec();
  }

  async publishActivityResult(userId: string, payload: Record<string, unknown>) {
    await this.redis.publish(USER_CHANNEL(userId), JSON.stringify({ type: 'activity.result', ...payload }));
  }
}
