/**
 * Sessions, as signed cookies.
 *
 * No server-side session store. The cookie carries the claims and an HMAC
 * over them, so any instance can verify it without shared state — which
 * matters because this runs on Cloud Run and the instance that signed a
 * session is usually not the one that reads it.
 *
 * The tradeoff, stated rather than glossed: a signed cookie cannot be
 * revoked before it expires. That is acceptable for "which creator is this",
 * and would not be acceptable for anything that authorises a payment. It
 * does not: a session identifies a creator, and every payout still goes
 * through the same gate with the same caps regardless of who is signed in.
 */

const ENC = new TextEncoder();

export interface Session {
  readonly creatorId: string;
  readonly sub: string;
  readonly email?: string;
  readonly name?: string;
  /** Seconds since epoch. */
  readonly exp: number;
}

export const SESSION_COOKIE = 'mc_session';
export const STATE_COOKIE = 'mc_oauth';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', ENC.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
}

export async function sign(session: Session, secret: string): Promise<string> {
  const payload = b64url(ENC.encode(JSON.stringify(session)));
  const mac = await crypto.subtle.sign('HMAC', await key(secret), ENC.encode(payload));
  return `${payload}.${b64url(new Uint8Array(mac))}`;
}

/**
 * Returns undefined for anything that is not a currently-valid session:
 * malformed, wrong signature, or expired. One return value for every failure
 * on purpose — a caller that can distinguish "bad signature" from "expired"
 * will eventually treat one of them as recoverable.
 */
export async function verify(token: string | undefined, secret: string, now: Date = new Date()):
  Promise<Session | undefined> {
  if (!token) return undefined;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);

  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await key(secret), fromB64url(mac), ENC.encode(payload));
  } catch {
    return undefined;
  }
  if (!ok) return undefined;

  try {
    const s = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as Session;
    if (typeof s.exp !== 'number' || s.exp * 1000 <= now.getTime()) return undefined;
    if (typeof s.creatorId !== 'string' || typeof s.sub !== 'string') return undefined;
    return s;
  } catch {
    return undefined;
  }
}

export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * `Secure` is conditional because a cookie marked Secure is simply dropped
 * over plain http, which would make sign-in fail silently on localhost and
 * look like a bug in the OAuth flow rather than in the cookie.
 */
export function cookie(
  name: string, value: string, maxAgeSeconds: number, secure: boolean,
): string {
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

export function clearCookie(name: string, secure: boolean): string {
  return cookie(name, '', 0, secure);
}
