import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { importJWK, jwtVerify, type JWK } from 'jose';

import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { pool } from '../src/db.js';
import type { BiliDeps } from '../src/deps.js';
import { runMigrations } from '../src/scripts/migrate.js';

/**
 * 端到端跑通整条链：
 *   认领（start → verify）→ 过桥 authorize → 换 code 拿 JWT → 用 JWKS 验签
 *
 * B站的接口和外网抓取用桩替代，其余（DB、状态机、签名）都是真的。
 */

const RUN = randomBytes(4).toString('hex');
const SLUG = `testtoy${RUN}`;
const TOY_ID = String(randomInt(1_000_000_000_000, 9_000_000_000_000));
const AUTHOR_OPENID = `author_${RUN}_openid`;
const PLAYER_OPENID = `player_${RUN}_openid`;

let app: FastifyInstance;
let nonce = '';
let clientId = '';

const stubBili: BiliDeps = {
  async fetchToyDetail(slug) {
    if (slug !== SLUG) return null;
    return {
      toyId: TOY_ID,
      slug,
      title: '测试 toy',
      iconUrl: null,
      version: 1,
      authorMid: '12345',
      authorName: '测试作者',
      authorFace: null,
    };
  },
  async fetchToySource(slug) {
    return {
      shellUrl: `https://www.bilibili.com/toy/${slug}/index.html`,
      contentUrl: `https://www.bilibilitoy.com/toy/${slug}/${TOY_ID}-v1/index.html`,
      // nonce 在 start 阶段才生成，所以这里在调用时读取
      html: `<html><head><meta name="xmeta-verify" content="${nonce}"></head><body>toy</body></html>`,
    };
  },
};

async function post(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await app.inject({
    method: 'POST',
    url,
    payload: body as object,
    headers: { 'content-type': 'application/json' },
  });
  return { status: res.statusCode, json: JSON.parse(res.body) };
}

before(async () => {
  await runMigrations();
  app = await buildApp({ bili: stubBili });
  await app.ready();
});

after(async () => {
  // 联机数据那几个用例会临时造人（stranger_/friend_/quota_/nosy_…），
  // 它们的 openid 都带这一轮的 RUN —— 一并清掉，别留垃圾用户污染统计。
  const suffix = `%_${RUN}_openid`;
  // 先清引用再删主体：auth_code 指向 toy_client，不清掉删不动 toy
  await pool.query(`delete from auth_code where client_id = $1`, [clientId]);
  await pool.query(`delete from toy where toy_id = $1`, [TOY_ID]);
  await pool.query(`delete from app_user where home_toy_id = $1 and toy_open_id like $2`, [
    config.MY_TOY_ID,
    suffix,
  ]);

  await app.close();
  await pool.end();
});

test('认领第一步：下发一次性 nonce', async () => {
  const { status, json } = await post('/api/claim/start', {
    slug: SLUG,
    toyOpenId: AUTHOR_OPENID,
    nickname: '测试作者',
  });

  assert.equal(status, 200);
  assert.equal(json.state, 'pending');
  assert.equal(json.toyId, TOY_ID);
  assert.ok(json.nonce, '应该下发 nonce');
  assert.match(json.nonce, /^[A-Za-z0-9]+$/, 'nonce 必须是 HTML 安全的字符集');
  nonce = json.nonce;
});

test('中途退出再进来，验证码不变', async () => {
  // 重新发布一次 toy 要十几分钟，用户中途退出是常态。
  // 如果这里换了 nonce，他已经发布出去的那个就作废了，
  // 之后验证只会得到一个莫名其妙的「源码里没找到验证码」。
  const { status, json } = await post('/api/claim/start', {
    slug: SLUG,
    toyOpenId: AUTHOR_OPENID,
    nickname: '测试作者',
  });

  assert.equal(status, 200);
  assert.equal(json.state, 'pending');
  assert.equal(json.reused, true, '应该标明是沿用上次的验证码');
  assert.equal(json.nonce, nonce, '同一个用户 + 同一个 toy 必须拿到同一个验证码');
});

test('认领第二步：源码里搜到 nonce 才放行', async () => {
  const { status, json } = await post('/api/claim/verify', {
    slug: SLUG,
    toyOpenId: AUTHOR_OPENID,
  });

  assert.equal(status, 200);
  assert.equal(json.state, 'verified');
  assert.ok(json.clientId, '应该下发 client_id');
  clientId = json.clientId;
});

