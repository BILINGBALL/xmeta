import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL 未配置'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8787),
  /** 对外可访问的基址，必须与真实部署一致（用于拼回调地址、JWT iss） */
  PUBLIC_BASE_URL: z.string().url(),
  /** 我的 toy 的 toy_id；所有身份都锚定在它的 toyOpenId 上 */
  MY_TOY_ID: z.string().regex(/^\d+$/, 'MY_TOY_ID 必须是数字'),
  MY_TOY_SLUG: z.string().min(1),
  ALLOWED_ORIGINS: z.string().default('https://www.bilibilitoy.com'),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  AUTH_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  /**
   * 可选的 Redis。**不配就纯走库** —— 读缓存空转，其余功能一切照旧。
   * 生产上建议绑在本机的 127.0.0.1，并开 AOF。
   */
  REDIS_URL: z.string().url().optional(),
  /** 联机数据的读缓存 TTL（秒）。列表只靠它过期，单格是写完主动删 */
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(30),
  CLAIM_NONCE_TTL_HOURS: z.coerce.number().int().positive().default(24),
  CLAIM_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  /**
   * 是否信任 X-Forwarded-For。只有在服务确实位于反向代理（nginx / SLB）后面时才开，
   * 否则客户端可以伪造 IP 绕过限流。
   */
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  console.error(`[xmeta] 环境变量校验失败：\n${issues}\n\n请检查 .env（可参考 .env.example）`);
  process.exit(1);
}

const env = parsed.data;

/** .env.example 里的占位值。身份锚点没配不会崩，但所有身份都会归错档。 */
const PLACEHOLDER_SLUGS = new Set(['CHANGE_ME', 'xxxxxxxxxxxxxxxx', '']);

const anchorProblems: string[] = [];
if (env.MY_TOY_ID === '0') anchorProblems.push('MY_TOY_ID 还是 0');
if (PLACEHOLDER_SLUGS.has(env.MY_TOY_SLUG)) anchorProblems.push('MY_TOY_SLUG 还是占位值');

if (anchorProblems.length > 0) {
  console.warn(
    `[xmeta] 警告：身份锚点没配好 —— ${anchorProblems.join('、')}\n` +
      '      这两个值必须指向你的中心 toy：\n' +
      '        MY_TOY_ID  = 中心 toy 的 toy_id（数字）\n' +
      '        MY_TOY_SLUG= 中心 toy 的 slug\n' +
      '      没配好之前，认领和过桥拿到的身份都无法正确归档。',
  );
}

export const config = {
  ...env,
  allowedOrigins: env.ALLOWED_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  isProd: process.env.NODE_ENV === 'production',
};

/**
 * 用户在授权时能选的有效期（小时）。
 *
 * 24 是上限，意味着用户每天都要回中心 toy 续一次 —— 这是刻意的：
 * 不用刷新令牌把用户一直留在登录态，而是把「这次授权管多久」
 * 交给用户自己决定。
 *
 * 改这个数组就等于改可选档位，服务端会按它校验，前端也从这里取。
 */
export const ALLOWED_TOKEN_TTL_HOURS = [3, 6, 12, 24] as const;

export const DEFAULT_TOKEN_TTL_HOURS = 6;
