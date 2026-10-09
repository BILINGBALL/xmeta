import { buildApp } from './app.js';
import { realDeps } from './deps.js';
import { config } from './config.js';
import { pool } from './db.js';
import { getActiveKey } from './lib/jwt.js';
import { cleanupExpired, cleanupToyData } from './repos.js';
import { runMigrations } from './scripts/migrate.js';

async function main(): Promise<void> {
  // 迁移是幂等的，启动时顺手跑一遍，省得部署时漏步骤
  await runMigrations();
  await getActiveKey();
  console.log('[xmeta] 签名密钥就绪');

  const app = await buildApp();

  await app.listen({ host: config.HOST, port: config.PORT });
  console.log(`[xmeta] 监听 http://${config.HOST}:${config.PORT}`);

  const cleanupTimer = setInterval(
    () => {
      Promise.all([cleanupExpired(), cleanupToyData()])
        .then(([r, data]) => {
          if (r.codes || r.claims || data) {
            console.log(
              `[xmeta] 清理过期授权码 ${r.codes} 条 / 认领 ${r.claims} 条 / 联机数据 ${data} 格`,
            );
          }
        })
        .catch((err) => console.error('[xmeta] 清理失败：', err));
    },
    30 * 60 * 1000,
  );
  cleanupTimer.unref();

  const shutdown = async (signal: string) => {
    console.log(`[xmeta] 收到 ${signal}，正在关闭…`);
    clearInterval(cleanupTimer);
    try {
      await app.close();
      await pool.end();
      await realDeps.cache.close();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[xmeta] 启动失败：', err);
  process.exit(1);
});
