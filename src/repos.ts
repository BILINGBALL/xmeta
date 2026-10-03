import type pg from 'pg';
import { query, queryOne, withTransaction } from './db.js';
import { config } from './config.js';
import type { ToyDetail } from './lib/bili.js';

/** 所有 id 类字段（bigint / bigserial）在 pg 里都是 string，避免 JS number 精度问题。 */

export type AppUser = {
  id: string;
  home_toy_id: string;
  toy_open_id: string;
  nickname: string | null;
  avatar: string | null;
};

export type Toy = {
  toy_id: string;
  slug: string;
  title: string | null;
  icon_url: string | null;
  author_mid: string | null;
  author_name: string | null;
  author_face: string | null;
  bili_version: number | null;
  state: 'unclaimed' | 'pending' | 'verified' | 'disabled';
  owner_uid: string | null;
};

export type ToyClaim = {
  id: string;
  toy_id: string;
  claimant_uid: string;
  nonce: string;
  state: 'pending' | 'verified' | 'failed' | 'expired';
  attempts: number;
  expires_at: Date;
};

export type ToyClient = {
  client_id: string;
  toy_id: string;
  revoked_at: Date | null;
};

export type AuthCodeRow = {
  code: string;
  uid: string;
  client_id: string;
  code_challenge: string | null;
  code_challenge_method: string | null;
  state: string | null;
  expires_at: Date;
  used_at: Date | null;
};

// ---------------------------------------------------------------- users

/**
 * 按「我的 toy + toyOpenId」找用户，没有就建。
 * 这是整个系统唯一的身份入口——作者和玩家共用。
 */
export async function upsertUser(input: {
  toyOpenId: string;
  nickname?: string | null;
  avatar?: string | null;
}): Promise<AppUser> {
  const row = await queryOne<AppUser>(
    `insert into app_user (home_toy_id, toy_open_id, nickname, avatar, last_seen_at)
     values ($1, $2, $3, $4, now())
     on conflict (home_toy_id, toy_open_id) do update
        set nickname     = coalesce(excluded.nickname, app_user.nickname),
            avatar       = coalesce(excluded.avatar, app_user.avatar),
            last_seen_at = now()
     returning id, home_toy_id, toy_open_id, nickname, avatar`,
    [config.MY_TOY_ID, input.toyOpenId, input.nickname ?? null, input.avatar ?? null],
  );
  // upsert + returning 一定有条记录
  return row!;
}

export async function getOwnedToys(uid: string): Promise<Toy[]> {
  const res = await query<Toy>(
    `select toy_id, slug, title, icon_url, author_mid, author_name, author_face,
            bili_version, state, owner_uid
       from toy
      where owner_uid = $1
      order by verified_at desc nulls last`,
    [uid],
  );
  return res.rows;
}

// ---------------------------------------------------------------- toys

/** 用 detail 接口的结果落库 / 刷新元数据。不碰 state / owner_uid。 */
export async function upsertToyFromDetail(detail: ToyDetail): Promise<Toy> {
  const row = await queryOne<Toy>(
    `insert into toy (toy_id, slug, title, icon_url, author_mid, author_name,
                      author_face, bili_version, synced_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now())
     on conflict (toy_id) do update
        set slug         = excluded.slug,
            title        = excluded.title,
            icon_url     = excluded.icon_url,
            author_mid   = excluded.author_mid,
            author_name  = excluded.author_name,
            author_face  = excluded.author_face,
            bili_version = excluded.bili_version,
            synced_at    = now(),
            updated_at   = now()
     returning toy_id, slug, title, icon_url, author_mid, author_name, author_face,
               bili_version, state, owner_uid`,
    [
      detail.toyId,
      detail.slug,
      detail.title,
      detail.iconUrl,
      detail.authorMid,
      detail.authorName,
      detail.authorFace,
      detail.version,
    ],
  );
  return row!;
}

