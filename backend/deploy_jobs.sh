#!/usr/bin/env bash
# Scheduled archive updates on Google Cloud: two Cloud Run jobs running the API's image, and their schedules.
#   firelens-daily    06:30 UTC every day   newest fires → the recent part of the archive (a few MB)
#   firelens-rebuild  07:30 UTC Sundays     country reports; the daily job also starts it, as a full rebuild,
#                                           when NASA publishes a new monthly file for every sensor
# Needs the secrets firms-api-key, r2-access-key-id and r2-secret-access-key in Secret Manager.
set -euo pipefail
PROJECT="${PROJECT:-firelens-aquila}"
REGION="${REGION:-asia-south1}"
R2_ENDPOINT="${R2_ENDPOINT:?set R2_ENDPOINT (S3 API endpoint, without the bucket)}"
R2_BUCKET="${R2_BUCKET:-firelens}"
R2_PUBLIC_URL="${R2_PUBLIC_URL:-https://pub-0c8f8afcb5ca41119ca93ba2cc66c242.r2.dev}"

IMAGE=$(gcloud run services describe firelens-api --project "$PROJECT" --region "$REGION" \
          --format 'value(spec.template.spec.containers[0].image)')
SA=$(gcloud run services describe firelens-api --project "$PROJECT" --region "$REGION" \
       --format 'value(spec.template.spec.serviceAccountName)')
ENV="^;^R2_ENDPOINT=$R2_ENDPOINT;R2_BUCKET=$R2_BUCKET;R2_PUBLIC_URL=$R2_PUBLIC_URL;FIRELENS_DATA_DIR=/tmp/firelens;JOBS_REGION=$REGION;REBUILD_JOB=firelens-rebuild"
SECRETS="FIRMS_API_KEY=firms-api-key:latest,R2_ACCESS_KEY_ID=r2-access-key-id:latest,R2_SECRET_ACCESS_KEY=r2-secret-access-key:latest"

gcloud run jobs deploy firelens-daily --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
  --command python --args=-m,scripts.update,daily --cpu 2 --memory 4Gi --task-timeout 45m --max-retries 1 \
  --set-env-vars "$ENV" --set-secrets "$SECRETS"
gcloud run jobs deploy firelens-rebuild --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
  --command python --args=-m,scripts.update,reports --cpu 8 --memory 32Gi --task-timeout 6h --max-retries 0 \
  --set-env-vars "$ENV" --set-secrets "$SECRETS"

schedule() { # schedule <name> <cron> <job>
  local args=(--project "$PROJECT" --location "$REGION" --schedule "$2" --time-zone UTC --http-method POST
              --uri "https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/$3:run"
              --oauth-service-account-email "$SA")
  if gcloud scheduler jobs describe "$1" --project "$PROJECT" --location "$REGION" >/dev/null 2>&1; then
    gcloud scheduler jobs update http "$1" "${args[@]}"
  else
    gcloud scheduler jobs create http "$1" "${args[@]}"
  fi
}
schedule firelens-daily-update "30 6 * * *" firelens-daily
schedule firelens-weekly-reports "30 7 * * 0" firelens-rebuild
