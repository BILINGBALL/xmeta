import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Errors } from '../errors.js';
import {
  FIELD_TO_COLUMN,
  kvPatchSchema,
  kvPutSchema,
  pageSchema,
  parse,
  profilesSchema,
  scopeSchema,
} from '../http.js';
import { config } from '../config.js';
import type { Cache } from '../lib/cache.js';
import { verifyToken } from '../lib/jwt.js';
import { rateLimit } from '../lib/ratelimit.js';
import {
  ROW_QUOTA,
  deleteToyData,
  deleteToyScope,
  getToyById,
  getProfileInToy,
  getToyData,
  getUserById,
  listToyData,
  listToyDataLog,
  writeToyData,
  type Toy,
  type ToyDataLogRow,
  type ToyDataRow,
  type UserProfile,
} from '../repos.js';

/**
 * 联机数据接口。
 *
 * 三条不变式：
 *   · 命名空间 = JWT 的 `aud`，用户 = `sub` —— **绝不取请求体里的 toy/uid**
 *     （唯一的例外：toy 作者可以用 ?uid= 指定别人，见 targetUid）
 *   · 读也要令牌；非作者只看得见 `is_public` 的行
 *   · 写别人的行只能走 PATCH，且只动 `open_edit` 里列的字段
 *
 * 额度：普通用户每 toy 128 行，toy 作者 512 行（按**行的属主**算）。
 */

type Caller = { uid: string; toy: Toy; isOwner: boolean };

/** 取出令牌验签，解析出「谁、哪个 toy、是不是作者」 */
async function requireCaller(req: FastifyRequest): Promise<Caller> {
  const token = String(req.headers.authorization || '')
    .replace(/^Bearer\s+/i, '')
    .trim();
  if (!token) throw Errors.unauthorized('缺少 Authorization: Bearer <jwt>');

  let payload;
  try {
    payload = await verifyToken(token);
  } catch {
    throw Errors.unauthorized('令牌无效或已过期');
  }

  const uid = typeof payload.sub === 'string' && payload.sub ? payload.sub : null;
  const toyId = payload.aud ? String(payload.aud) : null;
  if (!uid || !toyId) throw Errors.unauthorized('令牌里缺少 sub / aud');

  const toy = await getToyById(toyId);
  if (!toy) throw Errors.unauthorized('这枚令牌对应的 toy 不存在');
  if (toy.state !== 'verified') throw Errors.toyNotVerified();
  // 用户被删过的话 FK 会挡，这里先给一句人话
  if (!(await getUserById(uid))) throw Errors.unauthorized('这枚令牌对应的用户不存在');

  return { uid, toy, isOwner: toy.owner_uid === uid };
}

/**
 * 这一格属于谁。默认是自己；任何人都可以显式指定 `?uid=`，因为「改别人的行」
 * 本来就是 open_edit 的用法（世界 boss 也是靠这个让大家一起打）。
 *
 * 指定成别人不会自动获得权限 —— 读仍然要求 is_public、写仍然受 open_edit 约束，
 * 只有「创建别人的行」是作者专属（那个判断在 PUT 里）。
 */
async function targetUid(req: FastifyRequest, caller: Caller): Promise<string> {
  const asked = (req.query as Record<string, unknown> | undefined)?.uid;
  if (asked === undefined || asked === null || asked === '') return caller.uid;
  const uid = String(asked);
  if (!(await getUserById(uid))) throw Errors.invalidParam('这个 uid 不存在');
  return uid;
}

function scopeOf(req: FastifyRequest): string {
  const raw = (req.params as Record<string, unknown> | undefined)?.scope;
  const result = scopeSchema.safeParse(raw);
  if (!result.success) throw Errors.invalidParam(result.error.issues[0]?.message ?? 'scope 不合法');
  return result.data;
}

/** 日志行也走 camelCase —— 跟别的接口保持一致，别一半驼峰一半下划线 */
function toWireLog(row: ToyDataLogRow) {
  return {
    id: row.id,
    dataId: row.data_id,
    actorUid: row.actor_uid,
    action: row.action,
    changed: row.changed,
    before: row.before,
    after: row.after,
    createdAt: row.created_at,
  };
}