export async function getToyBySlug(slug: string): Promise<Toy | null> {
  return queryOne<Toy>(
    `select toy_id, slug, title, icon_url, author_mid, author_name, author_face,
            bili_version, state, owner_uid
       from toy where slug = $1`,
    [slug],
  );
}

export async function getToyById(toyId: string): Promise<Toy | null> {
  return queryOne<Toy>(
    `select toy_id, slug, title, icon_url, author_mid, author_name, author_face,
            bili_version, state, owner_uid
       from toy where toy_id = $1`,
    [toyId],
  );
}

// ---------------------------------------------------------------- claims

export type StartClaimResult = {
  claim: ToyClaim;
  /** true = 沿用了上次还没过期的验证码，没有换新的 */
  reused: boolean;
};

/**
 * 发起认领：把 toy 标成 pending，需要时写一条 nonce 记录。
 *
 * 关键语义：**同一个 (toy, user) 在验证码有效期内永远拿到同一个 nonce。**
 * 用户中途退出、过一会儿再进来，必须还是那一个——因为他可能已经把它
 * 写进 index.html 并发布了，而重新发布一次玩具要十几分钟。
 * 换 nonce 会让他做的功白费，还会得到一个莫名其妙的「源码里没找到验证码」。
 *
 * 只有两种情况才发新 nonce：没有可用的（首次 / 已过期 / 尝试次数用尽）。
 * 换 nonce 后旧的那个自然作废，因为它已经不在 pending 且未过期的集合里了。
 */
export async function startClaim(input: {
  toyId: string;
  uid: string;
  nonce: string;
  ttlHours: number;
  maxAttempts: number;
}): Promise<StartClaimResult> {
  return withTransaction(async (client) => {
    const existing = await client.query<ToyClaim>(
      `select id, toy_id, claimant_uid, nonce, state, attempts, expires_at
         from toy_claim
        where toy_id = $1
          and claimant_uid = $2
          and state = 'pending'
          and expires_at > now()
          and attempts < $3
        order by created_at desc
        limit 1`,
      [input.toyId, input.uid, input.maxAttempts],
    );

    const found = existing.rows[0];
    if (found) {
      await client.query(
        `update toy set state = 'pending', updated_at = now()
          where toy_id = $1 and state = 'unclaimed'`,
        [input.toyId],
      );
      return { claim: found, reused: true };
    }

    // 没有可用的，作废旧的再建一个新的
    await client.query(
      `update toy_claim
          set state = 'expired'
        where toy_id = $1 and claimant_uid = $2 and state = 'pending'`,
      [input.toyId, input.uid],
    );

    await client.query(
      `update toy set state = 'pending', updated_at = now()
        where toy_id = $1 and state = 'unclaimed'`,
      [input.toyId],
    );

    const res = await client.query<ToyClaim>(
      `insert into toy_claim (toy_id, claimant_uid, nonce, expires_at)
       values ($1, $2, $3, now() + make_interval(hours => $4))
       returning id, toy_id, claimant_uid, nonce, state, attempts, expires_at`,
      [input.toyId, input.uid, input.nonce, input.ttlHours],
    );
    return { claim: res.rows[0]!, reused: false };
  });
}

/** 找当前用户在该 toy 上还没过期的 pending 认领 */
export async function getPendingClaim(
  toyId: string,
  uid: string,
): Promise<ToyClaim | null> {
  return queryOne<ToyClaim>(
    `select id, toy_id, claimant_uid, nonce, state, attempts, expires_at
       from toy_claim
      where toy_id = $1 and claimant_uid = $2 and state = 'pending'
      order by created_at desc
      limit 1`,
    [toyId, uid],
  );
}

