#!/usr/bin/env bash
#
# Deploy the judge-facing console to Cloud Run.
#
# Idempotent: re-running redeploys the same service rather than creating a
# second one. Safe to run from a laptop or from CI.
#
#   ./deploy.sh                      # deploy with defaults
#   PROJECT=my-gcp-project ./deploy.sh
#
set -euo pipefail

PROJECT="${PROJECT:-merlinclips}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-merlinclips}"
BUCKET="${GCS_BUCKET:-merlinclips-state}"

# The identity the service runs as, not the identity that builds it.
#
# Cloud Run defaults to the project's compute service account, which is shared
# and accumulates whatever roles anything else in the project needed — ours
# picked up cloudbuild.builds.builder simply so `--source` deploys would work.
# A public payout service does not need permission to run builds. This account
# gets Vertex for the clip verifier and write access to the one state bucket,
# and nothing else.
RUNTIME_SA="${RUNTIME_SA:-merlinclips-run@${PROJECT}.iam.gserviceaccount.com}"

if [ -z "$PROJECT" ] || [ "$PROJECT" = "(unset)" ]; then
  echo "No GCP project set. Run: gcloud config set project <project-id>" >&2
  exit 1
fi

# Checked before deploying, not after, because the failure is silent. Without
# the bucket the campaign store is in-memory on a service that scales to zero:
# every snapshot dies with the instance, so no view ever survives the dwell
# window and every submission is held forever. The service would look healthy
# the entire time. This script never creates the bucket — it prints the command
# and stops, so the resource is created deliberately rather than as a side
# effect of a deploy.
if ! gcloud storage buckets describe "gs://${BUCKET}" --project "$PROJECT" >/dev/null 2>&1; then
  cat >&2 <<MISSING
Bucket gs://${BUCKET} not found in project ${PROJECT}.

Deploying without it would come up healthy and silently pay nobody: state
would live in memory on a service that scales to zero. Create it, then re-run:

  gcloud storage buckets create gs://${BUCKET} \\
    --project ${PROJECT} --location ${REGION} --uniform-bucket-level-access

MISSING
  exit 1
fi

echo "Deploying $SERVICE to $PROJECT ($REGION)"

# --allow-unauthenticated is a competition requirement, not laziness: judges
# must reach a working instance "free of charge and without any restriction".
if ! gcloud iam service-accounts describe "$RUNTIME_SA" --project "$PROJECT" >/dev/null 2>&1; then
  cat >&2 <<MISSINGSA
Runtime service account $RUNTIME_SA does not exist.

Cloud Run would otherwise run as the default compute account, which currently
also holds build permissions — far more than a payout service should carry.
Create it and grant only what it needs:

  gcloud iam service-accounts create merlinclips-run \\
    --project ${PROJECT} --display-name "Merlin Clips runtime"

  gcloud projects add-iam-policy-binding ${PROJECT} \\
    --member "serviceAccount:${RUNTIME_SA}" --role roles/aiplatform.user

  gcloud storage buckets add-iam-policy-binding gs://${BUCKET} \\
    --project ${PROJECT} --member "serviceAccount:${RUNTIME_SA}" \\
    --role roles/storage.objectAdmin

MISSINGSA
  exit 1
fi

# The oracle key is a secret, not configuration. Held in Secret Manager beside
# the OAuth and session secrets rather than passed as a plain env var: an env
# var is readable by anyone with Cloud Run viewer on the project and lands in
# shell history and deploy logs on the way there.
#
# Checked before deploying because the failure is quiet in the worst way. With
# no key the service comes up healthy, reports `viewOracle: not configured`,
# and holds every submission forever — no view can satisfy the dwell window,
# so nobody is ever paid and nothing errors.
if ! gcloud secrets describe youtube-api-key --project "$PROJECT" >/dev/null 2>&1; then
  cat >&2 <<MISSINGKEY
Secret youtube-api-key not found in project ${PROJECT}.

Without it the view oracle is unconfigured: the service looks healthy, and
holds every submission forever because no view can ever be confirmed. Create
it, grant the runtime account access, then re-run:

  printf '%s' "\$YOUTUBE_API_KEY" | gcloud secrets create youtube-api-key \\
    --project ${PROJECT} --replication-policy=automatic --data-file=-

  gcloud secrets add-iam-policy-binding youtube-api-key --project ${PROJECT} \\
    --member "serviceAccount:${RUNTIME_SA}" --role roles/secretmanager.secretAccessor

MISSINGKEY
  exit 1
fi

