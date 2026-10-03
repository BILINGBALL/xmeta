import type { FastifyInstance } from 'fastify';
import { Errors } from '../errors.js';
import { introspectSchema, parse } from '../http.js';
import { verifyToken } from '../lib/jwt.js';
import { rateLimit } from '../lib/ratelimit.js';
import { getRevocation } from '../repos.js';

/**
 * 查一枚 token 还有效吗。纯查询，不改状态。
 *
 * 为什么需要它：JWT 是自包含的，接入方本地验签只能验出「签名对、
 * 没过期」，**验不出用户后来手动失活了**。
 *
 * 所以有两种用法，接入方自己选：
 *   - 只要本地验签：省一次网络调用，代价是失活最多滞后到 token 过期
 *   - 每次用之前调一下这里：失活立即生效
 *
 * 因为 token 最长 24 小时，前者最坏也就滞后那么久。需要强一致的
 * 场景（比如联机的写操作）用后者。
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

    // 失活判断：token 的签发时刻早于失活时间点，就作废。
    // 这就是「记时间点而不是记令牌清单」的用法。
    const revocation = await getRevocation(uid, String(audience));
    if (revocation && payload.iat * 1000 < revocation.revoked_at.getTime()) {
      return { active: false, reason: 'revoked' };
    }

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
