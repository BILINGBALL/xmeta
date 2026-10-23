import { z } from 'zod';
import { ALLOWED_TOKEN_TTL_HOURS, TTL_SECONDS_MAX } from './config.js';
import { Errors } from './errors.js';

export function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, any>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues;
    // 字段名写错是最容易踩的一处。写接口的 schema 都是 strict 的，所以这里
    // 能把「你不认识的键」原样指出来 —— 光说「参数不合法」的话，接入方对着
    // 一份 200 的响应根本看不出是哪个字段被丢掉了。
    const unknown = issues.flatMap((i) => (i.code === 'unrecognized_keys' ? i.keys : []));
    if (unknown.length > 0) {
      throw Errors.invalidParam(
        `不认识的字段：${unknown.join('、')}。` +
          '字段名一律用驼峰（tagInt1 / text1 / tagBigint），没有下划线那种写法。',
        issues,
      );
    }
    throw Errors.invalidParam('请求参数不合法', issues);
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
});

/**
 * 展示资料：昵称和头像。
 *
 * **这是用户自己填的，不是平台资料。** `toy.getUserProfile()` 返回的昵称/头像
 * 只允许在过桥页上展示给用户看，由他自己复制粘贴进来 —— 不允许客户端直接上传。
 *
 * 三态语义（由 upsertUser 实现）：
 *   · 字段缺省      = 不修改（`undefined`）
 *   · `null` / 空串 = 明确清空
 *   · 有值          = 设置
 */
const MAX_NICKNAME_CHARS = 32;

const nicknameSchema = z
  .string()
  // 这个版本的 zod 没有 .normalize()，放到 transform 里做
  .transform((v) => v.trim().normalize('NFC'))
  .refine((v) => [...v].length <= MAX_NICKNAME_CHARS, `昵称最多 ${MAX_NICKNAME_CHARS} 个字`)
  .refine((v) => !/[\u0000-\u001f\u007f<>]/.test(v), '昵称含非法字符')
  .nullish()
  // 不能写成 v => v || null：zod 对**缺省字段**也会跑 transform，那样 undefined
  // 会被折叠成 null，等于每次授权都把旧昵称清掉。
  .transform((v) => (v === undefined ? undefined : v || null));

