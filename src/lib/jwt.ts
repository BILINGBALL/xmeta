import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importJWK,
  SignJWT,
  type JWK,
  type KeyLike,
} from 'jose';
import { config } from '../config.js';
import { query, queryOne, withTransaction } from '../db.js';
import { newUuid } from './ids.js';

/**
 * ES256 签名密钥。
 *
 * 用非对称签名而不是 HS256：接入方多半是个纯静态玩具，
 * 拿不到也不该拿到能「签发」的密钥，只能拿公钥验签。
 *
 * 密钥对在首次需要时生成并落库，支持多把共存（kid 区分）以便轮转。
 * 生产环境更稳妥的做法是把私钥放 KMS / 环境变量，这里为了少一个部署依赖先落库。
 */

type KeyRow = {
  kid: string;
  private_jwk: JWK;
  public_jwk: JWK;
};

type ActiveKey = {
  kid: string;
  privateKey: KeyLike;
  publicJwk: JWK;
};

let cached: ActiveKey | null = null;

async function loadOrCreateKey(): Promise<ActiveKey> {
  const existing = await queryOne<KeyRow>(
    `select kid, private_jwk, public_jwk
       from jwt_signing_key
      where retired_at is null
      order by created_at desc
      limit 1`,
  );

  if (existing) {
    const privateKey = (await importJWK(existing.private_jwk, 'ES256')) as KeyLike;
    return { kid: existing.kid, privateKey, publicJwk: existing.public_jwk };
  }

  // 生成新密钥。用 advisory lock 保证多实例并发启动时只生成一把。
  return withTransaction(async (client) => {
    await client.query(`select pg_advisory_xact_lock(hashtext('xmeta:jwt_signing_key'))`);

    const raced = await client.query<KeyRow>(
      `select kid, private_jwk, public_jwk
         from jwt_signing_key
        where retired_at is null
        order by created_at desc
        limit 1`,
    );
    const found = raced.rows[0];
    if (found) {
      const privateKey = (await importJWK(found.private_jwk, 'ES256')) as KeyLike;
      return { kid: found.kid, privateKey, publicJwk: found.public_jwk };
    }

    const { privateKey: priv, publicKey: pub } = await generateKeyPair('ES256', {
      extractable: true,
    });
    const privateJwk = await exportJWK(priv);
    const publicJwk = await exportJWK(pub);
    const kid = await calculateJwkThumbprint(publicJwk, 'sha256');

    publicJwk.kid = kid;
    publicJwk.use = 'sig';
    publicJwk.alg = 'ES256';

    await client.query(
      `insert into jwt_signing_key (kid, alg, private_jwk, public_jwk)
       values ($1, 'ES256', $2::jsonb, $3::jsonb)`,
      [kid, JSON.stringify(privateJwk), JSON.stringify(publicJwk)],
    );

    return { kid, privateKey: priv as KeyLike, publicJwk };
  });
}

export async function getActiveKey(): Promise<ActiveKey> {
  if (!cached) cached = await loadOrCreateKey();
  return cached;
}

export type IssueTokenInput = {
  uid: string;
  /** 目标 toy_id：这个 token 只对这一个 toy 有效 */
  audience: string;
};

export type IssuedToken = {
  accessToken: string;
  expiresIn: number;
  jti: string;
};

export async function issueToken({ uid, audience }: IssueTokenInput): Promise<IssuedToken> {
  const { kid, privateKey } = await getActiveKey();
  const jti = newUuid();
  const now = Math.floor(Date.now() / 1000);

  const accessToken = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
    .setIssuer(config.PUBLIC_BASE_URL)
    .setSubject(uid)
    .setAudience(audience)
    .setJti(jti)
    .setIssuedAt(now)
    .setExpirationTime(now + config.JWT_TTL_SECONDS)
    .sign(privateKey);

  return { accessToken, expiresIn: config.JWT_TTL_SECONDS, jti };
}

/** 全部未退休的公钥，供 JWKS 端点发布 */
export async function listPublicJwks(): Promise<JWK[]> {
  const res = await query<{ public_jwk: JWK }>(
    `select public_jwk from jwt_signing_key where retired_at is null order by created_at desc`,
  );
  return res.rows.map((r) => r.public_jwk);
}
