import { z } from 'zod';
import { ALLOWED_TOKEN_TTL_HOURS } from './config.js';
import { Errors } from './errors.js';

export function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, any>, data: unknown): T {
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

// ---------------------------------------------------------------- 联机数据

/** scope：小写字母开头、16 位以内。`admin*` 保留给 toy 作者，见 routes/data.ts */
export const scopeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,15}$/, 'scope 只能用小写字母、数字、下划线，且不超过 16 位');

/**
 * 能被 open_edit 授出去让别人改的字段。
 * extra / scope / uid / is_public / open_edit / expires_at 永远不在这一列里 ——
 * 数据库那边还有一道 CHECK 兜着，就算这里写错也越不了权。
 */
export const EDITABLE_FIELDS = [
  'tag_tinyint',
  'tag_int1',
  'tag_int2',
  'tag_bigint',
  'text_1',
  'text_2',
  'text_long',
] as const;

/** API 字段名 → 数据库列名（open_edit 里存的是列名） */
export const FIELD_TO_COLUMN: Record<string, string> = {
  tagTinyint: 'tag_tinyint',
  tagInt1: 'tag_int1',
  tagInt2: 'tag_int2',
  tagBigint: 'tag_bigint',
  text1: 'text_1',
  text2: 'text_2',
  textLong: 'text_long',
  extra: 'extra',
};

/** 有效期（天）：1~30 之间的任意整数。不给按 7 天；超过 30 天会被数据库的 CHECK 顶回来 */
const ttlSchema = z.coerce
  .number()
  .int('有效期要整数天')
  .min(1, '有效期最少 1 天')
  .max(30, '有效期最多 30 天');

const dataFields = {
  /** 0..255；当 boolean 用就传 0/1 */
  tagTinyint: z.number().int().min(0).max(255).nullish(),
  tagInt1: z.number().int().min(-32768).max(32767).nullish(),
  tagInt2: z.number().int().min(-2147483648).max(2147483647).nullish(),
  /** bigint 超出 JS 安全整数，所以收字符串（也收小整数） */
  tagBigint: z.union([z.string().regex(/^-?\d{1,19}$/), z.number().int()]).nullish(),

  text1: z.string().max(128, 'text_1 最多 128 字符').nullish(),
  text2: z.string().max(512, 'text_2 最多 512 字符').nullish(),
  textLong: z.string().max(1024, 'text_long 最多 1024 字符，超长请放 extra').nullish(),

  /** 容器：放什么由作者定，只要序列化后不超过 2048 字节 */
  extra: z
    .unknown()
    .refine(
      (v) =>
        v === undefined || v === null || Buffer.byteLength(JSON.stringify(v), 'utf8') <= 2048,
      'extra 序列化后最多 2048 字节',
    )
    .nullish(),
};

/** 新建 / 整行覆盖（属主或作者）。字段缺省即清空 */
export const kvPutSchema = z.object({
  ttlDays: ttlSchema.default(7),
  isPublic: z.boolean().default(false),
  openEdit: z.array(z.enum(EDITABLE_FIELDS)).max(EDITABLE_FIELDS.length).default([]),
  ...dataFields,
});

/**
 * `inc`：原子加减，只认四个数字标签。
 *
 * 为什么需要它：客户端「读出来 + 2 再写回去」在并发下必然丢更新（A 读到 1、B 也读到
 * 1，各写 3 和 4，最后是 4 不是 6）。把**增量**交给服务端，一条 `col = col + $n`
 * 才是原子的 —— 同行并发加减永远不会丢。
 *
 * **不做任何边界**：血量能不能变负、负数在游戏里什么意思，是玩具自己的事
 * （作者在前端把 -100HP 显示成 0HP 就行）。服务端只保证不超出列类型范围。
 */
export const incSchema = z
  .object({
    tagTinyint: z.number().int().nullish(),
    tagInt1: z.number().int().nullish(),
    tagInt2: z.number().int().nullish(),
    tagBigint: z.number().int().nullish(),
  })
  .strict('inc 只支持 tagTinyint / tagInt1 / tagInt2 / tagBigint')
  .nullish();

/**
 * 部分更新。**故意不用 default()** —— 缺省表示「这一项没动」，和显式传 null 是两回事。
 * 调用方用 `Object.hasOwn(parsed, 'text2')` 判断动了哪些。
 */
export const kvPatchSchema = z.object({
  inc: incSchema,
  ttlDays: ttlSchema.optional(),
  isPublic: z.boolean().optional(),
  openEdit: z.array(z.enum(EDITABLE_FIELDS)).max(EDITABLE_FIELDS.length).optional(),
  ...dataFields,
});

/** 批量查资料：一次最多 50 个 uid */
export const profilesSchema = z.object({
  uids: z
    .array(z.string().regex(/^\d+$/, 'uid 只能是数字'))
    .min(1, '至少要给一个 uid')
    .max(50, '一次最多查 50 个 uid'),
});

/** 列表分页：一页最多 100，默认 20 */
export const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
});