/** 出参一律 camelCase，别把数据库列名漏出去 */
function toWire(row: ToyDataRow) {
  return {
    uid: row.uid,
    scope: row.scope,
    isPublic: row.is_public,
    openEdit: row.open_edit,
    tagTinyint: row.tag_tinyint,
    tagInt1: row.tag_int1,
    tagInt2: row.tag_int2,
    tagBigint: row.tag_bigint,
    text1: row.text_1,
    text2: row.text_2,
    textLong: row.text_long,
    extra: row.extra,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 额度：按这一行的属主算 —— 属主是 toy 作者给 512，其余 128 */
function quotaFor(caller: Caller, ownerUid: string): number {
  return caller.toy.owner_uid === ownerUid ? ROW_QUOTA.owner : ROW_QUOTA.user;
}

/**
 * 缓存键。单格写完就删；列表只靠 TTL 过期（要枚举「哪些页/tag 受影响」才删得干净，
 * 代价大于收益），所以键里必须把可见性、tag、分页都带上，别让不同视角互相踩。
 */
function rowKey(toyId: string, scope: string, uid: string): string {
  return `kv:row:${toyId}:${scope}:${uid}`;
}

function listKey(
  toyId: string,
  scope: string,
  publicOnly: boolean,
  tagTinyint: number | null,
  page: number,
  size: number,
): string {
  return `kv:list:${toyId}:${scope}:${publicOnly ? 'pub' : 'all'}:${tagTinyint ?? '-'}:${page}:${size}`;
}

export async function dataRoutes(
  app: FastifyInstance,
  opts: { cache: Cache },
): Promise<void> {
  const cache = opts.cache;
  const cacheTtl = config.CACHE_TTL_SECONDS;

  const limit = (caller: Caller, key: string, max: number): void => {
    const r = rateLimit(`kv:${key}:${caller.uid}`, max, 60_000);
    if (!r.ok) throw Errors.rateLimited(r.retryAfter);
  };

  /** 读自己这一格。作者可以 ?uid= 读别人的（包括别人的私有行） */
  app.get('/api/kv/:scope', async (req) => {
    const caller = await requireCaller(req);
    limit(caller, 'read', 240);

    const scope = scopeOf(req);
    const uid = await targetUid(req, caller);

    // getOrFill 自带单飞：热键过期的那一瞬，并发请求只会有一次真的查库
    const row = await cache.getOrFill<ToyDataRow | null>(
      rowKey(caller.toy.toy_id, scope, uid),
      cacheTtl,
      () => getToyData(caller.toy.toy_id, uid, scope),
    );
    if (!row) return { data: null };
    // 缓存里那行可能刚好过点了（缓存 30 秒，过期要即时生效）
    if (new Date(row.expires_at).getTime() <= Date.now()) return { data: null };

    // 非作者读别人的行：必须是公开的
    if (row.uid !== caller.uid && !caller.isOwner && !row.is_public) {
      throw Errors.forbidden('这一格是私有的');
    }
    return { data: toWire(row) };
  });

  /** 列这个 scope 下所有人的格。非作者只看得见公开的那些 */
  app.get('/api/kv/:scope/list', async (req) => {
    const caller = await requireCaller(req);
    limit(caller, 'list', 120);

    const scope = scopeOf(req);
    const { page, size } = parse(pageSchema, req.query);
    const rawTag = (req.query as Record<string, unknown> | undefined)?.tagTinyint;
    const tagTinyint =
      rawTag === undefined || rawTag === '' ? null : Number.parseInt(String(rawTag), 10);

    const tag = Number.isNaN(tagTinyint) ? null : tagTinyint;
    const publicOnly = !caller.isOwner;
    const key = listKey(caller.toy.toy_id, scope, publicOnly, tag, page, size);

    const result = await cache.getOrFill<{ items: ToyDataRow[]; total: number }>(
      key,
      cacheTtl,
      () =>
        listToyData({
          toyId: caller.toy.toy_id,
          scope,
          page,
          size,
          tagTinyint: tag,
          publicOnly,
        }),
    );
    return {
      items: result.items.map(toWire),
      page,
      size,
      total: result.total,
      /** 还有没有下一页 —— 省得作者自己算 page * size < total */
      hasNext: page * size < result.total,
    };
  });

  /** 整行覆盖。属主或 toy 作者；不存在则新建（admin* 只有作者能建） */
  app.put('/api/kv/:scope', async (req) => {
    const caller = await requireCaller(req);
    limit(caller, 'write', 120);

    const scope = scopeOf(req);
    const uid = await targetUid(req, caller);
    const body = parse(kvPutSchema, req.body);

    const existing = await getToyData(caller.toy.toy_id, uid, scope);
    const isOwn = uid === caller.uid;

    if (!existing) {
      if (!isOwn && !caller.isOwner) {
        throw Errors.forbidden('只能创建自己那一格');
      }
      if (scope.startsWith('admin') && !caller.isOwner) {
        throw Errors.forbidden('admin 开头的 scope 只有 toy 作者能创建');
      }
    } else if (!isOwn && !caller.isOwner) {
      throw Errors.forbidden(
        '整行覆盖只有属主和 toy 作者能做；想改别人的行请用 PATCH（受 open_edit 限制）',
      );
    }

    const columns: Record<string, unknown> = {};
    for (const [api, col] of Object.entries(FIELD_TO_COLUMN)) {
      if (api in body) columns[col] = (body as Record<string, unknown>)[api] ?? null;
    }

    const result = await writeToyData({
      toyId: caller.toy.toy_id,
      uid,
      scope,
      actorUid: caller.uid,
      mode: 'put',
      changes: {
        columns,
        isPublic: body.isPublic,
        openEdit: body.openEdit,
        ttlDays: body.ttlDays,
      },
      quota: quotaFor(caller, uid),
    });

    await cache.del(rowKey(caller.toy.toy_id, scope, uid));

    return {
      data: toWire(result.row),
      created: result.created,
      changed: result.changed.map(columnToApi),
    };
  });

  /** 部分更新。属主全字段；别人的行只能动 open_edit 里列的（且动不了 extra） */
  app.patch('/api/kv/:scope', async (req) => {
    const caller = await requireCaller(req);
    limit(caller, 'write', 120);

    const scope = scopeOf(req);
    const uid = await targetUid(req, caller);
    const body = parse(kvPatchSchema, req.body);

    const existing = await getToyData(caller.toy.toy_id, uid, scope);
    if (!existing) throw Errors.notFound('这一格还不存在，请先用 PUT 创建');

    const isOwn = uid === caller.uid;
    const incFields = Object.entries(body.inc ?? {}).filter(
      ([, v]) => typeof v === 'number',
    ) as [string, number][];
    const touched = [
      ...Object.keys(body).filter(
        (k) => k in FIELD_TO_COLUMN || k === 'isPublic' || k === 'openEdit' || k === 'ttlDays',
      ),
      // inc 动的字段也要算进来，否则「别人 inc 一个未开放的字段」就绕过 open_edit 了
      ...incFields.map(([k]) => k),
    ];

    if (!isOwn && !caller.isOwner) {
      const denied = touched.filter((k) => {
        // 可见性、open_edit、有效期都不归别人管
        if (k === 'isPublic' || k === 'openEdit' || k === 'ttlDays') return true;
        const col = FIELD_TO_COLUMN[k];
        return !col || !existing.open_edit.includes(col);
      });
      if (denied.length > 0) {
        throw Errors.forbidden(
          `这几个字段不允许你改：${denied.join(', ')}` +
            (existing.open_edit.length
              ? `。这一格开放的是：${existing.open_edit.join(', ')}`
              : '。这一格没有开放任何字段（只读）'),
        );
      }
    }

    const columns: Record<string, unknown> = {};
    for (const [api, col] of Object.entries(FIELD_TO_COLUMN)) {
      if (api in body) columns[col] = (body as Record<string, unknown>)[api] ?? null;
    }

    // 同一个字段不能既赋值又加减 —— 一个说「等于」，一个说「加上」，没法解释
    const incColumns: Record<string, number> = {};
    for (const [api, delta] of incFields) {
      const col = FIELD_TO_COLUMN[api];
      if (!col) throw Errors.invalidParam(`inc 不支持 ${api}`);
      if (api in body && (body as Record<string, unknown>)[api] !== undefined) {
        throw Errors.invalidParam(
          `${api} 不能同时出现在 inc 和普通字段里：一个是加、一个是赋值`,
        );
      }
      incColumns[col] = delta;
    }

    let result;
    try {
      result = await writeToyData({
        toyId: caller.toy.toy_id,
        uid,
        scope,
        actorUid: caller.uid,
        mode: 'patch',
        changes: {
          columns,
          inc: incColumns,
          isPublic: body.isPublic,
          openEdit: body.openEdit,
          ttlDays: body.ttlDays,
        },
        quota: quotaFor(caller, uid),
      });
    } catch (e) {
      // 加减之后超出列能存的范围。服务端**不做任何业务边界**（血量能不能是负的
      // 是玩具自己的事），只有「存不进去」这一条硬线。
      if ((e as { code?: string } | null)?.code === '22003') {
        throw Errors.invalidParam(
          '加减之后超出了列能存的范围：tag_tinyint 是 0~255、tag_int1 是 ±32767、' +
            'tag_int2 是 ±21 亿。想放更大的数用 tag_bigint',
        );
      }
      throw e;
    }

    await cache.del(rowKey(caller.toy.toy_id, scope, uid));

    return {
      data: toWire(result.row),
      changed: result.changed.map(columnToApi),
    };
  });

  /**
   * 批量取昵称/头像。
   *
   * 数据里只存 uid（作者那边也该只存 id、渲染在本地），要显示名字就来这里换。
   * **只给「在本 toy 出现过的人」** —— uid 是全平台唯一的，放开就成了拿 uid 枚举
   * 全平台资料的入口。
   *
   * 缓存键里必须带 toy：同一个人在不同 toy 的可见性不同，不隔离就等于跨 toy 泄漏。
   */
  app.post('/api/user/profiles', async (req) => {
    const caller = await requireCaller(req);
    limit(caller, 'profile', 120);

    const body = parse(profilesSchema, req.body);
    const uids = [...new Set(body.uids)];

    const found = await Promise.all(
      uids.map((uid) =>
        cache.getOrFill<UserProfile | null>(
          `kv:profile:${caller.toy.toy_id}:${uid}`,
          300, // 昵称改了最多旧 5 分钟，换来的是这一次不用查库
          () => getProfileInToy(caller.toy.toy_id, uid),
        ),
      ),
    );

    return { profiles: found.filter((p): p is UserProfile => p !== null) };
  });

  /** 某一格的改动日志（读权限跟那一格走） */
  app.get('/api/kv/:scope/:uid/log', async (req) => {
    const caller = await requireCaller(req);
    limit(caller, 'log', 120);

    const scope = scopeOf(req);
    const rawUid = (req.params as Record<string, unknown>).uid;
    const uid = String(rawUid);
    const { page, size } = parse(pageSchema, req.query);

    const row = await getToyData(caller.toy.toy_id, uid, scope);
    if (!row) throw Errors.notFound('这一格不存在（或已过期）');
    if (row.uid !== caller.uid && !caller.isOwner && !row.is_public) {
      throw Errors.forbidden('这一格是私有的，看不到它的日志');
    }

    const result = await listToyDataLog(row.id, page, size);
    return {
      items: result.items.map(toWireLog),
      page,
      size,
      total: result.total,
      hasNext: page * size < result.total,
    };
  });

  /** 删一行 —— 属主删自己那格（清空间，不用等过期），toy 作者能删任何一格 */
  app.delete('/api/kv/:scope/:uid', async (req) => {
    const caller = await requireCaller(req);
    limit(caller, 'delete', 30);

    const scope = scopeOf(req);
    const uid = String((req.params as Record<string, unknown>).uid);
    if (!caller.isOwner && uid !== caller.uid) {
      throw Errors.forbidden('只能删自己那一格（toy 作者能删这个 toy 里的任何一格）');
    }
    const gone = await deleteToyData(caller.toy.toy_id, scope, uid);
    if (!gone) throw Errors.notFound('没有这一格');
    await cache.del(rowKey(caller.toy.toy_id, scope, uid));
    // 回带删掉的那一行：客户端要显示「删掉了什么」，而且此刻已经查不到了
    return { deleted: 1, data: toWire(gone) };
  });

  /** 删掉整个 scope（日志跟着级联删）。要显式带 ?all=1，免得手滑 */
  app.delete('/api/kv/:scope', async (req) => {
    const caller = await requireCaller(req);
    limit(caller, 'delete', 30);

    if (!caller.isOwner) throw Errors.forbidden('只有 toy 作者能删数据');
    if (String((req.query as Record<string, unknown> | undefined)?.all ?? '') !== '1') {
      throw Errors.invalidParam('删整个 scope 要显式带 ?all=1');
    }
    const scope = scopeOf(req);
    const n = await deleteToyScope(caller.toy.toy_id, scope);
    return { deleted: n, scope };
  });

  /** 给前端看的时候把列名换回 API 字段名 */
  function columnToApi(col: string): string {
    return (
      Object.entries(FIELD_TO_COLUMN).find(([, c]) => c === col)?.[0] ??
      col.replace(/^is_public$/, 'isPublic').replace(/^open_edit$/, 'openEdit')
    );
  }
}
