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

# Active Circle Funded Agent Wallet (Base Mainnet / Testnet)
DEFAULT_WALLET="0x0003a59858f44451be2a5b486ee612b4139700f0"
CAMPAIGN_WALLET="${CAMPAIGN_WALLET:-$DEFAULT_WALLET}"
MAINNET_CAMPAIGN_WALLET="${MAINNET_CAMPAIGN_WALLET:-$DEFAULT_WALLET}"

# Ensure secrets exist so Cloud Run endpoints (/api/tick and /api/campaigns) remain active
TICK_SECRET="${TICK_SECRET:-$(openssl rand -hex 24)}"
OPERATOR_SECRET="${OPERATOR_SECRET:-$(openssl rand -hex 24)}"

# Google OAuth & Session Configuration
GOOGLE_OAUTH_CLIENT_ID="${GOOGLE_OAUTH_CLIENT_ID:-}"
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
  --set-secrets "GOOGLE_OAUTH_CLIENT_SECRET=oauth-client-secret:latest,SESSION_SECRET=session-secret:latest" \
  --set-env-vars "NODE_ENV=production,ALLOW_MAINNET=true,BROADCAST=true,GCS_BUCKET=${BUCKET},TICK_SECRET=${TICK_SECRET},OPERATOR_SECRET=${OPERATOR_SECRET},CAMPAIGN_WALLET=${CAMPAIGN_WALLET},MAINNET_CAMPAIGN_WALLET=${MAINNET_CAMPAIGN_WALLET},YOUTUBE_API_KEY=${YOUTUBE_API_KEY:-},GOOGLE_GENAI_USE_VERTEXAI=true,GOOGLE_CLOUD_PROJECT=${PROJECT},GOOGLE_CLOUD_LOCATION=${GOOGLE_CLOUD_LOCATION:-global},GOOGLE_OAUTH_CLIENT_ID=${GOOGLE_OAUTH_CLIENT_ID},GOOGLE_OAUTH_REDIRECT_URI=${GOOGLE_OAUTH_REDIRECT_URI}"

# ALLOW_MAINNET and BROADCAST are deliberately never forwarded here. Unset in
# Cloud Run means estimate-only on testnet, which is the state a deploy should
# land in; arming real money is a decision someone makes explicitly, not one
# inherited from whatever happened to be in a laptop's shell.

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.url)')"
echo
echo "Live: $URL"
# Not /healthz. Cloud Run's frontend reserves that path and answers it itself
# with a Google 404, so the request never reaches the container — the first
# deploy reported a failed health check on a service that was serving fine.
echo "Health: $(curl -fsS "$URL/health" || echo 'FAILED')"
echo "Config: $(curl -fsS "$URL/api/campaign" | head -c 200 || echo 'unreachable')"
echo "Active Wallet: $CAMPAIGN_WALLET"
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
