import { Pool } from 'pg';
export class PostgresAdapter {
    pool;
    constructor(opts) {
        this.pool = new Pool(opts);
    }
    async connect() {
        const client = await this.pool.connect();
        return {
            query: (sql, params) => client
                .query(sql, params)
                .then((res) => ({ rows: res.rows })),
            release: () => client.release(),
        };
    }
    async disconnect() {
        await this.pool.end();
    }
}