test('已认领的 toy 不再接受第二个认领人', async () => {
  const { status, json } = await post('/api/claim/start', {
    slug: SLUG,
    toyOpenId: PLAYER_OPENID,
  });

  assert.equal(status, 409);
  assert.equal(json.error.code, 'toy_already_claimed');
});

test('原作者可以查询自己认领了哪些 toy', async () => {
  const { status, json } = await post('/api/toy/mine', { toyOpenId: AUTHOR_OPENID });

  assert.equal(status, 200);
  assert.equal(json.toys.length, 1);
  assert.equal(json.toys[0].slug, SLUG);
  assert.equal(json.toys[0].clientId, clientId);
});

test('过桥：玩家的 toyOpenId 换到一次性 code', async () => {
  const { status, json } = await post('/api/bridge/authorize', {
    cid: clientId,
    fromToyId: TOY_ID,
    toyOpenId: PLAYER_OPENID,
    nickname: '玩家',
  });

  assert.equal(status, 200);
  assert.ok(json.code);
  // 回跳目标必须由服务端给出，不能被调用方指定
  assert.equal(json.returnSlug, SLUG);
});

test('client_id 对不上的兑换失败，而且 code 会被烧掉', async () => {
  const { json: auth } = await post('/api/bridge/authorize', {
    cid: clientId,
    fromToyId: TOY_ID,
    toyOpenId: PLAYER_OPENID,
  });

  const { status, json } = await post('/api/oauth/token', {
    grant_type: 'authorization_code',
    code: auth.code,
    client_id: 'xmeta_someone_else',
  });

  assert.equal(status, 400);
  assert.equal(json.error.code, 'invalid_code');

  // code 取走即作废，再用对的 client_id 也不行
  const retry = await post('/api/oauth/token', {
    grant_type: 'authorization_code',
    code: auth.code,
    client_id: clientId,
  });
  assert.equal(retry.json.error.code, 'code_used');
});

test('换 JWT：签名与 claims 都正确', async () => {

  const { json: auth } = await post('/api/bridge/authorize', {
    cid: clientId,
    fromToyId: TOY_ID,
    toyOpenId: PLAYER_OPENID,
  });

  const { status, json } = await post('/api/oauth/token', {
    grant_type: 'authorization_code',
    code: auth.code,
    client_id: clientId,
  });

  assert.equal(status, 200);
  assert.equal(json.token_type, 'Bearer');
  assert.equal(json.audience, TOY_ID);

  // 用发布的 JWKS 验签
  const jwksRes = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
  const { keys } = JSON.parse(jwksRes.body) as { keys: JWK[] };
  assert.ok(keys.length >= 1);

  const key = await importJWK(keys[0]!, 'ES256');
  const { payload, protectedHeader } = await jwtVerify(json.access_token, key, {
    issuer: config.PUBLIC_BASE_URL,
    audience: TOY_ID,
  });

  assert.equal(protectedHeader.alg, 'ES256');
  assert.equal(protectedHeader.kid, keys[0]!.kid);
  assert.ok(payload.sub, 'sub 应该是 uid');
  assert.ok(payload.jti);
  assert.equal(payload.aud, TOY_ID);

  // aud 绑定：拿同一个 token 去验另一个 toy 的 audience 必须失败
  await assert.rejects(
    jwtVerify(json.access_token, key, { audience: '999999999999' }),
    'token 不能被用于 aud 之外的 toy',
  );
});

test('授权码是一次性的', async () => {
  const { json: auth } = await post('/api/bridge/authorize', {
    cid: clientId,
    fromToyId: TOY_ID,
    toyOpenId: PLAYER_OPENID,
  });

  const first = await post('/api/oauth/token', {
    grant_type: 'authorization_code',
    code: auth.code,
    client_id: clientId,
  });
  assert.equal(first.status, 200);

  const second = await post('/api/oauth/token', {
    grant_type: 'authorization_code',
    code: auth.code,
    client_id: clientId,
  });
  assert.equal(second.status, 409);
  assert.equal(second.json.error.code, 'code_used');
});
/** 走一遍过桥，拿一枚 access token */
async function bridgeOnce(ttlHours?: number): Promise<{ accessToken: string; expiresIn: number }> {
  const { json: auth } = await post('/api/bridge/authorize', {
    cid: clientId,
    fromToyId: TOY_ID,
    toyOpenId: PLAYER_OPENID,
    ...(ttlHours ? { ttl: ttlHours } : {}),
  });
  const { json } = await post('/api/oauth/token', {
    grant_type: 'authorization_code',
    code: auth.code,
    client_id: clientId,
  });
  return { accessToken: json.access_token, expiresIn: json.expires_in };
}

