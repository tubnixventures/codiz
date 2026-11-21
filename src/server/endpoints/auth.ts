import { Hono } from 'hono';
import { z } from 'zod';
import {
  claimWorkspacePassphrase,
  getAuthStatus,
  revokeSessionToken,
  verifyWorkspaceLogin,
} from '../middleware/auth.ts';

export const authRouter = new Hono();

const PassphraseSchema = z.object({
  passphrase: z.string().min(6, 'Passphrase must be at least 6 characters.').max(128),
});

authRouter.get('/status', (c) => {
  return c.json(getAuthStatus());
});

authRouter.post('/bootstrap', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = PassphraseSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid passphrase' }, 400);
  }
  try {
    const token = await claimWorkspacePassphrase(parsed.data.passphrase);
    return c.json({ token, mode: 'claimed' }, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Bootstrap failed' }, 409);
  }
});

authRouter.post('/login', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = PassphraseSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid passphrase format' }, 400);
  }
  const token = await verifyWorkspaceLogin(parsed.data.passphrase);
  if (!token) {
    return c.json({ error: 'Invalid passphrase or API token' }, 401);
  }
  return c.json({ token });
});

authRouter.post('/logout', (c) => {
  const auth = c.req.header('authorization') ?? '';
  if (auth.startsWith('Bearer ')) {
    revokeSessionToken(auth.slice(7).trim());
  }
  return c.json({ ok: true });
});
