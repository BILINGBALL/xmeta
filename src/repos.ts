import type pg from 'pg';
import { query, queryOne, withTransaction } from './db.js';
import { config } from './config.js';
import { Errors } from './errors.js';
import { fetchToyDetail, type ToyDetail } from './lib/bili.js';

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
  title: string;
  icon_url: string | null;
  author_mid: string | null;
  author_name: string | null;
  author_face: string | null;
  bili_version: number | null;
  state: 'unclaimed' | 'pending' | 'verified' | 'disabled';
  owner_uid: string | null;
  /** 元数据最后一次从 B站 detail 接口同步的时间，用于惰性刷新判断 */
  synced_at: Date | null;
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
  /** 用户在授权时选的有效期（小时）。老数据可能是 null，按默认值处理。 */
  ttl_seconds: number | null;
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
  const params = [
    config.MY_TOY_ID,
    input.toyOpenId,
    input.nickname ?? null,
    input.avatar ?? null,
  ];

  // 先试 UPDATE。
  //
  // ⚠️ 别图省事改回 `insert ... on conflict (…) do update` —— 那句看着像 upsert，
  // 实际**每次都把 app_user_id_seq 的 nextval 执行掉**：PG 先按 INSERT 准备这一行
  // （默认值在这一步求值），之后才检测到撞了唯一约束、转去走 UPDATE。于是老用户
  // 每授权一次就白吃一个号，id 一路飞涨，看着像 bug。
  // （实测：同一个人的第二次 upsert 也让序列 +1；连 `do nothing` 都照样 +1。）
  //
  // 先 UPDATE 就没这问题：老用户一个号都不花，只有真人第一次出现才占号。
  // 代价只有一个：新用户多一次往返（老用户仍是一次）—— 几乎没有代价。
  const updated = await queryOne<AppUser>(
    `update app_user
        set nickname     = coalesce($3, nickname),
            avatar       = coalesce($4, avatar),
            last_seen_at = now()
      where home_toy_id = $1 and toy_open_id = $2
      returning id, home_toy_id, toy_open_id, nickname, avatar`,
    params,
  );
  if (updated) return updated;

  // 真没见过的人才插。并发下同一个新人被插两次时，输的那边仍会吃掉一个号 ——
  // 想要绝对无洞就得把这一步串行化，不值当；空洞本身无害（id 只是主键，
  // 不表示「第几个用户」，要数量看 count(*)）。
  const inserted = await queryOne<AppUser>(
    `insert into app_user (home_toy_id, toy_open_id, nickname, avatar, last_seen_at)
     values ($1, $2, $3, $4, now())
     on conflict (home_toy_id, toy_open_id) do update
        set nickname     = coalesce(excluded.nickname, app_user.nickname),
            avatar       = coalesce(excluded.avatar, app_user.avatar),
            last_seen_at = now()
     returning id, home_toy_id, toy_open_id, nickname, avatar`,
    params,
  );
  // insert ... returning 一定有条记录
  return inserted!;
}

export async function getOwnedToys(uid: string): Promise<Toy[]> {
  const res = await query<Toy>(
    `select toy_id, slug, title, icon_url, author_mid, author_name, author_face,
            bili_version, state, owner_uid, synced_at
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
               bili_version, state, owner_uid, synced_at`,
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
            bili_version, state, owner_uid, synced_at
       from toy where slug = $1`,
    [slug],
  );
}

export async function getToyById(toyId: string): Promise<Toy | null> {
  return queryOne<Toy>(
    `select toy_id, slug, title, icon_url, author_mid, author_name, author_face,
            bili_version, state, owner_uid, synced_at
       from toy where toy_id = $1`,
    [toyId],
  );
}

/**
 * 手动刷新 toy 元数据（图标、作者名/头像等）。
 *
 * 这是给 toy 作者用的：作者在「我的 toy」里点「刷新」按钮，
 * 服务端去 B站 detail 接口拉最新数据覆盖入库。
 *
 * 不在读路径自动调——这些字段平时不怎么变，没必要每次请求都碰 B站。
 * 返回刷新后的 toy；B站 接口失败时抛错，由调用方决定怎么提示。
 */
export async function refreshToy(slug: string): Promise<Toy> {
  const detail = await fetchToyDetail(slug);
  if (!detail) throw Errors.toyNotFound(slug);
  return upsertToyFromDetail(detail);
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
 * 写进 index.html 并发布了，而重新发布一次 toy 要十几分钟。
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
  /** 授权码自己的寿命（秒），通常 60 */
  codeTtlSeconds: number;
  /** 用户在授权时选的 token 有效期（秒） */
  tokenTtlSeconds: number;
}): Promise<void> {
  await query(
    `insert into auth_code (code, uid, client_id, expires_at, ttl_seconds)
     values ($1, $2, $3, now() + make_interval(secs => $4), $5)`,
    [input.code, input.uid, input.clientId, input.codeTtlSeconds, input.tokenTtlSeconds],
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
      returning code, uid, client_id, ttl_seconds, expires_at, used_at`,
    [code],
  );
  return row;
}

