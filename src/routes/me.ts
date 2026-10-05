import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { Errors } from '../errors.js';
import { mineSchema, parse, revokeSchema } from '../http.js';
import { normalizeIconUrl } from '../lib/bili.js';
import { rateLimit } from '../lib/ratelimit.js';
import { getClient, getToyById, revokeTokensForToy } from '../repos.js';

/**
 * 个人中心的数据源 + 手动失活。
 *
 * `/api/me` 一次把页面要的东西全返回，减少往返 —— 页面本身会把结果
 * 缓存到 localStorage，正常情况下打开是秒出的，这个接口只在后台刷新时打。
 *
 * 身份未注册过时返回空壳而不是报错：用户第一次打开个人中心时本来就
 * 还没有记录，那不是错误。
 */

type UserRow = {
  id: string;
  nickname: string | null;
  avatar: string | null;
  created_at: Date;
};

type OwnedToyRow = {
  toy_id: string;
  slug: string;
  title: string | null;
  icon_url: string | null;
  author_mid: string | null;
  author_name: string | null;
  author_face: string | null;
  bili_version: number | null;
  state: string;
  owner_uid: string | null;
  synced_at: Date | null;
  verified_at: Date | null;
  client_id: string | null;
  client_revoked_at: Date | null;
  claim_nonce: string | null;
  claim_expires_at: Date | null;
  claim_attempts: number | null;
};

type UsageRow = {
  toy_id: string;
  slug: string;
  title: string | null;
  icon_url: string | null;
  author_mid: string | null;
  author_name: string | null;
  author_face: string | null;
  bili_version: number | null;
  state: string;
  owner_uid: string | null;
  synced_at: Date | null;
  client_id: string | null;
  last_used_at: Date;
  uses: number;
  revoked_at: Date | null;
};

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/me', async (req) => {
    const rl = rateLimit(`me:${req.ip}`, 60, 60_000);
    if (!rl.ok) throw Errors.rateLimited(rl.retryAfter);

    const body = parse(mineSchema, req.body);

    const user = await queryOne<UserRow>(
      `select id, nickname, avatar, created_at
         from app_user
        where home_toy_id = $1 and toy_open_id = $2`,
      [config.MY_TOY_ID, body.toyOpenId],
    );

    if (!user) {
      return { user: null, ownedToys: [], usage: [] };
    }

    // 作者视角：我认领了哪些 toy，附带还没完成的认领进度
    const owned = await query<OwnedToyRow>(
      `select t.toy_id, t.slug, t.title, t.icon_url, t.author_mid, t.author_name,
              t.author_face, t.bili_version, t.state, t.owner_uid, t.synced_at,
              t.verified_at,
              c.client_id, c.revoked_at as client_revoked_at,
              tc.nonce        as claim_nonce,
              tc.expires_at   as claim_expires_at,
              tc.attempts     as claim_attempts
         from toy t
         left join toy_client c on c.toy_id = t.toy_id
         left join lateral (
           select nonce, expires_at, attempts
             from toy_claim
            where toy_id = t.toy_id
              and state = 'pending'
              and expires_at > now()
            order by created_at desc
            limit 1
         ) tc on true
        where t.owner_uid = $1
        order by t.verified_at desc nulls last`,
      [user.id],
    );

    // 用户视角：这个身份在哪些 toy 上被用过、现在还能不能用。
    //
    // 读 identity_usage 而不是聚合 auth_code —— 后者是短命凭证，
    // 过期就被清掉，拿它当历史源会让这份记录缩水到只剩最近一天。
    //
    // 带出 revoked_at：用户手动失活过的，界面要能显示成「已退出」。
    const usage = await query<UsageRow>(
      `select t.toy_id, t.slug, t.title, t.icon_url, t.author_mid, t.author_name,
              t.author_face, t.bili_version, t.state, t.owner_uid, t.synced_at,
              c.client_id,
              u.last_used_at, u.uses,
              r.revoked_at
         from identity_usage u
         join toy t on t.toy_id = u.toy_id
         left join toy_client c on c.toy_id = t.toy_id
         left join token_revocation r on r.uid = u.uid and r.toy_id = t.toy_id
        where u.uid = $1
        order by u.last_used_at desc`,
      [user.id],
    );

    return {
      user: {
        uid: user.id,
        nickname: user.nickname,
        avatar: user.avatar,
        joinedAt: user.created_at,
      },
      ownedToys: owned.rows.map((r) => ({
        toyId: r.toy_id,
        slug: r.slug,
        title: r.title,
        iconUrl: normalizeIconUrl(r.icon_url),
        state: r.state,
        verifiedAt: r.verified_at,
        clientId: r.client_id,
        clientRevoked: Boolean(r.client_revoked_at),
        pendingClaim: r.claim_nonce
          ? {
              nonce: r.claim_nonce,
              expiresAt: r.claim_expires_at,
              attempts: r.claim_attempts ?? 0,
              attemptsLeft: Math.max(0, config.CLAIM_MAX_ATTEMPTS - (r.claim_attempts ?? 0)),
            }
          : null,
      })),
      usage: usage.rows.map((r) => ({
        toyId: r.toy_id,
        clientId: r.client_id,
        slug: r.slug,
        title: r.title,
        iconUrl: normalizeIconUrl(r.icon_url),
        lastUsedAt: r.last_used_at,
        uses: r.uses,
        revokedAt: r.revoked_at,
      })),
    };
  });

  /**
   * 手动失活：让这个用户在这个 toy 上、此刻之前签发的所有 token 作废。
   *
   * 记的是时间点而不是逐个 token，所以不需要令牌清单。
   * 「退出这个游戏」的语义正好如此 —— 连还没到期的也一起挡掉。
   */
  app.post('/api/me/revoke', async (req) => {
    const rl = rateLimit(`me:revoke:${req.ip}`, 30, 60_000);
    if (!rl.ok) throw Errors.rateLimited(rl.retryAfter);

    const body = parse(revokeSchema, req.body);

    const user = await queryOne<{ id: string }>(
      `select id from app_user where home_toy_id = $1 and toy_open_id = $2`,
      [config.MY_TOY_ID, body.toyOpenId],
    );
    if (!user) throw Errors.invalidIdentity();

    const client = await getClient(body.cid);
    if (!client) throw Errors.clientNotFound();

    const toy = await getToyById(client.toy_id);
    if (!toy) throw Errors.clientNotFound();

    const revokedAt = await revokeTokensForToy(user.id, toy.toy_id);

    return {
      ok: true,
      toyId: toy.toy_id,
      toySlug: toy.slug,
      revokedAt,
      message: `已退出《${toy.title || toy.slug}》。之前签发的 token 立即失效。`,
    };
  });
}
