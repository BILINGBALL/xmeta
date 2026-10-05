import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import type { BiliDeps } from '../deps.js';
import { Errors } from '../errors.js';
import { mineSchema, parse, refreshToySchema, startClaimSchema, verifyClaimSchema } from '../http.js';
import { htmlContainsNonce, normalizeIconUrl } from '../lib/bili.js';
import { clientId, randomNonce } from '../lib/ids.js';
import { rateLimit } from '../lib/ratelimit.js';
import {
  bumpClaimAttempt,
  completeClaim,
  getClientByToyId,
  getOwnedToys,
  getPendingClaim,
  getToyBySlug,
  refreshToy,
  startClaim,
  upsertToyFromDetail,
  upsertUser,
} from '../repos.js';

/**
 * Phase 0 —— 作者认领。
 *
 * 归属证明用的是「内容控制权」而不是「账号身份」：
 * 服务端给一个一次性 nonce，作者把它写进自己 toy 的 index.html 并发布，
 * 服务端去 bilibilitoy.com 抓真实源码校验。
 *
 * 为什么不用 getUserProfile 比对？因为 SDK 根本不返回 mid，
 * 昵称/头像又是客户端上报的，可以随便伪造。详见 README。
 */

function limit(req: FastifyRequest, key: string, max: number, windowMs: number): void {
  const result = rateLimit(`${key}:${req.ip}`, max, windowMs);
  if (!result.ok) throw Errors.rateLimited(result.retryAfter);
}

/** 认领相关的出站抓取很贵，限得紧一点 */
const CLAIM_LIMIT = { max: 20, windowMs: 60_000 };
const VERIFY_LIMIT = { max: 10, windowMs: 60_000 };