/** 计一次尝试并返回最新行；超限时把记录标成 failed。 */
export async function bumpClaimAttempt(input: {
  claimId: string;
  maxAttempts: number;
  error?: string | null;
}): Promise<ToyClaim> {
  const res = await query<ToyClaim>(
    `update toy_claim
        set attempts   = attempts + 1,
            last_error = $2,
            state      = case when attempts + 1 >= $3 then 'failed' else state end
      where id = $1
      returning id, toy_id, claimant_uid, nonce, state, attempts, expires_at`,
    [input.claimId, input.error ?? null, input.maxAttempts],
  );
  return res.rows[0]!;
}

/**
 * 认领通过：原子地消费 nonce、把 toy 置为 verified、建 client。
 * 返回 client_id。
 */
export async function completeClaim(input: {
  claimId: string;
  toyId: string;
  uid: string;
  clientId: string;
}): Promise<void> {
  await withTransaction(async (client) => {
    const consumed = await client.query(
      `update toy_claim
          set state = 'verified', consumed_at = now()
        where id = $1 and state = 'pending'
        returning id`,
      [input.claimId],
    );
    if (consumed.rowCount === 0) {
      // 并发下被别人抢先消费了
      throw new Error('claim_already_consumed');
    }

    await client.query(
      `update toy
          set state = 'verified', owner_uid = $2, verified_at = now(), updated_at = now()
        where toy_id = $1`,
      [input.toyId, input.uid],
    );

    // 这个 toy 已经被赢了，其他人还挂着的 pending 认领不会再有机会
    await client.query(
      `update toy_claim
          set state = 'failed', last_error = 'claimed_by_someone_else'
        where toy_id = $1 and state = 'pending'`,
      [input.toyId],
    );

    await client.query(
      `insert into toy_client (client_id, toy_id)
       values ($1, $2)
       on conflict (toy_id) do update set client_id = excluded.client_id, revoked_at = null`,
      [input.clientId, input.toyId],
    );
  });
}

// ---------------------------------------------------------------- clients

export async function getClient(clientId: string): Promise<ToyClient | null> {
  return queryOne<ToyClient>(
    `select client_id, toy_id, revoked_at from toy_client where client_id = $1`,
    [clientId],
  );
}

export async function getClientByToyId(toyId: string): Promise<ToyClient | null> {
  return queryOne<ToyClient>(
    `select client_id, toy_id, revoked_at from toy_client where toy_id = $1`,
    [toyId],
  );
}

// ---------------------------------------------------------------- auth codes

export async function insertAuthCode(input: {
  code: string;
  uid: string;
  clientId: string;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  state: string | null;
  ttlSeconds: number;
}): Promise<void> {
  await query(
    `insert into auth_code (code, uid, client_id, code_challenge,
                            code_challenge_method, state, expires_at)
     values ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))`,
    [
      input.code,
      input.uid,
      input.clientId,
      input.codeChallenge,
      input.codeChallengeMethod,
      input.state,
      input.ttlSeconds,
    ],
  );
}

/**
 * 原子地消费授权码：只有「未使用且未过期」才能被取走。
 * 返回 null 表示无效/已用/已过期——调用方再去分辨具体原因。
 */
export async function consumeAuthCode(code: string): Promise<AuthCodeRow | null> {
  const row = await queryOne<AuthCodeRow>(
    `update auth_code
        set used_at = now()
      where code = $1 and used_at is null and expires_at > now()
      returning code, uid, client_id, code_challenge, code_challenge_method,
                state, expires_at, used_at`,
    [code],
  );
  return row;
}

/** 用于给「已用过 / 已过期」给出准确报错 */
export async function peekAuthCode(code: string): Promise<AuthCodeRow | null> {
  return queryOne<AuthCodeRow>(
    `select code, uid, client_id, code_challenge, code_challenge_method,
            state, expires_at, used_at
       from auth_code where code = $1`,
    [code],
  );
}

/**
 * 记一次成功的身份使用。换 token 成功后调用。
 *
 * 单独一张表而不是从 auth_code 聚合：auth_code 是短命凭证，过期就清，
 * 拿它当历史数据源会让统计随清理缩水。
 */
