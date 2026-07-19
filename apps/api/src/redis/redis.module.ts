import { Global, Module } from '@nestjs/common';
import Redis from 'ioredis';
import { CONFIG } from '../config';

export const REDIS = 'REDIS';
export const REDIS_SUB = 'REDIS_SUB';

@Global()
@Module({
  providers: [
    { provide: REDIS, useFactory: () => new Redis(CONFIG.redisUrl, { maxRetriesPerRequest: null }) },
    { provide: REDIS_SUB, useFactory: () => new Redis(CONFIG.redisUrl, { maxRetriesPerRequest: null }) },
  ],
  exports: [REDIS, REDIS_SUB],
})
export class RedisModule {}
