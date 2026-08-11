# merlinclips.com

Four static pages and one stylesheet, served by the same Cloud Run service that
runs the product and the API.

    /                  the pitch, for creators and for brands
    /app               the product a creator actually uses
    /architecture      where the decision lives, and what breaks at scale
    /security          threat model, attacks in scope, the 21 invariants
    /testing           property tests, deterministic simulation, defects found

## Why one service and not a static host

Splitting the marketing site onto Vercel and leaving the app on Cloud Run means
every link between them is cross-origin and absolute. Worse, a relative `/app`
works perfectly in local preview — one server happens to serve both — and 404s
the moment they are deployed apart. That is the worst kind of broken link,
because it passes every check you run before shipping.

One origin, one deploy, relative links that cannot rot.

The pages are served from an allowlist in `src/server.ts`, not by joining the
request path onto a directory. A traversal bug there would read anything the
container can, and an allowlist cannot be traversed.

## Zero external requests

No fonts, no analytics, no CDN. Nothing we do not control can slow the page
down or block it.

## Claims on these pages are checkable, and must stay that way

The figures on `/testing` come from `bun run sweep`. That page once printed a
transcript of a command that did not exist, which is the worst possible defect
on a page arguing "proven, not sampled". If the simulation changes, re-run it
rather than letting the numbers drift:

```bash
bun run sweep
```

The invariant table on `/security` must match `ARCHITECTURE.md`. They are
maintained by hand in two places, so they will diverge eventually — the count
is the cheap thing to check:

```bash
grep -cE '^\| \*\*I[0-9]+\*\*' ../ARCHITECTURE.md
grep -coE '<td class="mono">I[0-9]+</td>' security.html
```

## Local preview

Same server as production, so what you see is what ships:

```bash
bun run src/server.ts
```
