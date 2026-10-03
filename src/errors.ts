/**
 * 统一的业务错误。带上机器可读的 code，前端/接入方按 code 分支，不要按 message 匹配。
 */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail?: unknown;

  constructor(code: string, message: string, status = 400, detail?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export const Errors = {
  invalidParam: (message = '参数不合法', detail?: unknown) =>
    new AppError('invalid_param', message, 400, detail),

  /** 该 toyOpenId 不是合法身份（空串 / 超长 / 非法字符） */
  invalidIdentity: (message = '身份标识不合法') =>
    new AppError('invalid_identity', message, 400),

  toyNotFound: (slug: string) =>
    new AppError('toy_not_found', `玩具 ${slug} 不存在或已被删除`, 404),

  toyAlreadyClaimed: () =>
    new AppError('toy_already_claimed', '该玩具已被认领', 409),

  toyNotVerified: () => new AppError('toy_not_verified', '该玩具尚未完成认领', 403),

  claimNotFound: () =>
    new AppError('claim_not_found', '没有进行中的认领，请先发起认领', 404),

  claimExpired: () => new AppError('claim_expired', '认领已过期，请重新发起', 410),

  claimAttemptsExceeded: () =>
    new AppError('claim_attempts_exceeded', '验证次数过多，请重新发起认领', 429),

  nonceNotInSource: () =>
    new AppError(
      'nonce_not_in_source',
      '在你 toy 的源码里没找到验证码。常见原因：改完没点发布；写到了别的文件而不是 index.html；' +
        '或者源码里还留着一个过期的旧验证码。回到认领页点一次「下一步」可以拿到当前有效的那个。',
      422,
    ),

  upstreamFetchFailed: (message = '抓取 B站 页面失败，请稍后重试', detail?: unknown) =>
    new AppError('upstream_fetch_failed', message, 502, detail),

  upstreamBlocked: (message = '目标地址不在允许的域名内') =>
    new AppError('upstream_blocked', message, 400),

  clientNotFound: () =>
    new AppError('client_not_found', 'client_id 不存在或已失效', 404),

  invalidCode: () => new AppError('invalid_code', '授权码无效', 400),

  codeExpired: () => new AppError('code_expired', '授权码已过期，请重新过桥', 410),

  codeUsed: () => new AppError('code_used', '授权码已被使用', 409),

  pkceMismatch: () => new AppError('pkce_mismatch', 'code_verifier 校验失败', 400),

  invalidGrant: () => new AppError('invalid_grant', '刷新令牌无效', 400),

  refreshTokenExpired: () =>
    new AppError('refresh_token_expired', '太久没用了，需要重新授权一次', 401),

  refreshTokenReused: () =>
    new AppError(
      'refresh_token_reused',
      '这个刷新令牌已经用过了。为了安全，本次会话已全部作废，请重新授权。',
      401,
    ),

  refreshTokenRevoked: () =>
    new AppError('refresh_token_revoked', '这个会话已失效，请重新授权。', 401),

  rateLimited: (retryAfter: number) =>
    new AppError('rate_limited', `请求过于频繁，请 ${retryAfter} 秒后再试`, 429, {
      retryAfter,
    }),
};
