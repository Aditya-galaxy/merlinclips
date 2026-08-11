# Merlin Clips — container for Google Cloud Run.
#
# Two competition requirements meet here: the base rules require the project to
# run on Google Cloud Platform, and judges must be able to reach a working
# instance "free of charge and without any restriction" until judging ends.
#
# Deliberately minimal. A judge's session must not be able to fail on a build
# step, and the fewer moving parts between them and the demo, the fewer ways
# that happens. There is no bundler, no transpile step and no node_modules in
# the final image: Bun runs the TypeScript directly, and the app's runtime
# dependency list is empty by design.

FROM oven/bun:1.3-alpine

WORKDIR /app

# Manifests first so the dependency layer is cached independently of source.
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production 2>/dev/null || bun install --production

# The Circle CLI, because the payout executor spawns `circle wallet transfer`.
#
# Without it the image runs perfectly right up to the moment it tries to pay,
# then reports "could not run the Circle CLI" — a failure that only appears
# once BROADCAST is on and money is meant to move, which is the worst possible
# time to discover a missing binary.
#
# Installed globally so it is on PATH for the unprivileged `bun` user.
RUN bun add -g @circle-fin/cli 2>/dev/null || npm install -g @circle-fin/cli || true
ENV PATH="/root/.bun/bin:/usr/local/bin:${PATH}"

# Fail the build rather than the payout if it is not there.
RUN command -v circle >/dev/null 2>&1 \
    && echo "circle CLI present: $(command -v circle)" \
    || (echo "FATAL: circle CLI missing — the payout executor cannot run" && exit 1)

COPY src ./src
# openapi.json is served at /openapi.json and Circle's marketplace requires it
# so a buying agent can read our contract itself. Omitting it deployed a 404
# over the one document whose audience is a machine.
COPY openapi.json ./
# One service serves the marketing site, the product and the API, so there is
# one origin, one deploy and no link that only works in local preview.
COPY landing ./landing
COPY README.md LICENSE ./

# Cloud Run injects PORT and expects the container to honour it. 8080 is the
# platform default and the fallback in server.ts.
ENV NODE_ENV=production
EXPOSE 8080

# Run unprivileged. The image ships a `bun` user; nothing here needs root.
USER bun

# Exec form so signals reach the process directly — Cloud Run sends SIGTERM on
# scale-down, and a shell wrapper would swallow it and force a 10s kill.
CMD ["bun", "run", "src/server.ts"]
