import type { FastifyInstance } from 'fastify';
import { DEFAULT_TOKEN_TTL_HOURS } from '../config.js';
import { Errors } from '../errors.js';
import { parse, tokenSchema } from '../http.js';
import { issueToken } from '../lib/jwt.js';
import { verifyChallenge } from '../lib/pkce.js';
import { rateLimit } from '../lib/ratelimit.js';
import {
  consumeAuthCode,
  getClient,
  getToyById,
  peekAuthCode,
  recordUsage,
} from '../repos.js';

/**
 * 用一次性 code + PKCE 换 JWT。
 *
 * token 的有效期由**用户在授权时自己选**（3/6/12/24 小时），存在
 * 授权码上带过来。所以这里是「按用户选的时长签发」，不是固定的
 * 全局 TTL —— 那个只作为兜底默认值。
 *
 * 没有刷新机制：过期了就回中心玩具重新授权一次。最长 24 小时，
 * 意味着每天都要回去一趟，这是刻意的节奏。
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

    // PKCE 必填。code 会进 URL（Web 端拼在 query 里），
    // 没有 code_verifier 的 code 形同裸奔，谁看到 URL 都能换。
    if (!row.code_challenge) throw Errors.invalidCode();
    if (!verifyChallenge(body.code_verifier, row.code_challenge, row.code_challenge_method)) {
      throw Errors.pkceMismatch();
    }

    const client = await getClient(row.client_id);
    if (!client || client.revoked_at) throw Errors.clientNotFound();

    const toy = await getToyById(client.toy_id);
    if (!toy) throw Errors.clientNotFound();
    if (toy.state !== 'verified') throw Errors.toyNotVerified();

    // 老数据（这次改动之前签发的 code）没有 ttl_seconds，按默认值处理
    const ttlSeconds = row.ttl_seconds ?? DEFAULT_TOKEN_TTL_HOURS * 3600;

    // 记一次使用记录。这是统计，不该因为它写失败就把已经签好的
    // token 吞掉 —— 用户那边是无感的，这里退化成少记一次。
    try {
      await recordUsage(row.uid, toy.toy_id);
    } catch (err) {
      req.log.error({ err }, 'recordUsage 失败');
    }

    const token = await issueToken({
      uid: row.uid,
      audience: toy.toy_id,
      ttlSeconds,
    });

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
