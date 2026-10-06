import { z } from 'zod';
import { ALLOWED_TOKEN_TTL_HOURS } from './config.js';
import { Errors } from './errors.js';

export function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw Errors.invalidParam('请求参数不合法', result.error.issues);
  }
  return result.data;
}

/**
 * 身份载荷。toyOpenId 是**密钥级**的东西：
 * 一旦泄漏，别人就能冒用该用户的身份去换 JWT。
 * 所以它只允许出现在 POST body 里，绝不进 query / 日志。
 */
export const identitySchema = z.object({
  toyOpenId: z
    .string()
    .min(8, 'toyOpenId 太短，可能没开启 OpenID 模式')
    .max(512, 'toyOpenId 过长')
    .regex(/^[\x21-\x7e]+$/, 'toyOpenId 含非法字符'),
  nickname: z.string().max(200).nullish(),
  avatar: z.string().max(1000).nullish(),
});

export const slugSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'slug 只能含字母、数字、下划线和短横线');

export const startClaimSchema = identitySchema.extend({ slug: slugSchema });

export const verifyClaimSchema = identitySchema.extend({ slug: slugSchema });

export const mineSchema = identitySchema.pick({ toyOpenId: true });

/** toy 作者手动刷新 toy 元数据 */
export const refreshToySchema = identitySchema.pick({ toyOpenId: true }).extend({
  slug: slugSchema,
});

export const bridgeAuthorizeSchema = identitySchema.extend({
  cid: z.string().min(1).max(128),
  /**
   * 这一跳的来源 toy_id —— 中心 toy 的授权页从地址上读出来的
   * （App 原生拼的 from_spmid / Web 端 SDK 拼的 spm_id_from）。
   * 必须和 cid 对应的 toy 一致，见 bridge.ts。
   */
  fromToyId: z.string().regex(/^\d+$/, '来源 toy_id 只能是数字'),
  /** 用户选的授权时长（小时），必须落在允许的档位里 */
  ttl: z
    .coerce.number()
    .int()
    .refine((v) => (ALLOWED_TOKEN_TTL_HOURS as readonly number[]).includes(v), {
      message: `授权时长只支持 ${ALLOWED_TOKEN_TTL_HOURS.join(' / ')} 小时`,
    })
    .nullish(),
});

export const introspectSchema = z.object({
  token: z.string().min(1).max(4096),
});

export const tokenSchema = z.object({
  grant_type: z.literal('authorization_code'),
  code: z.string().min(1).max(256),
  client_id: z.string().min(1).max(128),
});
