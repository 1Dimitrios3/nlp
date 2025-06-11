export interface DBClient {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
  release(): void;
}

export interface IDatabase {
  connect(): Promise<DBClient>;
  disconnect(): Promise<void>;
}
