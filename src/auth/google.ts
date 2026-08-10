/**
 * Google sign-in.
 *
 * ## Why an account layer at all
 *
 * Identity here used to be the wallet address: `creatorId = cre-<address>`.
 * Addresses are free. A farmer generates fifty of them, gets fifty fresh
 * "unproven" standings and fifty per-creator caps, and the cap that was
 * supposed to bound one participant bounds nothing.
 *
 * Binding a creator to a Google account raises that cost. It does not
 * eliminate it — Google accounts are also cheap, and anyone claiming
 * otherwise is selling something. What it buys is that standing accrues to a
 * person across their wallets rather than resetting with each new address,
 * and that the per-creator cap has something durable to attach to.
 *
 * ## What is verified
 *
 * The ID token is checked properly rather than decoded and believed:
 * signature against Google's published keys, issuer, audience, expiry, and
 * the nonce we generated. A token that fails any of these is refused, and
 * "we could not verify it so we let it through" is not a sentence anyone
 * wants in an incident review.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export interface GoogleConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

export interface GoogleIdentity {
  /** Google's stable per-account subject. Never the email — emails change. */
  readonly sub: string;
  readonly email?: string;
  readonly emailVerified: boolean;
  readonly name?: string;
  readonly picture?: string;
}

export function googleConfig(env: Record<string, string | undefined>): GoogleConfig | undefined {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) return undefined;
  return { clientId, clientSecret, redirectUri };
}

/** URL-safe base64 without padding, which is what JWTs use. */
function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomToken(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function authorizeUrl(
  cfg: GoogleConfig,
  state: string,
  nonce: string,
): string {
  const u = new URL(AUTH_ENDPOINT);
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', cfg.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'openid email profile');
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  // Consent is not re-prompted on every visit, but we do want a refreshable
  // session rather than one that dies with the tab.
  u.searchParams.set('access_type', 'online');
  u.searchParams.set('prompt', 'select_account');
  return u.toString();
}

interface Jwk {
  kid: string; n: string; e: string; alg?: string; kty: string; use?: string;
}

let jwksCache: { keys: Jwk[]; fetchedAt: number } | undefined;
const JWKS_TTL_MS = 60 * 60 * 1000;

async function jwks(fetchImpl: typeof fetch): Promise<Jwk[]> {
  const now = Date.now();
  if (jwksCache && now - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
  const res = await fetchImpl(JWKS_URI);
  if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  jwksCache = { keys: body.keys, fetchedAt: now };
  return body.keys;
}

/** Exported for tests, which need a cold cache between cases. */
export function resetJwksCache(): void {
  jwksCache = undefined;
}

async function verifyIdToken(
  idToken: string,
  cfg: GoogleConfig,
  nonce: string,
  now: Date,
  fetchImpl: typeof fetch,
): Promise<GoogleIdentity> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('id_token is not a JWT');
  const [rawHeader, rawPayload, rawSig] = parts as [string, string, string];

  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(rawHeader))) as {
    alg?: string; kid?: string;
  };
  if (header.alg !== 'RS256') throw new Error(`unexpected alg ${header.alg}`);
  if (!header.kid) throw new Error('id_token has no kid');

  const key = (await jwks(fetchImpl)).find((k) => k.kid === header.kid);
  if (!key) throw new Error('no signing key matches the token kid');

  const pub = await crypto.subtle.importKey(
    'jwk',
    { kty: key.kty, n: key.n, e: key.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signed = new TextEncoder().encode(`${rawHeader}.${rawPayload}`);
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', pub, b64urlToBytes(rawSig), signed,
  );
  if (!ok) throw new Error('id_token signature does not verify');

  const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(rawPayload))) as {
    iss?: string; aud?: string; exp?: number; iat?: number; nonce?: string;
    sub?: string; email?: string; email_verified?: boolean; name?: string; picture?: string;
  };

  if (!claims.iss || !ISSUERS.includes(claims.iss)) throw new Error('unexpected issuer');
  if (claims.aud !== cfg.clientId) throw new Error('token was not issued for this client');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now.getTime()) {
    throw new Error('id_token has expired');
  }
  // The nonce is what stops a token minted for another session being replayed
  // into this one. Comparing it is the entire point of having sent it.
  if (claims.nonce !== nonce) throw new Error('nonce does not match this sign-in attempt');
  if (!claims.sub) throw new Error('id_token has no subject');

  return {
    sub: claims.sub,
    email: claims.email,
    emailVerified: claims.email_verified === true,
    name: claims.name,
    picture: claims.picture,
  };
}

export async function exchangeCode(
  cfg: GoogleConfig,
  code: string,
  nonce: string,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleIdentity> {
  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) {
    // Deliberately not echoing the body: it can carry the client secret back
    // in some error shapes, and this string ends up in logs.
    throw new Error(`token exchange failed: ${res.status}`);
  }
  const body = (await res.json()) as { id_token?: string };
  if (!body.id_token) throw new Error('token response carried no id_token');
  return verifyIdToken(body.id_token, cfg, nonce, now, fetchImpl);
}

/**
 * A creator id derived from the Google subject.
 *
 * Hashed rather than used raw so the account identifier is not sitting in
 * every event, URL and log line. Truncated to 16 hex characters: 64 bits of
 * a SHA-256, which is far past any collision risk at this scale and short
 * enough to read in a terminal.
 */
export async function creatorIdForSubject(sub: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`google:${sub}`));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return `cre-g-${hex.slice(0, 16)}`;
}
