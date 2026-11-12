import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Sealed cookie values (doc §10 "Auth"): AES-256-GCM, so the browser holds an
 * opaque string it can neither read nor change. The GitHub token lives inside
 * and never reaches page scripts (the cookie is also httpOnly).
 */

const key = (secret: string) => createHash('sha256').update(`repopilot-session:${secret}`).digest();

/** Encrypts `value` with an expiry; returns base64url(iv | tag | ciphertext). */
export function seal(value: unknown, secret: string, ttlMs: number): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ v: value, exp: Date.now() + ttlMs }), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

/** The sealed value, or null when it was tampered with, sealed with another secret, or expired. */
export function unseal<T>(sealed: string | undefined, secret: string): T | null {
  if (!sealed) return null;
  try {
    const raw = Buffer.from(sealed, 'base64url');
    if (raw.length < 29) return null;
    const decipher = createDecipheriv('aes-256-gcm', key(secret), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    const { v, exp } = JSON.parse(json) as { v: T; exp: number };
    return typeof exp === 'number' && exp > Date.now() ? v : null;
  } catch {
    return null;
  }
}

/** Reads one cookie from a Cookie header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/** A Set-Cookie value: httpOnly, SameSite=Lax, Secure on https; maxAge 0 clears it. */
export function cookie(name: string, value: string, opts: { maxAgeSec: number; secure: boolean; path?: string }): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path ?? '/'}`,
    `Max-Age=${Math.max(0, Math.floor(opts.maxAgeSec))}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(opts.secure ? ['Secure'] : []),
  ].join('; ');
}
