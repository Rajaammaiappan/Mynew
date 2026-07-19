import { Queue } from 'bullmq';
import { CONFIG } from '../config';

export const INGEST_QUEUE = 'INGEST_QUEUE';

/** Plain options (not an ioredis instance): BullMQ bundles its own ioredis, so
 *  instance types don't unify across the two copies. Options are version-proof. */
export function ingestConnection() {
  const u = new URL(CONFIG.redisUrl);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    password: u.password || undefined,
    maxRetriesPerRequest: null as null,
  };
}

export const ingestQueueProvider = {
  provide: INGEST_QUEUE,
  useFactory: () =>
    new Queue('ingest', {
      connection: ingestConnection(),
      defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 2000 } },
    }),
};