/** 用于给「已用过 / 已过期」给出准确报错 */
export async function peekAuthCode(code: string): Promise<AuthCodeRow | null> {
  return queryOne<AuthCodeRow>(
    `select code, uid, client_id, ttl_seconds, expires_at, used_at
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
export async function recordUsage(
  uid: string,
  toyId: string,
  /** 这次签发的凭证能活多久（秒）。累加成「守护时长」，见 getStats */
  ttlSeconds: number,
): Promise<void> {
  await query(
    `insert into identity_usage (uid, toy_id, uses, seconds) values ($1, $2, 1, $3)
     on conflict (uid, toy_id) do update
        set uses = identity_usage.uses + 1,
            seconds = identity_usage.seconds + excluded.seconds,
            last_used_at = now()`,
    [uid, toyId, ttlSeconds],
  );
}

/**
 * 服务统计。全是聚合数字，没有任何用户信息，所以接口是公开只读的。
 *
 * 注意 pg 会把 count(*) / sum() 当字符串返回（bigint、numeric 的精度
 * 不是 JS number 能装的），这里统一转成数字。
 */
export type Stats = {
  /** 已接入的 toy 数（认领通过的） */
  toys: number;
  /** 中心 toy 上的用户总数 */
  users: number;
  /** 服务对数：一行 = 一个「用户 × toy」。一人玩 10 款记 10，另一人玩 5 款记 5 */
  toyServices: number;
  /** 凭证分发总次数 */
  tokens: number;
  /** 守护时长：每次签发的有效期之和（秒） */
  guardSeconds: number;
};

export async function getStats(): Promise<Stats> {
  const row = await queryOne<{
    toys: string;
    users: string;
    toy_services: string;
    tokens: string;
    guard_seconds: string;
  }>(
    `select
       (select count(*) from toy where state = 'verified')  as toys,
       (select count(*) from app_user)                      as users,
       (select count(*) from identity_usage)                as toy_services,
       (select coalesce(sum(uses), 0) from identity_usage)  as tokens,
       (select coalesce(sum(seconds), 0) from identity_usage) as guard_seconds`,
  );

  return {
    toys: Number(row?.toys ?? 0),
    users: Number(row?.users ?? 0),
    toyServices: Number(row?.toy_services ?? 0),
    tokens: Number(row?.tokens ?? 0),
    guardSeconds: Number(row?.guard_seconds ?? 0),
  };
}

/** 清掉过期数据，交给定时任务调用即可 */
export async function cleanupExpired(): Promise<{ codes: number; claims: number }> {
  // auth_code 只保留还活着的码。1 小时的宽限纯粹是为了排查问题时
  // 还能看到刚过期的记录，使用统计已经搬到 identity_usage 了。
  const codes = await query(`delete from auth_code where expires_at < now() - interval '1 hour'`);
  const claims = await query(
    `update toy_claim set state = 'expired'
      where state = 'pending' and expires_at < now()`,
  );
  return { codes: codes.rowCount ?? 0, claims: claims.rowCount ?? 0 };
}
export type { pg };

// ---------------------------------------------------------------- 联机数据

export type ToyDataRow = {
  id: string;
  uid: string;
  toy_id: string;
  scope: string;
  is_public: boolean;
  open_edit: string[];
  tag_tinyint: number | null;
  tag_int1: number | null;
  tag_int2: number | null;
  tag_bigint: string | null;
  text_1: string | null;
  text_2: string | null;
  text_long: string | null;
  extra: unknown;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
};

/** 八个可写的数据列（和迁移里的 CHECK 白名单一一对应） */
export const DATA_FIELDS = [
  'tag_tinyint',
  'tag_int1',
  'tag_int2',
  'tag_bigint',
  'text_1',
  'text_2',
  'text_long',
  'extra',
] as const;

/** 列名写死一处，别让 select * 跟着表结构漂 */
const DATA_COLUMNS = `id, uid, toy_id, scope, is_public, open_edit,
  tag_tinyint, tag_int1, tag_int2, tag_bigint,
  text_1, text_2, text_long, extra,
  expires_at, created_at, updated_at`;

/** 行数额度：普通用户每 toy 64 行，toy 作者 256 行 */
export const ROW_QUOTA = { user: 64, owner: 256 } as const;

export async function getUserById(id: string): Promise<AppUser | null> {
  return queryOne<AppUser>(
    `select id, home_toy_id, toy_open_id, nickname, avatar from app_user where id = $1`,
    [id],
  );
}

/** 这个人在这个 toy 里占了多少行（额度用，走 toy_data_by_uid_idx） */
export async function countUserDataRows(toyId: string, uid: string): Promise<number> {
  const row = await queryOne<{ n: string }>(
    `select count(*) as n from toy_data where toy_id = $1 and uid = $2`,
    [toyId, uid],
  );
  return Number(row?.n ?? 0);
}

/** 读一格。**过期的当作不存在** —— 清理任务是定时的，别把过期的读出来 */
export async function getToyData(
  toyId: string,
  uid: string,
  scope: string,
): Promise<ToyDataRow | null> {
  return queryOne<ToyDataRow>(
    `select ${DATA_COLUMNS} from toy_data
      where toy_id = $1 and uid = $2 and scope = $3 and expires_at > now()`,
    [toyId, uid, scope],
  );
}

/** 列一个 scope 下所有人的格（分页） */
export async function listToyData(input: {
  toyId: string;
  scope: string;
  page: number;
  size: number;
  tagTinyint?: number | null;
  /** true = 只列 is_public 的（非作者视角）。过滤要进 SQL，否则分页和 total 都会错 */
  publicOnly?: boolean;
}): Promise<{ items: ToyDataRow[]; total: number }> {
  const params: unknown[] = [input.toyId, input.scope];
  let filter = '';
  if (input.publicOnly) filter += ' and is_public';
  if (typeof input.tagTinyint === 'number') {
    params.push(input.tagTinyint);
    filter += ` and tag_tinyint = $${params.length}`;
  }
  const where = `toy_id = $1 and scope = $2 and expires_at > now()${filter}`;

  const totalRow = await queryOne<{ n: string }>(
    `select count(*) as n from toy_data where ${where}`,
    params,
  );
  const items = await query<ToyDataRow>(
    `select ${DATA_COLUMNS} from toy_data
      where ${where} order by uid
      limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, input.size, (input.page - 1) * input.size],
  );
  return { items: items.rows, total: Number(totalRow?.n ?? 0) };
}

