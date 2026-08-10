import { describe, expect, it } from 'bun:test';
import {
  SESSION_TTL_SECONDS, clearCookie, cookie, readCookie, sign, verify, type Session,
} from './session';
import { authorizeUrl, creatorIdForSubject, googleConfig, randomToken } from './google';

const SECRET = 'test-secret-not-a-real-one';

function session(over: Partial<Session> = {}): Session {
  return {
    creatorId: 'cre-g-0123456789abcdef',
    sub: '11223344556677889900',
    email: 'creator@example.com',
    name: 'A Creator',
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    ...over,
  };
}

describe('session cookies', () => {
  it('round-trips a session it signed', async () => {
    const s = session();
    const got = await verify(await sign(s, SECRET), SECRET);
    expect(got?.creatorId).toBe(s.creatorId);
    expect(got?.sub).toBe(s.sub);
  });

  it('refuses a session signed with a different secret', async () => {
    const token = await sign(session(), 'some-other-secret');
    expect(await verify(token, SECRET)).toBeUndefined();
  });

  // The whole point of signing. If a tampered payload verified, anyone could
  // mint a session for any creator by editing one field.
  it('refuses a payload edited after signing', async () => {
    const token = await sign(session(), SECRET);
    const [payload, mac] = token.split('.') as [string, string];
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    decoded.creatorId = 'cre-g-victimvictim';
    const forged = btoa(JSON.stringify(decoded))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(await verify(`${forged}.${mac}`, SECRET)).toBeUndefined();
  });

  it('refuses an expired session', async () => {
    const token = await sign(session({ exp: Math.floor(Date.now() / 1000) - 1 }), SECRET);
    expect(await verify(token, SECRET)).toBeUndefined();
  });

  it('accepts a session that expires in a second', async () => {
    const token = await sign(session({ exp: Math.floor(Date.now() / 1000) + 1 }), SECRET);
    expect(await verify(token, SECRET)).toBeDefined();
  });

  it('returns undefined for junk rather than throwing', async () => {
    for (const junk of ['', 'no-dot', 'a.b.c.d', '...', 'Zm9v.notbase64!!']) {
      expect(await verify(junk, SECRET)).toBeUndefined();
    }
    expect(await verify(undefined, SECRET)).toBeUndefined();
  });
});

describe('cookie header', () => {
  it('marks the session HttpOnly and SameSite=Lax', () => {
    const c = cookie('mc_session', 'v', 60, true);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Secure');
  });

  // A cookie marked Secure is dropped over plain http, so local sign-in would
  // fail in a way that looks like an OAuth bug rather than a cookie flag.
  it('omits Secure when the request was not https', () => {
    expect(cookie('mc_session', 'v', 60, false)).not.toContain('Secure');
  });

  it('clears by expiring immediately', () => {
    expect(clearCookie('mc_session', true)).toContain('Max-Age=0');
  });

  it('reads one cookie out of several', () => {
    const header = 'other=1; mc_session=abc%2Edef; third=3';
    expect(readCookie(header, 'mc_session')).toBe('abc.def');
    expect(readCookie(header, 'absent')).toBeUndefined();
    expect(readCookie(null, 'mc_session')).toBeUndefined();
  });
});

describe('google config', () => {
  it('is undefined unless every value is present', () => {
    expect(googleConfig({})).toBeUndefined();
    expect(googleConfig({ GOOGLE_OAUTH_CLIENT_ID: 'a' })).toBeUndefined();
    expect(googleConfig({
      GOOGLE_OAUTH_CLIENT_ID: 'a', GOOGLE_OAUTH_CLIENT_SECRET: 'b',
    })).toBeUndefined();
    expect(googleConfig({
      GOOGLE_OAUTH_CLIENT_ID: 'a',
      GOOGLE_OAUTH_CLIENT_SECRET: 'b',
      GOOGLE_OAUTH_REDIRECT_URI: 'https://merlinclips.com/auth/google/callback',
    })).toBeDefined();
  });

  it('treats whitespace-only values as absent', () => {
    expect(googleConfig({
      GOOGLE_OAUTH_CLIENT_ID: '   ',
      GOOGLE_OAUTH_CLIENT_SECRET: 'b',
      GOOGLE_OAUTH_REDIRECT_URI: 'c',
    })).toBeUndefined();
  });
});

describe('authorize url', () => {
  const cfg = {
    clientId: 'client-123',
    clientSecret: 'secret',
    redirectUri: 'https://merlinclips.com/auth/google/callback',
  };

  it('carries state and nonce, which are what make the callback trustworthy', () => {
    const u = new URL(authorizeUrl(cfg, 'st', 'no'));
    expect(u.searchParams.get('state')).toBe('st');
    expect(u.searchParams.get('nonce')).toBe('no');
    expect(u.searchParams.get('client_id')).toBe(cfg.clientId);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('scope')).toBe('openid email profile');
  });

  it('never puts the client secret in a redirect the browser follows', () => {
    expect(authorizeUrl(cfg, 'st', 'no')).not.toContain(cfg.clientSecret);
  });
});

describe('creator identity', () => {
  it('is stable for a subject and different across subjects', async () => {
    const a = await creatorIdForSubject('11223344');
    expect(await creatorIdForSubject('11223344')).toBe(a);
    expect(await creatorIdForSubject('11223345')).not.toBe(a);
  });

  it('does not leak the google subject', async () => {
    expect(await creatorIdForSubject('11223344')).not.toContain('11223344');
  });

  it('is shaped like the rest of the creator ids', async () => {
    expect(await creatorIdForSubject('x')).toMatch(/^cre-g-[0-9a-f]{16}$/);
  });
});

describe('random tokens', () => {
  it('are hex, full length, and not repeated', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const t = randomToken();
      expect(t).toMatch(/^[0-9a-f]{64}$/);
      expect(seen.has(t)).toBe(false);
      seen.add(t);
    }
  });
});
