import { randomBytes, randomUUID } from 'node:crypto';

/** URL 安全的 base64（去掉 padding），用于 code / nonce / client_id */
export function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/** 默认 32 字节的随机标识 */
export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

/**
 * 认领 nonce。限制成 [A-Za-z0-9]，这样它能原样出现在 HTML 属性里，
 * 不需要担心转义，源码匹配用简单的 includes 就够了。
 */
export function randomNonce(bytes = 24): string {
  return randomBytes(bytes).toString('base64url').replace(/[-_]/g, '');
}

export function clientId(): string {
  return `ucs_${randomToken(16)}`;
}

export function newUuid(): string {
  return randomUUID();
}

/** 校验 B站 toy slug：SDK 内部用的就是 [A-Za-z0-9_-] */
export const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isSlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG_RE.test(value);
}
