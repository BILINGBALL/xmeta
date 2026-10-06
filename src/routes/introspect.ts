import type { FastifyInstance } from 'fastify';
import { Errors } from '../errors.js';
import { introspectSchema, parse } from '../http.js';
import { verifyToken } from '../lib/jwt.js';
import { rateLimit } from '../lib/ratelimit.js';

/**
 * 查一枚 token 还有效吗。纯查询，不改状态。
 *
 * JWT 是自包含的。这个端点让**收数据那边**在服务端再确认一次，
 * 拿到 uid / aud / 剩余时长 —— 前端不需要调它。
 */
export async function introspectRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/oauth/introspect', async (req) => {
    const rl = rateLimit(`introspect:${req.ip}`, 120, 60_000);
    if (!rl.ok) throw Errors.rateLimited(rl.retryAfter);

    const body = parse(introspectSchema, req.body);

    let payload;
    try {
      payload = await verifyToken(body.token);
    } catch {
      // 签名不对 / 已过期 / iss 不对 —— 统一按无效处理，不区分原因，
      // 否则这个端点就成了探针
      return { active: false };
    }

    const uid = payload.sub;
    const audience = payload.aud;
    if (!uid || !audience || !payload.iat) return { active: false };

    const now = Math.floor(Date.now() / 1000);
    return {
      active: true,
      uid,
      audience: String(audience),
      iat: payload.iat,
      exp: payload.exp ?? null,
      /** 还剩多少秒。接入方可以据此提示用户 */
      remaining: payload.exp ? Math.max(0, payload.exp - now) : null,
    };
  });
}
