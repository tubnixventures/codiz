#!/usr/bin/env bash
set -euo pipefail

# Codiz — GCP IAM, Secret Manager, and GCS Bucket Setup
PROJECT_ID="${1:?Provide GCP_PROJECT_ID}"
BUCKET_NAME="${2:?Provide GCS_BUCKET_NAME}"
REGION="${3:-europe-west1}"
SA_NAME="codiz-runner"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud services enable run.googleapis.com storage.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com --project "${PROJECT_ID}"

# Create regional GCS bucket (single-region low-cost class)
gcloud storage buckets create "gs://${BUCKET_NAME}" --project="${PROJECT_ID}" --location="${REGION}" --uniform-bucket-level-access || true

# Create Codiz bucket directory markers
for prefix in foundation-models adapters/production adapters/candidates adapters/archived datasets/raw datasets/cleaned datasets/approved datasets/validation knowledge benchmarks training-runs evaluations manifests backups; do
  printf "" | gcloud storage cp - "gs://${BUCKET_NAME}/${prefix}/.keep"
done

# Create least-privilege service account (never embed JSON keys in code)
gcloud iam service-accounts create "${SA_NAME}" --project="${PROJECT_ID}" --display-name="Codiz Cloud Run Runner" || true

gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/storage.objectAdmin"

gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/secretmanager.secretAccessor"

echo "Done. Create secrets with:"
echo "  printf 'YOUR_TOKEN' | gcloud secrets create codiz-api-token --data-file=- --project=${PROJECT_ID}"
echo "  printf 'YOUR_GEMINI_KEY' | gcloud secrets create codiz-gemini-key --data-file=- --project=${PROJECT_ID}"
