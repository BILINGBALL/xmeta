import { buildApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
import { getActiveKey } from './lib/jwt.js';
import { cleanupExpired } from './repos.js';
import { runMigrations } from './scripts/migrate.js';

async function main(): Promise<void> {
  // 迁移是幂等的，启动时顺手跑一遍，省得部署时漏步骤
  await runMigrations();
  await getActiveKey();
  console.log('[ucs] 签名密钥就绪');

  const app = await buildApp();

  await app.listen({ host: config.HOST, port: config.PORT });
  console.log(`[ucs] 监听 http://${config.HOST}:${config.PORT}`);

  const cleanupTimer = setInterval(
    () => {
      cleanupExpired()
        .then((r) => {
          if (r.codes || r.claims) {
            console.log(`[ucs] 清理过期授权码 ${r.codes} 条 / 认领 ${r.claims} 条`);
          }
        })
        .catch((err) => console.error('[ucs] 清理失败：', err));
    },
    30 * 60 * 1000,
  );
  cleanupTimer.unref();

  const shutdown = async (signal: string) => {
    console.log(`[ucs] 收到 ${signal}，正在关闭…`);
    clearInterval(cleanupTimer);
    try {
      await app.close();
      await pool.end();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[ucs] 启动失败：', err);
  process.exit(1);
});
