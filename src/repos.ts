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

/**
 * 发起认领：把 toy 标成 pending，写一条 nonce 记录。
 * 同一个 (toy, user) 已有的 pending 记录会被作废，避免 nonce 满天飞。
 */
export async function startClaim(input: {
  toyId: string;
  uid: string;
  nonce: string;
  ttlHours: number;
}): Promise<ToyClaim> {
  return withTransaction(async (client) => {
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
    return res.rows[0]!;
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

/** 清掉过期数据，交给定时任务调用即可 */
export async function cleanupExpired(): Promise<{ codes: number; claims: number }> {
  const codes = await query(`delete from auth_code where expires_at < now() - interval '1 day'`);
  const claims = await query(
    `update toy_claim set state = 'expired'
      where state = 'pending' and expires_at < now()`,
  );
  return { codes: codes.rowCount ?? 0, claims: claims.rowCount ?? 0 };
}

export type { pg };