# Read a value off the running service, so a redeploy inherits working config
# rather than replacing it. See the note on the secrets below.
deployed_env() {
  gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" \
    --format=json 2>/dev/null \
    | python3 -c "
import sys, json
try:
    envs = json.load(sys.stdin)['spec']['template']['spec']['containers'][0].get('env', [])
except Exception:
    envs = []
print(next((e.get('value', '') for e in envs if e.get('name') == '$1'), ''))
" 2>/dev/null
}

# The wallets this deployment's Circle session can sign transfers from.
#
# Campaigns are funded to a wallet and paid out of that same wallet, so this
# list decides which funding wallets `create_campaign` will accept. Get it from
# the session that will actually settle:
#
#   circle wallet list --chain BASE-SEPOLIA
#
# There is deliberately no default. The value that used to sit here was one
# hardcoded address used for *both* networks, and it was not a wallet the
# session held — so the configured payer could not have signed anything, and
# nothing said so until a payout was attempted. Unset is the honest state for a
# deployment that has not been told: it settles nothing rather than settling
# from an address nobody checked.
# Where x402 revenue lands. Advertised in the 402 challenge as `payTo`, so a
# placeholder here is not a harmless default — a well-behaved client would send
# USDC to a string that is not an address and destroy it. Unset means the
# priced endpoints refuse to quote at all, which is the safe reading.
AGENT_WALLET_ADDRESS="${AGENT_WALLET_ADDRESS:-$(deployed_env AGENT_WALLET_ADDRESS)}"

# --set-env-vars REPLACES the whole environment, so anything not named on that
# line is deleted by the next deploy. That is how the PostHog key disappeared:
# it was set once by hand, then silently dropped, and analytics stopped without
# a single error anywhere. Carried forward like everything else now.
POSTHOG_KEY="${POSTHOG_KEY:-$(deployed_env POSTHOG_KEY)}"
POSTHOG_HOST="${POSTHOG_HOST:-$(deployed_env POSTHOG_HOST)}"
POSTHOG_INCLUDE_WALLETS="${POSTHOG_INCLUDE_WALLETS:-$(deployed_env POSTHOG_INCLUDE_WALLETS)}"

SETTLEMENT_WALLETS="${SETTLEMENT_WALLETS:-$(deployed_env SETTLEMENT_WALLETS)}"
MAINNET_SETTLEMENT_WALLETS="${MAINNET_SETTLEMENT_WALLETS:-$(deployed_env MAINNET_SETTLEMENT_WALLETS)}"

if [ -z "$SETTLEMENT_WALLETS" ]; then
  cat <<'NOWALLET'

Note: SETTLEMENT_WALLETS is unset, so this deployment will plan payouts and
never send them, and it will accept any funding wallet on a campaign. To settle
for real, list the addresses the settling Circle session holds:

  SETTLEMENT_WALLETS="$(circle wallet list --chain BASE-SEPOLIA --output json \
    | python3 -c 'import sys,json;print(",".join(w["address"] for w in json.load(sys.stdin)))')" \
    ./deploy.sh

NOWALLET
fi

# Carried forward from the running service, not regenerated.
#
# These were `${X:-$(openssl rand -hex 24)}`, so every deploy that did not
# happen to have the value in its shell minted a new one. The service came up
# healthy with a secret nothing else knew, and the Cloud Scheduler job kept
# sending the old header — so `/api/tick` returned 401 every hour and the
# hourly snapshot loop stopped. Nothing surfaced it: the deploy succeeded, the
# health check passed, and the only symptom was that no dwell window ever
# completed and nobody was paid. It ran that way for four days.
#
# Reading the deployed value first makes a redeploy leave working config alone.
# Generating is the last resort, for a service that does not exist yet.
TICK_SECRET="${TICK_SECRET:-$(deployed_env TICK_SECRET)}"
TICK_SECRET="${TICK_SECRET:-$(openssl rand -hex 24)}"
OPERATOR_SECRET="${OPERATOR_SECRET:-$(deployed_env OPERATOR_SECRET)}"
OPERATOR_SECRET="${OPERATOR_SECRET:-$(openssl rand -hex 24)}"

# Google OAuth & Session Configuration
GOOGLE_OAUTH_CLIENT_ID="${GOOGLE_OAUTH_CLIENT_ID:-868655245369-njpp3v17gd79ab3b85ttcg768ncu2bu4.apps.googleusercontent.com}"
GOOGLE_OAUTH_REDIRECT_URI="${GOOGLE_OAUTH_REDIRECT_URI:-https://merlinclips.com/auth/google/callback}"

