import pg from 'pg';
import { config } from './config.js';

// bigint(int8) 默认已经被 pg 解析成 string，正是我们要的：避免 JS number 精度丢失。
const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
});

pool.on('error', (err) => {
  console.error('[ucs] 空闲连接异常：', err);
});

export type QueryParam = unknown;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: QueryParam[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

/** 取单行，没有则返回 null */
export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: QueryParam[] = [],
): Promise<T | null> {
  const res = await pool.query<T>(text, params);
  return res.rows[0] ?? null;
}

/**
 * 在事务里跑一段逻辑。回调收到的是同一个 client，务必用它发 SQL。
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
