import type { FastifyInstance } from 'fastify';
import { ALLOWED_TOKEN_TTL_HOURS, config, DEFAULT_TOKEN_TTL_HOURS } from '../config.js';
import { listPublicJwks } from '../lib/jwt.js';

export async function wellKnownRoutes(app: FastifyInstance): Promise<void> {
  /** 接入方用这个验签。只发公钥。 */
  app.get('/.well-known/jwks.json', async (_req, reply) => {
    const keys = await listPublicJwks();
    reply.header('Cache-Control', 'public, max-age=300');
    return { keys };
  });

  /** 给接入方用的元信息，省得把 issuer 写死在文档里 */
  app.get('/.well-known/xmeta-configuration', async () => ({
    issuer: config.PUBLIC_BASE_URL,
    jwks_uri: `${config.PUBLIC_BASE_URL}/.well-known/jwks.json`,
    /** 接入方把用户送过来的入口 */
    authorization_endpoint: `https://www.bilibili.com/toy/${config.MY_TOY_SLUG}/index.html`,
    token_endpoint: `${config.PUBLIC_BASE_URL}/api/oauth/token`,
    token_endpoint_auth_methods_supported: ['none'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    id_token_signing_alg_values_supported: ['ES256'],
    /** 用户在授权时可选的 token 有效期（小时） */
    token_ttl_hours_options: ALLOWED_TOKEN_TTL_HOURS,
    token_ttl_hours_default: DEFAULT_TOKEN_TTL_HOURS,
    /** 授权码自己的有效期（秒） */
    auth_code_ttl: config.AUTH_CODE_TTL_SECONDS,
    /** 接入方必须校验 aud 等于自己的 toy_id */
    audience: 'toy_id',
  }));

  app.get('/health', async () => ({ ok: true }));
}
