import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import process from 'node:process';
import { getEnv } from '../server/config/env.ts';
import { getDb } from '../server/db/sqlite.ts';
import { validateProposedShellCommand } from '../server/services/agent/tools.ts';
import {
  invalidateRepoIndexCache,
  resolveSafeWorkspacePath,
} from '../server/services/repository/indexer.ts';
import { c, renderUnifiedDiff } from './ansi.ts';

interface ApprovalRow {
  id: string;
  tool_name: string;
  action_summary: string;
  payload_json: string;
  risk_level: string;
  status: string;
}

async function askYesNo(promptText: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(promptText);
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  } finally {
    rl.close();
  }
}

export async function reviewPendingApprovals(specificIds?: string[]): Promise<number> {
  const db = getDb();
  const rows = (
    specificIds && specificIds.length > 0
      ? specificIds
          .map((id) =>
            db
              .prepare(`SELECT * FROM agent_approvals WHERE id = ? AND status = 'pending'`)
              .get(id)
          )
          .filter(Boolean)
      : db
          .prepare(`SELECT * FROM agent_approvals WHERE status = 'pending' ORDER BY created_at ASC LIMIT 20`)
          .all()
  ) as ApprovalRow[];

  if (rows.length === 0) return 0;

  console.log('');
  console.log(c.bold(c.amber(`Pending Agent Proposals (${rows.length}) — Human Approval Required`)));

  let resolvedCount = 0;

  for (const row of rows) {
    console.log(c.slate('─'.repeat(64)));
    if (row.tool_name === 'propose_file_write') {
      const payload = JSON.parse(row.payload_json) as {
        path: string;
        content: string;
        reason: string;
      };
      let oldContent: string | null = null;
      let targetPath = '';
      try {
        targetPath = resolveSafeWorkspacePath(payload.path);
        if (fs.existsSync(targetPath)) {
          oldContent = fs.readFileSync(targetPath, 'utf8');
        }
      } catch (err) {
        console.log(c.red(`Blocked invalid workspace path: ${err instanceof Error ? err.message : String(err)}`));
        db.prepare(`UPDATE agent_approvals SET status = 'rejected', resolved_at = ? WHERE id = ?`).run(
          new Date().toISOString(),
          row.id
        );
        continue;
      }

      console.log(renderUnifiedDiff(payload.path, oldContent, payload.content, payload.reason));
      const approved = await askYesNo(
        `\n${c.bold(`Apply write to ${c.cyan(payload.path)}?`)} ${c.slate('[y/N]')} `
      );
      const now = new Date().toISOString();
      if (approved) {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, payload.content, 'utf8');
        invalidateRepoIndexCache();
        db.prepare(`UPDATE agent_approvals SET status = 'approved', resolved_at = ? WHERE id = ?`).run(
          now,
          row.id
        );
        console.log(c.green(`✓ Wrote ${payload.path}`));
        resolvedCount++;
      } else {
        db.prepare(`UPDATE agent_approvals SET status = 'rejected', resolved_at = ? WHERE id = ?`).run(
          now,
          row.id
        );
        console.log(c.slate(`✕ Rejected write to ${payload.path}`));
      }
      continue;
    }

    if (row.tool_name === 'propose_command') {
      const payload = JSON.parse(row.payload_json) as { command: string; reason: string };
      try {
        validateProposedShellCommand(payload.command);
      } catch (err) {
        console.log(c.red(`Blocked unsafe command: ${err instanceof Error ? err.message : String(err)}`));
        db.prepare(`UPDATE agent_approvals SET status = 'rejected', resolved_at = ? WHERE id = ?`).run(
          new Date().toISOString(),
          row.id
        );
        continue;
      }

      const env = getEnv();
      console.log(`${c.bold('Proposed Command:')} ${c.cyan(payload.command)}`);
      console.log(`${c.slate('Working Dir:')}      ${env.CODIZ_WORKSPACE_ROOT}`);
      console.log(`${c.slate('Reason:')}           ${payload.reason}`);

      const approved = await askYesNo(
        `\n${c.bold('Execute this command locally?')} ${c.slate('[y/N]')} `
      );
      const now = new Date().toISOString();
      if (approved) {
        console.log(c.slate(`\nRunning: ${payload.command}\n`));
        const shellBin = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
        const shellArgs = process.platform === 'win32' ? ['/c', payload.command] : ['-c', payload.command];
        const res = spawnSync(shellBin, shellArgs, {
          cwd: env.CODIZ_WORKSPACE_ROOT,
          stdio: 'inherit',
          timeout: 30_000,
        });
        db.prepare(`UPDATE agent_approvals SET status = 'approved', resolved_at = ? WHERE id = ?`).run(
          now,
          row.id
        );
        if (res.status === 0) {
          console.log(c.green(`\n✓ Command exited with code 0`));
        } else {
          console.log(c.amber(`\n! Command exited with code ${res.status ?? 'timeout'}`));
        }
        resolvedCount++;
      } else {
        db.prepare(`UPDATE agent_approvals SET status = 'rejected', resolved_at = ? WHERE id = ?`).run(
          now,
          row.id
        );
        console.log(c.slate('✕ Skipped command execution'));
      }
    }
  }

  console.log('');
  return resolvedCount;
}
