import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Storage } from '@google-cloud/storage';
import { getEnv } from '../../config/env.ts';

export const BUCKET_PREFIXES = {
  foundationModels: 'foundation-models',
  adaptersProduction: 'adapters/production',
  adaptersCandidates: 'adapters/candidates',
  adaptersArchived: 'adapters/archived',
  datasetsRaw: 'datasets/raw',
  datasetsCleaned: 'datasets/cleaned',
  datasetsApproved: 'datasets/approved',
  datasetsValidation: 'datasets/validation',
  knowledge: 'knowledge',
  benchmarks: 'benchmarks',
  trainingRuns: 'training-runs',
  evaluations: 'evaluations',
  manifests: 'manifests',
  backups: 'backups',
} as const;

export interface StoredArtifact {
  uri: string;
  sha256: string;
  sizeBytes: number;
  backend: 'gcs' | 'local-mirror';
  objectPath: string;
  uploadedAt: string;
}

class ArtifactStorageProvider {
  private storage: Storage | null = null;

  private getClient(): Storage | null {
    const env = getEnv();
    if (!env.GCS_BUCKET_NAME) return null;
    if (!this.storage) {
      this.storage = new Storage(env.GCP_PROJECT_ID ? { projectId: env.GCP_PROJECT_ID } : {});
    }
    return this.storage;
  }

  private resolveLocalMirrorPath(objectPath: string): string {
    const env = getEnv();
    const baseDir = path.resolve(env.CODIZ_DATA_DIR, 'artifacts');
    const cleanRel = objectPath.replace(/^\/+/, '');
    const resolved = path.resolve(baseDir, cleanRel);
    if (!resolved.startsWith(baseDir + path.sep)) {
      throw new Error('Invalid artifact path outside storage root');
    }
    return resolved;
  }

  async putObject(
    objectPath: string,
    data: Buffer | string,
    metadata: Record<string, string> = {}
  ): Promise<StoredArtifact> {
    const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const uploadedAt = new Date().toISOString();

    const env = getEnv();
    const client = this.getClient();

    if (client && env.GCS_BUCKET_NAME) {
      const bucket = client.bucket(env.GCS_BUCKET_NAME);
      const file = bucket.file(objectPath);
      await file.save(buffer, {
        resumable: buffer.length > 5 * 1024 * 1024,
        metadata: {
          metadata: {
            ...metadata,
            sha256,
            uploadedAt,
          },
        },
      });
      return {
        uri: `gs://${env.GCS_BUCKET_NAME}/${objectPath}`,
        sha256,
        sizeBytes: buffer.length,
        backend: 'gcs',
        objectPath,
        uploadedAt,
      };
    }

    // Persistent local artifact mirror when GCS bucket is not yet configured
    const targetPath = this.resolveLocalMirrorPath(objectPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, buffer);
    fs.writeFileSync(
      `${targetPath}.meta.json`,
      JSON.stringify({ sha256, sizeBytes: buffer.length, metadata, uploadedAt }, null, 2)
    );

    return {
      uri: `local://artifacts/${objectPath}`,
      sha256,
      sizeBytes: buffer.length,
      backend: 'local-mirror',
      objectPath,
      uploadedAt,
    };
  }

  async getStatus(): Promise<{
    backend: 'gcs' | 'local-mirror';
    bucketName: string;
    totalLocalBytes: number;
    objectCount: number;
  }> {
    const env = getEnv();
    const baseDir = path.resolve(env.CODIZ_DATA_DIR, 'artifacts');
    let totalLocalBytes = 0;
    let objectCount = 0;

    if (fs.existsSync(baseDir)) {
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (!entry.name.endsWith('.meta.json')) {
            objectCount += 1;
            totalLocalBytes += fs.statSync(full).size;
          }
        }
      };
      walk(baseDir);
    }

    return {
      backend: env.GCS_BUCKET_NAME ? 'gcs' : 'local-mirror',
      bucketName: env.GCS_BUCKET_NAME || 'local-mirror (.codiz-data/artifacts)',
      totalLocalBytes,
      objectCount,
    };
  }
}

export const artifactStorage = new ArtifactStorageProvider();
