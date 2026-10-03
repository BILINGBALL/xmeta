import assert from 'node:assert/strict';
import { createHash, randomBytes, randomInt } from 'node:crypto';
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
 * B站的接口和外网抓取用桩替代，其余（DB、状态机、PKCE、签名）都是真的。
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
      title: '测试玩具',
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

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

before(async () => {
  await runMigrations();
  app = await buildApp({ bili: stubBili });
  await app.ready();
});

after(async () => {
  const openIds = [AUTHOR_OPENID, PLAYER_OPENID];
  // 先清引用，再删主体；toy 删除会级联到 toy_claim / toy_client
  await pool.query(
    `delete from auth_code
      where uid in (select id from app_user where toy_open_id = any($1::text[]))`,
    [openIds],
  );
  await pool.query(`delete from toy where toy_id = $1`, [TOY_ID]);
  await pool.query(`delete from app_user where toy_open_id = any($1::text[])`, [openIds]);

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
    toyOpenId: PLAYER_OPENID,
    nickname: '玩家',
  });

  assert.equal(status, 200);
  assert.ok(json.code);
  // 回跳目标必须由服务端给出，不能被调用方指定
  assert.equal(json.returnSlug, SLUG);
});

test('PKCE 校验失败的 code 会被烧掉', async () => {
  const { challenge } = pkce();
  const { json: auth } = await post('/api/bridge/authorize', {
    cid: clientId,
    toyOpenId: PLAYER_OPENID,
    cc: challenge,
  });

  const wrong = pkce();
  const { status, json } = await post('/api/oauth/token', {
    grant_type: 'authorization_code',
    code: auth.code,
    client_id: clientId,
    code_verifier: wrong.verifier,
  });

  assert.equal(status, 400);
  assert.equal(json.error.code, 'pkce_mismatch');

  // 再用正确的 verifier 也不行——code 已经作废
  const retry = await post('/api/oauth/token', {
    grant_type: 'authorization_code',
    code: auth.code,
    client_id: clientId,
    code_verifier: wrong.verifier,
  });
  assert.equal(retry.json.error.code, 'code_used');
});

test('换 JWT：签名与 claims 都正确', async () => {
  const { verifier, challenge } = pkce();

  const { json: auth } = await post('/api/bridge/authorize', {
    cid: clientId,
    toyOpenId: PLAYER_OPENID,
    cc: challenge,
    st: 'state-abc',
  });

  const { status, json } = await post('/api/oauth/token', {
    grant_type: 'authorization_code',
    code: auth.code,
    client_id: clientId,
    code_verifier: verifier,
  });

  assert.equal(status, 200);
  assert.equal(json.token_type, 'Bearer');
  assert.equal(json.audience, TOY_ID);
  assert.equal(json.state, 'state-abc', 'state 应该原样回传');

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
    'token 不能被用于 aud 之外的玩具',
  );
});

test('授权码是一次性的', async () => {
  const { json: auth } = await post('/api/bridge/authorize', {
    cid: clientId,
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

test('未认领的玩具不能过桥', async () => {
  const { status, json } = await post('/api/bridge/authorize', {
    cid: 'xmeta_does_not_exist',
    toyOpenId: PLAYER_OPENID,
  });

  assert.equal(status, 404);
  assert.equal(json.error.code, 'client_not_found');
});
