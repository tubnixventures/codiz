import { Hono } from 'hono';
import { z } from 'zod';
import { getSelfHostedRuntimeConfig } from '../config/runtime.ts';
import { generateCompletion } from '../providers/llm/router.ts';
import { searchKnowledge } from '../services/retrieval/knowledge.ts';

export const openaiCompatRouter = new Hono();

const OpenAiChatSchema = z.object({
  model: z.string().optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string(),
      })
    )
    .min(1),
  max_tokens: z.number().int().min(1).max(8192).optional(),
  stream: z.boolean().optional().default(false),
  use_codiz_rag: z.boolean().optional().default(true),
});

openaiCompatRouter.get('/models', (c) => {
  const cfg = getSelfHostedRuntimeConfig();
  return c.json({
    object: 'list',
    data: [
      {
        id: cfg.selfHostedModel || 'codiz-qwen3-4b',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'codiz-self-hosted',
        adapter_version: cfg.activeAdapterVersion,
      },
    ],
  });
});

openaiCompatRouter.post('/chat/completions', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = OpenAiChatSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: { message: 'Invalid OpenAI-compatible request', details: parsed.error.flatten() } },
      400
    );
  }

  const messages = [...parsed.data.messages];
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');

  // Optionally enrich VS Code / IDE queries with Codiz Knowledge RAG
  if (parsed.data.use_codiz_rag && lastUser) {
    const docs = searchKnowledge(lastUser.content, undefined, 2);
    if (docs.length > 0) {
      const ragBlock = docs
        .map((d) => `[${d.collection}] ${d.title}: ${d.content.slice(0, 350)}`)
        .join('\n');
      messages.unshift({
        role: 'system',
        content: `Relevant Codiz Technical Documentation:\n${ragBlock}`,
      });
    }
  }

  try {
    const result = await generateCompletion({
      messages,
      modelOverride: parsed.data.model,
      maxTokens: parsed.data.max_tokens,
    });

    const id = `chatcmpl-${crypto.randomUUID().slice(0, 12)}`;
    const created = Math.floor(Date.now() / 1000);

    if (parsed.data.stream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          const chunkPayload = {
            id,
            object: 'chat.completion.chunk',
            created,
            model: result.modelId,
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: result.text },
                finish_reason: 'stop',
              },
            ],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunkPayload)}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }

    return c.json({
      id,
      object: 'chat.completion',
      created,
      model: result.modelId,
      codiz_provider: result.providerUsed,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: result.text },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: result.tokensIn,
        completion_tokens: result.tokensOut,
        total_tokens: result.tokensIn + result.tokensOut,
      },
    });
  } catch (err) {
    return c.json(
      { error: { message: err instanceof Error ? err.message : 'Inference failed' } },
      502
    );
  }
});