test('用户选的授权时长会体现在 token 的有效期上', async () => {
  assert.equal((await bridgeOnce(3)).expiresIn, 3 * 3600);
  assert.equal((await bridgeOnce(12)).expiresIn, 12 * 3600);
  assert.equal((await bridgeOnce(24)).expiresIn, 24 * 3600);
});

test('用户没选时用默认的 6 小时', async () => {
  assert.equal((await bridgeOnce()).expiresIn, 6 * 3600);
});

test('不在档位里的时长会被服务端拒绝', async () => {
  const { status, json } = await post('/api/bridge/authorize', {
    cid: clientId,
    fromToyId: TOY_ID,
    toyOpenId: PLAYER_OPENID,
    ttl: 5,
  });
  assert.equal(status, 400);
  assert.equal(json.error.code, 'invalid_param');
});

test('被篡改的 token 在 introspect 里一律无效', async () => {
  const { accessToken } = await bridgeOnce();
  const tampered = accessToken.slice(0, -4) + 'AAAA';
  const { json } = await post('/api/oauth/introspect', { token: tampered });
  assert.equal(json.active, false);
});

test('拿别的字符串也能安全地问，不会报错', async () => {
  const { status, json } = await post('/api/oauth/introspect', { token: 'not-a-jwt' });
  assert.equal(status, 200);
  assert.equal(json.active, false);
});


test('个人中心：一次请求拿全身份、使用记录', async () => {
  const { status, json } = await post('/api/me', { toyOpenId: PLAYER_OPENID });

  assert.equal(status, 200);
  assert.ok(json.user, '玩家已经有身份了');
  assert.ok(json.user.uid, '要有 uid');
  assert.ok(json.usage.length >= 1, '应该有用过这个 toy 的记录');

  const row = json.usage.find((u: any) => u.slug === SLUG);
  assert.ok(row, '使用记录里应该有这个 toy');
  assert.ok(row.clientId, '要带上 clientId');
  assert.ok(row.lastUsedAt, '要有最近使用时间');
  assert.ok(row.uses >= 1);
});

test('个人中心：作者视角能看到自己认领的 toy', async () => {
  const { json } = await post('/api/me', { toyOpenId: AUTHOR_OPENID });

  assert.equal(json.ownedToys.length, 1);
  assert.equal(json.ownedToys[0].slug, SLUG);
  assert.equal(json.ownedToys[0].clientId, clientId);
  assert.equal(json.ownedToys[0].state, 'verified');
});

test('个人中心：没见过的身份返回空壳而不是报错', async () => {
  const { status, json } = await post('/api/me', { toyOpenId: 'toid_never_seen_zzz9' });

  assert.equal(status, 200);
  assert.equal(json.user, null);
  assert.deepEqual(json.ownedToys, []);
  assert.deepEqual(json.usage, []);
});

test('未认领的 toy 不能过桥', async () => {
  const { status, json } = await post('/api/bridge/authorize', {
    cid: 'xmeta_does_not_exist',
    fromToyId: TOY_ID,
    toyOpenId: PLAYER_OPENID,
  });

  assert.equal(status, 404);
  assert.equal(json.error.code, 'client_not_found');
});

