import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * PKCE (RFC 7636)。接入方是纯静态玩具时没有 client_secret，
 * code 又会出现在 URL 里（B站 shell 会转发 query），所以 PKCE 是必要的。
 */

export function verifyChallenge(
  verifier: string,
  challenge: string,
  method: string | null | undefined,
): boolean {
  if (method && method.toUpperCase() !== 'S256') return false;
  const computed = createHash('sha256').update(verifier).digest('base64url');
  return safeEqual(computed, challenge);
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
