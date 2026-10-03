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
  console.error(`[ucs] 环境变量校验失败：\n${issues}\n\n请检查 .env（可参考 .env.example）`);
  process.exit(1);
}

const env = parsed.data;

if (env.MY_TOY_ID === '0' || env.MY_TOY_SLUG === 'CHANGE_ME') {
  console.warn(
    '[ucs] 警告：MY_TOY_ID / MY_TOY_SLUG 还是占位值。\n' +
      '      身份锚点没配好之前，认领和过桥拿到的身份都无法正确归档。',
  );
}

export const config = {
  ...env,
  allowedOrigins: env.ALLOWED_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  isProd: process.env.NODE_ENV === 'production',
};