/** `//host/x.png`、`http://host/x.png` 一律升级成 https —— 页面跑在 https 上，http 会被拦 */
function toHttpsUrl(v: string): string {
  if (v.startsWith('//')) return 'https:' + v;
  return v.replace(/^http:\/\//i, 'https://');
}

/** 头像只认 B站 自己的图床 —— 页面上的地址最后都要收敛到这里 */
const BILI_IMAGE_HOST = /(^|\.)(hdslb\.com|bilibili\.com)$/i;
const DEFAULT_AVATAR = 'https://p0.hdslb.com/bfs/face/member/noface.jpg';

const avatarSchema = z
  .string()
  .trim()
  .max(1000, '头像地址最多 1000 个字符')
  .nullish()
  .transform((v) => {
    if (v === undefined) return undefined
    if (!v) return null
    let url
    try {
      url = new URL(toHttpsUrl(v))
    } catch {
      return DEFAULT_AVATAR
    }
    return BILI_IMAGE_HOST.test(url.hostname) ? url.href : DEFAULT_AVATAR
  });

export const profileFields = { nickname: nicknameSchema, avatar: avatarSchema };

/** 个人中心改展示资料：和过桥页同一套字段和校验 */
export const profileUpdateSchema = identitySchema.extend(profileFields);

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

export const bridgeAuthorizeSchema = identitySchema.extend(profileFields).extend({
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

/** 过桥页预填：按 toyOpenId 查这个人已经提交过的昵称/头像 */
export const bridgeProfileSchema = identitySchema.extend({
  cid: z.string().min(1).max(128),
  fromToyId: z.string().regex(/^\d+$/, '来源 toy_id 只能是数字'),
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

/** API 字段名 → 数据库列名（库里一律存列名，出网一律给字段名） */
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

/**
 * openEdit 的入参别名：**字段名和列名都收**。
 *
 * 这两套名字曾经混着用（请求体是驼峰、白名单是下划线），是文档里最容易写反
 * 的一处。现在统一成「出网入网都认字段名」，老的 `tag_int1` 照样能用 ——
 * 但库里存的一直是列名，所以两边都不用改存量数据。
 *
 * `extra` 不在里面：它永远不开放给别人改。
 */
const OPEN_EDIT_ALIAS: Record<string, string> = Object.fromEntries([
  ...Object.entries(FIELD_TO_COLUMN)
    .filter(([api]) => api !== 'extra')
    .map(([api, col]) => [api, col] as [string, string]),
  ...EDITABLE_FIELDS.map((col) => [col, col] as [string, string]),
]);

/** 报错时列给人看的那 7 个名字（字段名，不是列名） */
const EDITABLE_FIELD_NAMES = Object.keys(FIELD_TO_COLUMN).filter((api) => api !== 'extra');

const openEditSchema = z
  .array(
    z
      .string()
      .refine((v) => v in OPEN_EDIT_ALIAS, {
        message:
          `openEdit 里只能填这 ${EDITABLE_FIELD_NAMES.length} 个：` +
          `${EDITABLE_FIELD_NAMES.join(' / ')}。` +
          '老的列名写法（tag_int1）也认，但新写就用字段名；extra 永远不开放。',
      })
      .transform((v) => OPEN_EDIT_ALIAS[v]!),
  )
  .max(EDITABLE_FIELDS.length);

/**
 * 有效期（**秒**）：1 秒 ~ 30 天。
 *
 * 语义是「从写这一刻起再活这么久」—— 带上它就把过期时刻重算一遍（续期），
 * 不带就一动不动。所以 PATCH 只改一个字段时，不会顺手把有效期也改掉。
 *
 * 「单次最多 30 天」只由这里把关：续期不封顶，数据库那条 CHECK 表达不了
 * now()（不是 immutable），见 sql/007。
 */
const ttlSchema = z.coerce
  .number()
  .int('ttl 要整数秒')
  .min(1, 'ttl 最少 1 秒')
  .max(TTL_SECONDS_MAX, '单次最多存 30 天（2592000 秒）');

const dataFields = {
  /** 0..255；当 boolean 用就传 0/1 */
  tagTinyint: z.number().int().min(0).max(255).nullish(),
  tagInt1: z.number().int().min(-32768).max(32767).nullish(),
  tagInt2: z.number().int().min(-2147483648).max(2147483647).nullish(),
  /** bigint 超出 JS 安全整数，所以收字符串（也收小整数） */
  tagBigint: z.union([z.string().regex(/^-?\d{1,19}$/), z.number().int()]).nullish(),

  text1: z.string().max(128, 'text1 最多 128 字符').nullish(),
  text2: z.string().max(512, 'text2 最多 512 字符').nullish(),
  textLong: z.string().max(1024, 'textLong 最多 1024 字符，超长请放 extra').nullish(),

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

/**
 * 新建 / 整行覆盖（属主或作者）。字段缺省即清空。
 *
 * `strict()`：不认识的字段直接 400。默认行为是**静默丢掉** —— 把 `tagInt1`
 * 写成 `tag_int1` 会拿到 200，而那一列是 null，查起来极费劲。
 */
export const kvPutSchema = z
  .object({
    /**
     * 不传就不动 —— 和 PATCH 一样。**只有新建那一次**才回落到默认 7 天
     * （那一步在 repos 里）。所以「原样 PUT 一遍」是真的什么都没改，
     * 不会顺手把过期时间推走。
     */
    ttl: ttlSchema.optional(),
    isPublic: z.boolean().default(false),
    openEdit: openEditSchema.default([]),
    ...dataFields,
  })
  .strict();

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
export const kvPatchSchema = z
  .object({
    inc: incSchema,
    ttl: ttlSchema.optional(),
    isPublic: z.boolean().optional(),
    openEdit: openEditSchema.optional(),
    ...dataFields,
  })
  .strict();

/**
 * 批量查资料：一次最多 100 个 uid。
 *
 * 100 = 列表一页的最大长度（见下面的 pageSchema），**故意对齐** —— 这样
 * 「翻满一页的人」可以一次问完，不用自己拆批次。上限本身只是为了别让这个
 * 接口变成枚举入口，反正也只回本 toy 出现过的人。
 */
export const profilesSchema = z.object({
  uids: z
    .array(z.string().regex(/^\d+$/, 'uid 只能是数字'))
    .min(1, '至少要给一个 uid')
    .max(100, '一次最多查 100 个 uid'),
});

/** 列表分页：一页最多 100，默认 20 */
export const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * 改动日志的查询参数。
 *
 * `changed=text1` 只回「动过 text1」的那些记录 —— 聊天历史靠它翻页，
 * 不会被同一条数据上的心跳日志挤掉。参数用**字段名**（驼峰），
 * 服务端内部再映射成列名。
 */
export const logQuerySchema = pageSchema.extend({
  changed: z
    .string()
    .max(32)
    .optional()
    .refine((v) => v === undefined || v in FIELD_TO_COLUMN, {
      message: `changed 只支持这些字段：${Object.keys(FIELD_TO_COLUMN).join(' / ')}`,
    }),
});
