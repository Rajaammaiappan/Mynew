/** Raw point-stream storage. Dev: local FS. Prod: S3 adapter behind the same interface. */
import { Injectable } from '@nestjs/common';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { TrackPoint } from '@runverse/core';
import { CONFIG } from '../config';

@Injectable()
export class StreamStore {
  constructor() { mkdirSync(CONFIG.streamDir, { recursive: true }); }

  put(activityId: string, points: TrackPoint[]): string {
    const path = join(CONFIG.streamDir, `${activityId}.json.gz`);
    writeFileSync(path, gzipSync(JSON.stringify(points)));
    return CONFIG.streamBucket ? `${CONFIG.streamBucket}/${activityId}.json.gz` : `file://${path}`;
  }

  get(activityId: string): TrackPoint[] | null {
    const path = join(CONFIG.streamDir, `${activityId}.json.gz`);
    if (!existsSync(path)) return null;
    return JSON.parse(gunzipSync(readFileSync(path)).toString());
  }
}
