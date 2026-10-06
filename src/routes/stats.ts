import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Errors } from '../errors.js';
import { rateLimit } from '../lib/ratelimit.js';
import { getStats } from '../repos.js';

/**
 * 服务统计。**公开只读** —— 返回的全是聚合数字，没有任何用户信息。
 *
 *   GET /api/stats →
 *   { toys, users, toyServices, tokens, guardSeconds }
 *
 * 各个数的口径见 repos.ts 的 Stats 注释。
 */
export async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/stats', async (req: FastifyRequest) => {
    // 公开接口，挡一下刷量。统计本来就是低频读的，60/分钟绰绰有余。
    const rl = rateLimit(`stats:${req.ip}`, 60, 60_000);
    if (!rl.ok) throw Errors.rateLimited(rl.retryAfter);

    return getStats();
  });
}