test('统计接口：五个数都在，且随发放增长', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/stats' });
  assert.equal(res.statusCode, 200);

  const stats = JSON.parse(res.body) as {
    toys: number;
    users: number;
    toyServices: number;
    tokens: number;
    guardSeconds: number;
  };
  assert.deepEqual(
    Object.keys(stats).sort(),
    ['guardSeconds', 'tokens', 'toyServices', 'toys', 'users'],
  );
  for (const [k, v] of Object.entries(stats)) {
    assert.equal(typeof v, 'number', `${k} 应该是数字，不是字符串`);
    assert.ok(v >= 0, `${k} 不该是负数`);
  }

  // 库里有真实数据，所以只能断言「至少」：这一轮 e2e 至少造了一个 toy、
  // 两个用户（作者 + 玩家），发放过带时长的凭证
  assert.ok(stats.toys >= 1, '至少这一个测试 toy');
  assert.ok(stats.users >= 2, '至少作者和玩家两个用户');
  assert.ok(stats.toyServices >= 1, '至少一对「用户 × toy」');
  assert.ok(stats.tokens >= 1, '至少发过一次凭证');
  assert.ok(stats.guardSeconds >= 3 * 3600, '至少发过一张 3 小时的凭证');
});

test('来源 toy 和 client_id 对不上：拒签，且不透露原 toy 的 id', async () => {
  const { status, json } = await post('/api/bridge/authorize', {
    cid: clientId,
    fromToyId: '123456789012',   // 别人的 toy
    toyOpenId: PLAYER_OPENID,
  });

  assert.equal(status, 403);
  assert.equal(json.error.code, 'source_toy_mismatch');
  // 提示里不能回带原 toy 的 id —— 那等于告诉抄包体的人该伪造什么
  assert.ok(!String(json.error.message).includes(TOY_ID), '不该透露原 toy 的 id');
});

test('fromToyId 缺失或不是数字：参数校验挡下', async () => {
  const missing = await post('/api/bridge/authorize', {
    cid: clientId,
    toyOpenId: PLAYER_OPENID,
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error.code, 'invalid_param');

  const notNumber = await post('/api/bridge/authorize', {
    cid: clientId,
    fromToyId: 'abc',
    toyOpenId: PLAYER_OPENID,
  });
  assert.equal(notNumber.status, 400);
});

// ─────────────────────────────────────────────────────────────
// 联机数据（/api/kv）：权限矩阵
// ─────────────────────────────────────────────────────────────

/** 从令牌里解出 uid（payload 是 base64url，测试里直接拆） */
function uidOf(token: string): string {
  const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
  return String(payload.sub);
}

/** 换一枚令牌：过桥 → code → token。toyOpenId 不同 = 不同的人 */
async function tokenFor(toyOpenId: string): Promise<string> {
  const { json: auth } = await post('/api/bridge/authorize', {
    cid: clientId,
    fromToyId: TOY_ID,
    toyOpenId,
  });
  const { json } = await post('/api/oauth/token', {
    grant_type: 'authorization_code',
    code: auth.code,
    client_id: clientId,
  });
  return String(json.access_token);
}

async function kv(
  method: 'GET' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await app.inject({
    method,
    url: path,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { payload: body as object }),
  });
  let json: any = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    json = res.body;
  }
  return { status: res.statusCode, json };
}

test('数据：没有令牌一律 401', async () => {
  assert.equal((await kv('GET', '/api/kv/package', null)).status, 401);
  assert.equal((await kv('PUT', '/api/kv/package', null, { text1: 'x' })).status, 401);
});

test('数据：PUT 建自己的格、GET 读回来，字段语义正确', async () => {
  const token = await tokenFor(PLAYER_OPENID);

  const put = await kv('PUT', '/api/kv/package', token, {
    ttlDays: 3,
    text1: '我的背包',
    tagTinyint: 1,
    tagBigint: '123456789012345',
    extra: { items: ['sword', 'shield'] },
  });
  assert.equal(put.status, 200);
  assert.equal(put.json.created, true);
  assert.equal(put.json.data.scope, 'package');
  assert.equal(put.json.data.isPublic, false, '默认私有');
  assert.deepEqual(put.json.data.openEdit, []);
  assert.equal(put.json.data.tagBigint, '123456789012345', 'bigint 用字符串往返');

  const got = await kv('GET', '/api/kv/package', token);
  assert.equal(got.status, 200);
  assert.equal(got.json.data.text1, '我的背包');
  assert.deepEqual(got.json.data.extra, { items: ['sword', 'shield'] });

  const span =
    (new Date(got.json.data.expiresAt).getTime() - new Date(got.json.data.createdAt).getTime()) /
    86400000;
  assert.ok(Math.abs(span - 3) < 0.01, `有效期应该是 3 天，实际 ${span}`);
});

