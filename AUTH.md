# Sign-in

Google is the only identity provider. Email-and-password would mean storing
password hashes, running a reset flow over email we do not yet send, and
owning a credential database — for a product whose whole security argument is
that it holds as little as possible.

## Why there is an account layer at all

Identity used to be the wallet address: `creatorId = cre-<address>`.

Addresses are free. A farmer generates fifty, gets fifty fresh *unproven*
standings and fifty per-creator caps, and the cap meant to bound one
participant bounds nothing.

Binding a creator to a Google account raises that cost. **It does not remove
it** — Google accounts are also easy to get, and anyone claiming otherwise is
selling something. What it buys:

- standing accrues to a person across their wallets instead of resetting with
  every new address
- the per-creator cap has something durable to attach to
- a creator stops re-pasting a wallet address to see their own submissions

A session says *which creator this is*. It authorises nothing. Every payout
still passes the same gate with the same caps regardless of who is signed in,
which is why a signed cookie is an acceptable session here and would not be
for anything that moved money.

## Configuration

Four variables. With any of them missing the routes return 503, `/api/me`
reports `available: false`, and no button is rendered — a deployment without
sign-in is a deployment without sign-in, not one where the button 503s.

| Variable | Value |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | from the OAuth client, ends `.apps.googleusercontent.com` |
| `GOOGLE_OAUTH_CLIENT_SECRET` | from the same client |
| `GOOGLE_OAUTH_REDIRECT_URI` | `https://merlinclips.com/auth/google/callback` |
| `SESSION_SECRET` | 32+ random bytes; rotating it signs everyone out |

### Creating the OAuth client

This needs your own Google Cloud console — it cannot be scripted with the
credentials on this machine, and you would not want it to be.

1. **APIs & Services → OAuth consent screen**, External, app name Merlin
   Clips, support email, `merlinclips.com` as an authorised domain. Scopes:
   `openid`, `email`, `profile` — nothing else, and adding anything else
   triggers verification review.
2. **Credentials → Create credentials → OAuth client ID → Web application**.
3. Authorised redirect URIs, both:
   - `https://merlinclips.com/auth/google/callback`
   - `http://localhost:8080/auth/google/callback` (local development)
4. Copy the client id and secret into the variables above.

Generate the session secret locally:

    openssl rand -hex 32

On Cloud Run, set the two secrets through Secret Manager rather than as plain
environment variables:

    gcloud run services update merlinclips --region us-central1 \
      --update-secrets GOOGLE_OAUTH_CLIENT_SECRET=oauth-client-secret:latest,SESSION_SECRET=session-secret:latest \
      --update-env-vars GOOGLE_OAUTH_CLIENT_ID=...,GOOGLE_OAUTH_REDIRECT_URI=https://merlinclips.com/auth/google/callback

## What is verified

The ID token is checked rather than decoded and believed:

- **signature** against Google's published JWKS, RS256 only
- **issuer** is `accounts.google.com`
- **audience** is our client id — a token minted for a different app is refused
- **expiry** has not passed
- **nonce** matches the one this sign-in attempt generated

Plus **state**, compared against a short-lived `HttpOnly` cookie, which is
what stops a callback from a flow we did not start.

Any failure redirects to `/app?signin=failed` **without** a session. The
reason is not surfaced to the browser: it would tell an attacker which check
they failed.

## Cookies

| Cookie | Life | Carries |
|---|---|---|
| `mc_oauth` | 10 minutes | `state.nonce` for one sign-in attempt |
| `mc_session` | 30 days | creator id, subject, email, name, expiry, HMAC |

Both are `HttpOnly` and `SameSite=Lax`. `Secure` is set only over https —
a Secure cookie is silently dropped over plain http, which would make local
sign-in fail in a way that looks like an OAuth bug rather than a cookie flag.

The session is a signed cookie with no server-side store, so any instance can
verify it without shared state. The tradeoff, stated rather than glossed: **it
cannot be revoked before it expires.** Rotating `SESSION_SECRET` invalidates
every session at once, which is the blunt instrument available.

## What is deliberately not stored

No password. No refresh token — `access_type=online`, because we never call a
Google API on a creator's behalf. No profile picture. The Google subject is
hashed into the creator id rather than used raw, so the account identifier is
not sitting in every event and log line.
