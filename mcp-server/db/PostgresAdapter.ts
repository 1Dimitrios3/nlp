import { Pool, PoolClient, QueryResult, PoolConfig } from 'pg';
import type { DBClient, IDatabase } from './types.js';

export class PostgresAdapter implements IDatabase {
  private pool: Pool;

   constructor(opts: PoolConfig) {
    this.pool = new Pool(opts);
  }

  async connect(): Promise<DBClient> {
    const client: PoolClient = await this.pool.connect();
    return {
      query: (sql, params) =>
        client
          .query(sql, params)
          .then((res: QueryResult<any>) => ({ rows: res.rows })),
      release: () => client.release(),
    };
  }

  async disconnect(): Promise<void> {
    await this.pool.end();
  }
}