gcloud run deploy "$SERVICE" \
  --source . \
  --project "$PROJECT" \
  --region "$REGION" \
  --service-account "$RUNTIME_SA" \
  --allow-unauthenticated \
  --port 8080 \
  --cpu 1 \
  --memory 512Mi \
  --min-instances 0 \
  --max-instances 4 \
  --timeout 60s \
  --set-secrets "GOOGLE_OAUTH_CLIENT_SECRET=oauth-client-secret:latest,SESSION_SECRET=session-secret:latest,YOUTUBE_API_KEY=youtube-api-key:latest" \
  --set-env-vars "NODE_ENV=production,GCS_BUCKET=${BUCKET},TICK_SECRET=${TICK_SECRET},OPERATOR_SECRET=${OPERATOR_SECRET},AGENT_WALLET_ADDRESS=${AGENT_WALLET_ADDRESS},POSTHOG_KEY=${POSTHOG_KEY},POSTHOG_HOST=${POSTHOG_HOST},POSTHOG_INCLUDE_WALLETS=${POSTHOG_INCLUDE_WALLETS},SETTLEMENT_WALLETS=${SETTLEMENT_WALLETS},MAINNET_SETTLEMENT_WALLETS=${MAINNET_SETTLEMENT_WALLETS},GOOGLE_GENAI_USE_VERTEXAI=true,GOOGLE_CLOUD_PROJECT=${PROJECT},GOOGLE_CLOUD_LOCATION=${GOOGLE_CLOUD_LOCATION:-global},GOOGLE_OAUTH_CLIENT_ID=${GOOGLE_OAUTH_CLIENT_ID},GOOGLE_OAUTH_REDIRECT_URI=${GOOGLE_OAUTH_REDIRECT_URI}"

# The scheduler holds the tick secret in a header, so the two can drift apart
# and the only symptom is a 401 an hour into a log nobody is reading — which is
# how the snapshot loop stayed down for four days. Carrying the secret forward
# above should prevent it; this checks rather than assumes, because the failure
# is silent and the cost is that nobody gets paid.
SCHEDULED=$(gcloud scheduler jobs describe merlinclips-tick \
  --project "$PROJECT" --location "$REGION" \
  --format="value(httpTarget.headers)" 2>/dev/null \
  | tr ';' '\n' | sed -n 's/^x-tick-secret=//p')

if [ -z "$SCHEDULED" ]; then
  echo "Note: no merlinclips-tick scheduler job found — see the command below."
elif [ "$SCHEDULED" != "$TICK_SECRET" ]; then
  cat <<DRIFT

The scheduler's tick secret does not match the one just deployed, so every
hourly tick will 401 and no view snapshot will be taken. Fix it now:

  gcloud scheduler jobs update http merlinclips-tick \\
    --project ${PROJECT} --location ${REGION} \\
    --update-headers "x-tick-secret=${TICK_SECRET}"

DRIFT
else
  echo "Scheduler: tick secret matches"
fi

# ALLOW_MAINNET and BROADCAST are deliberately never forwarded here. Unset in
# Cloud Run means estimate-only on testnet, which is the state a deploy should
# land in; arming real money is a decision someone makes explicitly, not one
# inherited from whatever happened to be in a laptop's shell.
#
# This comment described the intent; the command above did the opposite,
# passing ALLOW_MAINNET=true and BROADCAST=true on every deploy. Any redeploy
# therefore armed live USDC broadcasting on Base Mainnet as a side effect of
# shipping a CSS change. Arming it is now a separate, deliberate act:
#
#   gcloud run services update merlinclips --region us-central1 \
#     --update-env-vars ALLOW_MAINNET=true,BROADCAST=true

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.url)')"
echo
echo "Live: $URL"
# Not /healthz. Cloud Run's frontend reserves that path and answers it itself
# with a Google 404, so the request never reaches the container — the first
# deploy reported a failed health check on a service that was serving fine.
echo "Health: $(curl -fsS "$URL/health" || echo 'FAILED')"
echo "Config: $(curl -fsS "$URL/api/campaign" | head -c 200 || echo 'unreachable')"
echo "Settles from: ${SETTLEMENT_WALLETS:-<nothing — payouts are planned, never sent>}"
echo "Tick Secret: $TICK_SECRET"
echo "Operator Secret: $OPERATOR_SECRET"

cat <<SCHEDULER

Schedule the agent (hourly). Cloud Scheduler rather than an in-process timer,
so each pass is an HTTP request and Cloud Logging keeps the execution log:

  gcloud scheduler jobs create http ${SERVICE}-tick \\
    --project $PROJECT --location $REGION \\
    --schedule "0 * * * *" \\
    --uri "$URL/api/tick" \\
    --http-method POST \\
    --headers "x-tick-secret=\$TICK_SECRET"
SCHEDULER
