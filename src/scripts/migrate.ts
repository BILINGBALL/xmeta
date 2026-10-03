import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, withTransaction } from '../db.js';

const SQL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../sql');

/**
 * 顺序执行 sql/*.sql，已执行过的记在 schema_migration 里跳过。
 * 用 advisory lock 保证多实例同时启动时只有一个在跑迁移。
 */
export async function runMigrations(): Promise<void> {
  const files = (await readdir(SQL_DIR)).filter((f) => f.endsWith('.sql')).sort();

  await withTransaction(async (client) => {
    await client.query(`select pg_advisory_xact_lock(hashtext('ucs:migrations'))`);
    await client.query(
      `create table if not exists schema_migration (
         name       text primary key,
         applied_at timestamptz not null default now()
       )`,
    );

    const done = await client.query<{ name: string }>(`select name from schema_migration`);
    const applied = new Set(done.rows.map((r) => r.name));

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(SQL_DIR, file), 'utf8');
      await client.query(sql);
      await client.query(`insert into schema_migration (name) values ($1)`, [file]);
      console.log(`[ucs] 已应用迁移 ${file}`);
    }
  });
}

// 允许 `npm run db:migrate` 单独跑
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  runMigrations()
    .then(() => {
      console.log('[ucs] 迁移完成');
      return pool.end();
    })
    .catch((err) => {
      console.error('[ucs] 迁移失败：', err);
      process.exit(1);
    });
}