export type ToyDataLogRow = {
  id: string;
  data_id: string;
  actor_uid: string | null;
  action: 'create' | 'update';
  changed: string[];
  before: unknown;
  after: unknown;
  created_at: Date;
};

export async function listToyDataLog(
  dataId: string,
  page: number,
  size: number,
): Promise<{ items: ToyDataLogRow[]; total: number }> {
  const totalRow = await queryOne<{ n: string }>(
    `select count(*) as n from toy_data_log where data_id = $1`,
    [dataId],
  );
  const items = await query<ToyDataLogRow>(
    `select id, data_id, actor_uid, action, changed, before, after, created_at
       from toy_data_log where data_id = $1
      order by id desc limit $2 offset $3`,
    [dataId, size, (page - 1) * size],
  );
  return { items: items.rows, total: Number(totalRow?.n ?? 0) };
}

/**
 * 写一格，并记一条日志。**整个过程一个事务** —— 数据和日志必须同生同死，
 * 否则会留下「日志说改了、数据没变」的条目。
 *
 * 权限已经在 routes/data.ts 判完了，这里只负责落库：
 *   mode 'put'   整行覆盖：没提到的数据列一律清空
 *   mode 'patch' 部分更新：只动 changes.columns 里提到的列
 *   createOnly   作者替玩家/公共格占位时用，已存在就报错
 */