export async function recordUsage(uid: string, toyId: string): Promise<void> {
  await query(
    `insert into identity_usage (uid, toy_id) values ($1, $2)
     on conflict (uid, toy_id) do update
        set uses = identity_usage.uses + 1,
            last_used_at = now()`,
    [uid, toyId],
  );
}

// ---------------------------------------------------------------- refresh token

export type RefreshTokenRow = {
  token_hash: string;
  uid: string;
  client_id: string;
  family_id: string;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
};

/** 写入一枚新的刷新令牌。存的是哈希，明文只在这一刻存在。 */
export async function insertRefreshToken(input: {
  tokenHash: string;
  uid: string;
  clientId: string;
  familyId: string;
  ttlDays: number;
}): Promise<void> {
  await query(
    `insert into refresh_token (token_hash, uid, client_id, family_id, expires_at)
     values ($1, $2, $3, $4, now() + make_interval(days => $5))`,
    [input.tokenHash, input.uid, input.clientId, input.familyId, input.ttlDays],
  );
}

export async function getRefreshToken(tokenHash: string): Promise<RefreshTokenRow | null> {
  return queryOne<RefreshTokenRow>(
    `select token_hash, uid, client_id, family_id, expires_at, used_at, revoked_at
       from refresh_token where token_hash = $1`,
    [tokenHash],
  );
}

/**
 * 原子地消费一枚刷新令牌。
 * 只有「没用过、没作废、没过期」才能被取走；返回 null 表示没抢到。
 *
 * 两个并发请求同时刷新时，只有一个能成功 —— 另一个会拿到 null，
 * 调用方据此判定为「已用过的令牌又出现」，按泄漏处理。
 */
export async function consumeRefreshToken(tokenHash: string): Promise<RefreshTokenRow | null> {
  return queryOne<RefreshTokenRow>(
    `update refresh_token
        set used_at = now()
      where token_hash = $1
        and used_at is null
        and revoked_at is null
        and expires_at > now()
      returning token_hash, uid, client_id, family_id, expires_at, used_at, revoked_at`,
    [tokenHash],
  );
}

/**
 * 作废整条轮换链。用于检测到令牌被复制的情况 ——
 * 合法的使用者和窃取者里有一个是假的，分不清是谁，所以两边都踢掉，
 * 让他们重新走一次过桥。
 */
export async function revokeRefreshFamily(familyId: string): Promise<number> {
  const res = await query(
    `update refresh_token set revoked_at = now()
      where family_id = $1 and revoked_at is null`,
    [familyId],
  );
  return res.rowCount ?? 0;
}

/** 作废某个用户在某个玩具上的全部刷新令牌（用于将来做「退出登录」） */
export async function revokeUserClientRefreshTokens(uid: string, clientId: string): Promise<number> {
  const res = await query(
    `update refresh_token set revoked_at = now()
      where uid = $1 and client_id = $2 and revoked_at is null`,
    [uid, clientId],
  );
  return res.rowCount ?? 0;
}

/** 清掉过期数据，交给定时任务调用即可 */
export async function cleanupExpired(): Promise<{ codes: number; claims: number; tokens: number }> {
  // auth_code 只保留还活着的码。1 小时的宽限纯粹是为了排查问题时
  // 还能看到刚过期的记录，使用统计已经搬到 identity_usage 了。
  const codes = await query(`delete from auth_code where expires_at < now() - interval '1 hour'`);
  const claims = await query(
    `update toy_claim set state = 'expired'
      where state = 'pending' and expires_at < now()`,
  );
  // 刷新令牌过期后再留 7 天：万一是「过期后又被拿来用」的情况，
  // 还能查到它属于哪条链，有助于判断是真过期还是被复制过。
  const tokens = await query(
    `delete from refresh_token where expires_at < now() - interval '7 days'`,
  );
  return {
    codes: codes.rowCount ?? 0,
    claims: claims.rowCount ?? 0,
    tokens: tokens.rowCount ?? 0,
  };
}

export type { pg };