test('数据：私有格别人读不到（作者除外）', async () => {
  const player = await tokenFor(PLAYER_OPENID);
  const author = await tokenFor(AUTHOR_OPENID);
  const stranger = await tokenFor(`stranger_${RUN}_openid`);
  const uid = uidOf(await tokenFor(PLAYER_OPENID));

  await kv('PUT', '/api/kv/secret', player, { text1: '只有我看得到' });

  // 作者有最高权限，能读玩家的私有行
  assert.equal((await kv('GET', `/api/kv/secret?uid=${uid}`, author)).status, 200);

  // 别的玩家读不到
  const denied = await kv('GET', `/api/kv/secret?uid=${uid}`, stranger);
  assert.equal(denied.status, 403);
  assert.ok(String(denied.json.error.message).includes('私有'));

  // 陌生人读自己那一格：不存在，但不是错误
  const own = await kv('GET', '/api/kv/secret', stranger);
  assert.equal(own.status, 200);
  assert.equal(own.json.data, null);

  // 列表里也看不到别人的私有行
  const list = await kv('GET', '/api/kv/secret/list', stranger);
  assert.equal(list.json.total, 0, '非作者只列 is_public 的行');
  const asAuthor = await kv('GET', '/api/kv/secret/list', author);
  assert.equal(asAuthor.json.total, 1, '作者看得全');
});

test('数据：open_edit 只放开口子里列的字段，extra 永远改不了', async () => {
  const owner = await tokenFor(PLAYER_OPENID);
  const friend = await tokenFor(`friend_${RUN}_openid`);
  const target = `/api/kv/board?uid=${uidOf(owner)}`;

  await kv('PUT', '/api/kv/board', owner, {
    isPublic: true,
    openEdit: ['tag_int1'],
    tagInt1: 10,
    text1: '原标题',
    extra: { by: 'owner' },
  });

  // 别人改开放字段：可以
  const hit = await kv('PATCH', target, friend, { tagInt1: 20 });
  assert.equal(hit.status, 200);
  assert.equal(hit.json.data.tagInt1, 20);

  // 没开放的字段：403，报错要说清是哪个字段
  const denied = await kv('PATCH', target, friend, { text1: '我要改标题' });
  assert.equal(denied.status, 403);
  assert.ok(String(denied.json.error.message).includes('text1'));

  // extra 永远不在白名单里
  assert.equal((await kv('PATCH', target, friend, { extra: { hijack: true } })).status, 403);

  // 也不能整行覆盖
  assert.equal((await kv('PUT', target, friend, { text1: '全清掉' })).status, 403);

  // 属主自己不受限制
  assert.equal((await kv('PUT', '/api/kv/board', owner, { text1: '我说了算' })).status, 200);
});

test('数据：admin* 只有作者能创建，但开放字段谁都能改', async () => {
  const player = await tokenFor(PLAYER_OPENID);
  const author = await tokenFor(AUTHOR_OPENID);

  assert.equal((await kv('PUT', '/api/kv/admin_world', player, { tagInt1: 100 })).status, 403);

  const created = await kv('PUT', '/api/kv/admin_world', author, {
    isPublic: true,
    openEdit: ['tag_int1'],
    tagInt1: 100,
  });
  assert.equal(created.status, 200, '作者可以建 admin scope');

  // 世界 boss：作者开了血量，玩家就能打
  const hit = await kv('PATCH', `/api/kv/admin_world?uid=${uidOf(author)}`, player, {
    tagInt1: 99,
  });
  assert.equal(hit.status, 200);
  assert.equal(hit.json.data.tagInt1, 99);
});

test('数据：改动留日志，权限跟那一格走', async () => {
  const player = await tokenFor(PLAYER_OPENID);
  const stranger = await tokenFor(`nosy_${RUN}_openid`);
  const uid = uidOf(player);

  await kv('PUT', '/api/kv/logs', player, { ttlDays: 1, isPublic: true, text1: '第一版' });
  await kv('PATCH', '/api/kv/logs', player, { text1: '第二版', tagInt1: 7 });

  const mine = await kv('GET', `/api/kv/logs/${uid}/log`, player);
  assert.equal(mine.status, 200);
  assert.equal(mine.json.total, 2, 'create + update 各一条');
  const [latest, first] = mine.json.items;
  assert.equal(latest.action, 'update');
  assert.deepEqual([...latest.changed].sort(), ['tag_int1', 'text_1']);
  assert.equal(latest.before.text_1, '第一版', '日志存的是改动前后的值');
  assert.equal(latest.after.text_1, '第二版');
  assert.equal(first.action, 'create');

  // 公开的格，别人看得到它的日志
  assert.equal((await kv('GET', `/api/kv/logs/${uid}/log`, stranger)).status, 200);

  // 私有格的日志，别人看不到
  await kv('PUT', '/api/kv/private_log', player, { text1: '私有' });
  await kv('PATCH', '/api/kv/private_log', player, { text1: '改了' });
  assert.equal((await kv('GET', `/api/kv/private_log/${uid}/log`, stranger)).status, 403);
});

