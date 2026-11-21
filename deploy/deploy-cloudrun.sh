#!/usr/bin/env bash
set -euo pipefail

# Codiz — Google Cloud Run Deployment Script ($20/mo scale-to-zero profile)
# Usage: ./deploy/deploy-cloudrun.sh <GCP_PROJECT_ID> <GCS_BUCKET_NAME> [REGION]

PROJECT_ID="${1:?Provide GCP_PROJECT_ID}"
BUCKET_NAME="${2:?Provide GCS_BUCKET_NAME}"
REGION="${3:-europe-west1}"
SA_EMAIL="codiz-runner@${PROJECT_ID}.iam.gserviceaccount.com"

echo "Deploying Codiz Hono Gateway & Workbench to Cloud Run ($REGION)..."
gcloud run deploy codiz-gateway \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --source . \
  --min-instances 0 \
  --max-instances 2 \
  --cpu 1 \
  --memory 512Mi \
  --concurrency 40 \
  --service-account "${SA_EMAIL}" \
  --set-env-vars "NODE_ENV=production,GCP_PROJECT_ID=${PROJECT_ID},GCP_REGION=${REGION},GCS_BUCKET_NAME=${BUCKET_NAME},MONTHLY_BUDGET_USD=20,CODIZ_INFERENCE_MODE=auto" \
  --set-secrets "GEMINI_API_KEY=codiz-gemini-key:latest,CODIZ_API_TOKEN=codiz-api-token:latest" \
  --allow-unauthenticated=false

echo "Optional GPU Inference Service (scale-to-zero, max 1 L4 GPU):"
echo "gcloud run deploy codiz-inference --project ${PROJECT_ID} --region europe-west4 --gpu 1 --gpu-type nvidia-l4 --min-instances 0 --max-instances 1 --memory 16Gi --cpu 4 --no-cpu-throttling --service-account ${SA_EMAIL}"
