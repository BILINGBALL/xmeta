import { z } from 'zod';
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

export const bridgeAuthorizeSchema = identitySchema.extend({
  cid: z.string().min(1).max(128),
  /** PKCE challenge（S256），可选 */
  cc: z.string().min(16).max(256).nullish(),
  /** 接入方自己的 state，原样回传 */
  st: z.string().max(256).nullish(),
});

export const tokenSchema = z.object({
  grant_type: z.literal('authorization_code'),
  code: z.string().min(1).max(256),
  client_id: z.string().min(1).max(128),
  code_verifier: z.string().min(16).max(256).nullish(),
});