test('数据：额度 64 行，超了报 quota_exceeded', async () => {
  // 用一个干净的人，别被前面几个用例建的行影响计数
  const fresh = await tokenFor(`quota_${RUN}_openid`);

  for (let i = 0; i < 64; i++) {
    const res = await kv('PUT', `/api/kv/bag${i}`, fresh, { tagInt1: i });
    assert.equal(res.status, 200, `第 ${i + 1} 行应该能建`);
  }

  const over = await kv('PUT', '/api/kv/bag99', fresh, { tagInt1: 999 });
  assert.equal(over.status, 409);
  assert.equal(over.json.error.code, 'quota_exceeded');
  assert.ok(String(over.json.error.message).includes('64'));
});

test('数据：删除只有作者能用，且分页有上限', async () => {
  const player = await tokenFor(PLAYER_OPENID);
  const author = await tokenFor(AUTHOR_OPENID);
  const uid = uidOf(player);

  assert.equal((await kv('DELETE', `/api/kv/package/${uid}`, player)).status, 403, '玩家不能删');
  assert.equal(
    (await kv('DELETE', '/api/kv/package', author)).status,
    400,
    '删整个 scope 要显式带 ?all=1',
  );

  const byAuthor = await kv('DELETE', `/api/kv/package?all=1`, author);
  assert.equal(byAuthor.status, 200);
  assert.ok(byAuthor.json.deleted >= 1, '作者能删掉整个 scope');
  assert.equal((await kv('GET', '/api/kv/package', player)).json.data, null, '删干净了');

  assert.equal((await kv('GET', '/api/kv/package/list?size=200', player)).status, 400);
});

test('数据：scope 不合法、extra 过大、text 过长都会被参数校验挡下', async () => {
  const player = await tokenFor(PLAYER_OPENID);

  assert.equal((await kv('PUT', '/api/kv/BadScope', player, {})).status, 400, '大写不行');
  assert.equal(
    (await kv('PUT', '/api/kv/package', player, { extra: { blob: 'x'.repeat(3000) } })).status,
    400,
    'extra 超 2048 字节',
  );
  assert.equal(
    (await kv('PUT', '/api/kv/package', player, { text1: 'x'.repeat(129) })).status,
    400,
    'text_1 超 128 字符',
  );
  assert.equal(
    (await kv('PUT', '/api/kv/package', player, { openEdit: ['extra'] })).status,
    400,
    'extra 不许进 open_edit',
  );
});

test('CORS：数据接口的预检要放行方法和 Authorization 头', async () => {
  for (const [method, url] of [
    ['PATCH', '/api/kv/package'],
    ['PUT', '/api/kv/package'],
    ['DELETE', '/api/kv/package'],
    ['GET', '/api/kv/package'],
  ] as const) {
    const res = await app.inject({
      method: 'OPTIONS',
      url,
      headers: {
        origin: 'https://www.bilibilitoy.com',
        'access-control-request-method': method,
        'access-control-request-headers': 'authorization,content-type',
      },
    });

    assert.equal(res.statusCode, 204, `${method} ${url} 的预检`);
    assert.equal(
      res.headers['access-control-allow-origin'],
      'https://www.bilibilitoy.com',
    );
    const allowedMethods = String(res.headers['access-control-allow-methods'] ?? '');
    assert.ok(allowedMethods.includes(method), `${method} 要在 allow-methods 里：${allowedMethods}`);
    const allowedHeaders = String(res.headers['access-control-allow-headers'] ?? '').toLowerCase();
    assert.ok(allowedHeaders.includes('authorization'), `allow-headers 要含 authorization：${allowedHeaders}`);
  }
});
