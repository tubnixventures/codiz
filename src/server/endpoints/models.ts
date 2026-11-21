import { Hono } from 'hono';
import { z } from 'zod';
import { FOUNDATION_MODEL_CATALOG } from '../config/models.ts';
import {
  getSelfHostedRuntimeConfig,
  saveSelfHostedRuntimeConfig,
} from '../config/runtime.ts';
import { runModelBenchmarkSuite } from '../services/evaluator/runner.ts';
import {
  generateLocalDeploymentBundle,
  listModelVersions,
  promoteModelVersion,
  rollbackProductionModel,
} from '../services/model-registry/registry.ts';

export const modelsRouter = new Hono();

const RuntimeConfigSchema = z.object({
  inferenceMode: z.enum(['auto', 'local-ollama', 'vllm', 'gemini']).optional(),
  selfHostedBaseUrl: z.string().url().or(z.literal('')).optional(),
  selfHostedModel: z.string().min(1).max(120).optional(),
  vllmBaseUrl: z.string().url().or(z.literal('')).optional(),
  vllmModelId: z.string().min(1).max(120).optional(),
});

modelsRouter.get('/runtime-config', (c) => {
  return c.json({ config: getSelfHostedRuntimeConfig() });
});

modelsRouter.post('/runtime-config', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = RuntimeConfigSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid self-hosted Qwen endpoint configuration' }, 400);
  }
  const updated = saveSelfHostedRuntimeConfig(parsed.data);
  return c.json({ config: updated });
});

modelsRouter.get('/', (c) => {
  return c.json({ models: listModelVersions() });
});

modelsRouter.get('/catalog', (c) => {
  return c.json({ catalog: FOUNDATION_MODEL_CATALOG });
});

modelsRouter.get('/local-bundle', (c) => {
  const foundationId = c.req.query('foundationId') ?? 'qwen3-4b-q4km';
  return c.json(generateLocalDeploymentBundle(foundationId));
});

modelsRouter.post('/:id/evaluate', async (c) => {
  try {
    const res = await runModelBenchmarkSuite(c.req.param('id'));
    return c.json(res);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Evaluation failed' }, 400);
  }
});

modelsRouter.post('/:id/promote', (c) => {
  try {
    const promoted = promoteModelVersion(c.req.param('id'));
    return c.json({ model: promoted });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Promotion blocked' }, 409);
  }
});

modelsRouter.post('/rollback', (c) => {
  try {
    const restored = rollbackProductionModel();
    return c.json({ model: restored });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Rollback unavailable' }, 409);
  }
});