export async function writeToyData(input: {
  toyId: string;
  uid: string;
  scope: string;
  actorUid: string;
  mode: 'put' | 'patch';
  changes: {
    columns: Record<string, unknown>;
    /** 列名 → 增量（原子加减）。和 columns 里同名的列不允许同时出现，调用方先挡 */
    inc?: Record<string, number>;
    isPublic?: boolean;
    openEdit?: string[];
    ttlDays?: number;
  };
  quota: number;
  createOnly?: boolean;
}): Promise<{ row: ToyDataRow; created: boolean; changed: string[] }> {
  return withTransaction(async (client) => {
    // 锁住这一格：并发写同一格要排队，否则会丢更新
    const found = await client.query<ToyDataRow>(
      `select ${DATA_COLUMNS} from toy_data
        where toy_id = $1 and scope = $2 and uid = $3 for update`,
      [input.toyId, input.scope, input.uid],
    );
    const before = found.rows[0] ?? null;

    if (before && input.createOnly) {
      throw Errors.quotaExceeded('这一格已经存在了，别重复创建');
    }

    const inc = input.changes.inc ?? {};

    // 最终的列值：put 是全量（缺的清空），patch 是旧值 + 改动
    const values: Record<string, unknown> = {};
    for (const col of DATA_FIELDS) {
      if (input.mode === 'put') {
        values[col] = input.changes.columns[col] ?? null;
      } else if (col in inc) {
        values[col] = inc[col] ?? 0; // 增量：下面 SQL 里走 coalesce(col,0) + $n
      } else {
        values[col] =
          col in input.changes.columns
            ? (input.changes.columns[col] ?? null)
            : ((before as Record<string, unknown> | null)?.[col] ?? null);
      }
    }

    const ttlDays = input.changes.ttlDays ?? 7;

    if (!before) {
      // 额度检查放在事务里，避免并发把额度顶爆
      const n = await client.query<{ n: string }>(
        `select count(*) as n from toy_data where toy_id = $1 and uid = $2`,
        [input.toyId, input.uid],
      );
      if (Number(n.rows[0]!.n) >= input.quota) {
        throw Errors.quotaExceeded(
          `这一格放不下：每个用户在这个 toy 里最多 ${input.quota} 行。` +
            '只存 id 之类的必要信息、把展示用的名字留在本地，通常就够了',
        );
      }

      const cols = [...DATA_FIELDS, 'is_public', 'open_edit'];
      const params: unknown[] = [
        input.toyId,
        input.uid,
        input.scope,
        ...DATA_FIELDS.map((c) => values[c] ?? null),
        input.changes.isPublic ?? false,
        input.changes.openEdit ?? [],
        ttlDays,
      ];
      const row = (
        await client.query<ToyDataRow>(
          `insert into toy_data (toy_id, uid, scope, ${cols.join(', ')}, expires_at)
           values ($1, $2, $3,
                   ${cols.map((_, i) => `$${i + 4}`).join(', ')},
                   now() + make_interval(days => $${cols.length + 4}))
           returning ${DATA_COLUMNS}`,
          params,
        )
      ).rows[0]!;

      const created2 = diffColumns(null, row);
      await writeLog(client, {
        dataId: row.id,
        actorUid: input.actorUid,
        action: 'create',
        changed: created2,
        before: null,
        after: pick(row, created2),
      });
      return { row, created: true, changed: created2 };
    }

    // 更新：expires_at 一律重算成 created_at + ttlDays，**不接受续期**
    const isPublic = input.changes.isPublic ?? before.is_public;
    const openEdit = input.changes.openEdit ?? before.open_edit;
    const params: unknown[] = [
      ...DATA_FIELDS.map((c) => values[c] ?? null),
      isPublic,
      openEdit,
      ttlDays,
      input.toyId,
      input.scope,
      input.uid,
    ];
    const row = (
      await client.query<ToyDataRow>(
        `update toy_data set
           ${DATA_FIELDS.map((c, i) =>
             c in inc
               ? `${c} = coalesce(${c}, 0) + $${i + 1}` // 原子加减：并发也不会丢
               : `${c} = $${i + 1}`,
           ).join(', ')},
           is_public  = $${DATA_FIELDS.length + 1},
           open_edit  = $${DATA_FIELDS.length + 2},
           expires_at = created_at + make_interval(days => $${DATA_FIELDS.length + 3}),
           updated_at = now()
         where toy_id = $${DATA_FIELDS.length + 4}
           and scope = $${DATA_FIELDS.length + 5}
           and uid   = $${DATA_FIELDS.length + 6}
         returning ${DATA_COLUMNS}`,
        params,
      )
    ).rows[0]!;

    // 写完再比一次：inc 的最终值只有数据库知道，事先算不出来
    const changed = diffColumns(before, row);
    await writeLog(client, {
      dataId: row.id,
      actorUid: input.actorUid,
      action: 'update',
      changed,
      before: pick(before, changed),
      after: pick(row, changed),
    });
    return { row, created: false, changed };
  });
}

