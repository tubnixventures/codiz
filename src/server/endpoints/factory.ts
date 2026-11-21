import { Hono } from 'hono';
import { z } from 'zod';
import { findFoundationModel } from '../config/models.ts';
import { evaluateCodeSnippet } from '../services/evaluator/runner.ts';
import {
  dispatchLoraTrainingJob,
  estimateTrainingJobCost,
  listTrainingRuns,
} from '../services/model-registry/registry.ts';
import {
  generateSyntheticExample,
  importMuseCodeJsonl,
  ingestTrainingExample,
  listTrainingExamples,
  runTeacherReviewOnExample,
} from '../services/teacher/factory.ts';

export const factoryRouter = new Hono();

const ManualExampleSchema = z.object({
  prompt: z.string().min(12).max(12000),
  completion: z.string().min(20).max(20000),
  difficulty: z.enum(['beginner', 'intermediate', 'advanced']).default('intermediate'),
  category: z.string().optional(),
});

const MuseImportSchema = z.object({
  jsonlText: z.string().min(10).max(500_000),
  licenseMetadata: z.string().min(1).max(120).default('authorized-muse-code-export'),
  attribution: z.string().min(1).max(120).default('Muse Code Teacher'),
});

const SyntheticSchema = z.object({
  topic: z.string().min(3).max(200),
  difficulty: z.enum(['beginner', 'intermediate', 'advanced']).default('intermediate'),
});

const TrainingJobSchema = z.object({
  foundationModelId: z.string().default('qwen3-4b-bf16'),
  target: z.enum(['local-gpu', 'cloud-run-l4']).default('local-gpu'),
  confirmSpendAllowance: z.boolean().default(false),
  loraConfig: z
    .object({
      rank: z.number().int().min(4).max(64).default(16),
      alpha: z.number().int().min(8).max(128).default(32),
      dropout: z.number().min(0).max(0.3).default(0.05),
      learningRate: z.number().positive().max(0.01).default(0.0002),
      epochs: z.number().int().min(1).max(6).default(2),
      batchSize: z.number().int().min(1).max(8).default(2),
      quantizationBits: z.union([z.literal(4), z.literal(8), z.literal(16)]).default(4),
    })
    .default({
      rank: 16,
      alpha: 32,
      dropout: 0.05,
      learningRate: 0.0002,
      epochs: 2,
      batchSize: 2,
      quantizationBits: 4,
    }),
});

const EvaluateSnippetSchema = z.object({
  code: z.string().min(1).max(24000),
  language: z.enum(['typescript', 'python', 'other']).default('typescript'),
});

factoryRouter.get('/examples', (c) => {
  const stage = c.req.query('stage');
  return c.json({ examples: listTrainingExamples(stage) });
});

factoryRouter.post('/examples', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = ManualExampleSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid training example' }, 400);
  try {
    const res = ingestTrainingExample({ ...parsed.data, source: 'manual' });
    return c.json(res, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Ingestion failed' }, 400);
  }
});

factoryRouter.post('/muse-import', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = MuseImportSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid JSONL import payload' }, 400);
  const summary = importMuseCodeJsonl(parsed.data);
  return c.json(summary);
});

factoryRouter.post('/synthetic', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = SyntheticSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid synthetic topic request' }, 400);
  try {
    const record = await generateSyntheticExample(parsed.data);
    return c.json({ example: record }, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Teacher generation failed' }, 402);
  }
});

factoryRouter.post('/examples/:id/teacher-review', async (c) => {
  try {
    const review = await runTeacherReviewOnExample(c.req.param('id'));
    return c.json(review);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Teacher review failed' }, 400);
  }
});

factoryRouter.post('/evaluate-snippet', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = EvaluateSnippetSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid snippet payload' }, 400);
  return c.json(evaluateCodeSnippet(parsed.data.code, parsed.data.language));
});

factoryRouter.get('/training/estimate', (c) => {
  const foundationModelId = c.req.query('foundationModelId') ?? 'qwen3-4b-bf16';
  const examplesCount = Number(c.req.query('examplesCount') ?? 25);
  const epochs = Number(c.req.query('epochs') ?? 2);
  const target = c.req.query('target') === 'cloud-run-l4' ? 'cloud-run-l4' : 'local-gpu';
  return c.json(estimateTrainingJobCost({ foundationModelId, examplesCount, epochs, target }));
});

factoryRouter.get('/training/runs', (c) => {
  return c.json({ runs: listTrainingRuns() });
});

factoryRouter.post('/training/run', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = TrainingJobSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid training job config', details: parsed.error.flatten() }, 400);
  }
  const spec = findFoundationModel(parsed.data.foundationModelId);
  try {
    const result = await dispatchLoraTrainingJob({
      foundationModelId: spec.id,
      target: parsed.data.target,
      confirmSpendAllowance: parsed.data.confirmSpendAllowance,
      loraConfig: {
        ...parsed.data.loraConfig,
        targetModules: spec.loraTargetModules,
      },
    });
    return c.json(result, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Training dispatch blocked' }, 400);
  }
});
