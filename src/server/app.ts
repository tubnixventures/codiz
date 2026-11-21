import { Hono } from 'hono';
import { requireAuth } from './middleware/auth.ts';
import { structuredLogger } from './middleware/logger.ts';
import { rateLimit } from './middleware/rate-limit.ts';
import { authRouter } from './endpoints/auth.ts';
import { chatRouter } from './endpoints/chat.ts';
import { factoryRouter } from './endpoints/factory.ts';
import { healthRouter } from './endpoints/health.ts';
import { knowledgeRouter } from './endpoints/knowledge.ts';
import { modelsRouter } from './endpoints/models.ts';
import { openaiCompatRouter } from './endpoints/openai-compat.ts';
import { repoRouter } from './endpoints/repo.ts';
import { usageRouter } from './endpoints/usage.ts';

export function createCodizApiApp(): Hono {
  const app = new Hono().basePath('/api');

  app.use('*', structuredLogger);
  app.use('*', rateLimit({ windowMs: 60_000, maxRequests: 120 }));

  // Public health & authentication routes
  app.route('/', healthRouter);
  app.route('/auth', authRouter);

  // Protected Codiz Intelligence routes
  app.use('/chat/*', requireAuth);
  app.use('/chat', requireAuth);
  app.use('/repo/*', requireAuth);
  app.use('/models/*', requireAuth);
  app.use('/models', requireAuth);
  app.use('/factory/*', requireAuth);
  app.use('/knowledge/*', requireAuth);
  app.use('/usage/*', requireAuth);
  app.use('/v1/*', requireAuth);

  app.route('/chat', chatRouter);
  app.route('/repo', repoRouter);
  app.route('/models', modelsRouter);
  app.route('/factory', factoryRouter);
  app.route('/knowledge', knowledgeRouter);
  app.route('/usage', usageRouter);
  app.route('/v1', openaiCompatRouter);

  app.notFound((c) => c.json({ error: 'Codiz API route not found' }, 404));

  app.onError((err, c) => {
    console.error('Unhandled Codiz Hono API error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  return app;
}
