import path from 'node:path';
import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  APP_URL: z.string().default('http://localhost:3000'),
  CODIZ_API_TOKEN: z.string().optional().default(''),
  CODIZ_WORKSPACE_ROOT: z.string().default('.'),
  CODIZ_DATA_DIR: z.string().default('.codiz-data'),
  CODIZ_INFERENCE_MODE: z
    .enum(['auto', 'local-ollama', 'vllm', 'gemini'])
    .default('auto'),
  LOCAL_LLM_BASE_URL: z.string().default('http://127.0.0.1:11434/v1'),
  LOCAL_LLM_MODEL: z.string().default('qwen3:4b-q4_K_M'),
  LOCAL_EMBED_MODEL: z.string().default('nomic-embed-text'),
  VLLM_BASE_URL: z.string().optional().default(''),
  VLLM_API_KEY: z.string().optional().default(''),
  VLLM_MODEL_ID: z.string().default('Qwen/Qwen3-4B-Instruct'),
  GEMINI_API_KEY: z.string().optional().default(''),
  TEACHER_PROVIDER: z.enum(['gemini', 'openai-compatible']).default('gemini'),
  TEACHER_MODEL: z.string().default('gemini-4-hydrogen'),
  TEACHER_API_BASE_URL: z.string().optional().default(''),
  TEACHER_API_KEY: z.string().optional().default(''),
  GCP_PROJECT_ID: z.string().optional().default(''),
  GCP_REGION: z.string().default('europe-west1'),
  GCS_BUCKET_NAME: z.string().optional().default(''),
  MONTHLY_BUDGET_USD: z.coerce.number().positive().default(20),
  PREFERRED_CURRENCY: z
    .enum(['USD', 'KES', 'NGN', 'ZAR', 'GHS', 'EGP', 'UGX', 'TZS'])
    .default('KES'),
  MAX_DAILY_TEACHER_CALLS: z.coerce.number().int().positive().default(100),
  MAX_REQUEST_TOKENS: z.coerce.number().int().positive().default(4096),
  ENABLE_AUTO_PROMOTION: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  CODIZ_LOW_RESOURCE: z
    .string()
    .default('auto')
    .transform((v) => v.toLowerCase()),
  MIN_DATASET_EXAMPLES_FOR_TRAINING: z.coerce.number().int().positive().default(25),
});

export type AppEnv = z.infer<typeof EnvSchema>;

let cachedEnv: AppEnv | null = null;

export function getEnv(): AppEnv {
  if (cachedEnv) return cachedEnv;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment configuration:', parsed.error.flatten());
    throw new Error('Environment validation failed');
  }
  const data = parsed.data;
  data.CODIZ_WORKSPACE_ROOT = path.resolve(process.cwd(), data.CODIZ_WORKSPACE_ROOT);
  data.CODIZ_DATA_DIR = path.resolve(process.cwd(), data.CODIZ_DATA_DIR);
  cachedEnv = data;
  return data;
}

export function resetEnvCache(): void {
  cachedEnv = null;
}
