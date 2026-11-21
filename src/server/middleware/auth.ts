import crypto from 'node:crypto';
import type { Context, Next } from 'hono';
import { getEnv } from '../config/env.ts';
import { getDb } from '../db/sqlite.ts';

interface SessionEntry {
  createdAt: number;
  expiresAt: number;
}

const activeSessions = new Map<string, SessionEntry>();
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

function hashPassphrase(passphrase: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(passphrase, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey.toString('hex'));
    });
  });
}

export function getAuthStatus(): {
  mode: 'env-token' | 'claimed' | 'unclaimed';
  requiresSetup: boolean;
} {
  const env = getEnv();
  if (env.CODIZ_API_TOKEN.trim().length > 0) {
    return { mode: 'env-token', requiresSetup: false };
  }
  const db = getDb();
  const row = db.prepare('SELECT id FROM auth_config WHERE id = 1').get();
  if (row) {
    return { mode: 'claimed', requiresSetup: false };
  }
  return { mode: 'unclaimed', requiresSetup: true };
}

export async function claimWorkspacePassphrase(passphrase: string): Promise<string> {
  const status = getAuthStatus();
  if (status.mode === 'env-token') {
    throw new Error('Static CODIZ_API_TOKEN is configured; bootstrap is locked.');
  }
  if (status.mode === 'claimed') {
    throw new Error('Workspace passphrase is already claimed.');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await hashPassphrase(passphrase, salt);
  const db = getDb();
  db.prepare(
    `INSERT INTO auth_config (id, passphrase_hash, salt, claimed_at) VALUES (1, ?, ?, ?)`
  ).run(hash, salt, new Date().toISOString());

  return issueSessionToken();
}

export async function verifyWorkspaceLogin(passphrase: string): Promise<string | null> {
  const env = getEnv();
  if (env.CODIZ_API_TOKEN.trim().length > 0) {
    const expected = Buffer.from(env.CODIZ_API_TOKEN.trim());
    const supplied = Buffer.from(passphrase.trim());
    if (expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied)) {
      return issueSessionToken();
    }
    return null;
  }

  const db = getDb();
  const row = db
    .prepare('SELECT passphrase_hash, salt FROM auth_config WHERE id = 1')
    .get() as { passphrase_hash: string; salt: string } | undefined;

  if (!row) return null;
  const candidate = await hashPassphrase(passphrase, row.salt);
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(row.passphrase_hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }
  return issueSessionToken();
}

export function issueSessionToken(): string {
  const token = `cdz_${crypto.randomBytes(32).toString('hex')}`;
  const now = Date.now();
  activeSessions.set(token, { createdAt: now, expiresAt: now + SESSION_TTL_MS });
  return token;
}

export function revokeSessionToken(token: string): void {
  activeSessions.delete(token);
}

export function isValidBearerToken(token: string): boolean {
  const env = getEnv();
  if (env.CODIZ_API_TOKEN.trim().length > 0) {
    const a = Buffer.from(env.CODIZ_API_TOKEN.trim());
    const b = Buffer.from(token.trim());
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return true;
    }
  }
  const entry = activeSessions.get(token);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    activeSessions.delete(token);
    return false;
  }
  return true;
}

export async function requireAuth(c: Context, next: Next): Promise<Response | void> {
  const authHeader = c.req.header('authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized: Bearer token required' }, 401);
  }
  const token = authHeader.slice(7).trim();
  if (!isValidBearerToken(token)) {
    return c.json({ error: 'Unauthorized: Invalid or expired session token' }, 401);
  }
  await next();
}
