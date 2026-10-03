import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { Errors } from '../errors.js';
import { bridgeAuthorizeSchema, parse } from '../http.js';
import { randomToken } from '../lib/ids.js';
import { rateLimit } from '../lib/ratelimit.js';
import { getClient, getToyById, insertAuthCode, upsertUser } from '../repos.js';

/**
 * Phase 1 —— 用户过桥。
 *
 * 第三方 toy 带着自己的 client_id + PKCE challenge 把用户送到我的 toy；
 * 用户在这里同意授权后，我发一个一次性 code，用户带着 code 回到原 toy。
 *
 * 关键点：
 *  - 回跳的目标 slug 一律从库里按 client_id 查，绝不取 URL 里的参数（防开放重定向）。
 *  - code 而不是 JWT 进 URL。B站 shell 会把 query 原样转发给内层 iframe，
 *    query 会进日志和浏览器历史，不能放长期凭证。
 */

export async function bridgeRoutes(app: FastifyInstance): Promise<void> {
  /** 过桥页加载时用：确认这个 client_id 有效，拿到要展示的玩具信息 */
  app.get('/api/bridge/context', async (req: FastifyRequest) => {
    const rl = rateLimit(`bridge:ctx:${req.ip}`, 120, 60_000);
    if (!rl.ok) throw Errors.rateLimited(rl.retryAfter);

    const cid = (req.query as Record<string, unknown> | undefined)?.cid;
    if (typeof cid !== 'string' || !cid) {
      throw Errors.invalidParam('缺少 cid');
    }

    const client = await getClient(cid);
    if (!client || client.revoked_at) throw Errors.clientNotFound();

    const toy = await getToyById(client.toy_id);
    if (!toy) throw Errors.clientNotFound();
    if (toy.state !== 'verified') throw Errors.toyNotVerified();

    return {
      clientId: client.client_id,
      toyId: toy.toy_id,
      slug: toy.slug,
      title: toy.title,
      iconUrl: toy.icon_url,
      authorName: toy.author_name,
      ttlSeconds: config.AUTH_CODE_TTL_SECONDS,
    };
  });

  /** 用户在过桥页点了「开始授权」之后调用，body 里带 getUserProfile 的结果 */
  app.post('/api/bridge/authorize', async (req) => {
    const rl = rateLimit(`bridge:auth:${req.ip}`, 30, 60_000);
    if (!rl.ok) throw Errors.rateLimited(rl.retryAfter);

    const body = parse(bridgeAuthorizeSchema, req.body);

    const client = await getClient(body.cid);
    if (!client || client.revoked_at) throw Errors.clientNotFound();

    const toy = await getToyById(client.toy_id);
    if (!toy) throw Errors.clientNotFound();
    if (toy.state !== 'verified') throw Errors.toyNotVerified();

    const user = await upsertUser({
      toyOpenId: body.toyOpenId,
      nickname: body.nickname ?? null,
      avatar: body.avatar ?? null,
    });

    const code = randomToken(32);
    const challenge = body.cc ?? null;

    await insertAuthCode({
      code,
      uid: user.id,
      clientId: client.client_id,
      codeChallenge: challenge,
      codeChallengeMethod: challenge ? 'S256' : null,
      state: body.st ?? null,
      ttlSeconds: config.AUTH_CODE_TTL_SECONDS,
    });

    return {
      code,
      /** 回跳目标由服务端决定，前端拿它去 toy.navigate */
      returnSlug: toy.slug,
      returnToyTitle: toy.title,
      state: body.st ?? null,
      expiresIn: config.AUTH_CODE_TTL_SECONDS,
    };
  });
}
