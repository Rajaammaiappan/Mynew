import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { CONFIG } from '../config';

@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: CONFIG.databaseUrl, max: 20 });

  async query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pool.query<T>(text, params as any[]);
    return res.rows;
  }

  async one<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(text, params);
    return rows[0] ?? null;
  }

  /** Serializable-enough transactions: run fn with a dedicated client. */
  async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  onModuleDestroy() {
    return this.pool.end();
  }
}
