import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { Errors } from '../errors.js';
import { parse, tokenSchema } from '../http.js';
import { newUuid, randomToken, sha256Hex } from '../lib/ids.js';
import { issueToken } from '../lib/jwt.js';
import { verifyChallenge } from '../lib/pkce.js';
import { rateLimit } from '../lib/ratelimit.js';
import {
  consumeAuthCode,
  consumeRefreshToken,
  getClient,
  getRefreshToken,
  getToyById,
  insertRefreshToken,
  peekAuthCode,
  recordUsage,
  revokeRefreshFamily,
} from '../repos.js';

/**
 * Phase 2 —— 换 token。两种授权类型：
 *
 *   authorization_code  过桥回来的第一次，用一次性 code + PKCE 换
 *   refresh_token       access_token 过期后静默续期，用户无感
 *
 * 刷新令牌每次使用都轮换：发新的、废旧的。已经用过的又出现，
 * 说明它被复制走了 —— 整条链作废，两边都得重新过桥。
 *
 * 注意：code 是先被消费掉再校验 PKCE 的。这是故意的——
 * 校验失败就把 code 烧掉，避免拿它反复猜 code_verifier。
 */

type PairInput = {
  uid: string;
  clientId: string;
  toyId: string;
  /** 续期时传入原链的 id；首次授权不传，会新建一条 */
  familyId?: string;
};

type TokenPair = {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_expires_in: number;
};

async function issuePair(input: PairInput): Promise<TokenPair> {
  const access = await issueToken({ uid: input.uid, audience: input.toyId });

  const refresh = randomToken(32);
  await insertRefreshToken({
    tokenHash: sha256Hex(refresh),
    uid: input.uid,
    clientId: input.clientId,
    familyId: input.familyId ?? newUuid(),
    ttlDays: config.REFRESH_TTL_DAYS,
  });

  return {
    access_token: access.accessToken,
    refresh_token: refresh,
    token_type: 'Bearer',
    expires_in: access.expiresIn,
    refresh_expires_in: config.REFRESH_TTL_DAYS * 24 * 60 * 60,
  };
}

export async function tokenRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/oauth/token', async (req) => {
    // 刷新是高频操作（每个活跃用户每 TTL 一次），额度给宽一点。
    const rl = rateLimit(`token:${req.ip}`, 120, 60_000);
    if (!rl.ok) throw Errors.rateLimited(rl.retryAfter);

    const body = parse(tokenSchema, req.body);

    // ─────────────────────────────────────────────
    // 首次授权：一次性 code + PKCE
    // ─────────────────────────────────────────────
    if (body.grant_type === 'authorization_code') {
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

      // 记一次使用记录。这是统计，不该因为它写失败就把已经签好的
      // token 吞掉 —— 用户那边是无感的，这里退化成少记一次。
      try {
        await recordUsage(row.uid, toy.toy_id);
      } catch (err) {
        req.log.error({ err }, 'recordUsage 失败');
      }

      const pair = await issuePair({
        uid: row.uid,
        clientId: client.client_id,
        toyId: toy.toy_id,
      });

      return {
        ...pair,
        // 方便接入方自检：这个 token 只对下面这个 toy 有效
        audience: toy.toy_id,
        toy_slug: toy.slug,
        state: row.state,
      };
    }

    // ─────────────────────────────────────────────
    // 续期：刷新令牌轮换
    // ─────────────────────────────────────────────
    const presentedHash = sha256Hex(body.refresh_token);
    const found = await getRefreshToken(presentedHash);
    if (!found) throw Errors.invalidGrant();

    // 绑定校验：给 A 的令牌换不出 B 的 token
    if (found.client_id !== body.client_id) throw Errors.invalidGrant();

    // 被作废有两种来路：用户主动登出，或者检测到重放后整条链被清算。
    // 对客户端都是「这个会话没了，重新授权」，所以合成一个码。
    if (found.revoked_at) throw Errors.refreshTokenRevoked();
    if (found.expires_at.getTime() <= Date.now()) throw Errors.refreshTokenExpired();

    if (found.used_at) {
      // 用过的令牌又出现 —— 大概率是被复制了。
      // 分不清哪个是窃取者，整条链一起作废。
      const killed = await revokeRefreshFamily(found.family_id);
      req.log.warn(
        { uid: found.uid, clientId: found.client_id, familyId: found.family_id, killed },
        '刷新令牌被重复使用，已作废整条链',
      );
      throw Errors.refreshTokenReused();
    }

    // 原子消费。并发下只有一个能抢到，没抢到的按重用处理。
    const consumed = await consumeRefreshToken(presentedHash);
    if (!consumed) {
      await revokeRefreshFamily(found.family_id);
      throw Errors.refreshTokenReused();
    }

    const client = await getClient(consumed.client_id);
    if (!client || client.revoked_at) throw Errors.clientNotFound();

    const toy = await getToyById(client.toy_id);
    if (!toy) throw Errors.clientNotFound();
    if (toy.state !== 'verified') throw Errors.toyNotVerified();

    const pair = await issuePair({
      uid: consumed.uid,
      clientId: consumed.client_id,
      toyId: toy.toy_id,
      familyId: consumed.family_id, // 沿用同一条链
    });

    return { ...pair, audience: toy.toy_id, toy_slug: toy.slug };
  });
}
