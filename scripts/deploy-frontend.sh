
#!/usr/bin/env bash
set -euo pipefail

PROJECT="eximion-511003"
REGION="europe-west3"

IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/eximion/frontend:$(git rev-parse --short HEAD)"

BACKEND_URL="https://eximion-backend-aprnyhognq-ey.a.run.app"

echo "Building frontend..."

gcloud builds submit ./frontend \
  --config=./scripts/cloudbuild-frontend.yaml \
  --substitutions="_API_URL=${BACKEND_URL},_IMAGE=${IMAGE}" \
  --project="${PROJECT}"

echo "Deploying to Cloud Run..."

gcloud run deploy eximion-frontend \
  --image="${IMAGE}" \
  --region="${REGION}" \
  --project="${PROJECT}"

echo "Deployment completed!"
