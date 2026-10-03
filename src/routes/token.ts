import type { FastifyInstance } from 'fastify';
import { Errors } from '../errors.js';
import { parse, tokenSchema } from '../http.js';
import { issueToken } from '../lib/jwt.js';
import { verifyChallenge } from '../lib/pkce.js';
import { rateLimit } from '../lib/ratelimit.js';
import { consumeAuthCode, getClient, getToyById, peekAuthCode, recordUsage } from '../repos.js';

/**
 * Phase 2 —— 用 code 换 JWT。
 *
 * 接入方可能是纯静态玩具（没有后端），所以：
 *  - 不要求 client_secret，用 PKCE 代替；
 *  - 签出来的 JWT 用非对称密钥，接入方只拿公钥验签，拿不到签发能力。
 *
 * 注意：code 是先被消费掉再校验 PKCE 的。这是故意的——
 * 校验失败就把 code 烧掉，避免拿它反复猜 code_verifier。
 */

export async function tokenRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/oauth/token', async (req) => {
    const rl = rateLimit(`token:${req.ip}`, 60, 60_000);
    if (!rl.ok) throw Errors.rateLimited(rl.retryAfter);

    const body = parse(tokenSchema, req.body);

    const row = await consumeAuthCode(body.code);
    if (!row) {
      // 区分「不存在 / 已用 / 已过期」只为给出更清楚的报错
      const existing = await peekAuthCode(body.code);
      if (!existing) throw Errors.invalidCode();
      if (existing.used_at) throw Errors.codeUsed();
      throw Errors.codeExpired();
    }

    if (row.client_id !== body.client_id) throw Errors.invalidCode();

    if (row.code_challenge) {
      if (!body.code_verifier) throw Errors.pkceMismatch();
      if (!verifyChallenge(body.code_verifier, row.code_challenge, row.code_challenge_method)) {
        throw Errors.pkceMismatch();
      }
    }

    const client = await getClient(row.client_id);
    if (!client || client.revoked_at) throw Errors.clientNotFound();

    const toy = await getToyById(client.toy_id);
    if (!toy) throw Errors.clientNotFound();
    if (toy.state !== 'verified') throw Errors.toyNotVerified();

    const token = await issueToken({ uid: row.uid, audience: toy.toy_id });

    // 记一次使用记录。这是统计，不该因为它写失败就把已经签好的
    // token 吞掉 —— 用户那边是无感的，这里退化成少记一次。
    try {
      await recordUsage(row.uid, toy.toy_id);
    } catch (err) {
      req.log.error({ err }, 'recordUsage 失败');
    }

    return {
      access_token: token.accessToken,
      token_type: 'Bearer' as const,
      expires_in: token.expiresIn,
      /** 方便接入方自检：这个 token 只对下面这个 toy 有效 */
      audience: toy.toy_id,
      toy_slug: toy.slug,
      state: row.state,
    };
  });
}