export async function claimRoutes(
  app: FastifyInstance,
  opts: { bili: BiliDeps },
): Promise<void> {
  const { fetchToyDetail, fetchToySource } = opts.bili;

  /**
   * 发起认领。
   * 需要调用方先在本 toy 内跑过 toy.getUserProfile()，
   * 否则我们没有任何身份可以绑定——认领必须绑在具体的 toyOpenId 上。
   */
  app.post('/api/claim/start', async (req) => {
    limit(req, 'claim:start', CLAIM_LIMIT.max, CLAIM_LIMIT.windowMs);

    const body = parse(startClaimSchema, req.body);
    const user = await upsertUser({
      toyOpenId: body.toyOpenId,
      nickname: body.nickname ?? null,
      avatar: body.avatar ?? null,
    });

    const detail = await fetchToyDetail(body.slug);
    if (!detail) throw Errors.toyNotFound(body.slug);

    const toy = await upsertToyFromDetail(detail);

    // 已经认领过
    if (toy.state === 'verified') {
      if (toy.owner_uid !== user.id) throw Errors.toyAlreadyClaimed();
      // 幂等：同一个人重复发起，直接告诉他已完成
      const client = await getClientByToyId(toy.toy_id);
      return {
        state: 'verified' as const,
        toyId: toy.toy_id,
        slug: toy.slug,
        title: toy.title,
        clientId: client?.client_id ?? null,
        message: '这个 toy 已经归你所有了',
      };
    }

    // 注意用 claim.nonce 而不是刚生成的那个：同一个人重复进来会沿用旧 nonce
    const { claim, reused } = await startClaim({
      toyId: toy.toy_id,
      uid: user.id,
      nonce: randomNonce(),
      ttlHours: config.CLAIM_NONCE_TTL_HOURS,
      maxAttempts: config.CLAIM_MAX_ATTEMPTS,
    });

    return {
      state: 'pending' as const,
      toyId: toy.toy_id,
      slug: toy.slug,
      title: toy.title,
      authorName: toy.author_name,
      iconUrl: normalizeIconUrl(toy.icon_url),
      nonce: claim.nonce,
      /** 沿用了上次那个验证码 —— 前端据此换个说法，别让人以为又变了 */
      reused,
      expiresAt: claim.expires_at,
      attemptsLeft: Math.max(0, config.CLAIM_MAX_ATTEMPTS - claim.attempts),
      instructions:
        `把下面这行加进你 toy 的 index.html（<head> 里任意位置），保存并发布：\n\n` +
        `<meta name="xmeta-verify" content="${claim.nonce}">\n\n` +
        `发布完成后回来点「我已发布，开始验证」。验证码一次性，验证通过后可以删掉。`,
    };
  });

  /**
   * 校验 nonce。会真的去抓 bilibilitoy.com 上的源码。
   */
  app.post('/api/claim/verify', async (req) => {
    limit(req, 'claim:verify', VERIFY_LIMIT.max, VERIFY_LIMIT.windowMs);

    const body = parse(verifyClaimSchema, req.body);
    const user = await upsertUser({
      toyOpenId: body.toyOpenId,
      nickname: body.nickname ?? null,
      avatar: body.avatar ?? null,
    });

    const toy = await getToyBySlug(body.slug);
    if (!toy) throw Errors.toyNotFound(body.slug);

    if (toy.state === 'verified') {
      if (toy.owner_uid !== user.id) throw Errors.toyAlreadyClaimed();
      const client = await getClientByToyId(toy.toy_id);
      return {
        state: 'verified' as const,
        toyId: toy.toy_id,
        slug: toy.slug,
        clientId: client?.client_id ?? null,
      };
    }

    const claim = await getPendingClaim(toy.toy_id, user.id);
    if (!claim) throw Errors.claimNotFound();

    if (claim.expires_at.getTime() <= Date.now()) {
      throw Errors.claimExpired();
    }
    if (claim.attempts >= config.CLAIM_MAX_ATTEMPTS) {
      throw Errors.claimAttemptsExceeded();
    }

    let source;
    try {
      source = await fetchToySource(toy.slug);
    } catch (err) {
      await bumpClaimAttempt({
        claimId: claim.id,
        maxAttempts: config.CLAIM_MAX_ATTEMPTS,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    if (!htmlContainsNonce(source.html, claim.nonce)) {
      const updated = await bumpClaimAttempt({
        claimId: claim.id,
        maxAttempts: config.CLAIM_MAX_ATTEMPTS,
        error: 'nonce_not_in_source',
      });
      if (updated.state === 'failed') throw Errors.claimAttemptsExceeded();
      throw Errors.nonceNotInSource();
    }

    const newClientId = clientId();
    try {
      await completeClaim({
        claimId: claim.id,
        toyId: toy.toy_id,
        uid: user.id,
        clientId: newClientId,
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'claim_already_consumed') {
        throw Errors.claimNotFound();
      }
      throw err;
    }

    return {
      state: 'verified' as const,
      toyId: toy.toy_id,
      slug: toy.slug,
      clientId: newClientId,
    };
  });

  /** 我认领了哪些 toy */
  app.post('/api/toy/mine', async (req) => {
    limit(req, 'toy:mine', 60, 60_000);

    const body = parse(mineSchema, req.body);
    const user = await upsertUser({ toyOpenId: body.toyOpenId });
    const toys = await getOwnedToys(user.id);

    const items = await Promise.all(
      toys.map(async (t) => {
        const client = await getClientByToyId(t.toy_id);
        return {
          toyId: t.toy_id,
          slug: t.slug,
          title: t.title,
          iconUrl: normalizeIconUrl(t.icon_url),
          authorName: t.author_name,
          state: t.state,
          clientId: client?.client_id ?? null,
          revoked: Boolean(client?.revoked_at),
        };
      }),
    );

    return { uid: user.id, nickname: user.nickname, toys: items };
  });

  /**
   * 作者手动刷新 toy 元数据（图标、作者名/头像等）。
   *
   * 只有 toy 的所有者能调。刷新走 B站 detail 接口，成功后覆盖入库。
   * 不在读路径自动做——这些字段平时不怎么变，作者想更新时点一下就行。
   */
  app.post('/api/toy/refresh', async (req) => {
    limit(req, 'toy:refresh', 10, 60_000);

    const body = parse(refreshToySchema, req.body);
    const user = await upsertUser({ toyOpenId: body.toyOpenId });

    const toy = await getToyBySlug(body.slug);
    if (!toy) throw Errors.toyNotFound(body.slug);
    if (toy.owner_uid !== user.id) throw Errors.forbidden('你不是该 toy 的所有者');

    const fresh = await refreshToy(body.slug);
    const client = await getClientByToyId(fresh.toy_id);

    return {
      toyId: fresh.toy_id,
      slug: fresh.slug,
      title: fresh.title,
      iconUrl: normalizeIconUrl(fresh.icon_url),
      authorName: fresh.author_name,
      state: fresh.state,
      clientId: client?.client_id ?? null,
      revoked: Boolean(client?.revoked_at),
      syncedAt: fresh.synced_at,
    };
  });
}
