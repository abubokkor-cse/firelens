#!/usr/bin/env bash
# Deploy the FireLens API to Google Cloud Run
set -euo pipefail
PROJECT="${PROJECT:-firelens-aquila}"      # dedicated project — never deploys into another one
REGION="${REGION:-asia-south1}"            # Mumbai — closest to Bangladesh; any Cloud Run region works
SERVICE="${SERVICE:-firelens-api}"
FIRELENS_ARCHIVE_URL="${FIRELENS_ARCHIVE_URL:-https://pub-0c8f8afcb5ca41119ca93ba2cc66c242.r2.dev/archive}"
CORS_ORIGINS_RAW="${CORS_ORIGINS_RAW:-https://firelens.tech,https://www.firelens.tech,https://firelens.pages.dev,http://localhost:5173,http://localhost:5174}"
SITE_URL="${SITE_URL:-https://firelens.tech}"
ALERTS_FROM="${ALERTS_FROM:-FireLens Alerts <alerts@firelens.tech>}"
PUBLIC_API_URL="${PUBLIC_API_URL:-https://firelens-api-578816839215.asia-south1.run.app}"

gcloud run deploy "$SERVICE" \
  --project "$PROJECT" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --memory 4Gi --cpu 1 \
  --min-instances 0 --max-instances 4 \
  --cpu-boost \
  --set-env-vars "^;^FIRELENS_ARCHIVE_URL=${FIRELENS_ARCHIVE_URL};CORS_ORIGINS_RAW=${CORS_ORIGINS_RAW};SITE_URL=${SITE_URL};ALERTS_FROM=${ALERTS_FROM};ALERTS_STORE=firestore;PUBLIC_API_URL=${PUBLIC_API_URL}" \
  --set-secrets "FIRMS_API_KEY=firms-api-key:latest,RESEND_API_KEY=resend-api-key:latest,ALERTS_RUN_TOKEN=alerts-run-token:latest"

# Hourly alert check (Cloud Scheduler → POST /alerts/run with the shared token)
URL=$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.url)')
TOKEN=$(gcloud secrets versions access latest --secret alerts-run-token --project "$PROJECT")
JOB=(firelens-alerts --project "$PROJECT" --location "$REGION" --schedule "7 * * * *" --time-zone UTC
     --uri "$URL/api/v1/alerts/run" --http-method POST --attempt-deadline 600s)
if gcloud scheduler jobs describe firelens-alerts --project "$PROJECT" --location "$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "${JOB[@]}" --update-headers "X-Alerts-Token=$TOKEN"
else
  gcloud scheduler jobs create http "${JOB[@]}" --headers "X-Alerts-Token=$TOKEN"
fi

gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.url)'
