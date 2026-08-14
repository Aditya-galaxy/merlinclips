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

# The Circle CLI is deliberately NOT installed.
#
# It authenticates with an email-OTP session tied to a person's inbox —
# `circle wallet login <email>` takes no token or key flag, and a session
# expires in about a month. A container cannot obtain one, so the binary would
# sit here unable to do the only thing it is wanted for.
#
# Worse than useless: present, it implies a working fallback. Absent, the
# executor reports "could not run the Circle CLI" and names the real problem.
#
# Payouts on a deployment go through the Wallets SDK instead, which
# authenticates with CIRCLE_API_KEY and ENTITY_SECRET from the environment —
# no session, no expiry, no person. See src/campaign/sdk-executor.ts.


COPY src ./src
# openapi.json and mcp.json are served at /openapi.json and /mcp.json for agents.
COPY openapi.json mcp.json ./
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
