import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config, DEFAULT_TOKEN_TTL_HOURS } from '../config.js';
import { Errors } from '../errors.js';
import { bridgeAuthorizeSchema, parse } from '../http.js';
import { normalizeIconUrl } from '../lib/bili.js';
import { randomToken } from '../lib/ids.js';
import { rateLimit } from '../lib/ratelimit.js';
import { getClient, getToyById, insertAuthCode, upsertUser } from '../repos.js';

/**
 * Phase 1 —— 用户过桥。
 *
 * 第三方 toy 带着自己的 client_id 把用户送到我的 toy；
 * 用户在这里同意授权后，我发一个一次性 code，用户带着 code 回到原 toy。
 *
 * 关键点：
 *  - 回跳的目标 slug 一律从库里按 client_id 查，绝不取 URL 里的参数（防开放重定向）。
 *  - code 而不是 JWT 进 URL。B站 shell 会把 query 原样转发给内层 iframe，
 *    query 会进日志和浏览器历史，不能放长期凭证。
 *  - **没有 PKCE**：code 60 秒命、一次性、只对签发它的 toy 有效。
 *    这么点体量的玩具不值得让接入方去理解 verifier/challenge。
 */

export async function bridgeRoutes(app: FastifyInstance): Promise<void> {
  /** 过桥页加载时用：确认这个 client_id 有效，拿到要展示的 toy 信息 */
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
      // 旧数据里可能存了 http:// 的图标，toy 页面跑在 https 上会被拦。
      // 这里统一升一下级，不用改库。
      iconUrl: normalizeIconUrl(toy.icon_url),
      authorName: toy.author_name,
      authorMid: toy.author_mid,
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

    // 来源必须是这枚 client_id 自己的 toy。
    //
    // client_id 本来就不保密（它会出现在跳转链接里），所以抄走别人包体的人
    // 照样能把流程跑起来。他唯一改不了的是：平台在跳转时会在地址上盖章
    // 「这一跳来自哪个 toy」—— App 内是原生的 from_spmid，Web 端是 SDK 用
    // 当前玩具 id 拼的 spm_id_from。授权页把那个 id 原样报上来，这里一比就知道
    // 「他在替谁要凭证」和「他自己是谁」对不上。
    //
    // 抄的人连原 toy 的 id 都不知道（更别说伪造），所以这道能把他挡在门外。
    if (body.fromToyId !== toy.toy_id) throw Errors.sourceToyMismatch();

    const user = await upsertUser({
      toyOpenId: body.toyOpenId,
      nickname: body.nickname ?? null,
      avatar: body.avatar ?? null,
    });

    const code = randomToken(32);
    // 用户选的授权时长。没选（比如老版本前端）就按默认值走。
    const ttlHours = body.ttl ?? DEFAULT_TOKEN_TTL_HOURS;

    await insertAuthCode({
      code,
      uid: user.id,
      clientId: client.client_id,
      codeTtlSeconds: config.AUTH_CODE_TTL_SECONDS,
      tokenTtlSeconds: ttlHours * 3600,
    });

    return {
      code,
      /** 回跳目标由服务端决定，前端拿它去 toy.navigate */
      returnSlug: toy.slug,
      returnToyTitle: toy.title,
      expiresIn: config.AUTH_CODE_TTL_SECONDS,
      /** 这枚 code 换出来的 token 能活多久 */
      tokenTtlSeconds: ttlHours * 3600,
    };
  });
}