/** 哪些列真的变了（数据列 + 可见性 + 开放编辑） */
function diffColumns(before: unknown, after: unknown): string[] {
  const cols = [...DATA_FIELDS, 'is_public', 'open_edit'];
  return cols.filter(
    (c) =>
      JSON.stringify((before as Record<string, unknown> | null)?.[c] ?? null) !==
      JSON.stringify((after as Record<string, unknown> | null)?.[c] ?? null),
  );
}

/** 只挑这几个字段（日志里别塞整行） */
function pick(row: unknown, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = (row as Record<string, unknown> | null)?.[f] ?? null;
  return out;
}

/** 日志只追加。changed 为空时不记 */
async function writeLog(
  client: pg.PoolClient,
  entry: {
    dataId: string;
    actorUid: string;
    action: 'create' | 'update';
    changed: string[];
    before: unknown;
    after: unknown;
  },
): Promise<void> {
  if (entry.changed.length === 0) return;
  await client.query(
    `insert into toy_data_log (data_id, actor_uid, action, changed, before, after)
     values ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
    [
      entry.dataId,
      entry.actorUid,
      entry.action,
      entry.changed,
      JSON.stringify(entry.before ?? null),
      JSON.stringify(entry.after ?? null),
    ],
  );
}

/** 作者删一行。日志靠 on delete cascade 跟着走（你定的「日志随记录删除」） */
export async function deleteToyData(toyId: string, scope: string, uid: string): Promise<number> {
  const res = await query(
    `delete from toy_data where toy_id = $1 and scope = $2 and uid = $3`,
    [toyId, scope, uid],
  );
  return res.rowCount ?? 0;
}

/** 作者删掉整个 scope */
export async function deleteToyScope(toyId: string, scope: string): Promise<number> {
  const res = await query(`delete from toy_data where toy_id = $1 and scope = $2`, [toyId, scope]);
  return res.rowCount ?? 0;
}

/** 过期清理：分批删，别一次锁一大片 */
export async function cleanupToyData(batch = 1000, maxRounds = 20): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxRounds; i++) {
    const res = await query(
      `delete from toy_data
        where id in (select id from toy_data where expires_at < now() limit $1)`,
      [batch],
    );
    const n = res.rowCount ?? 0;
    total += n;
    if (n < batch) break;
  }
  return total;
}
