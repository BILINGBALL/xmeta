import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  SignJWT,
  type JWK,
  type JWTPayload,
  type KeyLike,
} from 'jose';
import { config } from '../config.js';
import { query, queryOne, withTransaction } from '../db.js';
import { newUuid } from './ids.js';

/**
 * ES256 签名密钥。
 *
 * 用非对称签名而不是 HS256：接入方多半是个纯静态 toy，
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
  /** 有效期（秒）。不传就用全局默认（JWT_TTL_SECONDS）。 */
  ttlSeconds?: number;
};

export type IssuedToken = {
  accessToken: string;
  expiresIn: number;
  jti: string;
};

export async function issueToken({
  uid,
  audience,
  ttlSeconds,
}: IssueTokenInput): Promise<IssuedToken> {
  const { kid, privateKey } = await getActiveKey();
  const jti = newUuid();
  // iat 取整到秒（标准 NumericDate，第三方验签库不吃小数），
  // 亚秒精度单独放一个私有 claim `iat_ms`。
  //
  // 失活判断靠「签发时刻 vs 失活时间点」做亚秒级比较（见 introspect）。
  // 如果只留整秒 iat，同一秒内签发的 token 就分不清是在失活前还是后，
  // 结果是刚失活完重新授权拿到的 token 会被误杀。
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const ttl = ttlSeconds ?? config.JWT_TTL_SECONDS;

  const accessToken = await new SignJWT({ iat_ms: nowMs })
    .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
    .setIssuer(config.PUBLIC_BASE_URL)
    .setSubject(uid)
    .setAudience(audience)
    .setJti(jti)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + ttl)
    .sign(privateKey);

  return { accessToken, expiresIn: ttl, jti };
}

/** 全部未退休的公钥，供 JWKS 端点发布 */
export async function listPublicJwks(): Promise<JWK[]> {
  const res = await query<{ public_jwk: JWK }>(
    `select public_jwk from jwt_signing_key where retired_at is null order by created_at desc`,
  );
  return res.rows.map((r) => r.public_jwk);
}

/**
 * 校验一枚自家签发的 token。用于 introspect 端点。
 *
 * 只校验签名和 iss —— aud 由调用方自己比对（introspect 的场景是
 * 「这枚 token 还有效吗」，不是「它是不是给这个 toy 的」）。
 *
 * 注意这里**不查失活名单**：那是调用方的事，因为判断依据是
 * token 的 iat 和 token_revocation 的时间点，属于业务逻辑。
 */
export async function verifyToken(token: string): Promise<JWTPayload> {
  const jwks = createLocalJWKSet({ keys: await listPublicJwks() });
  const { payload } = await jwtVerify(token, jwks, {
    issuer: config.PUBLIC_BASE_URL,
  });
  return payload;
}
