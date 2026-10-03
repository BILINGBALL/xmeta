import pg from 'pg';
import { config } from '../config.js';

/**
 * 建库脚本。连到实例上的 postgres 库，把目标库建出来。
 * 只建库，不碰任何已有数据。
 */
async function main(): Promise<void> {
  const url = new URL(config.DATABASE_URL);
  const targetDb = decodeURIComponent(url.pathname.replace(/^\//, ''));

  if (!targetDb) {
    console.error('[xmeta] DATABASE_URL 里没有库名，无法确定要创建哪个库');
    process.exit(1);
  }

  // 换到 admin 库上去执行 create database
  url.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: url.toString() });

  await admin.connect();
  try {
    const exists = await admin.query('select 1 from pg_database where datname = $1', [targetDb]);
    if ((exists.rowCount ?? 0) > 0) {
      console.log(`[xmeta] 库 ${targetDb} 已存在，跳过`);
      return;
    }
    // 标识符不能参数化，只能自己转义
    const safe = `"${targetDb.replace(/"/g, '""')}"`;
    await admin.query(`create database ${safe} encoding 'UTF8'`);
    console.log(`[xmeta] 已创建库 ${targetDb}`);
  } finally {
    await admin.end();
  }
}

main().catch((err) => {
  console.error('[xmeta] 建库失败：', err);
  process.exit(1);
});
